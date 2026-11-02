import { useState } from "react";
import type { MinerUProgress } from "../../../services/mineru";

export function MinerUConfigurationPanel({
  modeLabel,
  items,
  mineruRunning,
  mineruImporting,
  runMinerU,
  mineruProgress,
  onCancel,
  onOpenSettings,
}: {
  modeLabel: string;
  items: Zotero.Item[];
  mineruRunning: boolean;
  mineruImporting: boolean;
  runMinerU: (items: Zotero.Item[], forceRefresh?: boolean) => Promise<void>;
  mineruProgress: Map<string, MinerUProgress>;
  onCancel: () => void;
  onOpenSettings: () => void;
}) {
  const [forceRefresh, setForceRefresh] = useState(false);
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
        默认复用已有 Markdown
        与共享产物，不重复解析。每次转换使用插件设置中已保存的配置。
      </p>
      <label className="zrdb-field-checks">
        <input
          type="checkbox"
          checked={forceRefresh}
          disabled={mineruRunning}
          onChange={(event) => setForceRefresh(event.target.checked)}
        />
        重新解析并生成新产物（替换当前共享版本，旧附件保留为历史）
      </label>
      <div className="zrdb-inline-actions">
        <button
          type="button"
          className="primary"
          disabled={!items.length || mineruRunning}
          onClick={() => void runMinerU(items, forceRefresh)}
        >
          {forceRefresh ? "重新解析" : "转换"}选中 {items.length} 篇
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
