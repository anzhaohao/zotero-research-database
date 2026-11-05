import type JSZip from "jszip";

export interface MinerUArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

let jsZipFallbackQueue: Promise<void> = Promise.resolve();

/** Read every entry once so parsing and shared-store writes can reuse it. */
export async function readMinerUArchiveEntries(
  bytes: Uint8Array,
): Promise<MinerUArchiveEntry[]> {
  return hasNativeZipReader()
    ? readNativeMinerUArchiveEntries(bytes)
    : readJSZipMinerUArchiveEntries(bytes);
}

function hasNativeZipReader(): boolean {
  return (
    typeof Components !== "undefined" &&
    typeof PathUtils !== "undefined" &&
    typeof IOUtils !== "undefined"
  );
}

async function readJSZipMinerUArchiveEntries(
  bytes: Uint8Array,
): Promise<MinerUArchiveEntry[]> {
  if (typeof (globalThis as any).setImmediate === "function")
    return readJSZipEntries(bytes);

  // JSZip 3.10 calls setImmediate directly, which Zotero sandboxes may omit.
  // Serialize the fallback so the temporary scheduler is always restored.
  const pending = jsZipFallbackQueue.then(() =>
    withTemporaryImmediate(() => readJSZipEntries(bytes)),
  );
  jsZipFallbackQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

async function withTemporaryImmediate<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const target = globalThis as unknown as Record<string, any>;
  if (typeof target.setImmediate === "function") return operation();
  const hadOwnValue = Object.prototype.hasOwnProperty.call(
    target,
    "setImmediate",
  );
  const previous = target.setImmediate;
  target.setImmediate = (callback: (...args: any[]) => void, ...args: any[]) =>
    setTimeout(callback, 0, ...args);
  try {
    return await operation();
  } finally {
    if (hadOwnValue) target.setImmediate = previous;
    else delete target.setImmediate;
  }
}

async function readJSZipEntries(
  bytes: Uint8Array,
): Promise<MinerUArchiveEntry[]> {
  // Avoid JSZip's global scheduler polyfill when Gecko's native reader is used.
  const { default: JSZip } = await import("jszip");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new Error("无法打开 MinerU 结果压缩包", { cause: error });
  }
  try {
    const entries: MinerUArchiveEntry[] = [];
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      entries.push({
        name: entry.name,
        bytes: await entry.async("uint8array"),
      });
    }
    return entries;
  } catch (error) {
    throw new Error("无法读取 MinerU 结果压缩包", { cause: error });
  }
}

async function readNativeMinerUArchiveEntries(
  bytes: Uint8Array,
): Promise<MinerUArchiveEntry[]> {
  const temporaryPath = PathUtils.join(
    PathUtils.tempDir,
    `zrdb-mineru-result-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
  );
  let reader: nsIZipReader | undefined;
  try {
    await (IOUtils as any).write(temporaryPath, bytes);
    const file = (Components.classes as any)[
      "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile) as nsIFile;
    file.initWithPath(temporaryPath);
    reader = (Components.classes as any)[
      "@mozilla.org/libjar/zip-reader;1"
    ].createInstance(Components.interfaces.nsIZipReader) as nsIZipReader;
    reader.open(file);
    const entries: MinerUArchiveEntry[] = [];
    const iterator = reader.findEntries("*");
    while (iterator.hasMore()) {
      const name = iterator.getNext();
      if (reader.getEntry(name).isDirectory) continue;
      entries.push({ name, bytes: readNativeZipEntry(reader, name) });
    }
    return entries;
  } catch (error) {
    throw new Error("Zotero 无法读取 MinerU 结果压缩包", { cause: error });
  } finally {
    try {
      reader?.close();
    } catch {
      // The reader may already be closed after a malformed archive error.
    }
    await IOUtils.remove(temporaryPath, { ignoreAbsent: true });
  }
}

function readNativeZipEntry(reader: nsIZipReader, name: string): Uint8Array {
  const input = reader.getInputStream(name);
  try {
    const binary = (Components.classes as any)[
      "@mozilla.org/binaryinputstream;1"
    ].createInstance(
      Components.interfaces.nsIBinaryInputStream,
    ) as nsIBinaryInputStream;
    binary.setInputStream(input);
    return Uint8Array.from(binary.readByteArray(Number(binary.available())));
  } finally {
    input.close();
  }
}
