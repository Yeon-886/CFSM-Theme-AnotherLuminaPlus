import { z } from "zod";
import { withTimeoutSignal } from "@/utils/abort";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

const label = z.string().trim().min(1).max(120);
const hopSchema = z.object({
  ttl: z.number().int().min(1).max(64),
  ip: z.string().ip().optional(),
  rttMs: z.number().finite().nonnegative().optional(),
  asn: z.string().regex(/^AS[1-9]\d{0,9}$/).optional(),
  network: label.optional(),
  location: label.optional(),
});

const traceSchema = z.object({
  nodeId: label,
  direction: z.enum(["forward", "return"]),
  family: z.union([z.literal(4), z.literal(6)]),
  destination: label,
  targetIp: z.string().ip(),
  protocol: z.enum(["icmp", "tcp", "udp"]),
  port: z.number().int().min(1).max(65535).optional(),
  measuredAt: z.string().datetime({ offset: true }),
  status: z.enum(["reached", "incomplete", "failed"]),
  hops: z.array(hopSchema).max(64),
}).refine(
  (trace) => trace.family === (trace.targetIp.includes(":") ? 6 : 4)
    && (trace.port === undefined) === (trace.protocol === "icmp")
    && trace.hops.every((hop, index) => index === 0 || hop.ttl > trace.hops[index - 1].ttl),
  { message: "Invalid route family, port, or hop order" },
);

export const RouteTraceSnapshotSchema = z.object({
  version: z.literal(1),
  source: label,
  traces: z.array(traceSchema).max(32),
});

export type RouteTraceSnapshot = z.output<typeof RouteTraceSnapshotSchema>;
export type RouteTrace = z.output<typeof traceSchema> & { source: string; key: string };

export function getNodeRouteTraces(snapshots: RouteTraceSnapshot[], nodeId: string): RouteTrace[] {
  const routes = new Map<string, RouteTrace>();
  for (const { source, traces } of snapshots) {
    for (const trace of traces) {
      if (trace.nodeId !== nodeId) continue;
      const key = JSON.stringify([
        trace.direction, trace.family, source, trace.targetIp, trace.protocol, trace.port,
      ]);
      const current = routes.get(key);
      if (!current || Date.parse(trace.measuredAt) > Date.parse(current.measuredAt)) {
        routes.set(key, { ...trace, source, key });
      }
    }
  }
  return [...routes.values()];
}

async function readSnapshot(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get("Content-Length")) > MAX_SNAPSHOT_BYTES) {
    throw new Error("Invalid route snapshot size");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let json = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("Route snapshot exceeds 1 MiB");
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode()) as unknown;
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function fetchRouteTraceSnapshot(url: string, upstream?: AbortSignal): Promise<RouteTraceSnapshot> {
  // 快照可能来自独立域名。这里单独发请求，避免带上 CFSM 的 JWT 与验证凭证。
  return withTimeoutSignal(async (signal) => {
    const response = await fetch(url, {
      signal,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-cache",
    });
    if (!response.ok) throw new Error(`Route snapshot HTTP ${response.status}`);
    return RouteTraceSnapshotSchema.parse(await readSnapshot(response));
  }, FETCH_TIMEOUT_MS, upstream);
}
