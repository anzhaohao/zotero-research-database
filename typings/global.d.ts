declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

declare const IOUtils: {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  writeUTF8(path: string, content: string): Promise<void>;
  makeDirectory(
    path: string,
    options?: { ignoreExisting?: boolean },
  ): Promise<void>;
  remove(
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ): Promise<void>;
};

declare const PathUtils: {
  tempDir: string;
  join(...parts: string[]): string;
  filename(path: string): string;
};
