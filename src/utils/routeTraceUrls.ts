export const MAX_ROUTE_TRACE_URLS = 12;
const MAX_URL_LENGTH = 512;
const PATH_ORIGIN = "https://route-trace.invalid";

/** 快照 URL 会随公开主题配置下发，只接收不带凭证的 HTTPS 地址或站内绝对路径。 */
export function parseRouteTraceUrls(value: unknown): string[] | null {
  if (value == null || value === "") return [];
  if (typeof value !== "string" || value.length > 8192) return null;

  const urls = new Set<string>();
  for (const raw of value.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > MAX_URL_LENGTH || /[\s\\?#]/.test(line)) return null;

    const sameOrigin = line.startsWith("/") && !line.startsWith("//");
    if (!sameOrigin && !line.startsWith("https://")) return null;
    try {
      const url = new URL(line, PATH_ORIGIN);
      if (url.username || url.password) return null;
      if (sameOrigin && (url.origin !== PATH_ORIGIN || url.pathname.startsWith("//"))) {
        return null;
      }
      urls.add(sameOrigin ? url.pathname : url.href);
    } catch {
      return null;
    }
    if (urls.size > MAX_ROUTE_TRACE_URLS) return null;
  }

  return [...urls];
}
