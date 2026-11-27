#!/usr/bin/env python3
"""Run configured NextTrace measurements once or serve them on demand."""

import argparse
from datetime import datetime, timezone
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

MAX_HOPS = 30
MAX_TARGETS = 32
LABEL_LIMIT = 120
PROBE_TOKEN_ENV = "ROUTE_TRACE_TOKEN"
DATA_PROVIDERS = {"NextTrace-API", "IPInfoLocal", "ipdb.one", "disable-geoip"}


def require_label(value, field):
    if isinstance(value, str) and 0 < len(value.strip()) <= LABEL_LIMIT:
        return value.strip()
    raise ValueError(f"{field} must be a non-empty string of at most {LABEL_LIMIT} characters")


def ip_literal(value):
    if not isinstance(value, str) or "%" in value:
        return None
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None


def read_config(path):
    config = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("configuration must be a JSON object")

    source = require_label(config.get("source"), "source")
    provider = config.get("dataProvider", "NextTrace-API")
    if not isinstance(provider, str) or provider not in DATA_PROVIDERS:
        raise ValueError(f"dataProvider must be one of {', '.join(sorted(DATA_PROVIDERS))}")

    targets = config.get("targets")
    if not isinstance(targets, list) or not 1 <= len(targets) <= MAX_TARGETS:
        raise ValueError(f"targets must contain 1 to {MAX_TARGETS} entries")

    traces = []
    keys = set()
    for number, target in enumerate(targets, 1):
        if not isinstance(target, dict):
            raise ValueError(f"target #{number} must be an object")
        node_id = require_label(target.get("nodeId"), f"target #{number} nodeId")
        destination = require_label(target.get("destination"), f"target #{number} destination")
        direction = target.get("direction")
        if direction not in ("forward", "return"):
            raise ValueError(f"target #{number} direction must be forward or return")
        address = ip_literal(target.get("targetIp"))
        if not address or address.is_unspecified or address.is_multicast or getattr(address, "ipv4_mapped", None):
            raise ValueError(f"target #{number} targetIp must be a unicast IPv4 or IPv6 literal")
        protocol = target.get("protocol", "icmp")
        if protocol not in ("icmp", "tcp", "udp"):
            raise ValueError(f"target #{number} protocol must be icmp, tcp, or udp")
        port = target.get("port")
        if protocol == "icmp" and port is not None:
            raise ValueError(f"target #{number} must omit port for ICMP")
        if protocol != "icmp" and (type(port) is not int or not 1 <= port <= 65535):
            raise ValueError(f"target #{number} requires a port between 1 and 65535")

        key = (node_id, direction, address, protocol, port)
        if key in keys:
            raise ValueError(f"target #{number} duplicates an earlier measurement")
        keys.add(key)
        traces.append({
            "nodeId": node_id,
            "direction": direction,
            "family": address.version,
            "destination": destination,
            "targetIp": str(address),
            "protocol": protocol,
            **({"port": port} if port is not None else {}),
        })
    return source, provider, traces


def clean_geo(value):
    if isinstance(value, str):
        return value.strip()[:LABEL_LIMIT]
    return ""


def trace_hop(ttl, attempts):
    hop = {"ttl": ttl}
    for attempt in attempts or []:
        if not isinstance(attempt, dict) or attempt.get("Success") is not True:
            continue
        address = attempt.get("Address")
        ip = ip_literal(address.get("IP") if isinstance(address, dict) else address)
        if ip is None:
            continue
        hop["ip"] = str(ip)

        # The CLI's JSON uses Go time.Duration, which is encoded in nanoseconds.
        rtt = attempt.get("RTT")
        if type(rtt) in (int, float) and 0 <= rtt < 60 * 10**9:
            hop["rttMs"] = round(rtt / 10**6, 3)

        geo = attempt.get("Geo")
        if isinstance(geo, dict):
            asn = clean_geo(geo.get("asnumber")).upper().removeprefix("AS")
            if re.fullmatch(r"[1-9][0-9]{0,9}", asn):
                hop["asn"] = f"AS{asn}"
            network = clean_geo(geo.get("isp")) or clean_geo(geo.get("owner"))
            if network:
                hop["network"] = network
            parts = [clean_geo(geo.get(key)) for key in ("country", "prov", "city")]
            location = " · ".join(dict.fromkeys(part for part in parts if part))
            if location:
                hop["location"] = location[:LABEL_LIMIT]
        break
    return hop


def measure(executable, provider, trace):
    args = [
        executable, "--json", "--map", "--no-rdns", "--data-provider", provider,
        f"-{trace['family']}", "--max-hops", str(MAX_HOPS), "--queries", "1", "--timeout", "1500",
    ]
    if trace["protocol"] != "icmp":
        args.extend([f"--{trace['protocol']}", "--port", str(trace["port"])])
    args.append(trace["targetIp"])

    status = "failed"
    hops = []
    try:
        run = subprocess.run(
            args, stdin=subprocess.DEVNULL, capture_output=True, text=True,
            encoding="utf-8", timeout=60, check=True,
            env={key: value for key, value in os.environ.items() if key != PROBE_TOKEN_ENV},
        )
        result = json.loads(run.stdout)
        if not isinstance(result, dict) or not isinstance(result.get("Hops"), list):
            raise ValueError("NextTrace output has no Hops array")
        raw_hops = result["Hops"][:MAX_HOPS]
        if any(attempts is not None and not isinstance(attempts, list) for attempts in raw_hops):
            raise ValueError("NextTrace returned invalid hop rows")
        hops = [trace_hop(ttl, attempts) for ttl, attempts in enumerate(raw_hops, 1)]
        stop = result.get("StopReason")
        reached = stop.get("reason") == "destination_reached" if isinstance(stop, dict) else any(
            hop.get("ip") == trace["targetIp"] for hop in hops
        )
        status = "reached" if reached else "incomplete"
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        # Keep command output out of the snapshot. It can contain local paths or provider diagnostics.
        print(f"{trace['nodeId']} {trace['direction']} IPv{trace['family']}: {type(error).__name__}", file=sys.stderr)

    return {
        **trace,
        "measuredAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "status": status,
        "hops": hops,
    }


def write_snapshot(path, snapshot):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
        temp = Path(file.name)
        try:
            json.dump(snapshot, file, ensure_ascii=False, separators=(",", ":"))
            file.write("\n")
            file.close()
            temp.chmod(0o644)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path, help="JSON file with the local probe's fixed targets")
    parser.add_argument("output", type=Path, help="snapshot JSON to replace")
    parser.add_argument("--nexttrace", default="nexttrace", help="path or command name of NextTrace")
    parser.add_argument("--serve", action="store_true", help="serve snapshots and on-demand traces on loopback")
    parser.add_argument("--origin", help="CFSM theme site's origin for --serve")
    parser.add_argument("--port", type=int, default=8765, help="loopback port for --serve")
    args = parser.parse_args()

    executable = shutil.which(args.nexttrace)
    if not executable:
        parser.error("NextTrace executable not found")
    if args.config.resolve() == args.output.resolve():
        parser.error("config and output must be different files")
    try:
        source, provider, targets = read_config(args.config)
        if args.serve:
            if not args.origin or not 1 <= args.port <= 65535:
                parser.error("--serve requires --origin and a valid port")
            from route_trace_server import serve_probe

            serve_probe(
                source, targets, args.output, args.origin, args.port,
                os.environ.get(PROBE_TOKEN_ENV, ""),
                lambda target: measure(executable, provider, target), write_snapshot,
            )
            return
        traces = [measure(executable, provider, trace) for trace in targets]
        write_snapshot(args.output, {"version": 1, "source": source, "traces": traces})
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
