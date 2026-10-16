/** Runtime-only adapter for the optional Zotero Figure plugin.
 *
 * Nothing returned by this module is written to Extra, tags, attachments, or
 * synced workspace data. The adapter deliberately uses feature detection so
 * the database view remains usable when Zotero Figure is absent or changes its
 * internal API.
 */
import { resolvePrimaryPdf } from "./primaryPdf";

export type ZoteroFigureKind = "figure" | "table" | "formula";

export interface ZoteroFigureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ZoteroFigureRecord {
  provider: "zotero-figure";
  id: string;
  entryID: string;
  libraryID?: number;
  itemID: number;
  itemKey?: string;
  attachmentKey?: string;
  sourcePdfAttachmentKey?: string;
  kind: ZoteroFigureKind;
  caption: string;
  pageIndex: number;
  rect?: ZoteroFigureRect;
  latex?: string;
  imageRef?: string;
  cacheRevision?: number;
}

export function zoteroFigureImageSignature(record: ZoteroFigureRecord): string {
  return `${record.entryID}:${record.cacheRevision || 0}`;
}

type Gallery = {
  getBootstrap?: () => unknown;
  loadLibrary?: (libraryID: number) => unknown;
  entries?: unknown[] | (() => unknown[] | Promise<unknown[]>);
  items?: unknown[] | (() => unknown[] | Promise<unknown[]>);
  list?: () => unknown[] | Promise<unknown[]>;
  getAll?: () => unknown[] | Promise<unknown[]>;
  readImage?: (id: string) => unknown;
  openSource?: (id: string) => unknown;
};

const libraryEntriesCache = new Map<number, Promise<unknown[]>>();
const libraryCacheRevision = new Map<number, number>();

function gallery(): Gallery | undefined {
  const value = (globalThis as any).Zotero?.["ZoteroFigure"]?.api?.gallery;
  return value && typeof value === "object" ? (value as Gallery) : undefined;
}

export function hasZoteroFigure(): boolean {
  return Boolean(gallery());
}

async function resolveEntries(value: unknown): Promise<unknown[]> {
  if (typeof value === "function") {
    const result = await value();
    return Array.isArray(result) ? result : [];
  }
  return Array.isArray(value) ? value : [];
}

function entriesFromSnapshot(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  for (const key of ["entries", "items", "results", "figures"]) {
    if (Array.isArray(row[key])) return row[key] as unknown[];
    if (row[key] instanceof Map)
      return [...(row[key] as Map<unknown, unknown>).values()];
    if (row[key] && typeof row[key] === "object")
      return Object.values(row[key] as Record<string, unknown>);
  }
  return [];
}

async function loadGalleryEntries(libraryID?: number): Promise<unknown[]> {
  const api = gallery();
  if (!api) return [];
  if (libraryID !== undefined && api.loadLibrary) {
    const snapshot = await api.loadLibrary(libraryID);
    const values = entriesFromSnapshot(snapshot);
    if (values.length) return values;
  }
  if (api.getBootstrap) {
    const values = entriesFromSnapshot(await api.getBootstrap());
    if (values.length) return values;
  }
  for (const candidate of [api.entries, api.items]) {
    const values = await resolveEntries(candidate);
    if (values.length) return values;
  }
  for (const method of [api.list, api.getAll]) {
    if (!method) continue;
    const values = await resolveEntries(method.bind(api));
    if (values.length) return values;
  }
  return [];
}

export async function galleryEntries(libraryID?: number): Promise<unknown[]> {
  if (libraryID === undefined) return loadGalleryEntries();
  const current = libraryEntriesCache.get(libraryID);
  if (current) return current;
  const task = loadGalleryEntries(libraryID);
  libraryEntriesCache.set(libraryID, task);
  void task.catch(() => {
    if (libraryEntriesCache.get(libraryID) === task)
      libraryEntriesCache.delete(libraryID);
  });
  return task;
}

/** Explicitly invalidate one library (or all libraries) before manual refresh. */
export function invalidateZoteroFigureCache(libraryID?: number): void {
  if (libraryID === undefined) {
    libraryEntriesCache.clear();
    for (const id of libraryCacheRevision.keys())
      libraryCacheRevision.set(id, (libraryCacheRevision.get(id) || 0) + 1);
  } else {
    libraryEntriesCache.delete(libraryID);
    libraryCacheRevision.set(
      libraryID,
      (libraryCacheRevision.get(libraryID) || 0) + 1,
    );
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberValue(...values: unknown[]): number | undefined {
  for (const value of values) {
    const result = Number(value);
    if (Number.isFinite(result)) return result;
  }
  return undefined;
}

function normalizeKind(value: unknown): ZoteroFigureKind | undefined {
  const kind = String(value || "").toLocaleLowerCase();
  if (["figure", "fig", "image", "chart", "graphic"].includes(kind))
    return "figure";
  if (["table", "tab"].includes(kind)) return "table";
  if (["formula", "equation", "math"].includes(kind)) return "formula";
  return undefined;
}

function normalizeRect(value: unknown): ZoteroFigureRect | undefined {
  let values: number[] | undefined;
  if (Array.isArray(value) && value.length >= 4)
    values = value.slice(0, 4).map(Number);
  else if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const x = numberValue(row.x, row.left);
    const y = numberValue(row.y, row.top);
    const width = numberValue(row.width);
    const height = numberValue(row.height);
    if ([x, y, width, height].every((entry) => entry !== undefined))
      return {
        x: x!,
        y: y!,
        width: width!,
        height: height!,
      };
    values = [
      numberValue(row.x0, row.left),
      numberValue(row.y0, row.top),
      numberValue(row.x1, row.right),
      numberValue(row.y1, row.bottom),
    ].map((entry) => Number(entry));
  }
  if (!values || values.some((entry) => !Number.isFinite(entry))) return;
  const [x0, y0, x1, y1] = values;
  if (x1 <= x0 || y1 <= y0) return;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Normalize a Zotero Figure gallery entry without invoking any I/O. */
export function normalizeGalleryEntry(
  value: unknown,
): ZoteroFigureRecord | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  const entryID = firstString(row.id, row.entryID, row.key, row.uuid);
  const kind = normalizeKind(row.kind || row.type || row.category);
  const itemID = numberValue(row.documentItemID, row.itemID, row.parentItemID);
  if (!entryID || !kind || itemID === undefined) return;
  const pageIndex = Math.max(
    0,
    Math.floor(numberValue(row.pageIndex, row.page_idx, row.page) || 0),
  );
  const rect = normalizeRect(row.rect || row.bbox || row.position);
  return {
    provider: "zotero-figure",
    id: `zotero-figure:${entryID}`,
    entryID,
    itemID,
    itemKey: firstString(row.documentItemKey, row.itemKey, row.parentItemKey),
    attachmentKey: firstString(row.attachmentKey, row.imageAttachmentKey),
    sourcePdfAttachmentKey: firstString(
      row.sourcePdfAttachmentKey,
      row.pdfAttachmentKey,
    ),
    kind,
    caption: firstString(row.comment, row.caption, row.label, row.title) || "",
    pageIndex,
    rect,
    latex: firstString(row.latex, row.tex),
    imageRef: firstString(row.image, row.imagePath, row.path, row.imageRef),
  };
}

export async function listZoteroFigures(
  item: Zotero.Item,
  allowedKinds: Set<ZoteroFigureKind> = new Set(["figure", "table", "formula"]),
): Promise<ZoteroFigureRecord[]> {
  if (!hasZoteroFigure()) return [];
  const entries = await galleryEntries(item.libraryID);
  const result: ZoteroFigureRecord[] = [];
  const seen = new Set<string>();
  for (const value of entries) {
    const record = normalizeGalleryEntry(value);
    if (!record || record.itemID !== item.id || !allowedKinds.has(record.kind))
      continue;
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    record.libraryID = item.libraryID;
    record.itemKey ||= item.key;
    record.cacheRevision = libraryCacheRevision.get(item.libraryID) || 0;
    result.push(record);
  }
  return result;
}

function imageMime(path: string): string {
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.webp$/i.test(path)) return "image/webp";
  return "image/png";
}

function extensionForMime(mime: string): string {
  if (/jpe?g/i.test(mime)) return ".jpg";
  if (/webp/i.test(mime)) return ".webp";
  return ".png";
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const source = value.replace(/\s+/g, "");
    const padding = source.endsWith("==") ? 2 : source.endsWith("=") ? 1 : 0;
    const bytes = new Uint8Array(Math.floor((source.length * 3) / 4) - padding);
    const chunkSize = 32_768; // divisible by four; avoids one huge binary string
    let outputOffset = 0;
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      const binary = (globalThis as any).atob(
        source.slice(offset, offset + chunkSize),
      );
      for (let index = 0; index < binary.length; index++)
        bytes[outputOffset++] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

async function bytesFromImage(
  value: unknown,
): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
  if (value instanceof Uint8Array)
    return { bytes: value, mimeType: "image/png" };
  if (value instanceof ArrayBuffer)
    return { bytes: new Uint8Array(value), mimeType: "image/png" };
  if (ArrayBuffer.isView(value))
    return {
      bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      mimeType: "image/png",
    };
  if (typeof Blob !== "undefined" && value instanceof Blob)
    return {
      bytes: new Uint8Array(await value.arrayBuffer()),
      mimeType: value.type || "image/png",
    };
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (typeof row.base64 === "string") {
      const bytes = decodeBase64(row.base64);
      if (bytes?.length)
        return {
          bytes,
          mimeType:
            typeof row.mimeType === "string" &&
            row.mimeType.startsWith("image/")
              ? row.mimeType
              : "image/png",
        };
    }
  }
  return undefined;
}

async function cachePath(record: ZoteroFigureRecord): Promise<string> {
  const directory = PathUtils.join(
    (globalThis as any).PathUtils.profileDir,
    "zotero-research-database",
    "figure-cache",
    String(record.libraryID ?? 0),
    record.itemKey || String(record.itemID),
    String(record.cacheRevision || 0),
  );
  await IOUtils.makeDirectory(directory, { ignoreExisting: true });
  const safeID = record.entryID.replace(/[^a-z0-9._-]/gi, "_").slice(0, 100);
  return PathUtils.join(directory, `${safeID}.png`);
}

function normalizedPath(value: string): string {
  return value
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLocaleLowerCase();
}

/** Select only direct numeric revision children under one validated item cache. */
export function obsoleteFigureRevisionDirectories(
  itemDirectory: string,
  children: string[],
  currentRevision: number,
): string[] {
  const parent = normalizedPath(itemDirectory);
  return children.filter((child) => {
    const normalized = normalizedPath(child);
    const separator = normalized.lastIndexOf("/");
    if (separator < 0 || normalized.slice(0, separator) !== parent)
      return false;
    const leaf = normalized.slice(separator + 1);
    return /^\d+$/.test(leaf) && Number(leaf) !== currentRevision;
  });
}

/** Remove stale local-only revisions for exactly one Zotero item cache. */
export async function cleanupObsoleteFigureCache(
  record: ZoteroFigureRecord,
): Promise<void> {
  if (
    !Number.isInteger(record.libraryID) ||
    Number(record.libraryID) < 0 ||
    !record.itemKey ||
    !/^[A-Z0-9]{8}$/i.test(record.itemKey)
  )
    return;
  const itemDirectory = PathUtils.join(
    (globalThis as any).PathUtils.profileDir,
    "zotero-research-database",
    "figure-cache",
    String(record.libraryID),
    record.itemKey,
  );
  try {
    const io = IOUtils as any;
    if (!(await io.exists(itemDirectory)) || !io.getChildren) return;
    const children = await io.getChildren(itemDirectory);
    const obsolete = obsoleteFigureRevisionDirectories(
      itemDirectory,
      Array.isArray(children) ? children.map(String) : [],
      record.cacheRevision || 0,
    );
    for (const directory of obsolete)
      await io.remove(directory, { recursive: true, ignoreAbsent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (globalThis as any).Zotero?.logError?.(
      new Error(`[ZRDB Zotero Figure cache] cleanup failed: ${message}`),
    );
  }
}

/** Open Zotero Figure's public UI when the installed version exposes one. */
export async function openZoteroFigureParserUI(): Promise<boolean> {
  const plugin = (globalThis as any).Zotero?.["ZoteroFigure"];
  const candidates: Array<[unknown, unknown]> = [
    [plugin?.api?.openGallery, plugin?.api],
    [plugin?.api?.openManager, plugin?.api],
    [plugin?.api?.ui?.open, plugin?.api?.ui],
    [plugin?.openGallery, plugin],
  ];
  for (const [candidate, owner] of candidates) {
    if (typeof candidate !== "function") continue;
    await candidate.call(owner);
    return true;
  }
  return false;
}

export async function readZoteroFigureImage(
  record: ZoteroFigureRecord,
): Promise<{ path?: string; dataUrl?: string }> {
  // Local cache maintenance is best-effort and must never delay or break image
  // loading, MinerU fallback, or Zotero's own files.
  void cleanupObsoleteFigureCache(record);
  if (record.imageRef && /^data:image\//i.test(record.imageRef))
    return { dataUrl: record.imageRef };
  if (record.imageRef && !/^data:image\//i.test(record.imageRef)) {
    try {
      if (await IOUtils.exists(record.imageRef)) {
        return {
          path: record.imageRef,
          dataUrl: await Promise.resolve(
            Zotero.File.generateDataURI(
              record.imageRef,
              imageMime(record.imageRef),
            ) as unknown as string | Promise<string>,
          ),
        };
      }
    } catch {
      // Fall through to the gallery reader and local cache.
    }
  }
  const path = await cachePath(record);
  for (const candidate of [
    path,
    path.replace(/\.png$/i, ".jpg"),
    path.replace(/\.png$/i, ".webp"),
  ]) {
    if (await IOUtils.exists(candidate)) {
      return {
        path: candidate,
        dataUrl: await Promise.resolve(
          Zotero.File.generateDataURI(
            candidate,
            imageMime(candidate),
          ) as unknown as string | Promise<string>,
        ),
      };
    }
  }
  const api = gallery();
  const raw = api?.readImage ? await api.readImage(record.entryID) : undefined;
  if (typeof raw === "string") {
    if (/^data:image\//i.test(raw)) return { dataUrl: raw };
    if (await IOUtils.exists(raw)) {
      return {
        path: raw,
        dataUrl: await Promise.resolve(
          Zotero.File.generateDataURI(raw, imageMime(raw)) as unknown as
            string | Promise<string>,
        ),
      };
    }
  }
  const image = await bytesFromImage(raw);
  if (!image?.bytes.length) return {};
  const outputPath = path.replace(/\.png$/i, extensionForMime(image.mimeType));
  await (IOUtils as any).write(outputPath, image.bytes);
  return {
    path: outputPath,
    dataUrl: await Promise.resolve(
      Zotero.File.generateDataURI(outputPath, image.mimeType) as unknown as
        string | Promise<string>,
    ),
  };
}

export async function openZoteroFigureImage(
  record: ZoteroFigureRecord,
): Promise<void> {
  const image = await readZoteroFigureImage(record);
  if (image.path) await Zotero.launchFile(image.path);
}

export async function openZoteroFigureSource(
  record: ZoteroFigureRecord,
  item: Zotero.Item,
): Promise<void> {
  const api = gallery();
  if (api?.openSource) {
    const result = await api.openSource(record.entryID);
    if (result !== false) return;
  }
  const pdf =
    (record.sourcePdfAttachmentKey
      ? await Zotero.Items.getByLibraryAndKeyAsync(
          item.libraryID,
          record.sourcePdfAttachmentKey,
        )
      : undefined) || (await resolvePrimaryPdf(item))?.attachment;
  if (!pdf) return;
  const location = record.rect
    ? {
        position: {
          pageIndex: record.pageIndex,
          rects: [
            [
              record.rect.x,
              record.rect.y,
              record.rect.x + record.rect.width,
              record.rect.y + record.rect.height,
            ],
          ],
        },
      }
    : { pageIndex: record.pageIndex };
  if ((Zotero.Reader as any)?.open)
    await (Zotero.Reader as any).open(pdf.id, location);
  else await (Zotero.FileHandlers as any).open(pdf, { location });
}
