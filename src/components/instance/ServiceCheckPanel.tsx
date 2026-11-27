import { useId, useState } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { InstancePanel, InstanceChartLoadingBody } from "@/components/instance/InstancePanel";
import { locale, t } from "@/i18n";
import {
  SERVICE_CATEGORIES,
  SERVICE_CHECK_TOKEN_FORMAT,
  ServiceCheckError,
  fetchServiceSnapshot,
  getNodeServiceOptions,
  runServiceCheck,
  type ServiceCategory,
  type ServiceProbe,
  type ServiceSnapshot,
} from "@/services/serviceChecks";

const CATEGORY_LABELS: Record<ServiceCategory, string> = {
  ai: "AI 服务",
  streaming: "流媒体",
  social: "社交",
  ipReputation: "IP 信誉",
};

function statusLabel(status: string) {
  if (status === "reachable") return t("可访问");
  if (status === "blocked") return t("被拦截");
  if (status === "timeout") return t("超时");
  return t("检测失败");
}

function CheckError({ error }: { error: unknown }) {
  if (error instanceof ServiceCheckError && error.status === 401) return <p role="alert">{t("测量令牌不正确。")}</p>;
  if (error instanceof ServiceCheckError && error.status === 429) return <p role="alert">{t("探测机正在检测或处于冷却期，请稍后再试。")}</p>;
  if (error instanceof Error && error.message && !error.message.startsWith("Service check HTTP")) {
    return <p role="alert">{error.message}</p>;
  }
  return <p role="alert">{t("服务检测失败，请检查探测机服务。")}</p>;
}

function RunServiceCheck({ probe, onResult }: { probe: ServiceProbe; onResult: (snapshot: ServiceSnapshot) => void }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function run() {
    const value = token.trim();
    if (!SERVICE_CHECK_TOKEN_FORMAT.test(value)) {
      setError(new Error(t("请输入探测机的专用测量令牌。")));
      return;
    }
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const snapshot = await runServiceCheck(probe, value);
      onResult(snapshot);
      setToken("");
      setOpen(false);
      setDone(true);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 text-[13px]">
      <button
        type="button"
        className="instance-toggle-button surface-inset"
        disabled={busy}
        onClick={() => { setOpen(!open); setError(null); setDone(false); }}
        aria-expanded={open}
      >
        {busy ? t("正在检测…") : t("立即检测")}
      </button>
      {open && (
        <div className="surface-inset flex w-full flex-wrap items-end gap-2 p-3">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-(--text-secondary)">{t("测量令牌")}</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              maxLength={128}
              className="surface-inset rounded-lg px-2 py-1.5"
              disabled={busy}
            />
          </label>
          <button type="button" className="instance-toggle-button" onClick={() => void run()} disabled={busy}>
            {t("开始检测")}
          </button>
        </div>
      )}
      {error instanceof Error && <CheckError error={error} />}
      {done && <p role="status" className="text-(--text-secondary)">{t("服务检测结果已更新。")}</p>}
    </div>
  );
}

function ServiceResults({ category, result }: { category: ServiceCategory; result: ServiceSnapshot["results"][ServiceCategory] | undefined }) {
  if (!result) return <p className="py-3 text-[13px] text-(--text-secondary)">{t("尚未执行此项检测。")}</p>;
  const checkedAt = new Date(result.checkedAt);
  if (category === "ipReputation") {
    const reputation = result.reputation;
    return (
      <div className="surface-inset flex flex-col gap-2 p-3 text-[13px]">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <strong>{result.egressIp ?? reputation?.ip ?? "—"}</strong>
          <span className="text-(--text-secondary)">{t("检测时间")} {checkedAt.toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })}</span>
        </div>
        {reputation?.status === "ok" ? (
          <div className="grid gap-2 sm:grid-cols-3 text-(--text-secondary)">
            <span>{t("风险分数")} <strong className="text-(--text-primary)">{reputation.risk?.score ?? "—"}</strong></span>
            <span>{t("VPN")} <strong className="text-(--text-primary)">{String(reputation.risk?.vpn ?? "—")}</strong></span>
            <span>{t("代理")} <strong className="text-(--text-primary)">{String(reputation.risk?.proxy ?? "—")}</strong></span>
            <span>{t("Tor")} <strong className="text-(--text-primary)">{String(reputation.risk?.tor ?? "—")}</strong></span>
            <span>{t("数据中心")} <strong className="text-(--text-primary)">{String(reputation.risk?.datacenter ?? "—")}</strong></span>
            <span>{t("滥用标记")} <strong className="text-(--text-primary)">{String(reputation.risk?.abuser ?? "—")}</strong></span>
          </div>
        ) : <p className="text-(--text-secondary)">{reputation?.detail ?? t("IP 信誉接口没有返回结果。")}</p>}
        <p className="text-[11px] text-(--text-tertiary)">{t("信誉结果来自第三方数据库，仅供参考。")}</p>
      </div>
    );
  }
  return (
    <div className="surface-inset overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-[12px]">
        <thead className="text-(--text-secondary)"><tr>
          <th className="px-3 py-2">{t("服务")}</th><th className="px-3 py-2">{t("状态")}</th>
          <th className="px-3 py-2">{t("延迟")}</th><th className="px-3 py-2">{t("说明")}</th>
        </tr></thead>
        <tbody>{(result.results ?? []).map((item) => (
          <tr key={item.name} className="border-t border-(--border)">
            <td className="px-3 py-2 font-medium">{item.name}</td>
            <td className="px-3 py-2">{statusLabel(item.status)}{item.httpStatus ? ` (${item.httpStatus})` : ""}</td>
            <td className="px-3 py-2 tabular-nums">{item.latencyMs == null ? "—" : `${item.latencyMs} ms`}</td>
            <td className="px-3 py-2 text-(--text-secondary)">{item.detail}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export function ServiceCheckPanel({ nodeId, urls, canMeasure }: { nodeId: string; urls: string[]; canMeasure: boolean }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ServiceCategory>("ai");
  const panelId = useId();
  const queryClient = useQueryClient();
  const feeds = useQueries({
    queries: urls.map((url) => ({
      queryKey: ["service-snapshot", url],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchServiceSnapshot(url, signal),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
      enabled: open,
    })),
  });
  const options = getNodeServiceOptions(
    feeds.flatMap((feed, index) => feed.data ? [{ snapshotUrl: urls[index], snapshot: feed.data }] : []),
    nodeId,
  );
  const source = options[0];
  const hasPending = open && feeds.some((feed) => feed.isPending);
  const hasError = open && feeds.some((feed) => feed.isError);
  const probe = source ? { snapshotUrl: source.snapshotUrl, category } : undefined;

  return (
    <InstancePanel
      title={t("服务检测")}
      titleIcon={<ShieldCheck size={16} aria-hidden="true" />}
      description={t("从 VPS 出口检查 AI、流媒体、社交和 IP 信誉。")}
      aside={<button type="button" className="instance-toggle-button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>{open ? t("收起检测") : t("查看检测")}</button>}
    >
      <div id={panelId} hidden={!open}>
        {open && (
          <div className="flex flex-col gap-3">
            {hasPending && <InstanceChartLoadingBody />}
            {hasError && <p role="status" className="text-[13px] text-(--text-secondary)">{t("无法读取探测机的服务检测能力，请更新探测服务。")}</p>}
            {!hasPending && !source && <p className="text-[13px] text-(--text-secondary)">{t("没有找到支持服务检测的 VPS 探测机。请更新探测服务并刷新。")}</p>}
            {source && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="instance-segmented" role="group" aria-label={t("检测类别")}>
                    {SERVICE_CATEGORIES.map((value) => (
                      <button key={value} type="button" data-active={category === value} aria-pressed={category === value} onClick={() => setCategory(value)}>{t(CATEGORY_LABELS[value])}</button>
                    ))}
                  </div>
                  <span className="text-[12px] text-(--text-secondary)">{source.source}</span>
                </div>
                {canMeasure && probe && <RunServiceCheck probe={probe} onResult={(snapshot) => queryClient.setQueryData(["service-snapshot", source.snapshotUrl], snapshot)} />}
                <ServiceResults category={category} result={source.results[category]} />
              </>
            )}
          </div>
        )}
      </div>
    </InstancePanel>
  );
}
