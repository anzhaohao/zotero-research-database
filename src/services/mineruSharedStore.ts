import { readMinerUArchiveEntries } from "./mineruArchive";
import type { MinerUConversionResult, MinerUMode } from "./mineru";

const SHARED_STORE_SCHEMA_VERSION = 1;

export interface SharedMinerUIdentity {
  libraryID: number;
  attachmentKey: string;
  pdfSha256: string;
  pdfFileName: string;
}

interface SharedMinerUManifest {
  schemaVersion: number;
  status: "complete";
  pdfSha256: string;
  markdownPath: string;
  rawDirectory: string;
  sourceMode: MinerUMode | "cache-import";
  createdAt: string;
  files: Array<{ path: string; size: number }>;
}

export interface SharedMinerUClaim {
  paperDirectory: string;
  cacheHit: boolean;
  release(): Promise<void>;
}

function sharedIO(): any {
  return IOUtils as any;
}

function sharedNonce(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return (
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2) +
    Math.random().toString(36).slice(2)
  );
}

function sharedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}

function normalizeRelativePath(value: string): string {
  const parts = value
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== ".");
  if (!parts.length || parts.includes("..")) return "";
  return parts.join("/");
}

function safeIndexKey(identity: SharedMinerUIdentity): string {
  const key = identity.attachmentKey.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!Number.isInteger(identity.libraryID) || !key)
    throw new Error("共享 MinerU 索引缺少有效的 Zotero 附件标识");
  return identity.libraryID + "-" + key;
}

export function sharedMinerUPaperDirectory(
  root: string,
  pdfSha256: string,
): string {
  if (!/^[a-f0-9]{64}$/i.test(pdfSha256))
    throw new Error("共享 MinerU 缓存需要有效的 PDF SHA-256");
  return PathUtils.join(root, "papers", pdfSha256.toLocaleLowerCase());
}

async function readJSON(path: string): Promise<Record<string, any>> {
  return JSON.parse(
    sharedText(await Zotero.File.getContentsAsync(path, "utf-8")),
  ) as Record<string, any>;
}

/** Return only a complete, readable cache generation. */
export async function findSharedMinerUCache(
  root: string,
  pdfSha256: string,
): Promise<string> {
  if (!root.trim() || !/^[a-f0-9]{64}$/i.test(pdfSha256)) return "";
  const paperDirectory = sharedMinerUPaperDirectory(root, pdfSha256);
  return completeSharedMinerUCache(paperDirectory, pdfSha256);
}

async function completeSharedMinerUCache(
  paperDirectory: string,
  pdfSha256: string,
): Promise<string> {
  try {
    const manifest = (await readJSON(
      PathUtils.join(paperDirectory, "parse.json"),
    )) as unknown as SharedMinerUManifest;
    if (
      manifest.schemaVersion !== SHARED_STORE_SCHEMA_VERSION ||
      manifest.status !== "complete" ||
      manifest.pdfSha256?.toLocaleLowerCase() !==
        pdfSha256.toLocaleLowerCase() ||
      manifest.markdownPath !== "full.md" ||
      manifest.rawDirectory !== "raw" ||
      !Array.isArray(manifest.files)
    )
      return "";
    for (const entry of manifest.files) {
      const relative = normalizeRelativePath(String(entry?.path || ""));
      if (!relative) return "";
      const path = PathUtils.join(paperDirectory, ...relative.split("/"));
      if (!(await sharedIO().exists(path))) return "";
      const stat = await sharedIO().stat(path);
      if (
        !["file", "regular"].includes(stat.type) ||
        Number(stat.size) !== Number(entry.size)
      )
        return "";
    }
    const markdownPath = PathUtils.join(paperDirectory, "full.md");
    const markdown = sharedText(
      await Zotero.File.getContentsAsync(markdownPath, "utf-8"),
    );
    return markdown.trim() ? paperDirectory : "";
  } catch {
    return "";
  }
}

export async function findSharedMinerUCacheForAttachment(
  root: string,
  libraryID: number,
  attachmentKey: string,
): Promise<string> {
  try {
    const identity = { libraryID, attachmentKey } as SharedMinerUIdentity;
    const indexPath = PathUtils.join(
      root,
      "index",
      safeIndexKey(identity) + ".json",
    );
    const index = await readJSON(indexPath);
    return findSharedMinerUCache(root, String(index.pdfSha256 || ""));
  } catch {
    return "";
  }
}

export async function writeSharedMinerUIndex(
  root: string,
  identity: SharedMinerUIdentity,
  sourceMode: MinerUMode | "cache-import",
): Promise<void> {
  const directory = PathUtils.join(root, "index");
  await sharedIO().makeDirectory(directory, { ignoreExisting: true });
  const target = PathUtils.join(directory, safeIndexKey(identity) + ".json");
  const temporary = target + "." + sharedNonce() + ".tmp";
  try {
    await sharedIO().writeUTF8(
      temporary,
      JSON.stringify(
        {
          schemaVersion: SHARED_STORE_SCHEMA_VERSION,
          libraryID: identity.libraryID,
          attachmentKey: identity.attachmentKey,
          pdfSha256: identity.pdfSha256.toLocaleLowerCase(),
          pdfFileName: identity.pdfFileName,
          paperDirectory: "papers/" + identity.pdfSha256.toLocaleLowerCase(),
          sourceMode,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { overwrite: false },
    );
    await sharedIO().move(temporary, target, { overwrite: true });
  } finally {
    await sharedIO()
      .remove(temporary, { ignoreAbsent: true })
      .catch(() => undefined);
  }
}

async function writeBytes(
  root: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<{ path: string; size: number }> {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) throw new Error("MinerU 产物包含不安全的路径");
  const target = PathUtils.join(root, ...normalized.split("/"));
  const parent = PathUtils.join(root, ...normalized.split("/").slice(0, -1));
  await sharedIO().makeDirectory(parent, { ignoreExisting: true });
  await sharedIO().write(target, bytes, { overwrite: true });
  return { path: normalized, size: bytes.byteLength };
}

async function writeText(
  root: string,
  relativePath: string,
  text: string,
): Promise<{ path: string; size: number }> {
  return writeBytes(root, relativePath, new TextEncoder().encode(text));
}

function markdownDirectory(path: string): string {
  const normalized = normalizeRelativePath(path);
  return normalized.includes("/")
    ? normalized.slice(0, normalized.lastIndexOf("/"))
    : "";
}

/** Keep normalized full.md asset links valid after raw files are nested. */
export function rewriteSharedMinerUMarkdown(
  markdown: string,
  markdownSourcePath: string,
): string {
  const directory = markdownDirectory(markdownSourcePath);
  const prefix = "raw/" + (directory ? directory + "/" : "");
  return markdown.replace(
    /(!\[[^\]]*\]\()(<[^>]+>|[^)\s]+)(\))/g,
    (whole, start: string, target: string, end: string) => {
      const bracketed = target.startsWith("<") && target.endsWith(">");
      const value = bracketed ? target.slice(1, -1) : target;
      if (
        /^(?:[a-z][a-z\d+.-]*:|\/|#|\\)/i.test(value) ||
        value.startsWith("raw/")
      )
        return whole;
      const normalized = normalizeRelativePath(value);
      if (!normalized) return whole;
      const next = prefix + normalized;
      return start + (bracketed ? "<" + next + ">" : next) + end;
    },
  );
}

async function listFiles(directory: string, depth = 0): Promise<string[]> {
  if (depth > 12) return [];
  const output: string[] = [];
  for (const path of await sharedIO().getChildren(directory)) {
    const stat = await sharedIO().stat(path);
    if (stat.type === "directory")
      output.push(...(await listFiles(path, depth + 1)));
    else output.push(path);
  }
  return output;
}

function localRelativePath(root: string, path: string): string {
  const rootNormalized = root.replace(/[\\/]+$/, "");
  if (path.length <= rootNormalized.length) return "";
  return normalizeRelativePath(path.slice(rootNormalized.length + 1));
}

/** Commit a complete staged generation before replacing the current one. */
export async function writeSharedMinerUResult(options: {
  root: string;
  identity: SharedMinerUIdentity;
  result: MinerUConversionResult;
  sourceMode: MinerUMode | "cache-import";
  sourceDirectory?: string;
  overwrite?: boolean;
}): Promise<string> {
  const { root, identity, result, sourceMode, sourceDirectory } = options;
  const paperDirectory = sharedMinerUPaperDirectory(root, identity.pdfSha256);
  await sharedIO().makeDirectory(PathUtils.join(root, "papers"), {
    ignoreExisting: true,
  });
  const nonce = sharedNonce();
  const staging = paperDirectory + ".tmp-" + nonce;
  const previous = paperDirectory + ".old-" + nonce;
  const files: Array<{ path: string; size: number }> = [];
  let movedPrevious = false;
  try {
    await sharedIO().makeDirectory(staging, { ignoreExisting: false });
    let markdownSourcePath = result.markdownArchivePath || "full.md";
    if (result.archive?.byteLength) {
      const archiveEntries =
        result.archiveEntries ||
        (await readMinerUArchiveEntries(result.archive));
      for (const entry of archiveEntries) {
        const relative = normalizeRelativePath(entry.name);
        if (!relative || relative.toLocaleLowerCase() === "result.zip")
          throw new Error("MinerU ZIP 包含无效或冲突路径");
        files.push(await writeBytes(staging, "raw/" + relative, entry.bytes));
      }
      if (!archiveEntries.some((entry) => entry.name === markdownSourcePath)) {
        const candidate = archiveEntries.find((entry) =>
          /\.md$/i.test(entry.name),
        );
        if (!candidate) throw new Error("MinerU ZIP 中没有 Markdown");
        markdownSourcePath = candidate.name;
      }
      files.push(await writeBytes(staging, "raw/result.zip", result.archive));
    } else if (sourceDirectory) {
      for (const path of await listFiles(sourceDirectory)) {
        const relative = localRelativePath(sourceDirectory, path);
        if (!relative) continue;
        files.push(
          await writeBytes(
            staging,
            "raw/" + relative,
            await sharedIO().read(path),
          ),
        );
      }
      markdownSourcePath = "full.md";
    } else {
      for (const [index, figure] of result.figures.entries()) {
        const name = PathUtils.filename(figure.imageName) || "figure-" + index;
        files.push(
          await writeBytes(
            staging,
            "images/" + (index + 1) + "-" + name,
            figure.bytes,
          ),
        );
      }
      markdownSourcePath = "full.md";
    }
    files.push(
      await writeText(
        staging,
        "full.md",
        result.archive || sourceDirectory
          ? rewriteSharedMinerUMarkdown(result.markdown, markdownSourcePath)
          : result.markdown,
      ),
    );
    const manifest: SharedMinerUManifest = {
      schemaVersion: SHARED_STORE_SCHEMA_VERSION,
      status: "complete",
      pdfSha256: identity.pdfSha256.toLocaleLowerCase(),
      markdownPath: "full.md",
      rawDirectory: "raw",
      sourceMode,
      createdAt: new Date().toISOString(),
      files,
    };
    await sharedIO().writeUTF8(
      PathUtils.join(staging, "parse.json"),
      JSON.stringify(manifest, null, 2),
      { overwrite: false },
    );
    if (!(await completeSharedMinerUCache(staging, identity.pdfSha256)))
      throw new Error("新的 MinerU 共享产物未通过完整性校验");
    await writeSharedMinerUIndex(root, identity, sourceMode);
    if (await sharedIO().exists(paperDirectory)) {
      if (!options.overwrite) {
        if (await findSharedMinerUCache(root, identity.pdfSha256)) {
          await sharedIO().remove(staging, {
            recursive: true,
            ignoreAbsent: true,
          });
          return paperDirectory;
        }
        throw new Error("共享 MinerU 缓存已存在但未通过完整性检查");
      }
      await sharedIO().move(paperDirectory, previous, { overwrite: false });
      movedPrevious = true;
    }
    try {
      await sharedIO().move(staging, paperDirectory, { overwrite: false });
    } catch (error) {
      if (movedPrevious)
        await sharedIO().move(previous, paperDirectory, { overwrite: true });
      movedPrevious = false;
      throw error;
    }
    if (movedPrevious)
      await sharedIO()
        .remove(previous, { recursive: true, ignoreAbsent: true })
        .catch(() => undefined);
    return paperDirectory;
  } catch (error) {
    await sharedIO()
      .remove(staging, { recursive: true, ignoreAbsent: true })
      .catch(() => undefined);
    throw error;
  }
}

/** Check cache before locking, while waiting, and after lock acquisition. */
export async function claimSharedMinerUWork(options: {
  root: string;
  identity: SharedMinerUIdentity;
  timeoutMs: number;
  forceRefresh?: boolean;
  cancelled?: () => boolean;
  onWaiting?: () => void;
}): Promise<SharedMinerUClaim> {
  const { root, identity, forceRefresh } = options;
  const paperDirectory = sharedMinerUPaperDirectory(root, identity.pdfSha256);
  if (!forceRefresh) {
    const cached = await findSharedMinerUCache(root, identity.pdfSha256);
    if (cached)
      return { paperDirectory, cacheHit: true, release: async () => {} };
  }
  const lockDirectory = PathUtils.join(root, "locks");
  await sharedIO().makeDirectory(lockDirectory, { ignoreExisting: true });
  const lockPath = PathUtils.join(
    lockDirectory,
    identity.pdfSha256.toLocaleLowerCase() + ".lock",
  );
  const owner = sharedNonce();
  const deadline = Date.now() + Math.max(10_000, options.timeoutMs);
  const staleMs = Math.max(2 * 60 * 60 * 1000, options.timeoutMs * 2);
  let notified = false;
  while (Date.now() < deadline) {
    if (options.cancelled?.()) throw new Error("已取消 MinerU 任务");
    try {
      await sharedIO().writeUTF8(
        lockPath,
        JSON.stringify({ owner, createdAt: new Date().toISOString() }),
        { overwrite: false },
      );
      const release = async () => {
        try {
          const lock = await readJSON(lockPath);
          if (lock.owner === owner)
            await sharedIO().remove(lockPath, { ignoreAbsent: true });
        } catch {
          // Never remove another owner's lock during shutdown or races.
        }
      };
      if (!forceRefresh) {
        const cached = await findSharedMinerUCache(root, identity.pdfSha256);
        if (cached) {
          await release();
          return {
            paperDirectory,
            cacheHit: true,
            release: async () => {},
          };
        }
      }
      return {
        paperDirectory,
        cacheHit: false,
        release,
      };
    } catch (error) {
      if (options.cancelled?.()) throw error;
      if (!forceRefresh) {
        const cached = await findSharedMinerUCache(root, identity.pdfSha256);
        if (cached)
          return { paperDirectory, cacheHit: true, release: async () => {} };
      }
      try {
        const stat = await sharedIO().stat(lockPath);
        if (Date.now() - Number(stat.lastModified || 0) > staleMs)
          await sharedIO().remove(lockPath, { ignoreAbsent: true });
      } catch {
        // The owner may have released it between the failed create and stat.
      }
      if (!notified) {
        options.onWaiting?.();
        notified = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error("等待共享 MinerU 解析任务超时；请检查异常中断的锁");
}
