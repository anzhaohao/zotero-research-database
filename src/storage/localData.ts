import type { ItemInternalState, WorkspaceState } from "../domain/types";
import {
  parseItemInternalState,
  type ResearchDataChangeScope,
  type ResearchDataStore,
  type ResearchDataWriteOptions,
} from "./syncedData";
import { parseWorkspacePayload } from "../core/codec";
import {
  DATA_ROOT_DATABASE,
  dataRootPath,
  getDataRoot,
  getLegacyDataRoot,
  hasConfiguredDataRoot,
  initializeDataRoot,
} from "./dataRoot";

export interface LocalPayload {
  schemaVersion: 1;
  workspaceLibraryID?: number;
  workspace?: WorkspaceState;
  items: Record<string, ItemInternalState>;
}

const MEMORY_FALLBACK: LocalPayload = {
  schemaVersion: 1,
  items: {},
};

// All production repositories share a plugin scope. Retain a shared store
// cache and write queue as well for explicitly constructed adapters, so an
// older file snapshot cannot overwrite another service's newer value.
let sharedPayload: LocalPayload = emptyPayload();
let sharedLoaded = false;
let sharedLoading: Promise<void> | undefined;
let sharedWriteQueue: Promise<void> = Promise.resolve();
export interface LocalResearchDataChange {
  scope: ResearchDataChangeScope;
  /** Present only for item writes; absence means workspace/global change. */
  libraryID?: number;
  itemKey?: string;
}

const changeListeners = new Set<(change: LocalResearchDataChange) => void>();

interface LocalIOUtils {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  write?(path: string, bytes: Uint8Array): Promise<number>;
  writeUTF8?(path: string, content: string): Promise<number>;
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

interface LocalPathUtils {
  profileDir?: string;
  tempDir?: string;
  join?: (...parts: string[]) => string;
  normalize?: (path: string) => string;
}

export function onLocalResearchDataChanged(
  listener: (change: LocalResearchDataChange) => void,
): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function emitChange(change: LocalResearchDataChange): void {
  for (const listener of changeListeners) {
    try {
      listener(change);
    } catch {
      // A UI refresh listener must never make a successful write fail.
    }
  }
}

function itemID(libraryID: number, itemKey: string): string {
  return `${libraryID}:${itemKey.toUpperCase()}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function localPath(): string | undefined {
  if (hasConfiguredDataRoot()) return dataRootPath(DATA_ROOT_DATABASE);
  const pathUtils = runtimePathUtils();
  if (!pathUtils?.profileDir || typeof pathUtils.join !== "function")
    return undefined;
  return pathUtils.join(
    pathUtils.profileDir,
    "zotero-research-database",
    "research-data-v1.json",
  );
}

function localBackupPath(): string | undefined {
  const path = localPath();
  return path ? `${path}.bak` : undefined;
}

/**
 * Zotero exposes platform namespaces as lexical globals in some sandboxes,
 * but as globalThis properties in others (notably the Node-side test runner).
 * Resolve both forms so local data behaves identically in the add-on and tests.
 */
function runtimeIOUtils(): LocalIOUtils | undefined {
  try {
    if (typeof IOUtils !== "undefined")
      return IOUtils as unknown as LocalIOUtils;
  } catch {
    // The lexical global is not available in this runtime.
  }
  return (globalThis as { IOUtils?: LocalIOUtils }).IOUtils;
}

function runtimePathUtils(): LocalPathUtils | undefined {
  try {
    if (typeof PathUtils !== "undefined") return PathUtils as LocalPathUtils;
  } catch {
    // The lexical global is not available in this runtime.
  }
  return (globalThis as { PathUtils?: LocalPathUtils }).PathUtils;
}

function emptyPayload(): LocalPayload {
  return { schemaVersion: 1, items: {} };
}

/** Reset only when a plugin scope is disposed/recreated, never on root save. */
export function resetLocalDataScope(): void {
  sharedPayload = emptyPayload();
  sharedLoaded = false;
  sharedLoading = undefined;
  sharedWriteQueue = Promise.resolve();
}

export function parseLocalPayload(value: unknown): LocalPayload {
  const raw = value as Partial<LocalPayload>;
  if (
    !raw ||
    raw.schemaVersion !== 1 ||
    !raw.items ||
    typeof raw.items !== "object" ||
    Array.isArray(raw.items) ||
    (raw.workspaceLibraryID !== undefined &&
      (!Number.isInteger(raw.workspaceLibraryID) ||
        raw.workspaceLibraryID <= 0))
  )
    throw new Error("本机研究数据库文件格式无效；未覆盖原文件");

  const items: Record<string, ItemInternalState> = {};
  for (const [key, item] of Object.entries(raw.items)) {
    const parsed = parseItemInternalState(item);
    if (key !== itemID(parsed.libraryID, parsed.itemKey))
      throw new Error(`本机研究数据库条目标识不匹配：${key}`);
    items[key] = parsed;
  }
  return {
    schemaVersion: 1,
    workspaceLibraryID:
      raw.workspaceLibraryID === undefined
        ? undefined
        : Number(raw.workspaceLibraryID),
    workspace:
      raw.workspace === undefined
        ? undefined
        : parseWorkspacePayload(raw.workspace),
    items,
  };
}

export async function getLocalPayloadSnapshot(): Promise<LocalPayload> {
  await new ResearchLocalStore().ready();
  return clone(sharedPayload);
}

export async function replaceLocalPayload(
  value: unknown,
  options: { backupCurrent?: boolean } = {},
): Promise<void> {
  const next = parseLocalPayload(value);
  await new ResearchLocalStore().ready();
  const previous = sharedPayload;
  sharedPayload = clone(next);
  try {
    await persistSharedPayload({ scope: "all" }, options);
  } catch (error) {
    sharedPayload = previous;
    throw error;
  }
}

/**
 * Local-only research storage. It deliberately lives outside zotero.sqlite
 * and outside Zotero's sync queues, while the Zotero library remains the only
 * bibliographic database.
 */
export class ResearchLocalStore implements ResearchDataStore {
  ready(): Promise<void> {
    if (sharedLoaded) return Promise.resolve();
    if (!sharedLoading) sharedLoading = this.loadFromDisk();
    return sharedLoading;
  }

  getWorkspace(libraryID: number): WorkspaceState | undefined {
    if (sharedPayload.workspace?.schemaVersion === undefined) return undefined;
    if (
      sharedPayload.workspace &&
      sharedPayload.workspaceLibraryID !== undefined &&
      sharedPayload.workspaceLibraryID !== libraryID
    )
      return undefined;
    return clone(sharedPayload.workspace);
  }

  async setWorkspace(libraryID: number, state: WorkspaceState): Promise<void> {
    await this.ready();
    if (!Number.isInteger(libraryID) || libraryID <= 0)
      throw new Error("本机研究数据库首版只支持有效的个人库");
    sharedPayload.workspaceLibraryID = libraryID;
    sharedPayload.workspace = clone(parseWorkspacePayload(state));
    await this.persist();
  }

  getItem(libraryID: number, itemKey: string): ItemInternalState | undefined {
    const value = sharedPayload.items[itemID(libraryID, itemKey)];
    return value ? clone(value) : undefined;
  }

  async setItem(
    state: ItemInternalState,
    options?: ResearchDataWriteOptions,
  ): Promise<void> {
    await this.ready();
    const normalized = parseItemInternalState({
      ...state,
      updatedAt: new Date().toISOString(),
    });
    sharedPayload.items[itemID(normalized.libraryID, normalized.itemKey)] =
      clone(normalized);
    await this.persist({
      scope: options?.changeScope || "all",
      libraryID: normalized.libraryID,
      itemKey: normalized.itemKey,
    });
  }

  private async loadFromDisk(): Promise<void> {
    const path = localPath();
    const io = runtimeIOUtils();
    if (!path || typeof io?.exists !== "function") {
      sharedPayload = clone(MEMORY_FALLBACK);
      sharedLoaded = true;
      return;
    }
    await initializeDataRoot();
    let loaded = await loadValidatedPayload(path, io);
    let migrated = false;
    if (!loaded && hasConfiguredDataRoot()) {
      const paths = runtimePathUtils();
      const root = getDataRoot();
      const legacy = getLegacyDataRoot();
      const normalize = paths?.normalize || ((value: string) => value);
      // A user can explicitly select the existing default directory. Only
      // that same directory's old filename is eligible for migration; an
      // unrelated selected library never inherits profile data.
      if (
        root &&
        legacy &&
        normalize(root) === normalize(legacy) &&
        paths?.join
      ) {
        loaded = await loadValidatedPayload(
          paths.join(root, "research-data-v1.json"),
          io,
        );
        migrated = Boolean(loaded);
      }
    }
    if (loaded?.recovered || migrated)
      await writeValidatedPayload(path, loaded!.payload, io);
    sharedPayload = loaded?.payload || emptyPayload();
    sharedLoaded = true;
  }

  private async persist(
    change: LocalResearchDataChange = { scope: "all" },
  ): Promise<void> {
    await persistSharedPayload(change);
  }
}

async function loadValidatedPayload(
  path: string,
  io: LocalIOUtils,
): Promise<{ payload: LocalPayload; recovered: boolean } | undefined> {
  let failure: unknown;
  let found = false;
  for (const candidate of [path, `${path}.bak`]) {
    if (!(await io.exists(candidate))) continue;
    found = true;
    try {
      const payload = parseLocalPayload(
        JSON.parse(new TextDecoder().decode(await io.read(candidate))),
      );
      return { payload, recovered: candidate !== path };
    } catch (error) {
      failure = error;
    }
  }
  if (!found) return undefined;
  throw new Error(
    "本机研究数据库及恢复副本均无法读取；为保护数据，插件没有覆盖或删除原文件",
    { cause: failure },
  );
}

async function writeValidatedPayload(
  path: string,
  payload: LocalPayload,
  io: LocalIOUtils,
): Promise<void> {
  const directory = getDataRoot();
  if (!directory || !io.makeDirectory || !io.writeUTF8)
    throw new Error("当前 Zotero 无法安全恢复研究数据库文件");
  await io.makeDirectory(directory, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const temporaryPath = `${path}.${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  const content = JSON.stringify(parseLocalPayload(payload), null, 2);
  try {
    await io.writeUTF8(temporaryPath, content);
    parseLocalPayload(
      JSON.parse(new TextDecoder().decode(await io.read(temporaryPath))),
    );
    if (io.move) await io.move(temporaryPath, path, { noOverwrite: false });
    else await io.writeUTF8(path, content);
  } finally {
    await io.remove?.(temporaryPath, { ignoreAbsent: true });
  }
}

async function persistSharedPayload(
  change: LocalResearchDataChange = { scope: "all" },
  options: { backupCurrent?: boolean } = {},
): Promise<void> {
  const path = localPath();
  const io = runtimeIOUtils();
  if (
    !path ||
    typeof io?.writeUTF8 !== "function" ||
    typeof io.makeDirectory !== "function"
  ) {
    emitChange(change);
    return;
  }
  const directory = getDataRoot();
  if (!directory) {
    emitChange(change);
    return;
  }
  const content = JSON.stringify(sharedPayload, null, 2);
  const temporaryPath = `${path}.${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  // Recover the queue after one failed write. The failed caller still gets
  // its error, while a later edit can retry instead of inheriting a rejected
  // promise forever.
  sharedWriteQueue = sharedWriteQueue
    .catch(() => undefined)
    .then(async () => {
      await io.makeDirectory!(directory, {
        createAncestors: true,
        ignoreExisting: true,
      });
      if (options.backupCurrent && (await io.exists(path))) {
        const backupPath = localBackupPath();
        if (!backupPath) throw new Error("无法确定本机研究数据库备份路径");
        const bytes = await io.read(path);
        // Never replace a known-good recovery copy with an invalid primary.
        parseLocalPayload(JSON.parse(new TextDecoder().decode(bytes)));
        if (typeof io.write === "function") await io.write(backupPath, bytes);
        else if (typeof io.writeUTF8 === "function")
          await io.writeUTF8(backupPath, new TextDecoder().decode(bytes));
        else throw new Error("当前 Zotero 不支持写入研究数据库备份");
      }
      await io.writeUTF8!(temporaryPath, content);
      try {
        if (typeof io.move !== "function") {
          // Older test doubles may not expose move; Zotero 9 does.
          await io.writeUTF8!(path, content);
        } else {
          await io.move(temporaryPath, path, { noOverwrite: false });
        }
      } finally {
        if (typeof io.remove === "function") {
          await io.remove(temporaryPath, { ignoreAbsent: true });
        }
      }
    });
  await sharedWriteQueue;
  emitChange(change);
}
