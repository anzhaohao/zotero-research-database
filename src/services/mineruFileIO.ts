/** Gecko's Windows file writer still needs extended paths beyond MAX_PATH. */
export function mineruNativePath(path: string): string {
  if (typeof Services === "undefined" || Services.appinfo?.OS !== "WINNT")
    return path;
  if (path.startsWith("\\\\?\\")) return path;
  if (/^[a-z]:[\\/]/i.test(path)) return "\\\\?\\" + path.replaceAll("/", "\\");
  if (path.startsWith("\\\\")) return "\\\\?\\UNC\\" + path.slice(2);
  return path;
}

export function mineruDisplayPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return "\\\\" + path.slice(8);
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

export async function mineruImageDataURI(
  path: string,
  contentType: string,
): Promise<string> {
  return await Promise.resolve(
    Zotero.File.generateDataURI(
      mineruNativePath(path),
      contentType,
    ) as unknown as string | Promise<string>,
  );
}

/** Preserve optional IO capabilities while adapting every path argument. */
export function longPathIO<T extends object>(io: T): T {
  return new Proxy(io, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const count = property === "move" || property === "copy" ? 2 : 1;
        for (let i = 0; i < count; i++) {
          const path = args[i];
          if (typeof path === "string") args[i] = mineruNativePath(path);
        }
        const result = await value.apply(target, args);
        return property === "getChildren"
          ? result.map(mineruDisplayPath)
          : result;
      };
    },
  });
}

// Keep native prefixes at the IO boundary. Stored paths and links stay portable.
export const mineruFileIO = {
  exists: (path: string) => IOUtils.exists(mineruNativePath(path)),
  stat: (path: string) => (IOUtils as any).stat(mineruNativePath(path)),
  read: (path: string) => IOUtils.read(mineruNativePath(path)),
  readUTF8: (path: string) =>
    typeof (IOUtils as any).readUTF8 === "function"
      ? (IOUtils as any).readUTF8(mineruNativePath(path))
      : Zotero.File.getContentsAsync(mineruNativePath(path), "utf-8"),
  write: (path: string, bytes: Uint8Array, options?: any) =>
    (IOUtils as any).write(mineruNativePath(path), bytes, options),
  writeUTF8: (path: string, text: string, options?: any) =>
    (IOUtils as any).writeUTF8(mineruNativePath(path), text, options),
  makeDirectory: (path: string, options?: any) =>
    IOUtils.makeDirectory(mineruNativePath(path), options),
  move: (source: string, target: string, options?: any) =>
    (IOUtils as any).move(
      mineruNativePath(source),
      mineruNativePath(target),
      options,
    ),
  copy: (source: string, target: string, options?: any) =>
    (IOUtils as any).copy(
      mineruNativePath(source),
      mineruNativePath(target),
      options,
    ),
  remove: (path: string, options?: any) =>
    IOUtils.remove(mineruNativePath(path), options),
  getChildren: async (path: string) =>
    (await IOUtils.getChildren(mineruNativePath(path))).map(mineruDisplayPath),
};
