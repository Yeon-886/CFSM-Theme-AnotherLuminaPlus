import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { t } from "@/i18n";
import {
  ROUTE_TRACE_TOKEN_FORMAT,
  RouteTraceMeasurementError,
  measureRouteTrace,
  routeTraceMeasurementUrl,
  type RouteTraceProbe,
} from "@/services/routeTraces";

function measurementError(error: unknown) {
  if (error instanceof RouteTraceMeasurementError) {
    if (error.status === 401) return t("测量令牌不正确。");
    if (error.status === 403) return t("该探测机未允许此监控站点发起测量。");
    if (error.status === 404) return t("测量线路已变更，请刷新结果后再试。");
    if (error.status === 409) return t("探测机正在测量，请稍后再试。");
    if (error.status === 429) return t("请在上一次测量结束十秒后再试。");
    if (error.status === 503) return t("探测机无法保存结果，请检查快照目录。");
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return t("等待测量超时，请刷新结果确认是否完成。");
  }
  return t("无法取得测量结果，请检查探测机连接后重试。");
}

export function RunRouteMeasurement({ probe }: { probe: RouteTraceProbe }) {
  const queryClient = useQueryClient();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const provided = token.trim();
    if (!ROUTE_TRACE_TOKEN_FORMAT.test(provided)) {
      setError(t("请输入探测机的专用测量令牌。"));
      return;
    }
    setBusy(true);
    setToken("");
    setError("");
    setDone(false);
    try {
      const snapshot = await measureRouteTrace(probe, provided);
      const queryKey = ["route-trace-snapshot", probe.snapshotUrl];
      await queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData(queryKey, snapshot);
      setDone(true);
      setOpen(false);
    } catch (failure) {
      setError(measurementError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col items-start gap-2 text-[13px]">
      <button
        type="button"
        onClick={() => { setOpen(!open); setToken(""); setError(""); setDone(false); }}
        aria-expanded={open}
        aria-controls={formId}
        disabled={busy}
        className="instance-toggle-button surface-inset"
      >
        {busy ? t("正在测量…") : t("立即测量")}
      </button>
      <form
        id={formId}
        hidden={!open}
        onSubmit={(event) => void run(event)}
        aria-busy={busy}
        className={open ? "surface-inset w-full p-3" : undefined}
      >
        <p className="mb-2 break-all text-(--text-secondary)">
          {t("探测机 {host}，请使用该探测机的专用测量令牌。", { host: routeTraceMeasurementUrl(probe.snapshotUrl)?.host ?? "" })}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-(--text-secondary)">{t("测量令牌")}</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              maxLength={128}
              required
              disabled={busy}
              className="surface-inset max-w-full rounded-lg px-2 py-1.5"
            />
          </label>
          <button type="submit" disabled={busy} className="instance-toggle-button">
            {t("开始测量")}
          </button>
        </div>
      </form>
      {error && <p role="alert" className="text-(--text-secondary)">{error}</p>}
      {done && <p role="status" className="text-(--text-secondary)">{t("已更新本次测量结果。")}</p>}
    </div>
  );
}
