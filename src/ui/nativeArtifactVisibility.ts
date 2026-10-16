import type { ManagedArtifact } from "../domain/types";
import { ResearchRepository } from "../storage/repository";

const HIDDEN_ROLES = new Set<ManagedArtifact["role"]>([
  "mineru-original",
  "figure",
  "table",
]);

const COMPATIBILITY_WARNING =
  "Zotero Research Database：当前 Zotero ItemTree 与 MinerU 产物隐藏适配器不兼容；已安全降级为显示全部原生子附件。";
let compatibilityWarningEmitted = false;

interface ItemTreeRowLike {
  level: number;
  ref?: Zotero.Item;
}

interface ItemTreeRowProviderLike {
  _rows: ItemTreeRowLike[];
  _rowMap?: Record<string | number, number>;
  refreshRowMap?: () => void;
  onUpdate?: {
    addListener: (listener: (...args: any[]) => unknown) => void;
    removeListener: (listener: (...args: any[]) => unknown) => void;
  };
}

interface ItemTreeLike {
  _rows: ItemTreeRowLike[];
  _rowMap?: Record<string | number, number>;
  _refreshRowMap: () => void;
  rowProvider?: ItemTreeRowProviderLike;
  toggleOpenState: (...args: any[]) => unknown;
  refreshAndMaintainSelection: (...args: any[]) => unknown;
  refresh?: (...args: any[]) => unknown;
  tree?: { invalidate?: () => void };
  isContainerOpen?: (index: number) => boolean;
}

/**
 * Locally suppress plugin-managed MinerU attachment rows in Zotero's native
 * item tree. No item, tag, attachment or database row is modified.
 */
export class NativeArtifactVisibilityController {
  private tree?: ItemTreeLike;
  private enabled = false;
  private generation = 0;
  private originalToggle?: ItemTreeLike["toggleOpenState"];
  private originalRefresh?: ItemTreeLike["refreshAndMaintainSelection"];
  private wrappedToggle?: ItemTreeLike["toggleOpenState"];
  private wrappedRefresh?: ItemTreeLike["refreshAndMaintainSelection"];
  private rowProviderUpdateListener?: (...args: any[]) => Promise<void>;
  private hiddenParentIDs = new Set<number>();

  constructor(
    tree: unknown,
    private repository = new ResearchRepository(),
  ) {
    if (isCompatibleItemTree(tree)) this.tree = tree;
    else warnIncompatibleItemTreeOnce();
  }

  install(enabled: boolean): boolean {
    const tree = this.tree;
    if (!tree || this.originalToggle || this.originalRefresh) return false;
    this.originalToggle = tree.toggleOpenState;
    this.originalRefresh = tree.refreshAndMaintainSelection;

    // Zotero 10 declares `get _rowMap()` on ItemTree without a setter, but
    // LibraryTree._refreshRowMap() still assigns `this._rowMap = ...` which
    // hits the getter-only property. Install an instance-level shim that
    // forwards the assignment to rowProvider._rowMap so the inherited method
    // works without touching Zotero's class definition.
    const provider = tree.rowProvider;
    if (provider) {
      const existing = Object.getOwnPropertyDescriptor(tree, "_rowMap");
      if (!existing?.set) {
        const providerRef = provider;
        Object.defineProperty(tree, "_rowMap", {
          configurable: true,
          enumerable: true,
          get() {
            return providerRef._rowMap ?? {};
          },
          set(value: Record<string | number, number>) {
            providerRef._rowMap = value;
          },
        });
      }

      // Zotero 10 moved row mutations (opening restored containers, expanding
      // multiple rows, sorting and notifier updates) into ItemTreeRowProvider.
      // Most of those paths do not call ItemTree.toggleOpenState or
      // refreshAndMaintainSelection, so listen to the provider's single update
      // event as the authoritative point at which rebuilt child rows can be
      // filtered again.
      if (provider.onUpdate?.addListener) {
        this.rowProviderUpdateListener = async () => {
          if (this.enabled) await this.refresh();
        };
        provider.onUpdate.addListener(this.rowProviderUpdateListener);
      }
    }

    this.wrappedToggle = (...args: any[]) => {
      const result = this.originalToggle!.apply(tree, args);
      if (args[1] === true || !this.enabled) return result;
      return Promise.resolve(result).then(async (value) => {
        await this.refresh();
        return value;
      });
    };
    this.wrappedRefresh = (...args: any[]) =>
      Promise.resolve(this.originalRefresh!.apply(tree, args)).then(
        async (value) => {
          if (this.enabled) await this.refresh();
          return value;
        },
      );
    (this.wrappedToggle as any).__zrdbArtifactVisibility = true;
    (this.wrappedRefresh as any).__zrdbArtifactVisibility = true;
    (this.wrappedToggle as any).__zrdbArtifactVisibilityController = this;
    (this.wrappedToggle as any).__zrdbArtifactVisibilityEnabled = () =>
      this.enabled;
    tree.toggleOpenState = this.wrappedToggle;
    tree.refreshAndMaintainSelection = this.wrappedRefresh;
    this.enabled = enabled;
    if (enabled) void this.refresh();
    return true;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      if (!this.tree) return;
      // Preference notifications can be coalesced by Zotero. Re-run the
      // filter even when the controller already believes it is enabled: the
      // native ItemTree may have rebuilt its rows between notifications.
      this.enabled = true;
      const generation = ++this.generation;
      await this.refresh();
      if (generation !== this.generation || !this.enabled) return;
      return;
    }
    if (!this.tree || !this.enabled) return;
    this.enabled = false;
    const generation = ++this.generation;
    if (this.originalRefresh) {
      await this.restoreRows(undefined, undefined, generation);
      if (generation !== this.generation) return;
      this.tree.tree?.invalidate?.();
    }
  }

  async refresh(): Promise<void> {
    const tree = this.tree;
    if (!tree || !this.enabled) return;
    const parents = uniqueParents(tree._rows);
    const manifests = await Promise.all(
      parents.map(async (parent) => {
        try {
          return await this.repository.loadAllArtifacts(parent);
        } catch (error) {
          Zotero.logError(
            error instanceof Error ? error : new Error(String(error)),
          );
          return [];
        }
      }),
    );
    if (!this.enabled) return;
    const hiddenKeys = new Set(
      manifests
        .flat()
        .filter((artifact) => HIDDEN_ROLES.has(artifact.role))
        .map((artifact) => artifact.attachmentKey),
    );
    if (!hiddenKeys.size) return;
    const rows = tree._rows.filter((row) => {
      const hidden =
        row.level !== 0 && Boolean(row.ref?.key && hiddenKeys.has(row.ref.key));
      if (hidden && row.ref?.parentItemID)
        this.hiddenParentIDs.add(row.ref.parentItemID);
      return !hidden;
    });
    if (rows.length === tree._rows.length) return;
    // Zotero 10 exposes _rows as a getter-only property backed by
    // rowProvider. Mutate the underlying array in place via splice so the
    // filter works on both Zotero 9 (direct _rows) and Zotero 10
    // (rowProvider.rows).
    const provider = tree.rowProvider;
    if (provider && Array.isArray(provider._rows)) {
      provider._rows.splice(0, provider._rows.length, ...rows);
    } else {
      tree._rows.splice(0, tree._rows.length, ...rows);
    }
    if (typeof tree._refreshRowMap === "function") tree._refreshRowMap();
    else if (typeof provider?.refreshRowMap === "function")
      provider.refreshRowMap();
    tree.tree?.invalidate?.();
  }

  destroy(): void {
    const tree = this.tree;
    if (!tree) return;
    this.enabled = false;
    this.generation++;
    if (this.rowProviderUpdateListener) {
      tree.rowProvider?.onUpdate?.removeListener(
        this.rowProviderUpdateListener,
      );
      this.rowProviderUpdateListener = undefined;
    }
    let restored = false;
    if (this.originalToggle && tree.toggleOpenState === this.wrappedToggle) {
      tree.toggleOpenState = this.originalToggle;
      restored = true;
    }
    if (
      this.originalRefresh &&
      tree.refreshAndMaintainSelection === this.wrappedRefresh
    ) {
      tree.refreshAndMaintainSelection = this.originalRefresh;
      restored = true;
    }
    const refresh = this.originalRefresh;
    const toggle = this.originalToggle;
    this.originalToggle = undefined;
    this.originalRefresh = undefined;
    this.wrappedToggle = undefined;
    this.wrappedRefresh = undefined;
    if (restored && refresh) void this.restoreRows(refresh, toggle);
  }

  private async restoreRows(
    refresh = this.originalRefresh,
    toggle = this.originalToggle,
    expectedGeneration?: number,
  ): Promise<void> {
    const tree = this.tree;
    if (!tree || !refresh) return;
    const isCurrent = () =>
      expectedGeneration === undefined ||
      expectedGeneration === this.generation;
    await Promise.resolve(refresh.call(tree));
    if (!isCurrent()) return;
    if (tree.refresh) await Promise.resolve(tree.refresh.call(tree));
    if (!isCurrent()) return;
    for (const parentID of this.hiddenParentIDs) {
      if (!isCurrent()) return;
      let row = tree._rowMap?.[parentID];
      if (typeof row !== "number") continue;
      if (
        tree._rows.some((candidate) => candidate.ref?.parentItemID === parentID)
      ) {
        continue;
      }
      if (!toggle) continue;
      // Removing child rows leaves Zotero's parent-open state intact. A plain
      // refresh therefore may not rebuild those rows. Close and reopen an
      // already-open parent to make Zotero reconstruct its native children.
      if (tree.isContainerOpen?.(row)) {
        if (!isCurrent()) return;
        await Promise.resolve(toggle.call(tree, row));
        if (!isCurrent()) return;
        row = tree._rowMap?.[parentID];
        if (typeof row !== "number") continue;
      }
      if (!isCurrent()) return;
      await Promise.resolve(toggle.call(tree, row));
      if (!isCurrent()) return;
    }
    if (isCurrent()) this.hiddenParentIDs.clear();
  }
}

function isCompatibleItemTree(value: unknown): value is ItemTreeLike {
  const tree = value as Partial<ItemTreeLike> | undefined;
  const provider = tree?.rowProvider;
  return Boolean(
    tree &&
    (Array.isArray(tree._rows) || Array.isArray(provider?._rows)) &&
    (typeof tree._refreshRowMap === "function" ||
      typeof provider?.refreshRowMap === "function") &&
    typeof tree.toggleOpenState === "function" &&
    typeof tree.refreshAndMaintainSelection === "function",
  );
}

function warnIncompatibleItemTreeOnce(): void {
  if (compatibilityWarningEmitted) return;
  compatibilityWarningEmitted = true;
  const zotero = (globalThis as any).Zotero;
  if (typeof zotero?.warn === "function") {
    zotero.warn(COMPATIBILITY_WARNING);
    return;
  }
  if (typeof zotero?.logError === "function") {
    zotero.logError(new Error(COMPATIBILITY_WARNING));
  }
}

function uniqueParents(rows: ItemTreeRowLike[]): Zotero.Item[] {
  const found = new Map<string, Zotero.Item>();
  for (const row of rows) {
    const item = row.ref;
    if (
      row.level !== 0 ||
      !item?.key ||
      typeof item.isRegularItem !== "function" ||
      !item.isRegularItem()
    ) {
      continue;
    }
    found.set(`${item.libraryID}:${item.key}`, item);
  }
  return [...found.values()];
}
