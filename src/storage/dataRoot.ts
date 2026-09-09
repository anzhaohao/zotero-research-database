import { config } from "../../package.json";

export const DATA_ROOT_PREF = "dataRoot";
export const DATA_ROOT_SCHEMA_VERSION = 1;
export const DATA_ROOT_MANIFEST = "manifest.json";
export const DATA_ROOT_DATABASE = "database.json";
export const DATA_ROOT_SETTINGS = "settings.json";
export const DATA_ROOT_MAPPINGS = "mappings.json";
export const DATA_ROOT_STAGING = "staging";
export const DATA_ROOT_TRANSACTIONS = "transactions";

interface RuntimePathUtils {
  profileDir?: string;
  join?: (...parts: string[]) => string;
  normalize?: (path: string) => string;
  isAbsolute?: (path: string) => boolean;
}

interface RuntimeIOUtils {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  writeUTF8(path: string, content: string): Promise<number>;
  move?(
    sourcePath: string,
    destinationPath: string,
    options?: { noOverwrite?: boolean },
  ): Promise<void>;
  makeDirectory?(
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ): Promise<void>;
  remove?(
    path: string,
    options?: { recursive?: boolean; ignoreAbsent?: boolean },
  ): Promise<void>;
}

export interface DataRootManifest {
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  databaseFile: string;
  settingsFile: string;
  mappingsFile: string;
}

export interface DataRootInitialization {
  root: string;
  created: boolean;
  migratedLegacyDatabase: boolean;
}

let activeRoot: string | undefined;
let activeRootResolved = false;
let activeRootConfigured = false;
let initialization: Promise<DataRootInitialization> | undefined;

function runtimePathUtils(): RuntimePathUtils | undefined {
  try {
    if (typeof PathUtils !== "undefined") return PathUtils as RuntimePathUtils;
  } catch {
    // The lexical global is unavailable in the unit-test runtime.
  }
  return (globalThis as { PathUtils?: RuntimePathUtils }).PathUtils;
}

function runtimeIOUtils(): RuntimeIOUtils | undefined {
  try {
    if (typeof IOUtils !== "undefined") return IOUtils as RuntimeIOUtils;
  } catch {
    // The lexical global is unavailable in the unit-test runtime.
  }
  return (globalThis as { IOUtils?: RuntimeIOUtils }).IOUtils;
}

function getBootstrapPref(): string {
  try {
    return String(
      Zotero.Prefs.get(`${config.prefsPrefix}.${DATA_ROOT_PREF}`, true) || "",
    );
  } catch {
    return "";
  }
}

function setBootstrapPref(value: string): void {
  Zotero.Prefs.set(`${config.prefsPrefix}.${DATA_ROOT_PREF}`, value, true);
}

function fallbackJoin(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "\\")
    .replace(/\/{2,}/g, "/");
}

function legacyRoot(): string | undefined {
  const paths = runtimePathUtils();
  if (!paths?.profileDir) return undefined;
  return (paths.join || fallbackJoin)(
    paths.profileDir,
    "zotero-research-database",
  );
}

function normalizeRoot(value: string): string {
  const root = value.trim();
  if (!root) throw new Error("研究数据库目录不能为空");
  const paths = runtimePathUtils();
  if (typeof paths?.isAbsolute === "function" && !paths.isAbsolute(root))
    throw new Error("研究数据库目录必须是绝对路径");
  // The Zotero runtime exposes PathUtils.normalize. Node tests may not.
  return typeof paths?.normalize === "function" ? paths.normalize(root) : root;
}

export function getDataRoot(): string | undefined {
  if (!activeRootResolved) {
    const configured = getBootstrapPref().trim();
    activeRootConfigured = Boolean(configured);
    activeRoot = configured || legacyRoot();
    activeRootResolved = true;
  }
  return activeRoot;
}

/** Whether the user explicitly selected a portable research-library folder. */
export function hasConfiguredDataRoot(): boolean {
  getDataRoot();
  return activeRootConfigured;
}

export function getDataRootOrThrow(): string {
  const root = getDataRoot();
  if (!root) throw new Error("尚未设置研究数据库目录");
  return root;
}

export function dataRootPath(...parts: string[]): string {
  const root = getDataRootOrThrow();
  const paths = runtimePathUtils();
  return (paths?.join || fallbackJoin)(root, ...parts);
}

export function getLegacyDataRoot(): string | undefined {
  return legacyRoot();
}

export function setDataRoot(path: string): string {
  const normalized = path.trim() ? normalizeRoot(path) : "";
  // Resolve before saving the pointer even on the first selection. Open
  // repositories and caches must keep one directory until the next startup.
  getDataRoot();
  setBootstrapPref(normalized);
  return normalized;
}

export function resetDataRootScope(): void {
  activeRoot = undefined;
  activeRootResolved = false;
  activeRootConfigured = false;
  initialization = undefined;
}

export async function initializeDataRoot(): Promise<DataRootInitialization> {
  if (!initialization) initialization = initializeDataRootOnce();
  try {
    return await initialization;
  } catch (error) {
    initialization = undefined;
    throw error;
  }
}

async function initializeDataRootOnce(): Promise<DataRootInitialization> {
  const root = normalizeRoot(getDataRootOrThrow());
  const io = runtimeIOUtils();
  if (!io?.exists || !io.writeUTF8 || !io.makeDirectory)
    return { root, created: false, migratedLegacyDatabase: false };

  await io.makeDirectory(root, {
    createAncestors: true,
    ignoreExisting: true,
  });
  for (const directory of [
    DATA_ROOT_STAGING,
    DATA_ROOT_TRANSACTIONS,
    "artifacts",
  ])
    await io.makeDirectory(
      (runtimePathUtils()?.join || fallbackJoin)(root, directory),
      {
        createAncestors: true,
        ignoreExisting: true,
      },
    );

  const manifestPath = (runtimePathUtils()?.join || fallbackJoin)(
    root,
    DATA_ROOT_MANIFEST,
  );
  const created = !(await io.exists(manifestPath));
  if (created) {
    const now = new Date().toISOString();
    await writeJsonAtomic(manifestPath, {
      schemaVersion: DATA_ROOT_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      databaseFile: DATA_ROOT_DATABASE,
      settingsFile: DATA_ROOT_SETTINGS,
      mappingsFile: DATA_ROOT_MAPPINGS,
    } satisfies DataRootManifest);
  }
  // Opening a selected library never imports data from the Zotero profile.
  // ResearchLocalStore validates and migrates only the default directory's
  // legacy filename when loading that same default library.
  return { root, created, migratedLegacyDatabase: false };
}

export async function writeTextAtomic(
  path: string,
  content: string,
): Promise<void> {
  const io = runtimeIOUtils();
  if (!io?.writeUTF8) throw new Error("当前 Zotero 不支持写入研究数据库文件");
  const temporaryPath = `${path}.${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  await io.writeUTF8(temporaryPath, content);
  try {
    if (io.move) await io.move(temporaryPath, path, { noOverwrite: false });
    else await io.writeUTF8(path, content);
  } finally {
    await io.remove?.(temporaryPath, { ignoreAbsent: true });
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
): Promise<void> {
  await writeTextAtomic(path, JSON.stringify(value, null, 2));
}

export async function readJsonWithRecovery<T>(
  path: string,
  validate: (value: unknown) => T = (value) => value as T,
): Promise<T> {
  const io = runtimeIOUtils();
  if (!io?.read) throw new Error("当前 Zotero 不支持读取研究数据库文件");
  try {
    return validate(JSON.parse(new TextDecoder().decode(await io.read(path))));
  } catch (primaryError) {
    const candidates = [`${path}.bak`, `${path}.tmp`];
    for (const candidate of candidates) {
      try {
        return validate(
          JSON.parse(new TextDecoder().decode(await io.read(candidate))),
        );
      } catch {
        // Continue to the next recovery candidate.
      }
    }
    throw new Error("研究数据库文件无法读取，且没有可用的恢复版本", {
      cause: primaryError,
    });
  }
}
