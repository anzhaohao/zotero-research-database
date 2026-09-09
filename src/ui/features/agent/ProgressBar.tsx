import { type ExtractionProgress } from "../../../services/extraction";

export function ProgressBar({
  progress,
  total,
}: {
  progress: Map<string, ExtractionProgress>;
  total: number;
}) {
  const done = [...progress.values()].filter((entry) =>
    ["success", "failed", "cancelled"].includes(entry.state),
  ).length;
  const failed = [...progress.values()].filter(
    (entry) => entry.state === "failed",
  );
  const failureSummary = failed
    .map((entry) => `${entry.itemKey}：${entry.message}`)
    .join("\n");
  return (
    <div className="zrdb-progress" title={failureSummary || undefined}>
      <div
        style={{ width: `${Math.min(100, total ? (done / total) * 100 : 0)}%` }}
      />
      <span>
        {done}/{total}
        {failed.length ? `，失败 ${failed.length}` : ""}
      </span>
    </div>
  );
}

export function CellAgentStatus({
  progress,
}: {
  progress: ExtractionProgress;
}) {
  const label =
    progress.state === "running"
      ? progress.message
      : progress.state === "success"
        ? "AI 提取完成"
        : progress.state === "failed"
          ? `AI 提取失败：${progress.message}`
          : "AI 提取已取消";
  return (
    <span
      className={`zrdb-cell-agent-status is-${progress.state}`}
      data-agent-state={progress.state}
      role={progress.state === "failed" ? "alert" : "status"}
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        {progress.state === "running" ? (
          <>
            <circle className="zrdb-agent-ring-track" cx="10" cy="10" r="7" />
            <circle className="zrdb-agent-ring-value" cx="10" cy="10" r="7" />
          </>
        ) : (
          <circle className="zrdb-agent-ring-outline" cx="10" cy="10" r="7" />
        )}
        {progress.state === "success" && <path d="m6.7 10 2.1 2.1 4.6-4.5" />}
        {progress.state === "failed" && (
          <>
            <path d="M10 6.2v4.9" />
            <path d="M10 13.8h.01" strokeWidth="2.1" />
          </>
        )}
        {progress.state === "cancelled" && <path d="M6.8 10h6.4" />}
      </svg>
    </span>
  );
}
