import { useEffect, useRef, useState, type FormEvent } from "react";
import { t } from "@/i18n";
import {
  GLOBALPING_WEB_TRACEROUTE,
  GlobalpingTraceError,
  ONLINE_TRACE_SOURCES,
  publicTraceIp,
  runOnlineTrace,
  type OnlineMeasurement,
  type OnlineTraceProtocol,
  type OnlineTraceSource,
} from "@/services/globalpingTrace";

function onlineError(error: unknown) {
  if (error instanceof GlobalpingTraceError) {
    if (error.reason === "no_probes_found") return t("所选线路暂时没有在线探测点，请换一条线路。");
    if (error.status === 429) return t("Globalping 已限制测量频率，请稍后再试。");
    if (error.status === 400 || error.status === 422) return t("Globalping 无法测量该地址或线路。");
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return t("在线测量超时，请稍后再试。");
  }
  return t("无法连接 Globalping。请在后台的 CSP API 域名白名单中允许 https://api.globalping.io，或直接打开 Globalping。");
}

export function OnlineForwardTrace() {
  const [target, setTarget] = useState("");
  const [source, setSource] = useState<OnlineTraceSource>("china");
  const [protocol, setProtocol] = useState<OnlineTraceProtocol>("ICMP");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<OnlineMeasurement>();
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.current) return;
    const ip = publicTraceIp(target);
    if (!ip) {
      setError(t("请输入 VPS 的公网 IPv4 或 IPv6 地址。"));
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setTarget(ip);
    setError("");
    setResult(undefined);
    setBusy(true);
    try {
      await runOnlineTrace({ target: ip, source, protocol }, setResult, controller.signal);
    } catch (failure) {
      if (!controller.signal.aborted) setError(onlineError(failure));
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <div className="surface-inset mb-3 flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <form className="flex min-w-0 flex-col gap-2 text-[13px]" onSubmit={(event) => void start(event)}>
        <p className="text-(--text-secondary)">
          {t("Globalping 会从中国大陆的公共探测点测到你填的公网 IP。")}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1">
            <span>{t("VPS 公网 IP")}</span>
            <input
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder="IPv4 / IPv6"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              maxLength={64}
              required
              className="surface-inset max-w-full rounded-lg px-3 py-1.5"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span>{t("探测网络")}</span>
            <select
              value={source}
              onChange={(event) => setSource(event.target.value as OnlineTraceSource)}
              disabled={busy}
              className="surface-inset rounded-lg px-2 py-1.5"
            >
              {ONLINE_TRACE_SOURCES.map(({ id, label }) => <option value={id} key={id}>{t(label)}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span>{t("探测协议")}</span>
            <select
              value={protocol}
              onChange={(event) => setProtocol(event.target.value === "TCP" ? "TCP" : "ICMP")}
              disabled={busy}
              className="surface-inset rounded-lg px-2 py-1.5"
            >
              <option value="ICMP">ICMP</option>
              <option value="TCP">TCP/443</option>
            </select>
          </label>
          <button type="submit" className="instance-toggle-button surface-inset" disabled={busy}>
            {busy ? t("正在测量…") : t("开始在线测量")}
          </button>
          <a href={GLOBALPING_WEB_TRACEROUTE} target="_blank" rel="noopener noreferrer" className="instance-toggle-button">
            {t("直接打开 Globalping")}
          </a>
        </div>
      </form>
      {error && <p role="alert" className="text-[13px] text-(--text-secondary)">{error}</p>}
      {!busy && result?.results.length === 0 && (
        <p role="status" className="text-[13px] text-(--text-secondary)">{t("本次没有收到探测结果。")}</p>
      )}
      {result && (
        <div aria-busy={busy} className="flex min-w-0 flex-col gap-3">
          {result.results.map(({ probe, result: trace }, index) => (
            <div className="min-w-0 rounded-lg border border-(--border) p-3" key={index}>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
                <strong>{probe.country} · {probe.city} · AS{probe.asn}</strong>
                <span className="text-(--text-secondary)">{probe.network}</span>
                {trace.status === "failed" && <span>{t("本次测量失败")}</span>}
              </div>
              {trace.rawOutput && (
                <pre className="mt-2 max-h-72 overflow-auto text-[12px]" tabIndex={0}>{trace.rawOutput}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
