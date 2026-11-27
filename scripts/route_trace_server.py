"""Local HTTP adapter for running NextTrace against configured targets."""

from hashlib import sha256
import hmac
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
import ipaddress
import json
import re
import threading
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener
from urllib.parse import urlsplit

TOKEN_FORMAT = re.compile(r"[A-Za-z0-9._~-]{32,128}")
SNAPSHOT_PATH = "/snapshot.json"
MEASURE_PATH = "/measure"
SERVICE_SNAPSHOT_PATH = "/service-snapshot.json"
SERVICE_CHECK_PATH = "/service-check"
COOLDOWN_SECONDS = 10
MAX_REQUEST_THREADS = 8

SERVICE_CHECKS = {
    "ai": [
        ("OpenAI", "https://chatgpt.com/"),
        ("Claude", "https://claude.ai/"),
        ("Gemini", "https://gemini.google.com/"),
    ],
    "streaming": [
        ("Netflix", "https://www.netflix.com/title/80057281"),
        ("YouTube", "https://www.youtube.com/generate_204"),
        ("Disney+", "https://www.disneyplus.com/"),
    ],
    "social": [
        ("X", "https://x.com/"),
        ("Facebook", "https://www.facebook.com/"),
        ("Instagram", "https://www.instagram.com/"),
        ("TikTok", "https://www.tiktok.com/"),
    ],
}
SERVICE_CATEGORIES = tuple((*SERVICE_CHECKS, "ipReputation"))
SERVICE_HTTP_TIMEOUT = 10


class NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


NO_REDIRECT_OPENER = build_opener(NoRedirectHandler)


def target_id(target):
    fields = ("nodeId", "direction", "family", "destination", "targetIp", "protocol", "port")
    identity = json.dumps([target.get(field) for field in fields], ensure_ascii=False, separators=(",", ":"))
    return sha256(identity.encode("utf-8")).hexdigest()[:32]


def load_previous(path, source, targets):
    try:
        snapshot = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(snapshot, dict) or snapshot.get("version") != 1 or snapshot.get("source") != source:
        return {}
    traces = snapshot.get("traces")
    if not isinstance(traces, list):
        return {}
    return {
        target_id(trace): trace
        for trace in traces
        if isinstance(trace, dict) and target_id(trace) in targets
    }


class RouteProbe:
    def __init__(self, source, targets, output, measure, save):
        self.source = source
        self.targets = {target_id(target): target for target in targets}
        self.results = load_previous(output, source, self.targets)
        self.output = output
        self.measure = measure
        self.save = save
        self.lock = threading.Lock()
        self.next_allowed = 0

    def snapshot(self, results=None):
        if results is None:
            results = self.results
        return {
            "version": 1,
            "source": self.source,
            "traces": list(results.values()),
            "probeTargets": [{"id": key, **target} for key, target in self.targets.items()],
        }

    def run(self, key):
        if key not in self.targets:
            return 404, {"error": "unknown_target"}
        if not self.lock.acquire(blocking=False):
            return 409, {"error": "probe_busy"}
        try:
            if time.monotonic() < self.next_allowed:
                return 429, {"error": "probe_cooldown"}
            result = self.measure(self.targets[key])
            self.next_allowed = time.monotonic() + COOLDOWN_SECONDS
            results = {**self.results, key: result}
            snapshot = self.snapshot(results)
            try:
                self.save(self.output, snapshot)
            except OSError:
                return 503, {"error": "snapshot_write_failed"}
            self.results = results
            return 200, snapshot
        finally:
            self.lock.release()


def _safe_text(value, limit=200):
    return value.strip()[:limit] if isinstance(value, str) else ""


def _classify_http_status(status):
    if 200 <= status < 400:
        return "reachable"
    if status in (401, 403, 407, 451, 470, 472):
        return "blocked"
    return "error"


def _check_service_url(name, url):
    started = time.monotonic()
    request = Request(url, headers={
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.1",
        "User-Agent": "CFSM-Service-Check/1.0",
    })
    try:
        with NO_REDIRECT_OPENER.open(request, timeout=SERVICE_HTTP_TIMEOUT) as response:
            status = response.status
        category = _classify_http_status(status)
        detail = "收到正常网页响应" if category == "reachable" else f"HTTP {status}"
        if 300 <= status < 400:
            detail = "该站点要求继续跳转，未把它视为完全可用"
        return {
            "name": name, "url": url, "status": category, "httpStatus": status,
            "latencyMs": round((time.monotonic() - started) * 1000), "detail": detail,
        }
    except HTTPError as error:
        category = _classify_http_status(error.code)
        return {
            "name": name, "url": url, "status": category, "httpStatus": error.code,
            "latencyMs": round((time.monotonic() - started) * 1000), "detail": f"HTTP {error.code}",
        }
    except (TimeoutError, URLError, OSError) as error:
        reason = getattr(error, "reason", error)
        timeout = isinstance(reason, TimeoutError) or "timed out" in str(reason).lower()
        return {
            "name": name, "url": url, "status": "timeout" if timeout else "error",
            "latencyMs": round((time.monotonic() - started) * 1000),
            "detail": "连接超时" if timeout else "无法建立连接",
        }


def _egress_ip():
    request = Request("https://api.ipify.org?format=json", headers={"User-Agent": "CFSM-Service-Check/1.0"})
    try:
        with NO_REDIRECT_OPENER.open(request, timeout=SERVICE_HTTP_TIMEOUT) as response:
            value = json.loads(response.read(4096)).get("ip")
        return str(ipaddress.ip_address(value))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return ""


def _ip_reputation(ip):
    if not ip:
        return {"status": "error", "detail": "无法识别探测机公网 IP"}
    url = f"https://api.ipquery.io/{quote(ip, safe='')}"
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "CFSM-Service-Check/1.0"})
    try:
        with NO_REDIRECT_OPENER.open(request, timeout=SERVICE_HTTP_TIMEOUT) as response:
            data = json.loads(response.read(32_768))
        risk = data.get("risk") if isinstance(data, dict) else {}
        location = data.get("location") if isinstance(data, dict) else {}
        isp = data.get("isp") if isinstance(data, dict) else {}
        return {
            "status": "ok", "ip": ip,
            "risk": {
                "score": risk.get("risk_score") if isinstance(risk, dict) else None,
                "vpn": risk.get("is_vpn") if isinstance(risk, dict) else None,
                "proxy": risk.get("is_proxy") if isinstance(risk, dict) else None,
                "tor": risk.get("is_tor") if isinstance(risk, dict) else None,
                "datacenter": risk.get("is_datacenter") if isinstance(risk, dict) else None,
                "abuser": risk.get("is_abuser") if isinstance(risk, dict) else None,
            },
            "location": {
                "country": _safe_text(location.get("country")) if isinstance(location, dict) else "",
                "city": _safe_text(location.get("city")) if isinstance(location, dict) else "",
            },
            "isp": _safe_text(isp.get("isp") if isinstance(isp, dict) else isp),
        }
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
        return {"status": "error", "ip": ip, "detail": _safe_text(str(error)) or "IPQuery 查询失败"}


class ServiceProbe:
    def __init__(self, source, node_ids, output):
        self.source = source
        self.node_ids = sorted(set(node_ids))
        self.output = output.with_name("service.json")
        self.lock = threading.Lock()
        self.next_allowed = 0
        self.latest = self._load()

    def _load(self):
        try:
            value = json.loads(self.output.read_text(encoding="utf-8"))
            if isinstance(value, dict) and value.get("version") == 1 and value.get("source") == self.source:
                return value
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
        return {"version": 1, "source": self.source, "nodeIds": self.node_ids, "categories": list(SERVICE_CATEGORIES), "results": {}}

    def snapshot(self):
        return {**self.latest, "nodeIds": self.node_ids, "categories": list(SERVICE_CATEGORIES)}

    def run(self, category):
        if category not in SERVICE_CATEGORIES and category != "all":
            return 400, {"error": "unknown_service_category"}
        if not self.lock.acquire(blocking=False):
            return 409, {"error": "service_check_busy"}
        try:
            if time.monotonic() < self.next_allowed:
                return 429, {"error": "service_check_cooldown"}
            egress = _egress_ip()
            now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
            categories = list(SERVICE_CHECKS) if category == "all" else [category]
            results = dict(self.latest.get("results") or {})
            for current in categories:
                if current == "ipReputation":
                    results[current] = {"checkedAt": now, "egressIp": egress, "reputation": _ip_reputation(egress)}
                else:
                    results[current] = {
                        "checkedAt": now, "egressIp": egress,
                        "results": [_check_service_url(name, url) for name, url in SERVICE_CHECKS[current]],
                    }
            self.next_allowed = time.monotonic() + COOLDOWN_SECONDS
            snapshot = {"version": 1, "source": self.source, "nodeIds": self.node_ids, "categories": list(SERVICE_CATEGORIES), "results": results}
            try:
                write_json_atomic(self.output, snapshot)
            except OSError:
                return 503, {"error": "service_snapshot_write_failed"}
            self.latest = snapshot
            return 200, snapshot
        finally:
            self.lock.release()


def write_json_atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
        temp = Path(file.name)
        try:
            json.dump(value, file, ensure_ascii=False, separators=(",", ":"))
            file.write("\n")
            file.close()
            temp.chmod(0o644)
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


class ProbeHandler(BaseHTTPRequestHandler):
    timeout = 5

    def send_json(self, status, data=None):
        payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8") if data is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Vary", "Origin")
        if self.headers.get("Origin") == self.server.web_origin:
            self.send_header("Access-Control-Allow-Origin", self.server.web_origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload:
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

    def allowed_origin(self):
        origin = self.headers.get("Origin")
        return origin is None or origin == self.server.web_origin

    def do_GET(self):
        if self.path == SERVICE_SNAPSHOT_PATH:
            if not self.allowed_origin():
                self.send_json(403, {"error": "origin_not_allowed"})
            else:
                self.send_json(200, self.server.services.snapshot())
        elif self.path != SNAPSHOT_PATH:
            self.send_json(404, {"error": "not_found"})
        elif not self.allowed_origin():
            self.send_json(403, {"error": "origin_not_allowed"})
        else:
            self.send_json(200, self.server.probe.snapshot())

    def do_OPTIONS(self):
        if self.path not in (SNAPSHOT_PATH, MEASURE_PATH, SERVICE_SNAPSHOT_PATH, SERVICE_CHECK_PATH):
            self.send_json(404, {"error": "not_found"})
        elif not self.allowed_origin():
            self.send_json(403, {"error": "origin_not_allowed"})
        else:
            self.send_json(204)

    def do_POST(self):
        if self.path not in (MEASURE_PATH, SERVICE_CHECK_PATH):
            self.send_json(404, {"error": "not_found"})
            return
        if not self.allowed_origin():
            self.send_json(403, {"error": "origin_not_allowed"})
            return
        authorization = self.headers.get("Authorization", "")
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not TOKEN_FORMAT.fullmatch(token) or not hmac.compare_digest(token, self.server.token):
            self.send_json(401, {"error": "invalid_probe_token"})
            return
        if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
            self.send_json(415, {"error": "expected_json"})
            return
        content_length = self.headers.get_all("Content-Length", [])
        if len(content_length) != 1 or not re.fullmatch(r"[0-9]{1,3}", content_length[0]):
            self.send_json(400, {"error": "invalid_length"})
            return
        length = int(content_length[0])
        if not 0 < length <= 128:
            self.send_json(413, {"error": "invalid_length"})
            return
        try:
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError("incomplete request")
            request = json.loads(body)
        except (OSError, ValueError):
            self.send_json(400, {"error": "invalid_json"})
            return
        if self.path == SERVICE_CHECK_PATH:
            if not isinstance(request, dict) or set(request) != {"category"} or not isinstance(request["category"], str):
                self.send_json(400, {"error": "expected_service_category"})
                return
            status, data = self.server.services.run(request["category"])
        else:
            if not isinstance(request, dict) or set(request) != {"id"} or not isinstance(request["id"], str):
                self.send_json(400, {"error": "expected_target_id"})
                return
            status, data = self.server.probe.run(request["id"])
        self.send_json(status, data)


class ProbeHTTPServer(ThreadingHTTPServer):
    request_queue_size = 32

    def __init__(self, address, handler):
        self.slots = threading.BoundedSemaphore(MAX_REQUEST_THREADS)
        super().__init__(address, handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


def parse_origin(value):
    origin = value.rstrip("/")
    parts = urlsplit(origin)
    if (
        not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.path
        or parts.port == 0
        or "?" in origin
        or "#" in origin
        or parts.scheme not in ("http", "https")
        or (parts.scheme == "http" and parts.hostname not in ("localhost", "127.0.0.1", "::1"))
        or any(char.isspace() for char in origin)
    ):
        raise ValueError("--origin must be the HTTPS origin of the CFSM site (HTTP is allowed for loopback testing)")
    return origin


def serve_probe(source, targets, output, origin, port, token, measure, save):
    if not TOKEN_FORMAT.fullmatch(token):
        raise ValueError("Set ROUTE_TRACE_TOKEN to a dedicated 32–128 character token")
    origin = parse_origin(origin)
    probe = RouteProbe(source, targets, output, measure, save)
    services = ServiceProbe(source, [target["nodeId"] for target in targets], output)
    with ProbeHTTPServer(("127.0.0.1", port), ProbeHandler) as server:
        server.web_origin = origin
        server.probe = probe
        server.services = services
        server.token = token
        print(f"Route probe listening on http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
