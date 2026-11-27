import { z } from "zod";
import { withTimeoutSignal } from "@/utils/abort";

const MEASUREMENTS_URL = "https://api.globalping.io/v1/measurements";
const POLL_INTERVAL_MS = 1_000;
const TIMEOUT_MS = 45_000;

export const GLOBALPING_WEB_TRACEROUTE = "https://globalping.io/network-tools/traceroute-from-china";

export const ONLINE_TRACE_SOURCES = [
  { id: "china", label: "中国大陆（任意）", asn: undefined },
  { id: "telecom", label: "电信 AS4134", asn: 4134 },
  { id: "unicom", label: "联通 AS4837", asn: 4837 },
  { id: "mobile", label: "移动 AS9808", asn: 9808 },
] as const;

export type OnlineTraceSource = (typeof ONLINE_TRACE_SOURCES)[number]["id"];
export type OnlineTraceProtocol = "ICMP" | "TCP";

const ipLiteral = z.string().ip();
const measurementId = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) });
const onlineMeasurement = z.object({
  status: z.string(),
  results: z.array(z.object({
    probe: z.object({
      country: z.string().length(2),
      city: z.string().max(200),
      asn: z.number().int().nonnegative(),
      network: z.string().max(200),
    }),
    result: z.object({
      status: z.string(),
      rawOutput: z.string().max(60_000),
    }),
  })).max(3),
});

export type OnlineMeasurement = z.output<typeof onlineMeasurement>;

export function publicTraceIp(input: string): string | undefined {
  const target = input.trim();
  if (target.length > 45 || target.includes("%") || !ipLiteral.safeParse(target).success) return undefined;

  if (target.includes(":")) {
    const canonical = new URL(`https://[${target}]/`).hostname.slice(1, -1);
    if (!/^[23][0-9a-f]{3}:/.test(canonical) || /^(2001:db8:|3fff:)/.test(canonical)) {
      return undefined;
    }
    return canonical;
  }

  const [a, b, c] = target.split(".").map(Number);
  const nonPublic = a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113);
  return nonPublic ? undefined : target;
}

export class GlobalpingTraceError extends Error {
  constructor(readonly status: number, readonly reason?: string) {
    super(`Globalping HTTP ${status}`);
  }
}

async function requestJson(url: string, signal: AbortSignal, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal,
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const details = z.object({ error: z.object({ type: z.string() }) }).safeParse(body);
    throw new GlobalpingTraceError(response.status, details.success ? details.data.error.type : undefined);
  }
  return response.json() as Promise<unknown>;
}

function waitForNextPoll(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, POLL_INTERVAL_MS);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runOnlineTrace(
  input: { target: string; source: OnlineTraceSource; protocol: OnlineTraceProtocol },
  onUpdate: (measurement: OnlineMeasurement) => void,
  upstream?: AbortSignal,
) {
  const target = publicTraceIp(input.target);
  const source = ONLINE_TRACE_SOURCES.find(({ id }) => id === input.source);
  if (!target || !source || (input.protocol !== "ICMP" && input.protocol !== "TCP")) {
    throw new Error("Invalid online traceroute parameters");
  }
  await withTimeoutSignal(async (signal) => {
    const { id } = measurementId.parse(await requestJson(MEASUREMENTS_URL, signal, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "traceroute",
        target,
        limit: source.asn === undefined ? 3 : 1,
        locations: [{ country: "CN", ...(source.asn === undefined ? {} : { asn: source.asn }) }],
        measurementOptions: input.protocol === "TCP" ? { protocol: "TCP", port: 443 } : { protocol: "ICMP" },
        inProgressUpdates: true,
      }),
    }));
    const url = `${MEASUREMENTS_URL}/${id}`;
    for (;;) {
      await waitForNextPoll(signal);
      const measurement = onlineMeasurement.parse(await requestJson(url, signal, { cache: "no-cache" }));
      onUpdate(measurement);
      if (measurement.status !== "in-progress") return;
    }
  }, TIMEOUT_MS, upstream);
}
