import { config } from "../package.json";
import { createZToolkit } from "./utils/ztoolkit";
import { MainViewController } from "./ui/viewController";
import { unregisterArtifactEndpoint } from "./services/artifactEndpoint";
import { ItemPaneProperties } from "./ui/itemPaneProperties";
import { PreferencesController } from "./ui/preferencesController";
import { migrateAgentPreferences } from "./services/agentSettings";
import { migrateMinerUPreferences } from "./services/mineru";
import { createResearchServices } from "./services/researchServices";
import {
  getResearchRepository,
  resetResearchRepositoryScope,
} from "./storage/repositoryScope";
import { clearPdfThumbnailCache } from "./services/pdfThumbnail";
import { ensureCitationStylesReady } from "./services/citation";
import {
  registerArtifactStorageNotifier,
  unregisterArtifactStorageNotifier,
} from "./services/artifactStorage";
import { initializeDataRoot, resetDataRootScope } from "./storage/dataRoot";
import {
  initializePortableSettings,
  resetPortableSettingsScope,
} from "./storage/settingsStore";

const itemPaneProperties = new ItemPaneProperties();
let artifactStorageNotifierID: string | undefined;

/**
 * Register the plugin preferences pane so "Zotero Research Database" appears
 * in Zotero settings. The pane is unregistered automatically on shutdown.
 */
async function registerPreferencePane(): Promise<void> {
  try {
    await Zotero.PreferencePanes.register({
      pluginID: config.addonID,
      id: "zrdb-preferences",
      src: "content/preferences.xhtml",
      label: config.addonName,
      image: "content/icons/favicon.png",
    });
  } catch (error) {
    // Never block Zotero startup on settings registration.
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  try {
    await initializeDataRoot();
    await initializePortableSettings();
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
  const repository = getResearchRepository();
  const services = createResearchServices(repository);
  await registerPreferencePane();
  migrateAgentPreferences();
  migrateMinerUPreferences();
  try {
    await ensureCitationStylesReady();
  } catch (error) {
    // Citation controls remain disabled until the app-level retry succeeds.
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
  try {
    await repository.migrateLegacyStorage();
  } catch (error) {
    // A failed item remains fully recoverable in its old Extra lines. Continue
    // startup and retry the same migration next time.
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
  try {
    await services.migrateLegacyInternalTags();
  } catch (error) {
    // Never block Zotero startup. The migration preference remains unset, so
    // the exact same safe migration is retried on the next plugin startup.
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
  services.registerArtifactEndpoint();
  artifactStorageNotifierID = await registerArtifactStorageNotifier();
  await itemPaneProperties.register();
  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  if (addon.data.controllers.has(win)) return;
  const controller = new MainViewController(win);
  try {
    await controller.mount();
    addon.data.controllers.set(win, controller);
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
    new addon.data.ztoolkit.ProgressWindow(config.addonName)
      .createLine({
        text: `插件没有修改默认列表：${
          error instanceof Error ? error.message : String(error)
        }`,
        type: "fail",
      })
      .show();
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  addon.data.controllers.get(win)?.destroy();
  addon.data.controllers.delete(win);
}

function onShutdown(): void {
  unregisterArtifactEndpoint();
  unregisterArtifactStorageNotifier(artifactStorageNotifierID);
  artifactStorageNotifierID = undefined;
  itemPaneProperties.unregister();
  for (const controller of addon.data.controllers.values())
    controller.destroy();
  addon.data.controllers.clear();
  clearPdfThumbnailCache();
  resetResearchRepositoryScope();
  resetDataRootScope();
  resetPortableSettingsScope();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error Plugin instance is intentionally removed on shutdown.
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify() {}
async function onPrefsEvent(type: string, data: { window?: Window }) {
  if (type !== "load" || !data?.window) return;
  try {
    await new PreferencesController(data.window).mount();
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
}
function onShortcuts() {}
function onDialogEvents() {}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
