import { z } from "zod";
import { withTimeoutSignal } from "@/utils/abort";
import { routeTraceMeasurementUrl } from "@/services/routeTraces";

const SERVICE_TIMEOUT_MS = 20_000;
export const SERVICE_CHECK_TOKEN_FORMAT = /^[A-Za-z0-9._~-]{32,128}$/;
export const SERVICE_CATEGORIES = ["ai", "streaming", "social", "ipReputation"] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

const resultSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url().max(512),
  status: z.enum(["reachable", "blocked", "timeout", "error"]),
  httpStatus: z.number().int().min(100).max(599).optional(),
  latencyMs: z.number().finite().nonnegative().optional(),
  detail: z.string().max(200),
});

const reputationSchema = z.object({
  status: z.enum(["ok", "error"]),
  ip: z.string().ip().optional(),
  risk: z.object({
    score: z.number().finite().optional().nullable(),
    vpn: z.boolean().optional().nullable(),
    proxy: z.boolean().optional().nullable(),
    tor: z.boolean().optional().nullable(),
    datacenter: z.boolean().optional().nullable(),
    abuser: z.boolean().optional().nullable(),
  }).optional(),
  location: z.object({ country: z.string().max(120), city: z.string().max(120) }).optional(),
  isp: z.string().max(200).optional(),
  detail: z.string().max(200).optional(),
});

const categoryResultSchema = z.object({
  checkedAt: z.string().datetime({ offset: true }),
  egressIp: z.string().ip().optional(),
  results: z.array(resultSchema).max(20).optional(),
  reputation: reputationSchema.optional(),
});

export const ServiceSnapshotSchema = z.object({
  version: z.literal(1),
  source: z.string().trim().min(1).max(120),
  nodeIds: z.array(z.string().trim().min(1).max(120)).max(32),
  categories: z.array(z.enum(SERVICE_CATEGORIES)).max(4),
  results: z.record(z.enum(SERVICE_CATEGORIES), categoryResultSchema).default({}),
});

export type ServiceSnapshot = z.output<typeof ServiceSnapshotSchema>;
export type ServiceProbe = { snapshotUrl: string; category: ServiceCategory };
export class ServiceCheckError extends Error {
  constructor(readonly status: number) {
    super(`Service check HTTP ${status}`);
  }
}

function serviceUrl(snapshotUrl: string, pathname: string): URL | undefined {
  const sibling = routeTraceMeasurementUrl(snapshotUrl);
  if (!sibling) return undefined;
  return new URL(pathname, sibling);
}

export function serviceSnapshotUrl(snapshotUrl: string): URL | undefined {
  return serviceUrl(snapshotUrl, "service-snapshot.json");
}

function serviceCheckUrl(snapshotUrl: string): URL | undefined {
  return serviceUrl(snapshotUrl, "service-check");
}

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

export async function fetchServiceSnapshot(url: string, upstream?: AbortSignal): Promise<ServiceSnapshot> {
  if (!serviceSnapshotUrl(url)) throw new Error("Invalid service snapshot URL");
  return withTimeoutSignal(async (signal) => {
    const response = await fetch(serviceSnapshotUrl(url)!, {
      signal,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-cache",
    });
    if (!response.ok) throw new Error(`Service snapshot HTTP ${response.status}`);
    return ServiceSnapshotSchema.parse(await readJson(response));
  }, SERVICE_TIMEOUT_MS, upstream);
}

export function getNodeServiceOptions(
  feeds: { snapshotUrl: string; snapshot: ServiceSnapshot }[],
  nodeId: string,
) {
  return feeds
    .filter(({ snapshotUrl, snapshot }) => Boolean(serviceSnapshotUrl(snapshotUrl)) && snapshot.nodeIds.includes(nodeId))
    .map(({ snapshotUrl, snapshot }) => ({
      snapshotUrl,
      source: snapshot.source,
      categories: snapshot.categories,
      results: snapshot.results,
    }));
}

export async function runServiceCheck(probe: ServiceProbe, token: string): Promise<ServiceSnapshot> {
  const endpoint = serviceCheckUrl(probe.snapshotUrl);
  if (!endpoint || !SERVICE_CHECK_TOKEN_FORMAT.test(token)) throw new Error("Invalid service probe or token");
  return withTimeoutSignal(async (signal) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ category: probe.category }),
      signal,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
    });
    if (!response.ok) throw new ServiceCheckError(response.status);
    return ServiceSnapshotSchema.parse(await readJson(response));
  }, SERVICE_TIMEOUT_MS);
}
