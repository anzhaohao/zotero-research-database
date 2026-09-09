import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { config } from "../../package.json";
import { resetDataRootScope } from "../../src/storage/dataRoot";
import { resetLocalDataScope } from "../../src/storage/localData";

export async function createStorageRuntime() {
  const directory = await mkdtemp(join(tmpdir(), "zrdb-storage-"));
  const profile = join(directory, "profile");
  const legacyRoot = join(profile, "zotero-research-database");
  const prefs = new Map<string, unknown>();
  const previous = {
    IOUtils: (globalThis as any).IOUtils,
    PathUtils: (globalThis as any).PathUtils,
    Zotero: (globalThis as any).Zotero,
  };
  (globalThis as any).PathUtils = {
    profileDir: profile,
    join,
    normalize,
    isAbsolute,
  };
  (globalThis as any).Zotero = {
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => prefs.set(key, value),
    },
  };
  (globalThis as any).IOUtils = {
    exists: (path: string) =>
      access(path).then(
        () => true,
        () => false,
      ),
    read: async (path: string) => new Uint8Array(await readFile(path)),
    writeUTF8: async (path: string, content: string) => {
      await writeFile(path, content, "utf8");
      return content.length;
    },
    makeDirectory: async (path: string) => {
      await mkdir(path, { recursive: true });
    },
    move: rename,
    remove: (path: string, options?: { recursive?: boolean }) =>
      rm(path, {
        recursive: options?.recursive ?? false,
        force: true,
      }),
  };
  const restart = () => {
    resetDataRootScope();
    resetLocalDataScope();
  };
  restart();
  return {
    directory,
    profile,
    legacyRoot,
    prefs,
    rootPref: `${config.prefsPrefix}.dataRoot`,
    restart,
    async close() {
      restart();
      Object.assign(globalThis, previous);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
