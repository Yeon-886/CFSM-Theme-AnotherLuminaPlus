import { z } from "zod";
import { withTimeoutSignal } from "@/utils/abort";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const MEASUREMENT_TIMEOUT_MS = 75_000;
const TARGET_ID = /^[a-f0-9]{32}$/;
export const ROUTE_TRACE_TOKEN_FORMAT = /^[A-Za-z0-9._~-]{32,128}$/;

const label = z.string().trim().min(1).max(120);
const hopSchema = z.object({
  ttl: z.number().int().min(1).max(64),
  ip: z.string().ip().optional(),
  rttMs: z.number().finite().nonnegative().optional(),
  asn: z.string().regex(/^AS[1-9]\d{0,9}$/).optional(),
  network: label.optional(),
  location: label.optional(),
});

const targetFields = z.object({
  nodeId: label,
  direction: z.enum(["forward", "return"]),
  family: z.union([z.literal(4), z.literal(6)]),
  destination: label,
  targetIp: z.string().ip(),
  protocol: z.enum(["icmp", "tcp", "udp"]),
  port: z.number().int().min(1).max(65535).optional(),
});

type RouteTraceTarget = z.output<typeof targetFields>;

function hasValidTarget(target: RouteTraceTarget) {
  return target.family === (target.targetIp.includes(":") ? 6 : 4)
    && (target.port === undefined) === (target.protocol === "icmp");
}

const probeTargetSchema = targetFields
  .extend({ id: z.string().regex(TARGET_ID) })
  .refine(hasValidTarget, { message: "Invalid route family or port" });

const traceSchema = targetFields.extend({
  measuredAt: z.string().datetime({ offset: true }),
  status: z.enum(["reached", "incomplete", "failed"]),
  hops: z.array(hopSchema).max(64),
}).refine(
  (trace) => hasValidTarget(trace)
    && trace.hops.every((hop, index) => index === 0 || hop.ttl > trace.hops[index - 1].ttl),
  { message: "Invalid route family, port, or hop order" },
);

export const RouteTraceSnapshotSchema = z.object({
  version: z.literal(1),
  source: label,
  traces: z.array(traceSchema).max(32),
  probeTargets: z.array(probeTargetSchema).max(32).optional(),
});

export type RouteTraceSnapshot = z.output<typeof RouteTraceSnapshotSchema>;
export type RouteTrace = z.output<typeof traceSchema> & { source: string; key: string };

export type RouteTraceProbe = { snapshotUrl: string; targetId: string };
export type RouteTraceOption = RouteTraceTarget & {
  key: string;
  source: string;
  trace?: RouteTrace;
  probe?: RouteTraceProbe;
};

function routeKey(source: string, trace: RouteTraceTarget) {
  return JSON.stringify([trace.direction, trace.family, source, trace.targetIp, trace.protocol, trace.port]);
}

export function getNodeRouteTraces(snapshots: RouteTraceSnapshot[], nodeId: string): RouteTrace[] {
  const routes = new Map<string, RouteTrace>();
  for (const { source, traces } of snapshots) {
    for (const trace of traces) {
      if (trace.nodeId !== nodeId) continue;
      const key = routeKey(source, trace);
      const current = routes.get(key);
      if (!current || Date.parse(trace.measuredAt) > Date.parse(current.measuredAt)) {
        routes.set(key, { ...trace, source, key });
      }
    }
  }
  return [...routes.values()];
}

export function routeTraceMeasurementUrl(snapshotUrl: string): URL | undefined {
  let snapshot: URL;
  try {
    snapshot = new URL(snapshotUrl, typeof window === "undefined" ? undefined : window.location.href);
  } catch {
    return undefined;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(snapshot.hostname);
  if (
    !(snapshot.protocol === "https:" || (snapshot.protocol === "http:" && loopback))
    || snapshot.username || snapshot.password || snapshot.search || snapshot.hash
    || !snapshot.pathname.endsWith("/snapshot.json")
  ) {
    return undefined;
  }
  // Use the configured snapshot's sibling endpoint, never a URL supplied by a payload.
  return new URL("measure", snapshot);
}

export function getNodeRouteOptions(
  feeds: { snapshotUrl: string; snapshot: RouteTraceSnapshot }[],
  nodeId: string,
): RouteTraceOption[] {
  const traces = getNodeRouteTraces(feeds.map((feed) => feed.snapshot), nodeId);
  const options = new Map<string, RouteTraceOption>(traces.map((trace) => [trace.key, { ...trace, trace }]));
  for (const { snapshotUrl, snapshot } of feeds) {
    if (!snapshot.probeTargets?.length || !routeTraceMeasurementUrl(snapshotUrl)) continue;
    for (const { id, ...target } of snapshot.probeTargets) {
      if (target.nodeId !== nodeId) continue;
      const key = routeKey(snapshot.source, target);
      const existing = options.get(key);
      if (!existing?.probe) {
        options.set(key, {
          ...target, key, source: snapshot.source, trace: existing?.trace,
          probe: { snapshotUrl, targetId: id },
        });
      }
    }
  }
  return [...options.values()];
}

export class RouteTraceMeasurementError extends Error {
  constructor(readonly status: number) {
    super(`Route measurement HTTP ${status}`);
  }
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

export async function measureRouteTrace(probe: RouteTraceProbe, token: string): Promise<RouteTraceSnapshot> {
  const endpoint = routeTraceMeasurementUrl(probe.snapshotUrl);
  if (!endpoint || !TARGET_ID.test(probe.targetId) || !ROUTE_TRACE_TOKEN_FORMAT.test(token)) {
    throw new Error("Invalid route probe or token");
  }
  return withTimeoutSignal(async (signal) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: probe.targetId }),
      signal,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    if (!response.ok) throw new RouteTraceMeasurementError(response.status);
    const snapshot = RouteTraceSnapshotSchema.parse(await readSnapshot(response));
    const target = snapshot.probeTargets?.find((entry) => entry.id === probe.targetId);
    const hasResult = target && snapshot.traces.some((trace) =>
      trace.nodeId === target.nodeId && routeKey(snapshot.source, trace) === routeKey(snapshot.source, target),
    );
    if (!hasResult) throw new Error("The probe returned no result for the selected target");
    return snapshot;
  }, MEASUREMENT_TIMEOUT_MS);
}
