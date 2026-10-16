/** Lightweight first-page PDF preview service.
 *
 * It deliberately never opens a Zotero Reader. Only visible table rows should
 * call this service, and the small in-memory cache prevents repeated PDF.js
 * work while scrolling. Zotero's bundled PDF.js is loaded lazily at runtime.
 */
import { resolvePrimaryPdf } from "./primaryPdf";
import { readLru, writeLru } from "../core/lruCache";

export interface PdfThumbnailResult {
  dataUrl?: string;
  /** Local cache path, when a disk-backed image was generated. */
  path?: string;
  reason?: "no-pdf" | "unreadable" | "unsupported";
}

interface PdfDocument {
  numPages: number;
  getPage(index: number): Promise<{
    getViewport(options: { scale: number }): { width: number; height: number };
    render(options: Record<string, unknown>): { promise: Promise<void> };
  }>;
  destroy?: () => void | Promise<void>;
}

type PdfJs = {
  GlobalWorkerOptions?: {
    workerSrc?: string;
  };
  getDocument(options: Record<string, unknown>): {
    promise: Promise<PdfDocument>;
  };
};

const cache = new Map<string, PdfThumbnailResult>();
const pending = new Map<string, Promise<PdfThumbnailResult>>();
const pageCountCache = new Map<string, number>();
const pageCountPending = new Map<string, Promise<number>>();
const PDF_THUMBNAIL_CACHE_LIMIT = 50;
const PDF_PAGE_COUNT_CACHE_LIMIT = 256;
let cacheGeneration = 0;
let active = 0;
const waiting: Array<() => void> = [];
let pdfJsPromise: Promise<PdfJs> | undefined;

const PDF_WORKER_URL = "resource://zotero/reader/pdf/build/pdf.worker.mjs";
const PDF_MODULE_URL = "resource://zotero/reader/pdf/build/pdf.mjs";

function mainWindow(): Window | undefined {
  return (globalThis as any).Zotero?.getMainWindow?.() as Window | undefined;
}

function logThumbnailError(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  Zotero.logError(new Error(`[ZRDB PDF thumbnail] ${stage}: ${message}`));
}

async function disposePdf(document: PdfDocument | undefined): Promise<void> {
  try {
    await document?.destroy?.();
  } catch (error) {
    logThumbnailError("release document", error);
  }
}

function rememberThumbnail(key: string, result: PdfThumbnailResult): void {
  if (key.startsWith(`${cacheGeneration}:`))
    writeLru(cache, key, result, PDF_THUMBNAIL_CACHE_LIMIT);
}

function pdfCacheKey(attachment: PdfAttachmentFile): string {
  return `${cacheGeneration}:${attachment.item.libraryID}:${attachment.item.key}:${attachment.path}:${attachment.modified}:${attachment.size}`;
}

async function withLimit<T>(task: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

async function loadPdfJs(): Promise<PdfJs> {
  if (pdfJsPromise) return pdfJsPromise;
  const task = (async () => {
    const window = mainWindow();
    // pdf.mjs reads navigator while initialising. ChromeUtils.importESModule()
    // evaluates it in the add-on/system realm, where Zotero 9's sandbox has
    // no navigator; dynamically importing it from the main Zotero window
    // gives PDF.js its expected browser globals.
    if (window?.eval) {
      const pdfJs = (await window.eval(
        `import(${JSON.stringify(PDF_MODULE_URL)})`,
      )) as PdfJs;
      if (pdfJs.GlobalWorkerOptions && !pdfJs.GlobalWorkerOptions.workerSrc) {
        pdfJs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      }
      return pdfJs;
    }
    // Older Zotero builds may not expose Window.eval to add-ons. Retain a
    // best-effort fallback for those builds, with a clear runtime error if it
    // is not browser-capable.
    const chromeUtils =
      (window as any)?.ChromeUtils || (globalThis as any).ChromeUtils;
    if (chromeUtils?.importESModule) {
      const pdfJs = chromeUtils.importESModule(PDF_MODULE_URL) as PdfJs;
      if (pdfJs.GlobalWorkerOptions && !pdfJs.GlobalWorkerOptions.workerSrc) {
        pdfJs.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      }
      return pdfJs;
    }
    const loader = (globalThis as any).Zotero?.Reader?.PDFJS;
    if (loader?.getDocument) return loader as PdfJs;
    throw new Error("Zotero PDF.js 不可用");
  })();
  pdfJsPromise = task;
  // A temporarily unavailable main window or worker must not keep a rejected
  // module promise forever. Only clear the exact task that failed: a later
  // successful retry must never be reset by an older rejection callback.
  void task.catch(() => {
    if (pdfJsPromise === task) pdfJsPromise = undefined;
  });
  return task;
}

interface PdfAttachmentFile {
  item: Zotero.Item;
  path: string;
  modified: number;
  size: number;
}

async function resolvePdfAttachment(
  item: Zotero.Item,
): Promise<PdfAttachmentFile | undefined> {
  let attachment: Zotero.Item | undefined = item.isAttachment?.()
    ? item
    : undefined;
  if (!attachment) {
    attachment = (await resolvePrimaryPdf(item))?.attachment;
  }
  if (!attachment) return undefined;
  const path = await attachment.getFilePathAsync();
  if (!path) return undefined;
  const contentType = String(attachment.attachmentContentType || "");
  if (contentType && contentType !== "application/pdf" && !/\.pdf$/i.test(path))
    return undefined;
  const stat = await (globalThis as any).IOUtils.stat(path);
  return {
    item: attachment,
    path,
    modified: Number(stat.lastModified || 0),
    size: Number(stat.size || 0),
  };
}

async function bytesFor(path: string): Promise<Uint8Array | undefined> {
  const ioUtils = (globalThis as any).IOUtils;
  if (ioUtils?.read) return new Uint8Array(await ioUtils.read(path));
  const file = (globalThis as any).OS?.File;
  if (file?.read) return new Uint8Array(await file.read(path));
  return undefined;
}

async function cachedDataUrl(cachePath: string): Promise<string | undefined> {
  if (!(await IOUtils.exists(cachePath))) return undefined;
  try {
    // Zotero 9.0.6 implements this asynchronously even though older typings
    // described it as a synchronous string return.
    return await Promise.resolve(
      Zotero.File.generateDataURI(cachePath, "image/png") as unknown as
        string | Promise<string>,
    );
  } catch {
    return undefined;
  }
}

/** Disk-cache probe shared by PDF-region rendering and its regression tests. */
export async function readPdfRegionDiskCache(
  cachePath: string,
): Promise<PdfThumbnailResult | undefined> {
  const dataUrl = await cachedDataUrl(cachePath);
  return dataUrl ? { dataUrl, path: cachePath } : undefined;
}

async function writeCanvas(
  cachePath: string,
  canvas: HTMLCanvasElement,
): Promise<void> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) return;
  await (globalThis as any).IOUtils.write(
    cachePath,
    new Uint8Array(await blob.arrayBuffer()),
  );
}

/** Return the page count for the resolved primary PDF without opening Reader. */
export async function getPdfPageCount(item: Zotero.Item): Promise<number> {
  const attachment = await resolvePdfAttachment(item);
  if (!attachment) return 0;
  const key = pdfCacheKey(attachment);
  const cached = readLru(pageCountCache, key);
  if (cached !== undefined) return cached;
  const running = pageCountPending.get(key);
  if (running) return running;
  const task = withLimit(async () => {
    let documentProxy: PdfDocument | undefined;
    try {
      const bytes = await bytesFor(attachment.path);
      if (!bytes) return 0;
      const pdfjs = await loadPdfJs();
      documentProxy = await pdfjs.getDocument({
        data: bytes,
        annotationMode: 0,
        disableAutoFetch: true,
        disableStream: true,
        useWorkerFetch: false,
      }).promise;
      const count = Math.max(0, Number(documentProxy.numPages || 0));
      if (key.startsWith(`${cacheGeneration}:`))
        writeLru(pageCountCache, key, count, PDF_PAGE_COUNT_CACHE_LIMIT);
      return count;
    } catch (error) {
      logThumbnailError("read page count", error);
      return 0;
    } finally {
      await disposePdf(documentProxy);
    }
  });
  pageCountPending.set(key, task);
  try {
    return await task;
  } finally {
    pageCountPending.delete(key);
  }
}

/** Resolve the PDF attachment and render one page at a bounded width. */
export async function getPdfThumbnail(
  item: Zotero.Item,
  width = 112,
  pageNumber = 1,
): Promise<PdfThumbnailResult> {
  const attachment = await resolvePdfAttachment(item);
  if (!attachment) return { reason: "no-pdf" };
  const page = Math.max(1, Math.floor(pageNumber));
  const key = `${pdfCacheKey(attachment)}:${width}:${page}`;
  const existing = readLru(cache, key);
  if (existing) return existing;
  const running = pending.get(key);
  if (running) return running;
  const task = withLimit(async () => {
    let documentProxy: PdfDocument | undefined;
    try {
      const directory = PathUtils.join(
        (globalThis as any).PathUtils.profileDir,
        "zotero-research-database",
        "thumbnail-cache",
      );
      const cachePath = PathUtils.join(
        directory,
        `${attachment.item.libraryID}-${attachment.item.key}-${attachment.modified}-${attachment.size}-${width}-p${page}.png`,
      );
      // Disk caching must never make a valid thumbnail fail to display. A
      // read-only profile or a transient disk error simply skips the cache.
      try {
        await IOUtils.makeDirectory(directory, { ignoreExisting: true });
        const disk = await readPdfRegionDiskCache(cachePath);
        if (disk) {
          const result = disk;
          rememberThumbnail(key, result);
          return result;
        }
      } catch (error) {
        logThumbnailError("prepare cache", error);
      }
      const bytes = await bytesFor(attachment.path);
      if (!bytes) return { reason: "no-pdf" as const };
      const pdfjs = await loadPdfJs();
      documentProxy = await pdfjs.getDocument({
        data: bytes,
        annotationMode: 0,
        disableAutoFetch: true,
        disableStream: true,
        useWorkerFetch: false,
      }).promise;
      if (page > Number(documentProxy.numPages || 0)) {
        return { reason: "unreadable" as const };
      }
      const pdfPage = await documentProxy.getPage(page);
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const scale = Math.max(0.1, Math.min(2, width / baseViewport.width));
      const viewport = pdfPage.getViewport({ scale });
      const doc =
        mainWindow()?.document ||
        ((globalThis as any).document as Document | undefined);
      if (!doc) return { reason: "unsupported" as const };
      const canvas = doc.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const canvasContext = canvas.getContext("2d");
      if (!canvasContext) return { reason: "unsupported" as const };
      await pdfPage.render({
        canvasContext,
        viewport,
        annotationMode: 0,
      }).promise;
      const result = {
        dataUrl: canvas.toDataURL("image/png"),
        path: cachePath,
      };
      try {
        await writeCanvas(cachePath, canvas);
      } catch (error) {
        logThumbnailError("write cache", error);
      }
      rememberThumbnail(key, result);
      return result;
    } catch (error) {
      logThumbnailError("render page", error);
      // Do not poison the in-memory cache after a transient worker, canvas or
      // file-access failure. The next visible-row pass can retry the PDF.
      return { reason: "unreadable" as const };
    } finally {
      await disposePdf(documentProxy);
    }
  });
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

export interface PdfRegion {
  /** Normalized page coordinates (0..1), as stored in the MinerU manifest. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MinerUFigureRenderPlan {
  previewWidth?: number;
  openWidth?: number;
  fallbackToAttachment: boolean;
}

/** Keep preview work bounded while reserving a full-resolution click target. */
export function mineruFigureRenderPlan(
  hasRegion: boolean,
  quality: string,
): MinerUFigureRenderPlan {
  if (!hasRegion || quality === "standard")
    return { fallbackToAttachment: true };
  return {
    previewWidth: 720,
    openWidth: 2400,
    fallbackToAttachment: false,
  };
}

/** Render a bounded PDF region at high resolution without modifying attachments. */
export async function getPdfRegionThumbnail(
  item: Zotero.Item,
  pageIndex: number,
  region: PdfRegion,
  width = 640,
): Promise<PdfThumbnailResult> {
  const attachment = await resolvePdfAttachment(item);
  if (!attachment) return { reason: "no-pdf" };
  const x = Math.max(0, Math.min(1, Number(region.x)));
  const y = Math.max(0, Math.min(1, Number(region.y)));
  const w = Math.max(0, Math.min(1 - x, Number(region.width)));
  const h = Math.max(0, Math.min(1 - y, Number(region.height)));
  if (!(w > 0 && h > 0)) return { reason: "unreadable" };
  const page = Math.max(1, Math.floor(pageIndex) + 1);
  const targetWidth = Math.max(160, Math.min(2400, Math.floor(width)));
  const key = `${pdfCacheKey(attachment)}:region:${page}:${x.toFixed(5)}:${y.toFixed(5)}:${w.toFixed(5)}:${h.toFixed(5)}:${targetWidth}`;
  const existing = readLru(cache, key);
  if (existing) return existing;
  const running = pending.get(key);
  if (running) return running;
  const directory = PathUtils.join(
    (globalThis as any).PathUtils.profileDir,
    "zotero-research-database",
    "figure-cache",
    "pdf-regions",
  );
  const cachePath = PathUtils.join(
    directory,
    `${attachment.item.libraryID}-${attachment.item.key}-${attachment.modified}-${attachment.size}-${page}-${targetWidth}-${Math.round(x * 10000)}-${Math.round(y * 10000)}-${Math.round(w * 10000)}-${Math.round(h * 10000)}.png`,
  );
  const task = withLimit(async () => {
    let documentProxy: PdfDocument | undefined;
    try {
      try {
        await IOUtils.makeDirectory(directory, { ignoreExisting: true });
        const disk = await cachedDataUrl(cachePath);
        if (disk) {
          const result = { dataUrl: disk, path: cachePath };
          rememberThumbnail(key, result);
          return result;
        }
      } catch (error) {
        logThumbnailError("prepare PDF region cache", error);
      }
      const bytes = await bytesFor(attachment.path);
      if (!bytes) return { reason: "no-pdf" as const };
      const pdfjs = await loadPdfJs();
      documentProxy = await pdfjs.getDocument({
        data: bytes,
        annotationMode: 0,
        disableAutoFetch: true,
        disableStream: true,
        useWorkerFetch: false,
      }).promise;
      if (page > Number(documentProxy.numPages || 0)) {
        return { reason: "unreadable" as const };
      }
      const pdfPage = await documentProxy.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const requestedScale = targetWidth / (base.width * w);
      const pixelLimitedScale = Math.sqrt(
        16_000_000 / Math.max(1, base.width * w * base.height * h),
      );
      const scale = Math.max(
        0.5,
        Math.min(32, requestedScale, pixelLimitedScale),
      );
      const viewport = pdfPage.getViewport({ scale });
      const doc =
        mainWindow()?.document ||
        ((globalThis as any).document as Document | undefined);
      if (!doc) return { reason: "unsupported" as const };
      const canvas = doc.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width * w));
      canvas.height = Math.max(1, Math.ceil(viewport.height * h));
      const context = canvas.getContext("2d");
      if (!context) return { reason: "unsupported" as const };
      await pdfPage.render({
        canvasContext: context,
        viewport,
        annotationMode: 0,
        transform: [1, 0, 0, 1, -viewport.width * x, -viewport.height * y],
      }).promise;
      try {
        await writeCanvas(cachePath, canvas);
      } catch (error) {
        logThumbnailError("write PDF region cache", error);
      }
      const result = {
        dataUrl: canvas.toDataURL("image/png"),
        path: cachePath,
      };
      rememberThumbnail(key, result);
      return result;
    } catch (error) {
      logThumbnailError("render PDF region", error);
      return { reason: "unreadable" as const };
    } finally {
      await disposePdf(documentProxy);
    }
  });
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

export function clearPdfThumbnailCache(): void {
  cacheGeneration += 1;
  cache.clear();
  pageCountCache.clear();
}

/** Bounded diagnostics for host performance checks; no document data is exposed. */
export function getPdfThumbnailCacheStats() {
  return {
    thumbnails: cache.size,
    pageCounts: pageCountCache.size,
    pendingThumbnails: pending.size,
    pendingPageCounts: pageCountPending.size,
    active,
    queued: waiting.length,
    thumbnailLimit: PDF_THUMBNAIL_CACHE_LIMIT,
    pageCountLimit: PDF_PAGE_COUNT_CACHE_LIMIT,
  };
}
