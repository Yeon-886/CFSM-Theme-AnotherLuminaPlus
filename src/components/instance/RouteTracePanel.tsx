import { useId, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Route } from "lucide-react";
import { InstancePanel, InstanceChartLoadingBody } from "@/components/instance/InstancePanel";
import { RangeSelector } from "@/components/instance/RangeSelector";
import { locale, t } from "@/i18n";
import { fetchRouteTraceSnapshot, getNodeRouteTraces, type RouteTrace } from "@/services/routeTraces";

const DAY_MS = 24 * 60 * 60 * 1000;
const IP_FAMILIES = [{ value: 4, label: "IPv4" }, { value: 6, label: "IPv6" }];
const DIRECTIONS = ["forward", "return"] as const;
const STATUS_LABELS = {
  reached: "已到达目标",
  incomplete: "未确认到达目标",
  failed: "本次测量失败",
} as const;

function probeMethod(trace: RouteTrace) {
  const protocol = trace.protocol.toUpperCase();
  return trace.port === undefined ? protocol : `${protocol}/${trace.port}`;
}

function TraceHops({ trace }: { trace: RouteTrace }) {
  const measuredAt = new Date(trace.measuredAt);
  return (
    <div className="surface-inset min-w-0 p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
        <strong className="min-w-0 wrap-break-word text-(--text-primary)">
          {trace.source} → {trace.destination}
        </strong>
        <code className="break-all text-(--text-secondary)">{trace.targetIp}</code>
        <span className="text-(--text-secondary)">{probeMethod(trace)}</span>
      </div>
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-(--text-secondary)">
        <time dateTime={trace.measuredAt} title={trace.measuredAt}>
          {t("测量时间")} {measuredAt.toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })}
        </time>
        <span>{t(STATUS_LABELS[trace.status])}</span>
        {Date.now() - measuredAt.getTime() > DAY_MS && <span>{t("记录已超过 24 小时")}</span>}
      </p>
      {trace.hops.length > 0 && (
        <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label={t("逐跳路由")}>
          <table className="w-full min-w-[420px] text-left text-[12px]">
            <thead className="text-(--text-secondary)">
              <tr>
                <th scope="col" className="py-2 pr-3">{t("跳数")}</th>
                <th scope="col" className="py-2 pr-3">IP</th>
                <th scope="col" className="py-2 pr-3">{t("ASN / 运营商")}</th>
                <th scope="col" className="py-2 pr-3">{t("地区")}</th>
                <th scope="col" className="whitespace-nowrap py-2 text-right">RTT</th>
              </tr>
            </thead>
            <tbody className="text-(--text-primary)">
              {trace.hops.map((hop) => (
                <tr key={hop.ttl} className="border-t border-(--border)">
                  <td className="py-2 pr-3 tabular-nums">{hop.ttl}</td>
                  <td className="py-2 pr-3">
                    {hop.ip ? <code>{hop.ip}</code> : <span className="text-(--text-secondary)">{t("未应答")}</span>}
                  </td>
                  <td className="py-2 pr-3">{[hop.asn, hop.network].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="py-2 pr-3">{hop.location || "—"}</td>
                  <td className="whitespace-nowrap py-2 text-right tabular-nums">
                    {hop.rttMs === undefined ? "—" : `${hop.rttMs.toFixed(1)} ms`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RouteTraceResults({ nodeId, urls }: { nodeId: string; urls: string[] }) {
  const [pickedDirection, setDirection] = useState<RouteTrace["direction"] | null>(null);
  const [pickedFamily, setFamily] = useState<number | null>(null);
  const [pickedTrace, setTrace] = useState("");
  const feeds = useQueries({
    queries: urls.map((url) => ({
      queryKey: ["route-trace-snapshot", url],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchRouteTraceSnapshot(url, signal),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      networkMode: "always" as const,
      retry: false,
    })),
  });
  const snapshots = feeds.flatMap((feed) => feed.data ? [feed.data] : []);
  const traces = getNodeRouteTraces(snapshots, nodeId);
  const hasPending = feeds.some((feed) => feed.isPending);
  const isFetching = feeds.some((feed) => feed.isFetching);
  const hasError = feeds.some((feed) => feed.isError);
  const direction = pickedDirection ?? (traces.some((trace) => trace.direction === "forward")
    ? "forward"
    : traces[0]?.direction ?? "forward");
  const directionTraces = traces.filter((trace) => trace.direction === direction);
  const family = pickedFamily ?? (directionTraces.some((trace) => trace.family === 4)
    ? 4
    : directionTraces[0]?.family ?? 4);
  const options = directionTraces.filter((trace) => trace.family === family);
  const selected = options.find((trace) => trace.key === pickedTrace) ?? options[0];

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="instance-segmented" role="group" aria-label={t("路由方向")}>
          {DIRECTIONS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={direction === value}
              data-active={direction === value}
              onClick={() => { setDirection(value); setFamily(null); }}
            >
              {value === "forward" ? t("去程") : t("回程")}
            </button>
          ))}
        </div>
        <RangeSelector label={t("IP 协议")} ranges={IP_FAMILIES} value={family} onChange={setFamily} />
        <button
          type="button"
          className="instance-toggle-button ml-auto"
          disabled={isFetching}
          onClick={() => { for (const feed of feeds) void feed.refetch(); }}
        >
          {isFetching ? t("加载中…") : t("刷新结果")}
        </button>
      </div>

      {hasError && (
        <p role="status" className="text-[13px] text-(--text-secondary)">
          {snapshots.length === 0 ? t("无法加载路由快照，请检查数据源。") : t("部分路由数据源加载失败。")}
        </p>
      )}
      {hasPending && !selected && <InstanceChartLoadingBody />}
      {!hasPending && !selected && snapshots.length > 0 && (
        <p role="status" className="py-3 text-[13px] text-(--text-secondary)">
          {t("此节点暂无所选方向和协议的路由记录。")}
        </p>
      )}
      {selected && (
        <>
          {options.length > 1 && (
            <label className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-(--text-secondary)">
              {t("测量线路")}
              <select
                value={selected.key}
                onChange={(event) => setTrace(event.target.value)}
                className="surface-inset min-w-0 max-w-full rounded-lg px-2 py-1 text-(--text-primary)"
              >
                {options.map((trace) => (
                  <option key={trace.key} value={trace.key}>
                    {trace.source} → {trace.destination} · {trace.targetIp} · {probeMethod(trace)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <TraceHops trace={selected} />
        </>
      )}
    </div>
  );
}

export function RouteTracePanel({ nodeId, urls }: { nodeId: string; urls: string[] }) {
  const [open, setOpen] = useState(false);
  const resultsId = useId();
  return (
    <InstancePanel
      title={t("线路路由")}
      titleIcon={<Route size={16} aria-hidden="true" />}
      description={t("查看国内测量节点与服务器之间的逐跳路径。")}
      aside={(
        <button
          type="button"
          className="instance-toggle-button"
          aria-expanded={open}
          aria-controls={resultsId}
          onClick={() => setOpen(!open)}
        >
          {open ? t("收起路由") : t("查看路由")}
        </button>
      )}
    >
      <div id={resultsId} hidden={!open}>
        {open && <RouteTraceResults nodeId={nodeId} urls={urls} />}
      </div>
    </InstancePanel>
  );
}
