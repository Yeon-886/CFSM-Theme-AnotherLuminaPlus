"""Local HTTP adapter for running NextTrace against configured targets."""

from hashlib import sha256
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import threading
import time
from urllib.parse import urlsplit

TOKEN_FORMAT = re.compile(r"[A-Za-z0-9._~-]{32,128}")
SNAPSHOT_PATH = "/snapshot.json"
MEASURE_PATH = "/measure"
COOLDOWN_SECONDS = 10
MAX_REQUEST_THREADS = 8


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
        if self.path != SNAPSHOT_PATH:
            self.send_json(404, {"error": "not_found"})
        elif not self.allowed_origin():
            self.send_json(403, {"error": "origin_not_allowed"})
        else:
            self.send_json(200, self.server.probe.snapshot())

    def do_OPTIONS(self):
        if self.path not in (SNAPSHOT_PATH, MEASURE_PATH):
            self.send_json(404, {"error": "not_found"})
        elif not self.allowed_origin():
            self.send_json(403, {"error": "origin_not_allowed"})
        else:
            self.send_json(204)

    def do_POST(self):
        if self.path != MEASURE_PATH:
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
    with ProbeHTTPServer(("127.0.0.1", port), ProbeHandler) as server:
        server.web_origin = origin
        server.probe = probe
        server.token = token
        print(f"Route probe listening on http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
