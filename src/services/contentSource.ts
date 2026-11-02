import type { SourceText } from "../domain/types";
import { resolvePrimaryPdf } from "./primaryPdf";
import type { ResearchRepository } from "../storage/repository";
import { getResearchRepository } from "../storage/repositoryScope";

export type ContentSourceRepository = Pick<
  ResearchRepository,
  "loadArtifacts" | "loadPrimaryPdfKey" | "savePrimaryPdfKey"
>;

export async function readExistingMinerUMarkdown(
  item: Zotero.Item,
  repository: ContentSourceRepository = getResearchRepository(),
  existingAttachments?: Zotero.Item[],
): Promise<{ attachment: Zotero.Item; text: string } | undefined> {
  const attachments =
    existingAttachments || (await Zotero.Items.getAsync(item.getAttachments()));
  const activeMinerUKeys = new Set(
    (await repository.loadArtifacts(item))
      .filter(
        (artifact) => artifact.role === "mineru-original" && !artifact.history,
      )
      .map((artifact) => artifact.attachmentKey),
  );
  const candidates = attachments
    .filter((attachment) => isMinerUAttachment(attachment, activeMinerUKeys))
    .sort((a, b) => b.dateModified.localeCompare(a.dateModified));
  for (const attachment of candidates) {
    const path = await attachment.getFilePathAsync();
    if (!path) continue;
    try {
      const text = toText(await Zotero.File.getContentsAsync(path, "utf-8"));
      if (text.trim()) return { attachment, text };
    } catch {
      // A missing or partially written attachment must not block reconversion.
    }
  }
  return undefined;
}

export async function resolveSourceText(
  item: Zotero.Item,
  repository: ContentSourceRepository = getResearchRepository(),
): Promise<SourceText> {
  const attachments = await Zotero.Items.getAsync(item.getAttachments());
  const mineru = await readExistingMinerUMarkdown(
    item,
    repository,
    attachments,
  );
  const pdf = (await resolvePrimaryPdf(item, attachments, repository))
    ?.attachment;
  const pdfPathValue = pdf ? await pdf.getFilePathAsync() : undefined;
  const pdfPath = typeof pdfPathValue === "string" ? pdfPathValue : undefined;
  if (mineru) {
    return {
      type: "mineru-markdown",
      text: mineru.text,
      hash: await sha256Text(mineru.text),
      attachmentID: mineru.attachment.id,
      pdfPath,
    };
  }

  if (!pdf) throw new Error("条目下没有 MinerU Markdown 或主 PDF 附件");
  const fulltext = Zotero.Fulltext;
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
