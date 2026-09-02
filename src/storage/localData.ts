import type { ItemInternalState, WorkspaceState } from "../domain/types";
import {
  parseItemInternalState,
  type ResearchDataChangeScope,
  type ResearchDataStore,
  type ResearchDataWriteOptions,
} from "./syncedData";
import { parseWorkspacePayload } from "../core/codec";

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

// Several UI services construct their own repository. Share one in-process
// cache and write queue so one edit cannot overwrite another service's newer
// value with a stale file snapshot.
let sharedPayload: LocalPayload = emptyPayload();
let sharedLoaded = false;
let sharedLoading: Promise<void> | undefined;
let sharedWriteQueue: Promise<void> = Promise.resolve();
export interface LocalResearchDataChange {
  scope: ResearchDataChangeScope;
}

const changeListeners = new Set<(change: LocalResearchDataChange) => void>();

interface LocalIOUtils {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array>;
  write?(path: string, bytes: Uint8Array): Promise<void>;
  writeUTF8?(path: string, content: string): Promise<void>;
  move?(
    sourcePath: string,
    destinationPath: string,
    options?: { noOverwrite?: boolean },
  ): Promise<void>;
  makeDirectory?(
    path: string,
    options?: { ignoreExisting?: boolean },
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
}

export function onLocalResearchDataChanged(
  listener: (change: LocalResearchDataChange) => void,
): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function emitChange(scope: ResearchDataChangeScope): void {
  const change: LocalResearchDataChange = { scope };
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
    if (typeof IOUtils !== "undefined") return IOUtils as LocalIOUtils;
  } catch {
    // The lexical global is not available in this runtime.
  }
  return (globalThis as any).IOUtils as LocalIOUtils | undefined;
}

function runtimePathUtils(): LocalPathUtils | undefined {
  try {
    if (typeof PathUtils !== "undefined") return PathUtils as LocalPathUtils;
  } catch {
    // The lexical global is not available in this runtime.
  }
  return (globalThis as any).PathUtils as LocalPathUtils | undefined;
}

function emptyPayload(): LocalPayload {
  return { schemaVersion: 1, items: {} };
}

export function parseLocalPayload(value: unknown): LocalPayload {
  const raw = value as Partial<LocalPayload>;
  if (
    !raw ||
    raw.schemaVersion !== 1 ||
    !raw.items ||
    typeof raw.items !== "object"
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
    await persistSharedPayload("all", options);
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
    await this.persist(options?.changeScope);
  }

  private async loadFromDisk(): Promise<void> {
    const path = localPath();
    const io = runtimeIOUtils();
    if (!path || typeof io?.exists !== "function") {
      sharedPayload = clone(MEMORY_FALLBACK);
      sharedLoaded = true;
      return;
    }
    if (!(await io.exists(path))) {
      sharedPayload = emptyPayload();
      sharedLoaded = true;
      return;
    }
    let raw: string;
    try {
      raw = new TextDecoder().decode(await io.read(path));
      sharedPayload = parseLocalPayload(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        "本机研究数据库文件无法读取；为保护数据，插件没有覆盖或删除原文件",
        { cause: error },
      );
    }
    sharedLoaded = true;
  }

  private async persist(
    changeScope: ResearchDataChangeScope = "all",
  ): Promise<void> {
    await persistSharedPayload(changeScope);
  }
}

async function persistSharedPayload(
  changeScope: ResearchDataChangeScope = "all",
  options: { backupCurrent?: boolean } = {},
): Promise<void> {
  const path = localPath();
  const io = runtimeIOUtils();
  if (
    !path ||
    typeof io?.writeUTF8 !== "function" ||
    typeof io.makeDirectory !== "function"
  ) {
    emitChange(changeScope);
    return;
  }
  const pathUtils = runtimePathUtils();
  if (!pathUtils?.profileDir || typeof pathUtils.join !== "function") {
    emitChange(changeScope);
    return;
  }
  const directory = pathUtils.join(
    pathUtils.profileDir,
    "zotero-research-database",
  );
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
      await io.makeDirectory!(directory, { ignoreExisting: true });
      if (options.backupCurrent && (await io.exists(path))) {
        const backupPath = localBackupPath();
        if (!backupPath) throw new Error("无法确定本机研究数据库备份路径");
        const bytes = await io.read(path);
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
  emitChange(changeScope);
}
