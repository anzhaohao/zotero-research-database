import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { config } from "../../package.json";
import { ResearchRepository, WORKSPACE_TITLE } from "../storage/repository";
import {
  ResearchDatabaseApp,
  type DatabaseViewMode,
} from "./ResearchDatabaseApp";
import { getPref, setPref } from "../utils/prefs";
import { SYNCED_SETTING_PREFIX } from "../domain/defaults";
import { itemNotificationTouchesView, selectedTabType } from "./refreshPolicy";
import { onLocalResearchDataChanged } from "../storage/localData";
import { NativeArtifactVisibilityController } from "./nativeArtifactVisibility";

type ViewMode = "default" | DatabaseViewMode;

export class MainViewController {
  private root?: Root;
  private customPane?: HTMLDivElement;
  private nativePane?: Element;
  private itemsContainer?: HTMLElement;
  private toggleButton?: HTMLButtonElement;
  private refreshListener?: () => void;
  private sourceChangeListener?: EventListener;
  private collectionSelectionBinding?: {
    removeListener?: (listener: () => void) => void;
  };
  private collectionTree?: HTMLElement;
  private itemsTreeObserver?: MutationObserver;
  private localDataUnsubscribe?: () => void;
  private notifierID?: string;
  private notifyTimer?: number;
  private settleTimer?: number;
  private reloadTimer?: number;
  private visibilityPrefObserverID?: symbol;
  private nativeArtifactVisibility?: NativeArtifactVisibilityController;
  private libraryTabActive = true;
  private mode: ViewMode = "default";
  private repository = new ResearchRepository();

  constructor(private win: _ZoteroTypes.MainWindow) {}

  async mount(): Promise<void> {
    this.activateReactWindowContext();
    const doc = this.win.document;
    const toolbar = doc.querySelector<HTMLElement>("#zotero-items-toolbar");
    const container = doc.querySelector<HTMLElement>(
      "#zotero-items-pane-container",
    );
    this.nativePane =
      doc.querySelector<Element>("#zotero-items-pane") || undefined;
    if (!toolbar || !container || !this.nativePane) {
      throw new Error("Zotero 9 文献列表结构不兼容，已保留默认视图");
    }
    this.itemsContainer = container;
    // Keep Zotero's middle pane as the flex sizing authority. The custom view
    // is an overlay inside it, so switching views cannot change the width of
    // the collection tree or the item-details pane.
    container.classList.add("zrdb-items-pane-container");
    if (!doc.getElementById(`${config.addonRef}-stylesheet`)) {
      const link = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "link",
      ) as HTMLLinkElement;
      link.id = `${config.addonRef}-stylesheet`;
      link.rel = "stylesheet";
      link.href = `${rootURI}content/zoteroPane.css`;
      doc.documentElement?.appendChild(link);
    }

    toolbar.classList.add("zrdb-has-view-toggle");
    this.toggleButton = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    this.toggleButton.id = `${config.addonRef}-view-toggle`;
    this.toggleButton.className = "zrdb-view-toggle";
    this.toggleButton.type = "button";
    this.toggleButton.append(
      createViewIcon(doc, "table", "table"),
      createViewIcon(doc, "default", "default"),
    );
    this.toggleButton.addEventListener("click", () =>
      this.setMode(this.mode === "default" ? "table" : "default"),
    );
    toolbar.appendChild(this.toggleButton);

    this.customPane = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    this.customPane.id = `${config.addonRef}-custom-pane`;
    this.customPane.className = "zrdb-custom-pane";
    this.customPane.hidden = true;
    container.appendChild(this.customPane);
    this.root = createRoot(this.customPane);

    // During early startup Zotero may not have assigned the library tab type
    // yet. Only a positively identified reader should suppress the first
    // database render; later tab notifications provide the canonical type.
    this.libraryTabActive = this.win.Zotero_Tabs.selectedType !== "reader";
    this.nativeArtifactVisibility = new NativeArtifactVisibilityController(
      this.win.ZoteroPane.itemsView,
      this.repository,
    );
    this.nativeArtifactVisibility.install(
      getPref("hideMinerUArtifactsInNativeList") !== false,
    );
    this.visibilityPrefObserverID = Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.hideMinerUArtifactsInNativeList`,
      () =>
        void this.nativeArtifactVisibility?.setEnabled(
          getPref("hideMinerUArtifactsInNativeList") !== false,
        ),
      true,
    );
    this.refreshListener = () => {
      void this.nativeArtifactVisibility?.refresh();
      if (!this.libraryTabActive) return;
      this.scheduleRefresh();
    };
    (this.win.ZoteroPane.itemsView as any).onRefresh.addListener(
      this.refreshListener,
    );
    this.installSourceChangeListeners();
    this.localDataUnsubscribe = onLocalResearchDataChanged((change) => {
      if (change.scope === "translated-title") return;
      void this.nativeArtifactVisibility?.refresh();
      if (!this.libraryTabActive || this.mode === "default") return;
      this.scheduleRefresh();
    });
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event, type, ids, extraData) =>
          this.handleNotification(event, type, ids, extraData),
      },
      ["item", "setting", "tab"],
      `${config.addonRef}-database-view`,
    );

    const preferred = String(
      getPref("lastViewMode") || getPref("defaultView") || "default",
    ) as ViewMode;
    this.setMode(preferred === "table" ? "table" : "default");
  }

  destroy(): void {
    this.activateReactWindowContext();
    if (this.refreshListener) {
      try {
        (this.win.ZoteroPane.itemsView as any).onRefresh.removeListener(
          this.refreshListener,
        );
      } catch (error) {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = undefined;
    }
    this.localDataUnsubscribe?.();
    this.localDataUnsubscribe = undefined;
    if (this.visibilityPrefObserverID) {
      Zotero.Prefs.unregisterObserver(this.visibilityPrefObserverID);
      this.visibilityPrefObserverID = undefined;
    }
    this.nativeArtifactVisibility?.destroy();
    this.nativeArtifactVisibility = undefined;
    this.destroySourceChangeListeners();
    this.cancelScheduledRefresh();
    this.cancelDatabaseViewReload();
    this.setNativePaneHidden(false);
    this.root?.unmount();
    this.toggleButton?.remove();
    this.win.document
      .querySelector("#zotero-items-toolbar")
      ?.classList.remove("zrdb-has-view-toggle");
    this.itemsContainer?.classList.remove("zrdb-items-pane-container");
    this.customPane?.remove();
    this.win.document.getElementById(`${config.addonRef}-stylesheet`)?.remove();
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    setPref("lastViewMode", mode);
    if (!this.nativePane || !this.customPane) return;
    const custom = mode !== "default";
    this.setNativePaneHidden(custom);
    this.customPane.hidden = !custom;
    if (this.toggleButton) {
      const label =
        mode === "default" ? "切换到数据库表格" : "返回 Zotero 默认列表";
      this.toggleButton.dataset.mode = mode;
      this.toggleButton.dataset.tooltip = label;
      this.toggleButton.title = label;
      this.toggleButton.setAttribute("aria-label", label);
      this.toggleButton.classList.toggle("active", mode === "table");
      this.toggleButton.setAttribute(
        "aria-pressed",
        mode === "table" ? "true" : "false",
      );
    }
    if (custom && this.libraryTabActive) this.scheduleRefresh();
  }

  private setNativePaneHidden(hidden: boolean): void {
    if (!this.nativePane) return;
    this.nativePane.classList.toggle("zrdb-native-pane-hidden", hidden);
    // Do not set XUL's `hidden` attribute here: it removes the only in-flow
    // child of the middle pane and lets its min-content width affect Zotero's
    // three-column splitter. `visibility` keeps that geometry intact while
    // the custom view covers the exact same rectangle.
    this.nativePane.removeAttribute("hidden");
  }

  private handleNotification(
    event: _ZoteroTypes.Notifier.Event,
    type: _ZoteroTypes.Notifier.Type,
    ids: string[] | number[],
    extraData: Record<string | number, { type?: unknown }>,
  ): void {
    if (type === "tab") {
      if (event !== "select") return;
      const nextLibraryTabActive =
        selectedTabType(ids, extraData, this.win.Zotero_Tabs.selectedType) ===
        "zotero-pane";
      this.libraryTabActive = nextLibraryTabActive;
      if (!nextLibraryTabActive) {
        this.cancelScheduledRefresh();
        this.cancelDatabaseViewReload();
        return;
      }
      // A PDF reader can leave React's virtualized table with the item range
      // from the article that opened it. Recreate only this plugin's React
      // root after Zotero's ItemTree has had time to settle; do not restart
      // Zotero or re-register the controller, toolbar, notifier, or observers.
      if (this.mode !== "default") this.scheduleDatabaseViewReload();
      return;
    }

    if (type === "setting") {
      if (!this.libraryTabActive || this.mode === "default") return;
      const touchesResearchData = ids.some((id) =>
        String(id)
          .split("/")
          .slice(1)
          .join("/")
          .startsWith(`${SYNCED_SETTING_PREFIX}.`),
      );
      if (touchesResearchData) this.scheduleRefresh();
      return;
    }

    if (
      type !== "item" ||
      !this.libraryTabActive ||
      this.mode === "default" ||
      !this.itemNotificationTouchesCurrentView(ids)
    ) {
      return;
    }
    this.scheduleRefresh();
  }

  private itemNotificationTouchesCurrentView(
    ids: Array<string | number>,
  ): boolean {
    const sorted = (this.win.ZoteroPane.getSortedItems() ||
      []) as Zotero.Item[];
    return itemNotificationTouchesView(
      ids,
      sorted,
      (id) => {
        try {
          return Zotero.Items.get(id);
        } catch {
          return undefined;
        }
      },
      (item) => this.isWorkspaceItem(item),
    );
  }

  private isWorkspaceItem(item: Zotero.Item): boolean {
    return (
      item.libraryID === Zotero.Libraries.userLibraryID &&
      !item.deleted &&
      item.getField("title") === WORKSPACE_TITLE
    );
  }

  private scheduleRefresh(): void {
    if (!this.ensureLibraryTabIsActive() || this.mode === "default") return;
    this.cancelScheduledRefresh(false);
    this.notifyTimer = this.win.setTimeout(() => {
      this.notifyTimer = undefined;
      void this.render();
    }, 80);
  }

  private cancelScheduledRefresh(cancelSettled = true): void {
    if (this.notifyTimer !== undefined) {
      this.win.clearTimeout(this.notifyTimer);
      this.notifyTimer = undefined;
    }
    if (cancelSettled && this.settleTimer !== undefined) {
      this.win.clearTimeout(this.settleTimer);
      this.settleTimer = undefined;
    }
  }

  /**
   * A collection/search/tag change updates the native ItemTree asynchronously.
   * `onRefresh` is normally enough, but it can run before `getSortedItems()`
   * has received the new rows. Observe the real ItemTree as a compatibility
   * fallback, then take a second settled snapshot after its update completes.
   */
  private installSourceChangeListeners(): void {
    const schedule = () => this.scheduleSourceRefresh();
    this.sourceChangeListener = schedule;

    const collectionView = (this.win.ZoteroPane as any).collectionsView;
    const onSelect = collectionView?.onSelect;
    if (onSelect?.addListener) {
      onSelect.addListener(schedule);
      this.collectionSelectionBinding = onSelect;
    }

    const tree = this.win.document.querySelector<HTMLElement>(
      "#zotero-collections-tree",
    );
    if (tree) {
      this.collectionTree = tree;
      for (const event of ["select", "change", "command", "click"])
        tree.addEventListener(event, schedule, true);
    }

    const MutationObserverCtor = this.win.MutationObserver;
    if (MutationObserverCtor && this.nativePane) {
      const observer = new MutationObserverCtor(() =>
        this.scheduleSourceRefresh(),
      );
      observer.observe(this.nativePane, {
        childList: true,
        subtree: true,
      });
      this.itemsTreeObserver = observer;
    }
  }

  private destroySourceChangeListeners(): void {
    if (this.sourceChangeListener) {
      this.collectionSelectionBinding?.removeListener?.(
        this.sourceChangeListener as () => void,
      );
      for (const event of ["select", "change", "command", "click"])
        this.collectionTree?.removeEventListener(
          event,
          this.sourceChangeListener,
          true,
        );
    }
    this.sourceChangeListener = undefined;
    this.collectionSelectionBinding = undefined;
    this.collectionTree = undefined;
    this.itemsTreeObserver?.disconnect();
    this.itemsTreeObserver = undefined;
  }

  private scheduleSourceRefresh(): void {
    if (!this.ensureLibraryTabIsActive() || this.mode === "default") return;
    this.scheduleRefresh();
    if (this.settleTimer !== undefined) this.win.clearTimeout(this.settleTimer);
    this.settleTimer = this.win.setTimeout(() => {
      this.settleTimer = undefined;
      // The second render intentionally reads `getSortedItems()` again after
      // Zotero's `changeCollectionTreeRow()` and virtual-tree update settle.
      this.scheduleRefresh();
    }, 180);
  }

  /**
   * Re-mount the database view after returning from Zotero's PDF reader.
   * This deliberately preserves the controller and its native registrations;
   * only the React tree that owns the custom table is replaced.
   */
  private scheduleDatabaseViewReload(): void {
    if (this.mode === "default") return;
    this.cancelDatabaseViewReload();
    this.reloadTimer = this.win.setTimeout(() => {
      this.reloadTimer = undefined;
      if (
        this.mode === "default" ||
        this.win.Zotero_Tabs.selectedType !== "zotero-pane" ||
        !this.customPane
      ) {
        return;
      }
      try {
        this.activateReactWindowContext();
        this.libraryTabActive = true;
        this.cancelScheduledRefresh();
        this.root?.unmount();
        this.customPane.replaceChildren();
        this.root = createRoot(this.customPane);
        // Both snapshots read ZoteroPane.getSortedItems() at render time,
        // after the reader and native ItemTree have finished their transition.
        this.scheduleSourceRefresh();
      } catch (error) {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
        this.setMode("default");
      }
    }, 230);
  }

  private cancelDatabaseViewReload(): void {
    if (this.reloadTimer === undefined) return;
    this.win.clearTimeout(this.reloadTimer);
    this.reloadTimer = undefined;
  }

  /**
   * Reader-originated actions can return to the library without delivering the
   * normal `tab/select` notifier event to a bootstrap add-on. Do not let that
   * missed event permanently suppress collection/item-tree refreshes. The
   * selected tab is Zotero's authoritative state; this only re-enables the
   * view after it has actually returned to the library tab.
   */
  private ensureLibraryTabIsActive(): boolean {
    if (this.libraryTabActive) return true;
    if (this.win.Zotero_Tabs.selectedType !== "zotero-pane") return false;
    this.libraryTabActive = true;
    if (this.mode !== "default") this.scheduleDatabaseViewReload();
    return true;
  }

  private async render(): Promise<void> {
    if (
      !this.root ||
      this.mode === "default" ||
      !this.ensureLibraryTabIsActive()
    ) {
      return;
    }
    try {
      this.activateReactWindowContext();
      const sorted = (this.win.ZoteroPane.getSortedItems() ||
        []) as Zotero.Item[];
      const items = sorted.filter(
        (item) =>
          item?.isRegularItem?.() &&
          item.libraryID === Zotero.Libraries.userLibraryID &&
          !item.deleted &&
          !this.isWorkspaceItem(item),
      );
      this.root.render(
        <ResearchDatabaseApp
          mode={this.mode}
          items={items}
          repository={this.repository}
          zoteroWindow={this.win}
          onSelect={(selected) => this.selectItems(selected)}
          onModeChange={(mode) => this.setMode(mode)}
        />,
      );
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
      this.setMode("default");
      new addon.data.ztoolkit.ProgressWindow(config.addonName)
        .createLine({
          text: `数据库视图加载失败，已返回默认列表：${
            error instanceof Error ? error.message : String(error)
          }`,
          type: "fail",
        })
        .show();
    }
  }

  private async selectItems(items: Zotero.Item[]): Promise<void> {
    const ids = items.map((item) => item.id);
    if (!ids.length) {
      (this.win.ZoteroPane.itemsView as any).selection.clearSelection();
      return;
    }
    await (this.win.ZoteroPane.itemsView as any).selectItems(ids);
  }

  private activateReactWindowContext(): void {
    // Bootstrap plugins execute in a sandbox without a global `window`, while
    // ReactDOM consults it during renders and event-driven state updates.
    // Point the sandbox globals at the Zotero window that owns this view.
    const sandbox = globalThis as typeof globalThis & {
      window: Window;
      document: Document;
      getComputedStyle: Window["getComputedStyle"];
    };
    sandbox.window = this.win as unknown as Window;
    sandbox.document = this.win.document;
    sandbox.getComputedStyle = this.win.getComputedStyle.bind(this.win);
  }
}

function createViewIcon(
  doc: Document,
  mode: ViewMode,
  role: "table" | "default",
): Element {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "zrdb-ui-icon");
  svg.setAttribute("data-toggle-icon", role);
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.45");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");

  const append = (
    name: "path" | "rect",
    attributes: Record<string, string>,
  ) => {
    const element = doc.createElementNS(svgNS, name);
    for (const [attribute, value] of Object.entries(attributes))
      element.setAttribute(attribute, value);
    svg.appendChild(element);
  };

  if (mode === "default") {
    append("path", { d: "M7 5h9M7 10h9M7 15h9" });
    append("path", {
      d: "M4 5h.01M4 10h.01M4 15h.01",
      "stroke-width": "2.4",
    });
  } else if (mode === "table") {
    append("rect", { x: "3", y: "3", width: "14", height: "14", rx: "2" });
    append("path", { d: "M3 8h14M8 3v14M13 3v14" });
  }
  return svg;
}
