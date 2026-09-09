import type { ManagedArtifact } from "../domain/types";
import type { ResearchRepository } from "../storage/repository";
import { getResearchRepository } from "../storage/repositoryScope";
import { getPref, setPref } from "../utils/prefs";
import { getDataRoot, hasConfiguredDataRoot } from "../storage/dataRoot";

export const ARTIFACT_STORAGE_ROOT_PREF = "artifactStorageRoot";
export const ARTIFACT_STORAGE_MIGRATION_PREF =
  "artifactStorageMigrationVersion";
export const ARTIFACT_STORAGE_MIGRATION_VERSION = 1;
export const ARTIFACT_STORAGE_MANIFEST = ".zrdb-manifest.json";

export type ArtifactStorageRepository = Pick<
  ResearchRepository,
  "loadArtifacts" | "loadAllArtifacts" | "loadFigures" | "saveManifests"
>;

export interface ArtifactStorageManifestEntry {
  relativePath: string;
  attachmentKey: string;
  sha256: string;
  role: ManagedArtifact["role"];
  runID?: string;
  figureID?: string;
  snapshotID?: string;
  format?: ManagedArtifact["format"];
}

export interface ArtifactStorageManifest {
  schemaVersion: 1;
  itemKey: string;
  files: ArtifactStorageManifestEntry[];
  updatedAt: string;
}

export interface ManagedAttachmentResult {
  attachment: Zotero.Item;
  sha256: string;
  relativePath?: string;
}

export interface ArtifactMigrationResult {
  root: string;
  migrated: number;
  skipped: number;
  broken: number;
  failures: string[];
}

export interface BrokenArtifactLink {
  itemKey: string;
  attachmentKey: string;
  relativePath?: string;
  reason: string;
}

/** Serializes read/modify/write operations for one Zotero parent item. */
const artifactLocks = new Map<string, Promise<void>>();

async function withArtifactItemLock<T>(
  itemKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = artifactLocks.get(itemKey) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  artifactLocks.set(itemKey, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (artifactLocks.get(itemKey) === tail) artifactLocks.delete(itemKey);
  }
}

export function withArtifactStorageItemLock<T>(
  itemKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withArtifactItemLock(itemKey, operation);
}

export function getArtifactStorageRoot(): string {
  const dataRoot =
    typeof getDataRoot === "function" ? getDataRoot() : undefined;
  const legacyConfiguredRoot = String(
    getPref(ARTIFACT_STORAGE_ROOT_PREF) || "",
  ).trim();
  if (dataRoot && hasConfiguredDataRoot()) {
    const libraryID = Number(Zotero?.Libraries?.userLibraryID || 0);
    if (
      libraryID > 0 &&
      (!legacyConfiguredRoot ||
        normalizePath(dataRoot) !== normalizePath(legacyConfiguredRoot))
    )
      return PathUtils.join(dataRoot, "artifacts", String(libraryID));
  }
  return legacyConfiguredRoot;
}

/** Legacy user-selected root, retained only as a migration source. */
export function getLegacyArtifactStorageRoot(): string {
  return String(getPref(ARTIFACT_STORAGE_ROOT_PREF) || "").trim();
}

export function setArtifactStorageRoot(value: string): string {
  const root = normalizeStorageRoot(value);
  setPref(ARTIFACT_STORAGE_ROOT_PREF, root);
  return root;
}

/** Returns the new canonical root while retaining the legacy preference API for migration. */
export function getCanonicalArtifactStorageRoot(
  dataRootValue = typeof getDataRoot === "function" ? getDataRoot() : undefined,
  libraryID = Number(Zotero?.Libraries?.userLibraryID || 0),
): string {
  if (!dataRootValue || !libraryID) return "";
  return PathUtils.join(
    normalizeStorageRoot(dataRootValue),
    "artifacts",
    String(libraryID),
  );
}

export function normalizeStorageRoot(value: string): string {
  const root = String(value || "").trim();
  if (!root) return "";
  if (!isAbsolutePath(root)) {
    throw new Error("研究产物根目录必须是绝对路径");
  }
  return normalizePath(root);
}

export function isAbsolutePath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value.trim());
}

export function sanitizeArtifactFileName(name: string): string {
  const basename = String(name || "").replace(/^.*[\\/]/, "");
  const sanitized = [...basename]
    .map((character) =>
      '<>:"/\\|?*'.includes(character) || character.charCodeAt(0) <= 0x1f
        ? "_"
        : character,
    )
    .join("")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "artifact";
  }
  return sanitized.slice(0, 180);
}

export function chooseArtifactFileName(
  desiredName: string,
  occupiedNames: Iterable<string>,
): string {
  const occupied = new Set(
    [...occupiedNames].map((name) => name.toLocaleLowerCase()),
  );
  const safe = sanitizeArtifactFileName(desiredName);
  if (!occupied.has(safe.toLocaleLowerCase())) return safe;

  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!occupied.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error(`无法为产物生成不冲突的文件名：${safe}`);
}

export function buildArtifactRelativePath(
  itemKey: string,
  fileName: string,
): string {
  assertItemKey(itemKey);
  const safe = sanitizeArtifactFileName(fileName);
  return `${itemKey}/${safe}`;
}

export function parseArtifactStorageManifest(
  value: string,
  itemKey: string,
): ArtifactStorageManifest {
  const parsed = JSON.parse(value) as Partial<ArtifactStorageManifest>;
  if (
    parsed.schemaVersion !== 1 ||
    parsed.itemKey !== itemKey ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error(`产物目录 ${itemKey} 的清单格式无效`);
  }
  const files = parsed.files.map((entry) => {
    if (
      !entry ||
      typeof entry.relativePath !== "string" ||
      !isSafeRelativeFileName(entry.relativePath, itemKey) ||
      typeof entry.attachmentKey !== "string" ||
      !/^[A-Z0-9]{8}$/i.test(entry.attachmentKey) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
      ![
        "mineru-original",
        "translation",
        "figure",
        "table",
        "snapshot",
      ].includes(String(entry.role))
    ) {
      throw new Error(`产物目录 ${itemKey} 的清单包含无效文件记录`);
    }
    return {
      relativePath: entry.relativePath,
      attachmentKey: entry.attachmentKey.toUpperCase(),
      sha256: entry.sha256.toLowerCase(),
      role: entry.role as ManagedArtifact["role"],
      ...(entry.runID ? { runID: entry.runID } : {}),
      ...(entry.figureID ? { figureID: entry.figureID } : {}),
      ...(entry.snapshotID ? { snapshotID: entry.snapshotID } : {}),
      ...(entry.format ? { format: entry.format } : {}),
    };
  });
  return {
    schemaVersion: 1,
    itemKey,
    files,
    updatedAt:
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date().toISOString(),
  };
}

export async function readArtifactStorageManifest(
  root: string,
  itemKey: string,
): Promise<ArtifactStorageManifest> {
  assertItemKey(itemKey);
  const directory = itemDirectory(root, itemKey);
  const path = PathUtils.join(directory, ARTIFACT_STORAGE_MANIFEST);
  if (!(await IOUtils.exists(path))) {
    return { schemaVersion: 1, itemKey, files: [], updatedAt: "" };
  }
  const bytes = await IOUtils.read(path);
  return parseArtifactStorageManifest(new TextDecoder().decode(bytes), itemKey);
}

export async function createManagedAttachment(
  parent: Zotero.Item,
  sourcePath: string,
  title: string,
  metadata: Pick<ManagedArtifact, "role"> &
    Partial<
      Pick<ManagedArtifact, "runID" | "figureID" | "snapshotID" | "format">
    >,
): Promise<ManagedAttachmentResult> {
  return withArtifactItemLock(parent.key, () =>
    createManagedAttachmentUnlocked(parent, sourcePath, title, metadata),
  );
}

export async function createManagedAttachmentUnlocked(
  parent: Zotero.Item,
  sourcePath: string,
  title: string,
  metadata: Pick<ManagedArtifact, "role"> &
    Partial<
      Pick<ManagedArtifact, "runID" | "figureID" | "snapshotID" | "format">
    >,
): Promise<ManagedAttachmentResult> {
  const root = getArtifactStorageRoot();
  const sha256 = await sha256File(sourcePath);
  if (!root) {
    const attachment = await Zotero.Attachments.importFromFile({
      file: sourcePath,
      parentItemID: parent.id,
      title,
    });
    return { attachment, sha256 };
  }

  const directory = itemDirectory(root, parent.key);
  await IOUtils.makeDirectory(directory, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const manifest = await readArtifactStorageManifest(root, parent.key);
  const sourceName = sanitizeArtifactFileName(
    PathUtils.filename(sourcePath) || title,
  );
  let fileName = sourceName;
  const samePathEntry = manifest.files.find(
    (entry) =>
      entry.relativePath ===
        buildArtifactRelativePath(parent.key, sourceName) &&
      entry.sha256 === sha256,
  );
  if (
    samePathEntry &&
    (await IOUtils.exists(
      absoluteArtifactPath(root, samePathEntry.relativePath),
    ))
  ) {
    const existing = await getAttachmentByKey(
      parent.libraryID,
      samePathEntry.attachmentKey,
    );
    if (existing && isLinkedFileAttachment(existing)) {
      const existingPath = await existing.getFilePathAsync();
      if (
        typeof existingPath === "string" &&
        (await IOUtils.exists(existingPath))
      ) {
        return {
          attachment: existing,
          sha256,
          relativePath: samePathEntry.relativePath,
        };
      }
    }
  }

  const occupied = new Set(
    manifest.files.map(
      (entry) => entry.relativePath.split(/[\\/]/).at(-1) || entry.relativePath,
    ),
  );
  let targetPath = PathUtils.join(directory, fileName);
  if (await IOUtils.exists(targetPath)) {
    const existingHash = await sha256File(targetPath);
    if (existingHash !== sha256 || !samePathEntry) {
      occupied.add(fileName);
      fileName = await chooseAvailableArtifactFileName(
        directory,
        fileName,
        occupied,
      );
      targetPath = PathUtils.join(directory, fileName);
    }
  }
  const targetExistedBeforeCopy = await IOUtils.exists(targetPath);
  if (!targetExistedBeforeCopy) {
    await copyFile(sourcePath, targetPath);
  }
  let attachment: Zotero.Item | undefined;
  try {
    const copiedHash = await sha256File(targetPath);
    if (copiedHash !== sha256) {
      throw new Error(`复制产物后哈希校验失败：${sourcePath}`);
    }

    attachment = await linkArtifactFile(targetPath, parent, title || fileName);
    const relativePath = buildArtifactRelativePath(parent.key, fileName);
    const nextEntry: ArtifactStorageManifestEntry = {
      relativePath,
      attachmentKey: attachment.key,
      sha256,
      role: metadata.role,
      ...(metadata.runID ? { runID: metadata.runID } : {}),
      ...(metadata.figureID ? { figureID: metadata.figureID } : {}),
      ...(metadata.snapshotID ? { snapshotID: metadata.snapshotID } : {}),
      ...(metadata.format ? { format: metadata.format } : {}),
    };
    await writeArtifactStorageManifest(root, parent.key, {
      ...manifest,
      files: [
        ...manifest.files.filter(
          (entry) =>
            entry.attachmentKey !== attachment!.key &&
            entry.relativePath !== nextEntry.relativePath,
        ),
        nextEntry,
      ],
    });
    return { attachment, sha256, relativePath };
  } catch (error) {
    try {
      if (attachment) await attachment.eraseTx();
    } catch {
      // Preserve the original error; cleanup is best-effort.
    }
    if (!targetExistedBeforeCopy) {
      try {
        await IOUtils.remove(targetPath, { ignoreAbsent: true });
      } catch {
        // Preserve the original error; a later integrity scan can clean it.
      }
    }
    throw error;
  }
}

export async function migrateStoredArtifacts(
  repository: ArtifactStorageRepository = getResearchRepository(),
  createAttachment = createManagedAttachment,
): Promise<ArtifactMigrationResult> {
  const root = normalizeStorageRoot(getArtifactStorageRoot());
  if (!root) throw new Error("请先设置研究产物根目录");
  await IOUtils.makeDirectory(root, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
  const result: ArtifactMigrationResult = {
    root,
    migrated: 0,
    skipped: 0,
    broken: 0,
    failures: [],
  };
  for (const item of items) {
    if (!item.isRegularItem()) continue;
    try {
      await withArtifactItemLock(item.key, async () => {
        const transactionCreateAttachment =
          createAttachment === createManagedAttachment
            ? createManagedAttachmentUnlocked
            : createAttachment;
        const artifacts = await repository.loadAllArtifacts(item);
        if (!artifacts.length) return;
        let nextArtifacts = artifacts;
        let nextFigures = await repository.loadFigures(item);
        const children = await Zotero.Items.getAsync(item.getAttachments());
        for (const [index, artifact] of artifacts.entries()) {
          const attachment = children.find(
            (child) => child.key === artifact.attachmentKey,
          );
          if (!attachment) {
            result.broken += 1;
            continue;
          }
          if (!isStoredFileAttachment(attachment)) {
            result.skipped += 1;
            continue;
          }
          const sourcePath = await attachment.getFilePathAsync();
          if (typeof sourcePath !== "string") {
            result.broken += 1;
            continue;
          }
          const linked = await transactionCreateAttachment(
            item,
            sourcePath,
            String(attachment.getField("title") || artifact.role),
            artifact,
          );
          nextArtifacts = nextArtifacts.map((entry, currentIndex) =>
            currentIndex === index
              ? {
                  ...entry,
                  attachmentKey: linked.attachment.key,
                  sha256: linked.sha256,
                  relativePath: linked.relativePath,
                }
              : entry,
          );
          nextFigures = nextFigures.map((figure) =>
            figure.attachmentKey === attachment.key
              ? { ...figure, attachmentKey: linked.attachment.key }
              : figure,
          );
          await repository.saveManifests(item, nextArtifacts, nextFigures);
          // Migration is intentionally non-destructive. The old stored/linked
          // attachment and its source file remain available until the user has
          // verified the new root and explicitly asks for cleanup.
          result.migrated += 1;
        }
      });
    } catch (error) {
      result.failures.push(
        `${item.key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!result.failures.length && !result.broken) {
    setPref(
      ARTIFACT_STORAGE_MIGRATION_PREF,
      ARTIFACT_STORAGE_MIGRATION_VERSION,
    );
  }
  return result;
}

/**
 * Copy managed files to a new data-root-backed artifact directory and relink
 * manifests without deleting the source tree. This is safe to rerun.
 */
export async function relocateArtifactStorageRoot(
  sourceRoot: string,
  destinationRoot: string,
  repository: ArtifactStorageRepository = getResearchRepository(),
): Promise<ArtifactMigrationResult> {
  const source = normalizeStorageRoot(sourceRoot);
  const destination = normalizeStorageRoot(destinationRoot);
  if (!source || !destination)
    throw new Error("产物迁移需要有效的源目录和目标目录");
  await IOUtils.makeDirectory(destination, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const result: ArtifactMigrationResult = {
    root: destination,
    migrated: 0,
    skipped: 0,
    broken: 0,
    failures: [],
  };
  const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
  for (const item of items) {
    if (!item.isRegularItem()) continue;
    try {
      await withArtifactItemLock(item.key, async () => {
        const manifest = await readArtifactStorageManifest(source, item.key);
        if (!manifest.files.length) return;
        const existingDestination = await readArtifactStorageManifest(
          destination,
          item.key,
        );
        const destinationDirectory = itemDirectory(destination, item.key);
        await IOUtils.makeDirectory(destinationDirectory, {
          createAncestors: true,
          ignoreExisting: true,
        });
        const children = await Zotero.Items.getAsync(item.getAttachments());
        const sourceArtifacts = await repository.loadArtifacts(item);
        let nextArtifacts = sourceArtifacts;
        let nextFigures = await repository.loadFigures(item);
        const createdAttachments: Zotero.Item[] = [];
        const nextFiles: ArtifactStorageManifestEntry[] = [];
        for (const entry of manifest.files) {
          const sourcePath = absoluteArtifactPath(source, entry.relativePath);
          if (!(await IOUtils.exists(sourcePath))) {
            result.broken += 1;
            continue;
          }
          if ((await sha256File(sourcePath)) !== entry.sha256) {
            result.broken += 1;
            continue;
          }
          const fileName = entry.relativePath.split(/[\\/]/).at(-1)!;
          const destinationPath = PathUtils.join(
            destinationDirectory,
            fileName,
          );
          if (!(await IOUtils.exists(destinationPath))) {
            await copyFile(sourcePath, destinationPath);
          }
          if ((await sha256File(destinationPath)) !== entry.sha256) {
            throw new Error(`迁移产物后哈希校验失败：${entry.relativePath}`);
          }
          const reusable = existingDestination.files.find(
            (candidate) =>
              candidate.relativePath === entry.relativePath &&
              candidate.sha256 === entry.sha256 &&
              children.some((child) => child.key === candidate.attachmentKey),
          );
          let attachmentKey = reusable?.attachmentKey;
          if (!attachmentKey) {
            const attachment = await linkArtifactFile(
              destinationPath,
              item,
              fileName,
            );
            attachmentKey = attachment.key;
            createdAttachments.push(attachment);
          }
          nextFiles.push({ ...entry, attachmentKey });
          nextArtifacts = nextArtifacts.map((artifact) =>
            artifact.attachmentKey === entry.attachmentKey
              ? { ...artifact, attachmentKey, relativePath: entry.relativePath }
              : artifact,
          );
          nextFigures = nextFigures.map((figure) =>
            figure.attachmentKey === entry.attachmentKey
              ? { ...figure, attachmentKey }
              : figure,
          );
          result.migrated += 1;
        }
        try {
          await writeArtifactStorageManifest(destination, item.key, {
            ...manifest,
            files: nextFiles,
          });
          await repository.saveManifests(item, nextArtifacts, nextFigures);
        } catch (error) {
          for (const attachment of createdAttachments)
            await attachment.eraseTx().catch(() => undefined);
          if (existingDestination.files.length)
            await writeArtifactStorageManifest(
              destination,
              item.key,
              existingDestination,
            );
          else
            await IOUtils.remove(
              PathUtils.join(destinationDirectory, ARTIFACT_STORAGE_MANIFEST),
              { ignoreAbsent: true },
            );
          throw error;
        }
      });
    } catch (error) {
      result.failures.push(
        `${item.key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}

/** Removes only files/manifest entries created for the supplied attachments. */
export async function rollbackManagedAttachments(
  itemKey: string,
  attachmentKeys: Iterable<string>,
  rootValue = getArtifactStorageRoot(),
  alreadyLocked = false,
): Promise<void> {
  const root = normalizeStorageRoot(rootValue);
  if (!root) return;
  const keys = new Set([...attachmentKeys].map((key) => key.toUpperCase()));
  if (!keys.size) return;
  const operation = async () => {
    const manifest = await readArtifactStorageManifest(root, itemKey);
    const removed = manifest.files.filter((entry) =>
      keys.has(entry.attachmentKey.toUpperCase()),
    );
    if (!removed.length) return;
    const remaining = manifest.files.filter(
      (entry) => !keys.has(entry.attachmentKey.toUpperCase()),
    );
    await writeArtifactStorageManifest(root, itemKey, {
      ...manifest,
      files: remaining,
    });
    for (const entry of removed) {
      const path = absoluteArtifactPath(root, entry.relativePath);
      if (
        (await IOUtils.exists(path)) &&
        !(await isFilesystemLink(path)) &&
        (await sha256File(path)) === entry.sha256
      ) {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
    }
  };
  if (alreadyLocked) await operation();
  else await withArtifactItemLock(itemKey, operation);
}

export async function scanBrokenArtifactLinks(
  rootValue = getArtifactStorageRoot(),
  repository: Pick<
    ArtifactStorageRepository,
    "loadAllArtifacts"
  > = getResearchRepository(),
): Promise<BrokenArtifactLink[]> {
  const root = normalizeStorageRoot(rootValue);
  if (!root) return [];
  const items = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
  const broken: BrokenArtifactLink[] = [];
  for (const item of items) {
    if (!item.isRegularItem()) continue;
    const artifacts = await repository.loadAllArtifacts(item);
    const children = await Zotero.Items.getAsync(item.getAttachments());
    for (const artifact of artifacts) {
      const attachment = children.find(
        (child) => child.key === artifact.attachmentKey,
      );
      if (!attachment || !isLinkedFileAttachment(attachment)) continue;
      const path = await attachment.getFilePathAsync();
      if (typeof path !== "string" || !(await IOUtils.exists(path))) {
        broken.push({
          itemKey: item.key,
          attachmentKey: artifact.attachmentKey,
          relativePath: artifact.relativePath,
          reason: "linked file 不存在",
        });
      }
    }
  }
  return broken;
}

export async function cleanupOwnedArtifactDirectory(
  itemKey: string,
  rootValue = getArtifactStorageRoot(),
): Promise<void> {
  const root = normalizeStorageRoot(rootValue);
  if (!root) return;
  assertItemKey(itemKey);
  const directory = itemDirectory(root, itemKey);
  if (await isFilesystemLink(directory)) return;
  const manifestPath = PathUtils.join(directory, ARTIFACT_STORAGE_MANIFEST);
  if (!(await IOUtils.exists(manifestPath))) return;
  if (await isFilesystemLink(manifestPath)) return;
  const manifest = await readArtifactStorageManifest(root, itemKey);
  for (const entry of manifest.files) {
    if (!isSafeRelativeFileName(entry.relativePath, itemKey)) continue;
    const path = absoluteArtifactPath(root, entry.relativePath);
    if (
      !isWithinDirectory(path, directory) ||
      (await isFilesystemLink(path)) ||
      !(await IOUtils.exists(path))
    )
      continue;
    try {
      if ((await sha256File(path)) !== entry.sha256) continue;
      await IOUtils.remove(path, { ignoreAbsent: true });
    } catch {
      // A changed, unreadable, or non-regular path is user data until proven
      // to be the exact file recorded by the manifest.
    }
  }
  await IOUtils.remove(manifestPath, { ignoreAbsent: true });
  const children = await IOUtils.getChildren?.(directory);
  if (Array.isArray(children) && children.length === 0) {
    await IOUtils.remove(directory, { ignoreAbsent: true });
  }
}

export async function openArtifactStorageDirectory(
  itemKey?: string,
): Promise<string> {
  const root = normalizeStorageRoot(getArtifactStorageRoot());
  if (!root) throw new Error("请先设置研究产物根目录");
  const directory = itemKey ? itemDirectory(root, itemKey) : root;
  await IOUtils.makeDirectory(directory, {
    createAncestors: true,
    ignoreExisting: true,
  });
  await Zotero.launchFile(directory);
  return directory;
}

export async function registerArtifactStorageNotifier(): Promise<
  string | undefined
> {
  const notifier = Zotero.Notifier;
  if (!notifier || typeof notifier.registerObserver !== "function") return;
  return notifier.registerObserver(
    {
      notify: async (
        event: _ZoteroTypes.Notifier.Event,
        type: _ZoteroTypes.Notifier.Type,
        ids: string[] | number[],
        extraData: Record<string | number, unknown>,
      ) => {
        if (event !== "delete" || type !== "item") return;
        for (const id of ids) {
          const value = extraData?.[id];
          if (!value || typeof value !== "object") continue;
          const data = value as Record<string, unknown>;
          const libraryID = Number(data?.libraryID);
          if (
            !Number.isInteger(libraryID) ||
            libraryID !== Number(Zotero.Libraries.userLibraryID)
          )
            continue;
          const item = data.item;
          const itemKey =
            data.key ||
            data.itemKey ||
            (item && typeof item === "object"
              ? (item as Record<string, unknown>).key
              : undefined);
          if (typeof itemKey !== "string") continue;
          try {
            await cleanupOwnedArtifactDirectory(itemKey);
          } catch (error) {
            Zotero.logError(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        }
      },
    },
    ["item"],
    "zoteroResearchDatabase-artifact-storage",
  );
}

export function unregisterArtifactStorageNotifier(
  observerID: string | undefined,
): void {
  if (observerID === undefined) return;
  Zotero.Notifier?.unregisterObserver(observerID);
}

export async function sha256File(path: string): Promise<string> {
  const bytes = await IOUtils.read(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function itemDirectory(root: string, itemKey: string): string {
  const normalizedRoot = normalizeStorageRoot(root);
  assertItemKey(itemKey);
  return PathUtils.join(normalizedRoot, itemKey);
}

function absoluteArtifactPath(root: string, relativePath: string): string {
  const parts = relativePath.split(/[\\/]/);
  if (!isSafeRelativeFileName(relativePath)) {
    throw new Error(`产物相对路径无效：${relativePath}`);
  }
  return PathUtils.join(normalizeStorageRoot(root), parts[0], parts[1]);
}

async function writeArtifactStorageManifest(
  root: string,
  itemKey: string,
  manifest: ArtifactStorageManifest,
): Promise<void> {
  const directory = itemDirectory(root, itemKey);
  await IOUtils.makeDirectory(directory, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const normalized: ArtifactStorageManifest = {
    schemaVersion: 1,
    itemKey,
    files: manifest.files,
    updatedAt: new Date().toISOString(),
  };
  const manifestPath = PathUtils.join(directory, ARTIFACT_STORAGE_MANIFEST);
  const temporaryPath = `${manifestPath}.tmp-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  const encoded = JSON.stringify(normalized, null, 2);
  try {
    await IOUtils.writeUTF8(temporaryPath, encoded);
    const written = parseArtifactStorageManifest(
      new TextDecoder().decode(await IOUtils.read(temporaryPath)),
      itemKey,
    );
    if (JSON.stringify(written.files) !== JSON.stringify(normalized.files)) {
      throw new Error("产物清单写入校验失败");
    }
    if (typeof (IOUtils as any).move === "function") {
      await (IOUtils as any).move(temporaryPath, manifestPath, {
        noOverwrite: false,
      });
    } else if (typeof (IOUtils as any).copy === "function") {
      await (IOUtils as any).copy(temporaryPath, manifestPath);
      await IOUtils.remove(temporaryPath, { ignoreAbsent: true });
    } else {
      await IOUtils.writeUTF8(manifestPath, encoded);
      await IOUtils.remove(temporaryPath, { ignoreAbsent: true });
    }
  } catch (error) {
    await IOUtils.remove(temporaryPath, { ignoreAbsent: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

async function linkArtifactFile(
  path: string,
  parent: Zotero.Item,
  title: string,
): Promise<Zotero.Item> {
  // The relative-path API is anchored to Zotero's global baseAttachmentPath.
  // The plugin root is intentionally independent so changing it cannot alter
  // how unrelated linked attachments resolve. Use the absolute-path API here.
  const linkFromFile = Zotero.Attachments.linkFromFile;
  if (typeof linkFromFile !== "function") {
    throw new Error("当前 Zotero 不支持 linked file 附件");
  }
  const attachment = await linkFromFile.call(Zotero.Attachments, {
    file: path,
    parentItemID: parent.id,
    title,
  });
  if (!isLinkedFileAttachment(attachment)) {
    try {
      await attachment.eraseTx();
    } catch {
      // Preserve the original failure if cleanup itself is unavailable.
    }
    throw new Error("Zotero 创建的产物附件不是 linked file");
  }
  const linkedPath = await attachment.getFilePathAsync();
  if (typeof linkedPath !== "string" || !(await IOUtils.exists(linkedPath))) {
    try {
      await attachment.eraseTx();
    } catch {
      // Preserve the original failure if cleanup itself is unavailable.
    }
    throw new Error("Zotero 创建的 linked file 无法回读");
  }
  return attachment;
}

async function getAttachmentByKey(
  libraryID: number,
  key: string,
): Promise<Zotero.Item | undefined> {
  const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
  return item || undefined;
}

function isStoredFileAttachment(item: Zotero.Item): boolean {
  return Boolean(
    (typeof item.isStoredFileAttachment === "function" &&
      item.isStoredFileAttachment()) ||
    item.attachmentLinkMode === 0,
  );
}

function isLinkedFileAttachment(item: Zotero.Item): boolean {
  return Boolean(
    (typeof item.isLinkedFileAttachment === "function" &&
      item.isLinkedFileAttachment()) ||
    item.attachmentLinkMode === (Zotero.Attachments.LINK_MODE_LINKED_FILE ?? 2),
  );
}

function isSafeRelativeFileName(
  relativePath: string,
  expectedItemKey?: string,
): boolean {
  const parts = relativePath.split(/[\\/]/);
  return (
    parts.length === 2 &&
    /^[A-Z0-9]{8}$/i.test(parts[0]) &&
    (!expectedItemKey || parts[0] === expectedItemKey) &&
    Boolean(parts[1]) &&
    parts[1] !== "." &&
    parts[1] !== ".." &&
    !parts[1].includes("..\\") &&
    !parts[1].includes("../") &&
    parts[1] !== ARTIFACT_STORAGE_MANIFEST &&
    !isReservedWindowsFileName(parts[1]) &&
    ![...parts[1]].some(
      (character) =>
        character.charCodeAt(0) <= 0x1f || '<>:"|?*'.includes(character),
    )
  );
}

function isReservedWindowsFileName(fileName: string): boolean {
  const normalized = fileName.replace(/[. ]+$/g, "");
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[. ].*)?$/i.test(normalized);
}

async function isFilesystemLink(path: string): Promise<boolean> {
  const pathToFile = Zotero.File?.pathToFile;
  if (typeof pathToFile !== "function") return false;
  try {
    const file = pathToFile(path);
    return typeof file?.isSymlink === "function" && file.isSymlink();
  } catch {
    // If the path cannot be inspected, cleanup must fail closed.
    return true;
  }
}

function normalizePath(value: string): string {
  const normalizer = PathUtils.normalize;
  return typeof normalizer === "function" ? normalizer(value) : value;
}

async function chooseAvailableArtifactFileName(
  directory: string,
  desiredName: string,
  occupied: Set<string>,
): Promise<string> {
  let candidate = chooseArtifactFileName(desiredName, occupied);
  while (await IOUtils.exists(PathUtils.join(directory, candidate))) {
    occupied.add(candidate);
    candidate = chooseArtifactFileName(desiredName, occupied);
  }
  return candidate;
}

async function copyFile(sourcePath: string, targetPath: string): Promise<void> {
  const ioUtils = IOUtils;
  if (typeof ioUtils.copy === "function") {
    await ioUtils.copy(sourcePath, targetPath);
    return;
  }
  if (typeof ioUtils.write !== "function") {
    throw new Error("当前 Zotero 不支持复制产物文件");
  }
  await ioUtils.write(targetPath, await IOUtils.read(sourcePath));
}

function isWithinDirectory(path: string, directory: string): boolean {
  const normalize = (value: string) =>
    normalizePath(value)
      .replace(/[\\/]+/g, "/")
      .replace(/\/$/, "")
      .toLocaleLowerCase();
  const normalizedPath = normalize(path);
  const normalizedDirectory = normalize(directory);
  return (
    normalizedPath === normalizedDirectory ||
    normalizedPath.startsWith(`${normalizedDirectory}/`)
  );
}

function assertItemKey(itemKey: string): void {
  if (!/^[A-Z0-9]{8}$/i.test(itemKey)) {
    throw new Error(`无效的 Zotero itemKey：${itemKey}`);
  }
}
