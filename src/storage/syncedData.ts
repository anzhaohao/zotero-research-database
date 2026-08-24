import {
  WORKSPACE_SYNCED_SETTING,
  itemSyncedSetting,
} from "../domain/defaults";
import type {
  FigureArtifact,
  ItemInternalState,
  ManagedArtifact,
  WorkspaceState,
} from "../domain/types";
import { parseRecordPayload, parseWorkspacePayload } from "../core/codec";

interface SyncedSettingsAPI {
  get(libraryID: number, setting: string): unknown;
  clear(
    libraryID: number,
    setting: string,
    options?: { skipDeleteLog?: boolean },
  ): Promise<unknown>;
}

function api(): SyncedSettingsAPI {
  const syncedSettings = (Zotero as unknown as { SyncedSettings?: unknown })
    .SyncedSettings as SyncedSettingsAPI | undefined;
  if (
    !syncedSettings ||
    typeof syncedSettings.get !== "function" ||
    typeof syncedSettings.clear !== "function"
  ) {
    throw new Error("Zotero 同步设置运行时不可用");
  }
  return syncedSettings;
}

export function createItemInternalState(
  libraryID: number,
  itemKey: string,
): ItemInternalState {
  return {
    schemaVersion: 1,
    libraryID,
    itemKey,
    figures: [],
    artifacts: [],
    updatedAt: new Date().toISOString(),
  };
}

export function parseItemInternalState(value: unknown): ItemInternalState {
  const raw = value as Partial<ItemInternalState>;
  if (
    !raw ||
    raw.schemaVersion !== 1 ||
    !Number.isInteger(raw.libraryID) ||
    typeof raw.itemKey !== "string" ||
    !/^[A-Z0-9]{8}$/i.test(raw.itemKey) ||
    !Array.isArray(raw.figures) ||
    !Array.isArray(raw.artifacts) ||
    typeof raw.updatedAt !== "string"
  ) {
    throw new Error("研究数据库条目内部记录格式无效");
  }
  const state: ItemInternalState = {
    schemaVersion: 1,
    libraryID: Number(raw.libraryID),
    itemKey: raw.itemKey.toUpperCase(),
    figures: raw.figures.map(parseFigure),
    artifacts: raw.artifacts.map(parseArtifact),
    updatedAt: raw.updatedAt,
  };
  if (raw.record !== undefined) state.record = parseRecordPayload(raw.record);
  if (raw.primaryPdfAttachmentKey !== undefined) {
    if (!/^[A-Z0-9]{8}$/i.test(raw.primaryPdfAttachmentKey))
      throw new Error("研究数据库主 PDF 附件键无效");
    state.primaryPdfAttachmentKey = raw.primaryPdfAttachmentKey.toUpperCase();
  }
  return state;
}

function parseFigure(value: unknown): FigureArtifact {
  const figure = value as Partial<FigureArtifact>;
  const rect = figure?.rect;
  if (
    !figure ||
    typeof figure.id !== "string" ||
    !figure.id ||
    typeof figure.parentItemKey !== "string" ||
    typeof figure.attachmentKey !== "string" ||
    !["figure", "table"].includes(String(figure.kind)) ||
    typeof figure.caption !== "string" ||
    !Number.isInteger(figure.pageIndex) ||
    Number(figure.pageIndex) < 0 ||
    !/^[a-f0-9]{64}$/i.test(String(figure.sha256)) ||
    (figure.sourcePdfAttachmentKey !== undefined &&
      !/^[A-Z0-9]{8}$/i.test(figure.sourcePdfAttachmentKey)) ||
    (rect !== undefined &&
      ([rect.x, rect.y, rect.width, rect.height].some(
        (entry) => typeof entry !== "number" || !Number.isFinite(entry),
      ) ||
        rect.width <= 0 ||
        rect.height <= 0))
  ) {
    throw new Error("研究数据库图表记录格式无效");
  }
  return {
    id: figure.id,
    parentItemKey: figure.parentItemKey,
    attachmentKey: figure.attachmentKey.toUpperCase(),
    sourcePdfAttachmentKey: figure.sourcePdfAttachmentKey?.toUpperCase(),
    kind: figure.kind as FigureArtifact["kind"],
    caption: figure.caption,
    pageIndex: Number(figure.pageIndex),
    rect: rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : undefined,
    sha256: String(figure.sha256).toLowerCase(),
  };
}

function parseArtifact(value: unknown): ManagedArtifact {
  const artifact = value as Partial<ManagedArtifact>;
  const validRoles = [
    "mineru-original",
    "translation",
    "figure",
    "table",
    "snapshot",
  ];
  if (
    !artifact ||
    typeof artifact.attachmentKey !== "string" ||
    !/^[A-Z0-9]{8}$/i.test(artifact.attachmentKey) ||
    !validRoles.includes(String(artifact.role)) ||
    (artifact.sha256 !== undefined &&
      !/^[a-f0-9]{64}$/i.test(artifact.sha256)) ||
    (artifact.runID !== undefined && typeof artifact.runID !== "string") ||
    (artifact.figureID !== undefined &&
      typeof artifact.figureID !== "string") ||
    (artifact.snapshotID !== undefined &&
      typeof artifact.snapshotID !== "string") ||
    (artifact.format !== undefined &&
      !["md", "html", "csv"].includes(artifact.format)) ||
    (artifact.history !== undefined && typeof artifact.history !== "boolean")
  ) {
    throw new Error("研究数据库附件产物记录格式无效");
  }
  return {
    attachmentKey: artifact.attachmentKey.toUpperCase(),
    role: artifact.role as ManagedArtifact["role"],
    sha256: artifact.sha256?.toLowerCase(),
    runID: artifact.runID,
    figureID: artifact.figureID,
    snapshotID: artifact.snapshotID,
    format: artifact.format,
    ...(artifact.history ? { history: true } : {}),
  };
}

export interface ResearchDataStore {
  /** Local stores load asynchronously before synchronous pane reads begin. */
  ready?(): Promise<void>;
  getWorkspace(libraryID: number): WorkspaceState | undefined;
  setWorkspace(libraryID: number, state: WorkspaceState): Promise<void>;
  getItem(libraryID: number, itemKey: string): ItemInternalState | undefined;
  setItem(
    state: ItemInternalState,
    options?: ResearchDataWriteOptions,
  ): Promise<void>;
}

export type ResearchDataChangeScope = "all" | "translated-title";

export interface ResearchDataWriteOptions {
  changeScope?: ResearchDataChangeScope;
}

/** Read-only adapter used only to migrate 0.3.21 settings out of the sync queue. */
export class ResearchSyncedStore {
  getWorkspace(libraryID: number): WorkspaceState | undefined {
    const value = api().get(libraryID, WORKSPACE_SYNCED_SETTING);
    return value === null || value === undefined
      ? undefined
      : parseWorkspacePayload(value);
  }

  getItem(libraryID: number, itemKey: string): ItemInternalState | undefined {
    const value = api().get(libraryID, itemSyncedSetting(itemKey));
    return value === null || value === undefined
      ? undefined
      : parseItemInternalState(value);
  }
}
