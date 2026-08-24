import { config } from "../../package.json";
import { setManualValue } from "../core/records";
import type { FieldDefinition } from "../domain/types";
import { onLocalResearchDataChanged } from "../storage/localData";
import { ResearchRepository } from "../storage/repository";

interface RegisteredRow {
  rowID: string;
  field: FieldDefinition;
  signature: string;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function storedValue(value: string, field: FieldDefinition): unknown {
  const trimmed = value.trim();
  if (field.type === "checkbox")
    return ["true", "1", "是", "yes", "已勾选"].includes(
      trimmed.toLocaleLowerCase(),
    );
  if (field.type === "number" || field.type === "rating") {
    if (!trimmed) return null;
    const number = Number(trimmed);
    if (!Number.isFinite(number)) throw new Error(`${field.name} 必须是数字`);
    return number;
  }
  if (field.type === "multiSelect")
    return value
      .split(/[，,、]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  return value;
}

/** Register research fields directly in Zotero's native Info pane. */
export class ItemPaneProperties {
  private repository = new ResearchRepository();
  private rows = new Map<string, RegisteredRow>();
  private unsubscribe?: () => void;
  private registered = false;

  async register(): Promise<void> {
    if (this.registered) return;
    const workspace = await this.repository.loadWorkspace();
    this.syncFields(workspace.fields);
    this.unsubscribe = onLocalResearchDataChanged(() => {
      void this.refreshWorkspaceRows();
    });
    this.registered = true;
  }

  unregister(): void {
    for (const row of this.rows.values())
      Zotero.ItemPaneManager.unregisterInfoRow(row.rowID);
    this.rows.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.registered = false;
  }

  /** Reconcile renamed, added, restored and archived field definitions. */
  syncFields(fields: FieldDefinition[]): void {
    const active = new Map(
      fields
        .filter((field) => !field.archived)
        .map((field) => [field.id, field]),
    );
    for (const [fieldID, row] of this.rows) {
      const field = active.get(fieldID);
      const signature = field ? this.signature(field) : "";
      if (!field || signature !== row.signature) {
        Zotero.ItemPaneManager.unregisterInfoRow(row.rowID);
        this.rows.delete(fieldID);
      }
    }
    for (const field of active.values()) {
      if (this.rows.has(field.id)) continue;
      this.registerField(field);
    }
    this.refreshRows();
  }

  private registerField(field: FieldDefinition): void {
    const result = Zotero.ItemPaneManager.registerInfoRow({
      rowID: `property-${field.id}`,
      pluginID: config.addonID,
      // Zotero 9 requires an l10nID but exposes no dynamic l10n arguments for
      // info rows. The runtime retains `text`; patchLabels applies the exact
      // user-defined name after each native render.
      label: {
        l10nID: "zrdb-item-info-row-label",
        text: field.name,
      } as { l10nID: string },
      position: "end",
      multiline: field.type === "longText" || field.type === "multiSelect",
      nowrap: false,
      editable: true,
      onGetData: ({ item }) => {
        this.scheduleLabelPatch();
        if (!this.supports(item)) return "";
        return displayValue(
          this.repository.peekRecord(item)?.fields[field.id]?.value,
        );
      },
      onSetData: ({ item, value, editable }) => {
        if (!editable || !this.supports(item)) return;
        void this.saveValue(item, field, value);
      },
      onItemChange: ({ item, editable, setEnabled, setEditable }) => {
        const supported = this.supports(item);
        setEnabled(supported);
        setEditable(supported && editable);
        this.scheduleLabelPatch();
      },
    });
    if (result === false)
      throw new Error(`无法注册 Zotero 原生研究属性：${field.name}`);
    this.rows.set(field.id, {
      rowID: result,
      field,
      signature: this.signature(field),
    });
  }

  private async saveValue(
    item: Zotero.Item,
    field: FieldDefinition,
    value: string,
  ): Promise<void> {
    try {
      const workspace = await this.repository.loadWorkspace();
      const current = (await this.repository.loadRecord(
        item,
        true,
        workspace.fields,
      ))!;
      const next = setManualValue(current, field.id, storedValue(value, field));
      await this.repository.saveRecord(item, next, workspace.fields);
      const row = this.rows.get(field.id);
      if (row) Zotero.ItemPaneManager.refreshInfoRow(row.rowID);
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private supports(item: Zotero.Item): boolean {
    return Boolean(
      item?.isRegularItem?.() &&
      item.libraryID === Zotero.Libraries.userLibraryID &&
      !item.deleted &&
      !this.repository.isWorkspaceItemSync(item),
    );
  }

  private signature(field: FieldDefinition): string {
    return JSON.stringify({
      id: field.id,
      name: field.name,
      type: field.type,
      archived: field.archived,
    });
  }

  private async refreshWorkspaceRows(): Promise<void> {
    try {
      this.syncFields((await this.repository.loadWorkspace()).fields);
      this.refreshRows();
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private refreshRows(): void {
    for (const row of this.rows.values())
      Zotero.ItemPaneManager.refreshInfoRow(row.rowID);
    this.scheduleLabelPatch();
  }

  private scheduleLabelPatch(): void {
    const patch = () => this.patchLabels();
    for (const win of Zotero.getMainWindows()) {
      win.setTimeout(patch, 0);
      win.setTimeout(patch, 80);
    }
  }

  private patchLabels(): void {
    for (const win of Zotero.getMainWindows()) {
      for (const row of this.rows.values()) {
        const escape = win.CSS?.escape || CSS.escape;
        const label = win.document.querySelector<HTMLElement>(
          `[data-custom-row-id="${escape(row.rowID)}"] .meta-label label`,
        );
        if (!label) continue;
        label.removeAttribute("data-l10n-id");
        label.textContent = row.field.name;
        label.title = row.field.description;
      }
    }
  }
}
