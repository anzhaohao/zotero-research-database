import type { FigureArtifact, ManagedArtifact } from "../domain/types";
import { getPref, setPref } from "../utils/prefs";
import type { ResearchRepository } from "../storage/repository";
import { getResearchRepository } from "../storage/repositoryScope";

export const INTERNAL_TAG_PREFIX = "#ZRDB/";
const MIGRATION_PREF = "artifactMetadataMigrationVersion";
const MIGRATION_VERSION = 1;
export type ArtifactMetadataRepository = Pick<
  ResearchRepository,
  "loadFigures" | "loadArtifacts" | "saveArtifacts"
>;

/** Mark the previous artifact in the same logical slot as history. */
export function setCurrentArtifact(
  current: ManagedArtifact[],
  next: ManagedArtifact,
  sameSlot: (artifact: ManagedArtifact) => boolean,
): ManagedArtifact[] {
  const retained = current
    .filter((artifact) => artifact.attachmentKey !== next.attachmentKey)
    .map((artifact) =>
      sameSlot(artifact) && !artifact.history
        ? { ...artifact, history: true as const }
        : artifact,
    );
  return [...retained, { ...next, history: undefined }];
}

export interface ArtifactTagMigrationResult {
  migrated: number;
  removedTags: number;
  skipped: boolean;
}

/**
 * Move legacy #ZRDB/* attachment metadata into each parent item's structured
 * manifest, then remove only those internal tags through Zotero's public API.
 */
export async function migrateLegacyInternalTags(
  repository: ArtifactMetadataRepository = getResearchRepository(),
): Promise<ArtifactTagMigrationResult> {
  if (Number(getPref(MIGRATION_PREF) || 0) >= MIGRATION_VERSION) {
    return { migrated: 0, removedTags: 0, skipped: true };
  }
  const libraryID = Zotero.Libraries.userLibraryID;
  const legacyTags = (await Zotero.Tags.getAll(libraryID)).filter((entry) =>
    entry.tag.startsWith(INTERNAL_TAG_PREFIX),
  );
  if (!legacyTags.length) {
    setPref(MIGRATION_PREF, MIGRATION_VERSION);
    return { migrated: 0, removedTags: 0, skipped: false };
  }

  const tagIDs = legacyTags
    .map((entry) => Zotero.Tags.getID(entry.tag))
    .filter((id): id is number => typeof id === "number");
  const itemIDs = new Set<number>();
  for (const tagID of tagIDs) {
    for (const itemID of await Zotero.Tags.getTagItems(libraryID, tagID)) {
      itemIDs.add(itemID);
    }
  }
  const taggedItems = itemIDs.size
    ? await Zotero.Items.getAsync([...itemIDs])
    : [];
  const byParent = new Map<number, Zotero.Item[]>();
  for (const item of taggedItems) {
    if (!item.isAttachment() || !item.parentItemID) continue;
    const siblings = byParent.get(item.parentItemID) || [];
    siblings.push(item);
    byParent.set(item.parentItemID, siblings);
  }

  let migrated = 0;
  for (const [parentID, attachments] of byParent) {
    const parent = await Zotero.Items.getAsync(parentID);
    if (!parent || !parent.isRegularItem()) continue;
    const figures = await repository.loadFigures(parent);
    let artifacts = await repository.loadArtifacts(parent);
    for (const attachment of attachments) {
      const tags = attachment
        .getTags()
        .map((entry) => entry.tag)
        .filter((tag) => tag.startsWith(INTERNAL_TAG_PREFIX));
      const figure = figures.find(
        (entry) => entry.attachmentKey === attachment.key,
      );
      const record = legacyTagsToArtifact(attachment, tags, figure);
      if (!record) continue;
      artifacts = [
        ...artifacts.filter(
          (entry) => entry.attachmentKey !== record.attachmentKey,
        ),
        record,
      ];
      migrated += 1;
    }
    await repository.saveArtifacts(parent, artifacts);
  }

  // Only remove tags after every recoverable metadata record has been saved.
  if (tagIDs.length) {
    await Zotero.Tags.removeFromLibrary(libraryID, tagIDs, () => {}, [0, 1]);
  }
  setPref(MIGRATION_PREF, MIGRATION_VERSION);
  return { migrated, removedTags: tagIDs.length, skipped: false };
}

function legacyTagsToArtifact(
  attachment: Zotero.Item,
  tags: string[],
  figure?: FigureArtifact,
): ManagedArtifact | undefined {
  const valueAfter = (prefix: string) =>
    tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
  const roleValue = valueAfter(`${INTERNAL_TAG_PREFIX}role/`);
  const snapshotID = valueAfter(`${INTERNAL_TAG_PREFIX}snapshot/`);
  const role = snapshotID ? "snapshot" : roleValue || figure?.kind;
  if (
    !role ||
    !["mineru-original", "translation", "figure", "table", "snapshot"].includes(
      role,
    )
  ) {
    return undefined;
  }
  const filename = String(
    attachment.attachmentFilename || attachment.getField("title") || "",
  );
  const extension = filename.split(".").pop()?.toLocaleLowerCase();
  const format = ["md", "html", "csv"].includes(extension || "")
    ? (extension as ManagedArtifact["format"])
    : undefined;
  const hash = valueAfter(`${INTERNAL_TAG_PREFIX}sha256/`) || figure?.sha256;
  return {
    attachmentKey: attachment.key,
    role: role as ManagedArtifact["role"],
    sha256: /^[a-f0-9]{64}$/i.test(hash || "") ? hash : undefined,
    runID: valueAfter(`${INTERNAL_TAG_PREFIX}run/`),
    figureID:
      valueAfter(`${INTERNAL_TAG_PREFIX}figure/`) || figure?.id || undefined,
    snapshotID,
    format,
    ...(tags.includes(`${INTERNAL_TAG_PREFIX}history`)
      ? { history: true }
      : {}),
  };
}
