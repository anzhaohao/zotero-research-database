import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { config } from "../../package.json";
import { WORKSPACE_TITLE } from "../storage/repository";
import { getResearchRepository } from "../storage/repositoryScope";
import {
  ResearchDatabaseApp,
  type DatabaseViewMode,
} from "./ResearchDatabaseApp";
import { getPref, setPref } from "../utils/prefs";
import { SYNCED_SETTING_PREFIX } from "../domain/defaults";
import {
  isLibraryTabType,
  itemNotificationTouchesView,
  selectedTabType,
} from "./refreshPolicy";
import { onLocalResearchDataChanged } from "../storage/localData";
import { NativeArtifactVisibilityController } from "./nativeArtifactVisibility";

type ViewMode = "default" | DatabaseViewMode;

function debugLog(message: string, data?: Record<string, unknown>): void {
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  Zotero.debug(`[ZRDB] ${message}${payload}`);
}

export class MainViewController {
  private root?: Root;
  private customPane?: HTMLDivElement;
  private nativePane?: Element;
  private itemsContainer?: HTMLElement;
  private toggleButton?: Element;
  private togglePositionObserverID?: symbol;
  private toggleVisibilityFrame?: number;
  private paneResizeObserver?: ResizeObserver;
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
  private visibilityPrefObserverID?: symbol;
  private nativeArtifactVisibility?: NativeArtifactVisibilityController;
  private libraryTabActive = true;
  private mode: ViewMode = "default";
  private repository = getResearchRepository();

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
    // the collection tree or the item-details pane. Only cover the item list,
    // not its container: Zotero also puts the native toolbar in that container.
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
    this.toggleButton = this.createToggleButton(doc);
    this.placeToggleButton();
    this.scheduleToggleVisibilityCheck();
    this.togglePositionObserverID = Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.viewTogglePosition`,
      () => this.placeToggleButton(),
      true,
    );

    this.customPane = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    this.customPane.id = `${config.addonRef}-custom-pane`;
    this.customPane.className = "zrdb-custom-pane";
    this.customPane.hidden = true;
    container.appendChild(this.customPane);
    this.root = createRoot(this.customPane);
    const paneResizeObserver = new this.win.ResizeObserver(() => {
      this.updateCustomPaneBounds();
      this.scheduleToggleVisibilityCheck();
    });
    paneResizeObserver.observe(container);
    paneResizeObserver.observe(this.nativePane);
    this.paneResizeObserver = paneResizeObserver;

    this.libraryTabActive = isLibraryTabType(this.win.Zotero_Tabs.selectedType);
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
    if (this.togglePositionObserverID) {
      Zotero.Prefs.unregisterObserver(this.togglePositionObserverID);
      this.togglePositionObserverID = undefined;
    }
    if (this.toggleVisibilityFrame !== undefined) {
      this.win.cancelAnimationFrame(this.toggleVisibilityFrame);
      this.toggleVisibilityFrame = undefined;
    }
    this.paneResizeObserver?.disconnect();
    this.paneResizeObserver = undefined;
    this.destroySourceChangeListeners();
    this.cancelScheduledRefresh();
    this.setNativePaneHidden(false);
    this.root?.unmount();
    this.toggleButton?.remove();
    const toolbar = this.win.document.querySelector("#zotero-items-toolbar");
    toolbar?.classList.remove(
      "zrdb-has-view-toggle",
      "zrdb-has-html-view-toggle",
    );
    toolbar?.removeAttribute("data-zrdb-toggle-position");
    this.itemsContainer?.classList.remove("zrdb-items-pane-container");
    this.customPane?.remove();
    this.win.document.getElementById(`${config.addonRef}-stylesheet`)?.remove();
  }

  /**
   * Use Zotero 9's XUL creation API instead of createElementNS(). The latter
   * can produce a DOM node that exists but never receives a XUL frame.
   */
  private createToggleButton(doc: Document): Element {
    const button = doc.createXULElement("toolbarbutton");
    this.configureToggleButton(button, "native");
    return button;
  }

  /**
   * A visible HTML control is safer than leaving users stranded in the custom
   * view if a host theme or a future Zotero toolbar fails to lay out XUL nodes.
   */
  private createHtmlToggleButton(doc: Document): HTMLButtonElement {
    const button = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    button.type = "button";
    button.append(
      createViewIcon(doc, "table", "table"),
      createViewIcon(doc, "default", "default"),
    );
    this.configureToggleButton(button, "html-fallback");
    return button;
  }

  private configureToggleButton(
    button: Element,
    kind: "native" | "html-fallback",
  ): void {
    button.id = `${config.addonRef}-view-toggle`;
    button.classList.add("zrdb-view-toggle");
    button.setAttribute("data-toggle-kind", kind);
    if (kind === "native") {
      // Match Zotero's own toolbarbutton styling and let XUL render the icon.
      button.classList.add("zotero-tb-button");
      button.setAttribute("tabindex", "-1");
    }
    // XUL's command covers both real mouse and keyboard activation (and
    // .click()). Listening to click as well would toggle twice for one action.
    button.addEventListener(kind === "native" ? "command" : "click", () =>
      this.setMode(this.mode === "default" ? "table" : "default"),
    );
    this.updateToggleButton(button);
  }

  private toggleIconURI(mode = this.mode): string {
    const icon = mode === "default" ? "view-table.svg" : "view-list.svg";
    return `${rootURI}content/icons/${icon}`;
  }

  private updateToggleButton(button = this.toggleButton): void {
    if (!button) return;
    const label =
      this.mode === "default" ? "切换到数据库表格" : "返回 Zotero 默认列表";
    button.setAttribute("data-mode", this.mode);
    button.setAttribute("data-tooltip", label);
    button.setAttribute("tooltiptext", label);
    button.setAttribute("title", label);
    button.setAttribute("aria-label", label);
    button.classList.toggle("active", this.mode === "table");
    button.setAttribute(
      "aria-pressed",
      this.mode === "table" ? "true" : "false",
    );
    if (button.getAttribute("data-toggle-kind") === "native") {
      button.setAttribute("image", this.toggleIconURI());
    }
  }

  private scheduleToggleVisibilityCheck(): void {
    const nativeButton = this.toggleButton;
    if (
      nativeButton?.getAttribute("data-toggle-kind") !== "native" ||
      this.toggleVisibilityFrame !== undefined
    )
      return;
    this.toggleVisibilityFrame = this.win.requestAnimationFrame(() => {
      this.toggleVisibilityFrame = undefined;
      if (this.toggleButton !== nativeButton || !nativeButton.isConnected)
        return;
      // Reader tabs hide the entire library. That is not a broken XUL frame;
      // retry when its observed item pane is laid out again instead.
      const toolbar = nativeButton.parentElement?.getBoundingClientRect();
      if (!toolbar?.width || !toolbar.height) return;
      const bounds = nativeButton.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        const viewport = {
          left: 0,
          top: 0,
          right: this.win.innerWidth,
          bottom: this.win.innerHeight,
        };
        const visibleLeft = Math.max(toolbar.left, viewport.left);
        const visibleTop = Math.max(toolbar.top, viewport.top);
        const visibleRight = Math.min(toolbar.right, viewport.right);
        const visibleBottom = Math.min(toolbar.bottom, viewport.bottom);
        const centerX =
          (Math.max(bounds.left, visibleLeft) +
            Math.min(bounds.right, visibleRight)) /
          2;
        const centerY =
          (Math.max(bounds.top, visibleTop) +
            Math.min(bounds.bottom, visibleBottom)) /
          2;
        const hit =
          visibleRight > visibleLeft && visibleBottom > visibleTop
            ? this.win.document.elementFromPoint(centerX, centerY)
            : null;
        if (
          bounds.left >= visibleLeft &&
          bounds.right <= visibleRight &&
          bounds.top >= visibleTop &&
          bounds.bottom <= visibleBottom &&
          (hit === nativeButton || nativeButton.contains(hit))
        )
          return;
      }

      debugLog("native view toggle had no layout; using HTML fallback", {
        width: bounds.width,
        height: bounds.height,
      });
      const fallback = this.createHtmlToggleButton(this.win.document);
      nativeButton.replaceWith(fallback);
      this.toggleButton = fallback;
      this.placeToggleButton();
      this.updateToggleButton();
    });
  }

  /**
   * Insert the toggle at the start or at the visible right edge of
   * `#zotero-items-toolbar` based on the `viewTogglePosition` preference
   * ("left" | "right", default "right").
   */
  private placeToggleButton(): void {
    if (!this.toggleButton) return;
    const toolbar = this.win.document.querySelector("#zotero-items-toolbar");
    if (!toolbar) return;
    const position = this.togglePosition();
    toolbar.setAttribute("data-zrdb-toggle-position", position);
    toolbar.classList.toggle(
      "zrdb-has-html-view-toggle",
      this.toggleButton.getAttribute("data-toggle-kind") === "html-fallback",
    );
    if (position === "left") {
      if (toolbar.firstElementChild !== this.toggleButton)
        toolbar.insertBefore(this.toggleButton, toolbar.firstElementChild);
    } else {
      // Zotero keeps a fixed pane-layout button at the end of this hbox. Put
      // our control immediately before it so the button stays in the primary
      // visible toolbar area instead of being clipped after the trailing
      // control when the window is narrow or the toolbar is customized.
      const anchor = toolbar.querySelector(
        "#zotero-tb-toggle-item-pane-stacked",
      );
      if (anchor && anchor !== this.toggleButton) {
        if (anchor.previousElementSibling !== this.toggleButton)
          toolbar.insertBefore(this.toggleButton, anchor);
      } else if (toolbar.lastElementChild !== this.toggleButton) {
        toolbar.appendChild(this.toggleButton);
      }
    }
  }

  private togglePosition(): "left" | "right" {
    return String(getPref("viewTogglePosition") || "right") === "left"
      ? "left"
      : "right";
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    setPref("lastViewMode", mode);
    this.updateToggleButton();
    if (!this.nativePane || !this.customPane) return;
    const custom = mode !== "default";
    this.updateCustomPaneBounds();
    this.setNativePaneHidden(custom);
    this.customPane.hidden = !custom;
    if (custom && this.libraryTabActive) this.scheduleRefresh();
  }

  private updateCustomPaneBounds(): void {
    if (!this.nativePane || !this.itemsContainer || !this.customPane) return;
    const native = this.nativePane.getBoundingClientRect();
    if (!native.width || !native.height) return;
    const container = this.itemsContainer.getBoundingClientRect();
    // Absolute offsets are relative to the container's padding box. Keep the
    // native pane in flow and mirror it after toolbar/theme/splitter changes.
    const { clientLeft, clientTop, scrollLeft, scrollTop } =
      this.itemsContainer;
    Object.assign(this.customPane.style, {
      left: `${native.left - container.left - clientLeft + scrollLeft}px`,
      top: `${native.top - container.top - clientTop + scrollTop}px`,
      width: `${native.width}px`,
      height: `${native.height}px`,
    });
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
      const notifiedType = selectedTabType(
        ids,
        extraData,
        this.win.Zotero_Tabs.selectedType,
      );
      const nextLibraryTabActive = isLibraryTabType(notifiedType);
      debugLog("tab/select notification", {
        notifiedType,
        nextLibraryTabActive,
        mode: this.mode,
      });
      this.libraryTabActive = nextLibraryTabActive;
      if (!nextLibraryTabActive) {
        this.cancelScheduledRefresh();
        return;
      }
      // Zotero reports the library content type as `library`; `zotero-pane`
      // is the tab ID, not the selected tab type. Keep the existing React tree
      // and read the current ItemTree range after the tab transition.
      if (this.mode !== "default") this.scheduleSourceRefresh();
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
      let lastRefreshAt = 0;
      const observer = new MutationObserverCtor(() => {
        const now = Date.now();
        if (now - lastRefreshAt < 100) return;
        lastRefreshAt = now;
        this.scheduleSourceRefresh();
      });
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
   * Reader-originated actions can return to the library without delivering the
   * normal `tab/select` notifier event to a bootstrap add-on. Do not let that
   * missed event permanently suppress collection/item-tree refreshes. The
   * selected tab is Zotero's authoritative state; this only re-enables the
   * view after it has actually returned to the library tab.
   */
  private ensureLibraryTabIsActive(): boolean {
    // The selected tab is authoritative even when a bootstrap notifier was
    // missed. This prevents a stale `libraryTabActive` flag from rendering
    // after the user has already switched into a reader tab.
    let selectedType: unknown;
    try {
      selectedType = this.win.Zotero_Tabs.selectedType;
    } catch (error) {
      debugLog("unable to read selected tab type", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.libraryTabActive;
    }
    // During very early Zotero startup the tab manager can exist before it has
    // populated a selected type. Preserve the initial library assumption until
    // an authoritative non-empty type is available.
    if (selectedType == null) return this.libraryTabActive;
    if (!isLibraryTabType(selectedType)) {
      this.libraryTabActive = false;
      return false;
    }
    if (!this.libraryTabActive) {
      this.libraryTabActive = true;
      if (this.mode !== "default") this.scheduleSourceRefresh();
    }
    return true;
  }

  private async render(): Promise<void> {
    if (
      !this.root ||
      this.mode === "default" ||
      !this.ensureLibraryTabIsActive()
    ) {
      debugLog("render skipped", {
        hasRoot: Boolean(this.root),
        mode: this.mode,
        libraryTabActive: this.libraryTabActive,
      });
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
      debugLog("render", {
        sortedCount: sorted.length,
        itemCount: items.length,
        firstTitle: items[0]?.getField("title")?.toString()?.slice(0, 30),
      });
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
