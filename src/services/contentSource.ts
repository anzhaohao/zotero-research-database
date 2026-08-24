import type { SourceText } from "../domain/types";
import { resolvePrimaryPdf } from "./primaryPdf";
import { ResearchRepository } from "../storage/repository";

const repository = new ResearchRepository();

export async function resolveSourceText(
  item: Zotero.Item,
): Promise<SourceText> {
  const attachments = await Zotero.Items.getAsync(item.getAttachments());
  const activeMinerUKeys = new Set(
    (await repository.loadArtifacts(item))
      .filter(
        (artifact) => artifact.role === "mineru-original" && !artifact.history,
      )
      .map((artifact) => artifact.attachmentKey),
  );
  const mineru = attachments
    .filter((attachment) => isMinerUAttachment(attachment, activeMinerUKeys))
    .sort((a, b) => b.dateModified.localeCompare(a.dateModified))[0];
  const pdf = (await resolvePrimaryPdf(item, attachments))?.attachment;
  const pdfPathValue = pdf ? await pdf.getFilePathAsync() : undefined;
  const pdfPath = typeof pdfPathValue === "string" ? pdfPathValue : undefined;
  if (mineru) {
    const path = await mineru.getFilePathAsync();
    if (path) {
      const text = toText(await Zotero.File.getContentsAsync(path, "utf-8"));
      if (text.trim()) {
        return {
          type: "mineru-markdown",
          text,
          hash: await sha256Text(text),
          attachmentID: mineru.id,
          pdfPath,
        };
      }
    }
  }

  if (!pdf) throw new Error("条目下没有 MinerU Markdown 或主 PDF 附件");
  const fulltext = Zotero.Fulltext as any;
  try {
    await fulltext.indexItems([pdf.id], { complete: true, ignoreErrors: true });
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
  let text = "";
  try {
    const cachePath = fulltext.getItemCacheFile(pdf).path;
    text = toText(await Zotero.File.getContentsAsync(cachePath, "utf-8"));
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
  if (!text.trim()) {
    if (pdfPath) {
      return {
        type: "pdf-fulltext",
        text: "",
        hash: await sha256Text(""),
        attachmentID: pdf.id,
        pdfPath,
      };
    }
    throw new Error("PDF 没有可读取的文本；扫描件需要先运行 OCR 或 MinerU");
  }
  return {
    type: "pdf-fulltext",
    text,
    hash: await sha256Text(text),
    attachmentID: pdf.id,
    pdfPath,
  };
}

function isMinerUAttachment(
  item: Zotero.Item,
  activeMinerUKeys: Set<string>,
): boolean {
  if (!item.isAttachment()) return false;
  if (activeMinerUKeys.size) return activeMinerUKeys.has(item.key);
  const filename =
    item.attachmentFilename || String(item.getField("title") || "");
  return /^【MinerU原文】.*\.md$/i.test(filename);
}

export async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}
