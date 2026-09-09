/**
 * Narrow additions absent from zotero-types 4.1.0-beta.4.
 * Verified against Zotero 9's app/omni.ja:
 * chrome/content/zotero/xpcom/syncedSettings.js (get and clear).
 * Only migration reads and acknowledged clears are exposed here; research
 * data must never be written back into Zotero's sync settings.
 */
declare namespace _ZoteroTypes {
  interface ResearchMigrationSyncedSettings {
    get(libraryID: number, setting: string): unknown;
    clear(
      libraryID: number,
      setting: string,
      options?: { skipDeleteLog?: boolean },
    ): Promise<boolean>;
  }
}

declare namespace Zotero {
  const SyncedSettings: _ZoteroTypes.ResearchMigrationSyncedSettings;
}
