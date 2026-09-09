import { useCallback, useEffect, useState } from "react";
import {
  listPdfAttachments,
  resolvePrimaryPdf,
  pdfAttachmentLabel,
  setPrimaryPdf,
  type PrimaryPdfRepository,
  type PrimaryPdfResolution,
} from "../../../services/primaryPdf";

export function usePrimaryPdfRows(
  items: Zotero.Item[],
  repository: PrimaryPdfRepository,
) {
  const [pdfRows, setPdfRows] = useState<
    Array<{
      item: Zotero.Item;
      attachments: Zotero.Item[];
      explicitKey: string;
      automaticLabel: string;
    }>
  >([]);

  const reloadPdfRows = useCallback(async () => {
    const rows = await Promise.all(
      items.map(async (item) => {
        const attachments = await listPdfAttachments(item);
        const resolution = await resolvePrimaryPdf(
          item,
          attachments,
          repository,
        );
        return {
          item,
          attachments,
          explicitKey:
            resolution?.source === "explicit" ? resolution.attachment.key : "",
          automaticLabel: resolution
            ? `${pdfAttachmentLabel(resolution.attachment)}（${primaryPdfSourceLabel(resolution.source)}）`
            : "没有 PDF",
        };
      }),
    );
    setPdfRows(rows);
  }, [items, repository]);

  useEffect(() => {
    void reloadPdfRows();
  }, [reloadPdfRows]);

  return { pdfRows, reloadPdfRows };
}

export function PrimaryPdfManager({
  items,
  repository,
  pdfRows,
  reloadPdfRows,
  running,
  onStatus,
  onConvert,
}: {
  items: Zotero.Item[];
  repository: PrimaryPdfRepository;
  pdfRows: ReturnType<typeof usePrimaryPdfRows>["pdfRows"];
  reloadPdfRows: () => Promise<void>;
  running: boolean;
  onStatus: (message: string) => void;
  onConvert: (item: Zotero.Item) => void;
}) {
  return (
    <section className="zrdb-tool-section zrdb-primary-pdf-section">
      <header>
        <div>
          <strong>主 PDF</strong>
          <small>MinerU、PDF 首页预览和全文回退都使用同一附件</small>
        </div>
      </header>
      {!items.length && <p className="zrdb-status">请先在表格中选中文献。</p>}
      {pdfRows.map((row) => (
        <div className="zrdb-primary-pdf-row" key={row.item.key}>
          <span>{String(row.item.getField("title") || row.item.key)}</span>
          <select
            value={row.explicitKey}
            disabled={!row.attachments.length}
            onChange={(event) =>
              void (async () => {
                try {
                  await setPrimaryPdf(
                    row.item,
                    event.target.value || undefined,
                    repository,
                  );
                  await reloadPdfRows();
                  onStatus("主 PDF 已保存到条目 Extra；原始 PDF 数据没有修改");
                } catch (error) {
                  onStatus(
                    error instanceof Error ? error.message : String(error),
                  );
                }
              })()
            }
          >
            <option value="">自动：{row.automaticLabel}</option>
            {row.attachments.map((attachment) => (
              <option value={attachment.key} key={attachment.key}>
                {pdfAttachmentLabel(attachment)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!row.attachments.length || running}
            onClick={() => {
              onConvert(row.item);
            }}
          >
            转换此篇
          </button>
        </div>
      ))}
    </section>
  );
}

export function primaryPdfSourceLabel(
  source: PrimaryPdfResolution["source"],
): string {
  if (source === "explicit") return "已指定";
  if (source === "named-pdf") return "标题为 PDF";
  if (source === "best-attachment") return "Zotero 默认附件";
  return "首个 PDF";
}
