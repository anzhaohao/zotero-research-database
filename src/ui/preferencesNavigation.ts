export type ResearchPreferencesSection =
  | "general"
  | "appearance"
  | "fields"
  | "figures"
  | "agent"
  | "mineru"
  | "backup";

/** Open the plugin preferences and select one of its own sections. */
export async function openResearchPreferences(
  section: ResearchPreferencesSection = "general",
): Promise<Window> {
  const internal = (Zotero.Utilities as any)?.Internal as
    | { openPreferences?: (pane: string, options?: object) => Window | null }
    | undefined;
  if (typeof internal?.openPreferences !== "function")
    throw new Error("无法打开 Zotero 设置，请手动进入插件设置。");

  // Zotero 9's openPreferences focuses an existing window and returns it;
  // otherwise it creates the preferences dialog with the requested pane.
  let win = internal.openPreferences("zrdb-preferences", {}) as
    Window | null | undefined;

  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    if (!win)
      win = Services.wm.getMostRecentWindow("zotero:pref") as unknown as
        Window | undefined;
    if (!win) {
      await Zotero.Promise.delay(50);
      continue;
    }
    if (win.closed) throw new Error("插件设置窗口已关闭。");
    const tab = win.document.querySelector<HTMLElement>(
      `[data-pref-tab="${section}"]`,
    );
    if (
      tab &&
      win.document
        .getElementById("zrdb-preferences-root")
        ?.getAttribute("data-zrdb-bound") === "1"
    ) {
      tab.click();
      tab.focus();
      return win;
    }
    await Zotero.Promise.delay(50);
  }
  throw new Error("插件设置页面加载超时。");
}
