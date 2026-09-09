import type { ResearchRepository } from "../storage/repository";
import { getResearchRepository } from "../storage/repositoryScope";

export type PrimaryPdfRepository = Pick<
  ResearchRepository,
  "loadPrimaryPdfKey" | "savePrimaryPdfKey"
>;

export interface PrimaryPdfResolution {
  attachment: Zotero.Item;
  source: "explicit" | "named-pdf" | "best-attachment" | "first-pdf";
}

export async function listPdfAttachments(
  item: Zotero.Item,
): Promise<Zotero.Item[]> {
  const children = await Zotero.Items.getAsync(item.getAttachments());
  return children.filter(
    (attachment) => attachment.isAttachment() && attachment.isPDFAttachment(),
  );
}

export async function resolvePrimaryPdf(
  item: Zotero.Item,
  suppliedAttachments?: Zotero.Item[],
  repository: PrimaryPdfRepository = getResearchRepository(),
): Promise<PrimaryPdfResolution | undefined> {
  const attachments = suppliedAttachments
    ? suppliedAttachments.filter(
        (attachment) =>
          attachment.isAttachment() && attachment.isPDFAttachment(),
      )
    : await listPdfAttachments(item);
  if (!attachments.length) return undefined;

  const explicitKey = await repository.loadPrimaryPdfKey(item);
  const explicit = explicitKey
    ? attachments.find((attachment) => attachment.key === explicitKey)
    : undefined;
  if (explicit) return { attachment: explicit, source: "explicit" };

  const namedPdf = attachments.find(
    (attachment) =>
      String(attachment.getField("title") || "")
        .trim()
        .toLocaleLowerCase() === "pdf",
  );
  if (namedPdf) return { attachment: namedPdf, source: "named-pdf" };

  const best = await item.getBestAttachment?.();
  if (best && attachments.some((attachment) => attachment.id === best.id)) {
    return { attachment: best, source: "best-attachment" };
  }

  return { attachment: attachments[0], source: "first-pdf" };
}

export async function setPrimaryPdf(
  item: Zotero.Item,
  attachmentKey?: string,
  repository: PrimaryPdfRepository = getResearchRepository(),
): Promise<void> {
  if (attachmentKey) {
    const attachments = await listPdfAttachments(item);
    if (!attachments.some((attachment) => attachment.key === attachmentKey)) {
      throw new Error("所选附件不是该条目下的 PDF");
    }
  }
  await repository.savePrimaryPdfKey(item, attachmentKey);
}

export function pdfAttachmentLabel(attachment: Zotero.Item): string {
  const title = String(attachment.getField("title") || "").trim();
  const filename = String(attachment.attachmentFilename || "").trim();
  if (title && filename && title !== filename) return `${title} · ${filename}`;
  return title || filename || attachment.key;
}
