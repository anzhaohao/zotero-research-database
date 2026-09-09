import type { FigureArtifact } from "../../../domain/types";
import {
  zoteroFigureImageSignature,
  type ZoteroFigureRecord,
} from "../../../services/zoteroFigure";

export type FigureRecord = FigureArtifact | ZoteroFigureRecord;

export function isZoteroFigureRecord(
  value: FigureRecord,
): value is ZoteroFigureRecord {
  return (value as ZoteroFigureRecord).provider === "zotero-figure";
}

export function figureImageSignature(value: FigureRecord): string {
  return isZoteroFigureRecord(value)
    ? zoteroFigureImageSignature(value)
    : `${value.attachmentKey}:${value.sha256}`;
}

/**
 * Signature for deciding whether a freshly loaded figure can reuse the
 * previous object. Include display and source fields so cache reconciliation
 * cannot retain stale captions, geometry, or image revisions.
 */
export function figureDataSignature(value: FigureRecord): string {
  if (isZoteroFigureRecord(value)) {
    return JSON.stringify({
      provider: value.provider,
      id: value.id,
      entryID: value.entryID,
      libraryID: value.libraryID,
      itemID: value.itemID,
      itemKey: value.itemKey,
      attachmentKey: value.attachmentKey,
      sourcePdfAttachmentKey: value.sourcePdfAttachmentKey,
      kind: value.kind,
      caption: value.caption,
      pageIndex: value.pageIndex,
      rect: value.rect,
      latex: value.latex,
      imageRef: value.imageRef,
      cacheRevision: value.cacheRevision,
    });
  }
  return JSON.stringify({
    id: value.id,
    parentItemKey: value.parentItemKey,
    attachmentKey: value.attachmentKey,
    sourcePdfAttachmentKey: value.sourcePdfAttachmentKey,
    kind: value.kind,
    caption: value.caption,
    pageIndex: value.pageIndex,
    rect: value.rect,
    sha256: value.sha256,
  });
}
