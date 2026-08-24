import {
  WORKSPACE_MARKER,
  WORKSPACE_SYNCED_SETTING,
  TRANSLATED_TITLE_FIELD_ID,
  createDefaultWorkspace,
  itemSyncedSetting,
} from "../domain/defaults";
import type {
  FieldAudit,
  FieldDefinition,
  FigureArtifact,
  ItemInternalState,
  ItemResearchRecord,
  ManagedArtifact,
  WorkspaceState,
} from "../domain/types";
import {
  isRecordNote,
  isWorkspaceNote,
  parseRecordNote,
  parseWorkspaceNote,
} from "../core/codec";
import { applyAgentValues, createEmptyRecord } from "../core/records";
import {
  hasManagedItemExtra,
  hasManagedWorkspaceExtra,
  parseArtifactExtra,
  parseFigureExtra,
  parsePrimaryPdfExtra,
  parseRecordExtra,
  parseWorkspaceExtra,
  stripManagedItemExtra,
  stripManagedWorkspaceExtra,
} from "../core/extraProperties";
import {
  ResearchSyncedStore,
  createItemInternalState,
  type ResearchDataStore,
} from "./syncedData";
import { ResearchLocalStore } from "./localData";

export const WORKSPACE_TITLE = "Zotero Research Database";

export type EditableNativeField = "title" | "date" | "DOI" | "url" | "tags";

export interface LegacyStorageMigrationResult {
  migratedItems: number;
  workspaceMigrated: boolean;
}

/**
 * The repository is the only authority for plugin data. Research data is
 * local-only by design; Zotero.SyncedSettings is retained only as a
 * read-and-clear migration adapter for 0.3.21.
 */
export class ResearchRepository {
  private workspaceItemID?: number;
  private readonly legacySyncedStore = new ResearchSyncedStore();

  constructor(private store: ResearchDataStore = new ResearchLocalStore()) {}

  get libraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }

  async loadWorkspace(): Promise<WorkspaceState> {
    await this.ready();
    const item = await this.ensureWorkspaceItem();
    const stored = this.store.getWorkspace(this.libraryID);
    if (stored) {
      await this.cleanupWorkspaceExtra(item);
      return stored;
    }

    const legacySynced = this.readLegacyWorkspace();
    if (legacySynced) {
      await this.saveWorkspace(legacySynced);
      await this.clearLegacyWorkspace();
      return this.store.getWorkspace(this.libraryID)!;
    }

    // 0.3.20 and earlier stored the workspace in Extra, and still earlier
    // builds used a child note. Both remain read-only until the new value has
    // been written and read back successfully.
    const legacyExtra = parseWorkspaceExtra(
      String(item.getField("extra") || ""),
    );
    if (legacyExtra) {
      await this.saveWorkspace(legacyExtra);
      return this.store.getWorkspace(this.libraryID)!;
    }

    const legacyNote = await this.findWorkspaceNote(item);
    if (legacyNote) {
      const legacy = parseWorkspaceNote(legacyNote.getNote());
      await this.saveWorkspace(legacy);
      return this.store.getWorkspace(this.libraryID)!;
    }

    const state = createDefaultWorkspace();
    await this.saveWorkspace(state);
    return this.store.getWorkspace(this.libraryID)!;
  }

  async saveWorkspace(state: WorkspaceState): Promise<void> {
    await this.ready();
    const item = await this.ensureWorkspaceItem();
    const next = { ...state, updatedAt: new Date().toISOString() };
    await this.store.setWorkspace(this.libraryID, next);
    await this.cleanupWorkspaceExtra(item);
  }

  async getWorkspaceItem(): Promise<Zotero.Item> {
    return this.ensureWorkspaceItem();
  }

  async isWorkspaceItem(item: Zotero.Item): Promise<boolean> {
    return this.isWorkspaceItemSync(item);
  }

  isWorkspaceItemSync(item: Zotero.Item): boolean {
    return (
      Boolean(this.workspaceItemID && item.id === this.workspaceItemID) ||
      (item.libraryID === this.libraryID &&
        item.isRegularItem() &&
        item.getField("title") === WORKSPACE_TITLE)
    );
  }

  /** Synchronous read used by Zotero's registerInfoRow onGetData hook. */
  peekRecord(item: Zotero.Item): ItemResearchRecord | undefined {
    this.assertPaper(item);
    const state = this.store.getItem(item.libraryID, item.key);
    if (state) {
      this.assertStateIdentity(item, state);
      return state.record;
    }
    // Startup migration normally makes this unnecessary, but retaining a
    // read-only fallback prevents a blank UI if one item could not migrate.
    const legacy = parseRecordExtra(String(item.getField("extra") || ""));
    if (legacy) this.assertRecordIdentity(item, legacy);
    return legacy;
  }

  async loadRecord(
    item: Zotero.Item,
    create = false,
    _definitions: FieldDefinition[] = [],
  ): Promise<ItemResearchRecord | undefined> {
    await this.ready();
    const state = await this.loadItemState(item);
    if (state?.record) return state.record;
    if (!create) return undefined;
    const record = createEmptyRecord(item.libraryID, item.key);
    await this.saveRecord(item, record, _definitions);
    return record;
  }

  async saveRecord(
    item: Zotero.Item,
    record: ItemResearchRecord,
    _definitions: FieldDefinition[],
  ): Promise<void> {
    await this.ready();
    this.assertPaper(item);
    this.assertRecordIdentity(item, record);
    const state =
      (await this.loadItemState(item)) ||
      createItemInternalState(item.libraryID, item.key);
    await this.saveItemState(item, { ...state, record });
  }

  /**
   * Persist only the translated-title research field. This deliberately
   * bypasses saveItemState/cleanupItemExtra so legacy or user Extra remains
   * byte-for-byte untouched while the local store is updated and read back.
   */
  async saveTranslatedTitle(
    item: Zotero.Item,
    value: string,
    audit: FieldAudit,
    currentRecord?: ItemResearchRecord,
  ): Promise<ItemResearchRecord> {
    await this.ready();
    this.assertPaper(item);
    if (currentRecord) {
      this.assertRecordIdentity(item, currentRecord);
      const current = currentRecord.fields[TRANSLATED_TITLE_FIELD_ID];
      if (current?.locked || String(current?.value ?? "").trim()) {
        return currentRecord;
      }
    }
    const translated = value.trim();
    if (!translated) throw new Error("中文标题不能为空");
    const state =
      this.store.getItem(item.libraryID, item.key) ||
      createItemInternalState(item.libraryID, item.key);
    this.assertStateIdentity(item, state);
    const record = state.record || createEmptyRecord(item.libraryID, item.key);
    const existing = record.fields[TRANSLATED_TITLE_FIELD_ID];
    if (existing?.locked || String(existing?.value ?? "").trim()) {
      return record;
    }
    const next = applyAgentValues(
      record,
      { [TRANSLATED_TITLE_FIELD_ID]: translated },
      audit,
    );
    const nextState = { ...state, record: next };
    await this.store.setItem(nextState, {
      changeScope: "translated-title",
    });
    const stored = this.store.getItem(item.libraryID, item.key);
    if (!stored) throw new Error(`条目 ${item.key} 的标题翻译保存后无法回读`);
    this.assertStateIdentity(item, stored);
    return stored.record || next;
  }

  async saveNativeField(
    item: Zotero.Item,
    field: EditableNativeField,
    value: string,
  ): Promise<void> {
    this.assertPaper(item);
    if (field === "tags") {
      const names = [
        ...new Set(
          value
            .split(/[，,]/)
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ];
      const current = item.getTags() as Array<{ tag: string; type?: number }>;
      item.setTags(
        names.map((name) => ({
          tag: name,
          type: current.find((tag) => tag.tag === name)?.type ?? 0,
        })),
      );
    } else {
      item.setField(field, value.trim());
    }
    await item.saveTx();
  }

  async loadFigures(item: Zotero.Item): Promise<FigureArtifact[]> {
    return (await this.loadItemState(item))?.figures || [];
  }

  async saveFigures(
    item: Zotero.Item,
    figures: FigureArtifact[],
  ): Promise<void> {
    this.assertPaper(item);
    if (figures.some((figure) => figure.parentItemKey !== item.key))
      throw new Error(`拒绝把其它条目的图表清单用于条目 ${item.key}`);
    const state =
      (await this.loadItemState(item)) ||
      createItemInternalState(item.libraryID, item.key);
    await this.saveItemState(item, { ...state, figures });
  }

  async loadArtifacts(item: Zotero.Item): Promise<ManagedArtifact[]> {
    return (await this.loadItemState(item))?.artifacts || [];
  }

  async saveArtifacts(
    item: Zotero.Item,
    artifacts: ManagedArtifact[],
  ): Promise<void> {
    const state =
      (await this.loadItemState(item)) ||
      createItemInternalState(item.libraryID, item.key);
    await this.saveItemState(item, { ...state, artifacts });
  }

  async saveManifests(
    item: Zotero.Item,
    artifacts: ManagedArtifact[],
    figures?: FigureArtifact[],
  ): Promise<void> {
    const state =
      (await this.loadItemState(item)) ||
      createItemInternalState(item.libraryID, item.key);
    if (figures?.some((figure) => figure.parentItemKey !== item.key))
      throw new Error(`拒绝把其它条目的图表清单用于条目 ${item.key}`);
    await this.saveItemState(item, {
      ...state,
      artifacts,
      figures: figures || state.figures,
    });
  }

  async loadPrimaryPdfKey(item: Zotero.Item): Promise<string | undefined> {
    return (await this.loadItemState(item))?.primaryPdfAttachmentKey;
  }

  async savePrimaryPdfKey(
    item: Zotero.Item,
    attachmentKey?: string,
  ): Promise<void> {
    const state =
      (await this.loadItemState(item)) ||
      createItemInternalState(item.libraryID, item.key);
    const next = { ...state };
    if (attachmentKey) next.primaryPdfAttachmentKey = attachmentKey;
    else delete next.primaryPdfAttachmentKey;
    await this.saveItemState(item, next);
  }

  /** Migrate every visible legacy Extra payload without touching user Extra. */
  async migrateLegacyStorage(): Promise<LegacyStorageMigrationResult> {
    const workspace = await this.ensureWorkspaceItem();
    const workspaceHadLegacy = hasManagedWorkspaceExtra(
      String(workspace.getField("extra") || ""),
    );
    const workspaceHadSynced = Boolean(this.readLegacyWorkspace());
    await this.loadWorkspace();
    const all = (await (Zotero.Items as any).getAll(
      this.libraryID,
      true,
    )) as Zotero.Item[];
    let migratedItems = 0;
    const failures: Error[] = [];
    for (const item of all) {
      if (!item.isRegularItem()) {
        continue;
      }
      const hasExtra = hasManagedItemExtra(
        String(item.getField("extra") || ""),
      );
      const hasSynced = Boolean(this.readLegacyItem(item));
      if (!hasExtra && !hasSynced) continue;
      try {
        await this.loadItemState(item);
        migratedItems += 1;
      } catch (error) {
        const failure = new Error(`条目 ${item.key} 的旧 ZRDB Extra 迁移失败`, {
          cause: error,
        });
        failures.push(failure);
        Zotero.logError(failure);
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        `${failures.length} 个条目的旧研究数据库数据未清理；原 Extra 已保留`,
      );
    }
    return {
      migratedItems,
      workspaceMigrated: workspaceHadLegacy || workspaceHadSynced,
    };
  }

  private async loadItemState(
    item: Zotero.Item,
  ): Promise<ItemInternalState | undefined> {
    this.assertPaper(item);
    await this.ready();
    const stored = this.store.getItem(item.libraryID, item.key);
    if (stored) {
      this.assertStateIdentity(item, stored);
      await this.cleanupItemExtra(item);
      return stored;
    }

    const legacySynced = this.readLegacyItem(item);
    if (legacySynced) {
      await this.saveItemState(item, legacySynced);
      await this.clearLegacyItem(item);
      return this.store.getItem(item.libraryID, item.key);
    }

    const extra = String(item.getField("extra") || "");
    const hasLegacyExtra = hasManagedItemExtra(extra);
    let record = parseRecordExtra(extra);
    const figures = parseFigureExtra(extra);
    const artifacts = parseArtifactExtra(extra);
    const primaryPdfAttachmentKey = parsePrimaryPdfExtra(extra);

    let hasLegacyNote = false;
    if (!record) {
      const legacyNote = await this.findRecordNote(item);
      if (legacyNote) {
        record = parseRecordNote(legacyNote.getNote());
        hasLegacyNote = true;
      }
    }
    if (!hasLegacyExtra && !hasLegacyNote) return undefined;
    if (record) this.assertRecordIdentity(item, record);

    const state: ItemInternalState = {
      ...createItemInternalState(item.libraryID, item.key),
      record,
      figures,
      artifacts,
      primaryPdfAttachmentKey,
    };
    await this.saveItemState(item, state);
    return this.store.getItem(item.libraryID, item.key)!;
  }

  private async saveItemState(
    item: Zotero.Item,
    state: ItemInternalState,
  ): Promise<void> {
    await this.ready();
    this.assertStateIdentity(item, state);
    await this.store.setItem(state);
    // The store has already read the value back successfully. Only now is it
    // safe to remove the obsolete, user-visible Extra lines.
    await this.cleanupItemExtra(item);
  }

  private async cleanupItemExtra(item: Zotero.Item): Promise<void> {
    const before = String(item.getField("extra") || "");
    if (!hasManagedItemExtra(before)) return;
    const expected = stripManagedItemExtra(before);
    item.setField("extra", expected);
    await item.saveTx();
    const after = String(item.getField("extra") || "");
    if (hasManagedItemExtra(after) || after !== expected) {
      throw new Error(`条目 ${item.key} 的旧 ZRDB Extra 清理后校验失败`);
    }
  }

  private async cleanupWorkspaceExtra(item: Zotero.Item): Promise<void> {
    const before = String(item.getField("extra") || "");
    if (!hasManagedWorkspaceExtra(before)) return;
    const expected = stripManagedWorkspaceExtra(before);
    item.setField("extra", expected);
    await item.saveTx();
    const after = String(item.getField("extra") || "");
    if (hasManagedWorkspaceExtra(after) || after !== expected)
      throw new Error("研究数据库系统条目的旧 Extra 清理后校验失败");
  }

  private async ready(): Promise<void> {
    await this.store.ready?.();
  }

  private readLegacyWorkspace(): WorkspaceState | undefined {
    if (!this.syncedSettingsAvailable()) return undefined;
    return this.legacySyncedStore.getWorkspace(this.libraryID);
  }

  private readLegacyItem(item: Zotero.Item): ItemInternalState | undefined {
    if (!this.syncedSettingsAvailable()) return undefined;
    const state = this.legacySyncedStore.getItem(item.libraryID, item.key);
    if (
      state &&
      state.itemKey === item.key &&
      state.libraryID === item.libraryID
    )
      return state;
    return undefined;
  }

  private async clearLegacyWorkspace(): Promise<void> {
    if (!this.syncedSettingsAvailable()) return;
    await ((Zotero as any).SyncedSettings as any).clear(
      this.libraryID,
      WORKSPACE_SYNCED_SETTING,
      { skipDeleteLog: true },
    );
  }

  private async clearLegacyItem(item: Zotero.Item): Promise<void> {
    if (!this.syncedSettingsAvailable()) return;
    await ((Zotero as any).SyncedSettings as any).clear(
      item.libraryID,
      itemSyncedSetting(item.key),
      { skipDeleteLog: true },
    );
  }

  private syncedSettingsAvailable(): boolean {
    const settings = (Zotero as any).SyncedSettings;
    return Boolean(
      settings &&
      typeof settings.get === "function" &&
      typeof settings.clear === "function",
    );
  }

  private assertPaper(item: Zotero.Item): void {
    if (item.libraryID !== this.libraryID || !item.isRegularItem())
      throw new Error("第一版仅支持个人库中的普通文献条目");
  }

  private assertRecordIdentity(
    item: Zotero.Item,
    record: ItemResearchRecord,
  ): void {
    if (record.itemKey !== item.key || record.libraryID !== item.libraryID) {
      throw new Error(
        `拒绝把 ${record.itemKey} 的研究属性用于条目 ${item.key}`,
      );
    }
  }

  private assertStateIdentity(
    item: Zotero.Item,
    state: ItemInternalState,
  ): void {
    if (state.itemKey !== item.key || state.libraryID !== item.libraryID)
      throw new Error(`条目 ${item.key} 的研究数据库内部记录身份不匹配`);
    if (state.record) this.assertRecordIdentity(item, state.record);
  }

  private async findRecordNote(
    item: Zotero.Item,
  ): Promise<Zotero.Item | undefined> {
    const notes = await Zotero.Items.getAsync(item.getNotes());
    return notes.find((note) => note.isNote() && isRecordNote(note.getNote()));
  }

  private async findWorkspaceNote(
    item: Zotero.Item,
  ): Promise<Zotero.Item | undefined> {
    const notes = await Zotero.Items.getAsync(item.getNotes());
    return notes.find(
      (note) => note.isNote() && isWorkspaceNote(note.getNote()),
    );
  }

  private async ensureWorkspaceItem(): Promise<Zotero.Item> {
    let item = this.workspaceItemID
      ? await Zotero.Items.getAsync(this.workspaceItemID)
      : undefined;
    if (!item || !item.isRegularItem()) {
      const all = (await (Zotero.Items as any).getAll(
        this.libraryID,
        true,
      )) as Zotero.Item[];
      const candidates = all.filter(
        (candidate) =>
          candidate.isRegularItem() &&
          candidate.getField("title") === WORKSPACE_TITLE,
      );
      item =
        candidates.find((candidate) =>
          String(candidate.getField("extra") || "").includes(WORKSPACE_MARKER),
        ) || candidates[0];
    }
    if (!item) {
      item = new Zotero.Item("document");
      item.libraryID = this.libraryID;
      item.setField("title", WORKSPACE_TITLE);
      await item.saveTx();
    }
    this.workspaceItemID = item.id;
    return item;
  }
}
