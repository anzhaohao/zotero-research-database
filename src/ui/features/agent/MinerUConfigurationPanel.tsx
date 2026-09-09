import type { MinerUProgress } from "../../../services/mineru";

export function MinerUConfigurationPanel({
  modeLabel,
  desktopMode,
  items,
  mineruRunning,
  mineruImporting,
  runMinerU,
  mineruProgress,
  onCancel,
  onOpenSettings,
}: {
  modeLabel: string;
  desktopMode: boolean;
  items: Zotero.Item[];
  mineruRunning: boolean;
  mineruImporting: boolean;
  runMinerU: (items: Zotero.Item[]) => Promise<void>;
  mineruProgress: Map<string, MinerUProgress>;
  onCancel: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <section className="zrdb-tool-section">
      <header>
        <div>
          <strong>MinerU 转换</strong>
          <small>
            已选择 {items.length} 篇文献 · {modeLabel}
          </small>
        </div>
        <button type="button" onClick={onOpenSettings}>
          打开 MinerU 设置
        </button>
      </header>
      <p className="zrdb-dialog-hint">
        每次转换使用插件设置中已保存的配置，结果自动导入对应文献。
      </p>
      {desktopMode && (
        <p className="zrdb-tool-capability" data-tone="notice">
          主 PDF 投递到 Desktop 后，请在客户端点击“立即解析”。完成后，Markdown
          与论文图表会自动回传到对应 Zotero 条目。
        </p>
      )}
      <div className="zrdb-inline-actions">
        <button
          type="button"
          className="primary"
          disabled={!items.length || mineruRunning}
          onClick={() => void runMinerU(items)}
        >
          转换选中 {items.length} 篇
        </button>
        {mineruRunning && (
          <button type="button" onClick={onCancel} disabled={mineruImporting}>
            {mineruImporting ? "正在导入 Zotero…" : "取消当前队列"}
          </button>
        )}
      </div>
      {!!mineruProgress.size && (
        <div className="zrdb-tool-progress-list" aria-live="polite">
          {[...mineruProgress.values()].map((entry) => (
            <div key={entry.itemKey} data-state={entry.state}>
              <span>
                {entry.state === "running"
                  ? "◌"
                  : entry.state === "success"
                    ? "✓"
                    : "!"}
              </span>
              <p>
                {items
                  .find((item) => item.key === entry.itemKey)
                  ?.getField("title") || entry.itemKey}
              </p>
              <small>{entry.message}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
