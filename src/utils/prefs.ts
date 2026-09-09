import { config } from "../../package.json";
import {
  getPortableSetting,
  isPortableSettingsReady,
  setPortableSetting,
} from "../storage/settingsStore";

type PluginPrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

const PREFS_PREFIX = config.prefsPrefix;

/**
 * Get preference value.
 * Wrapper of `Zotero.Prefs.get`.
 * @param key
 */
export function getPref<K extends keyof PluginPrefsMap>(key: K) {
  if (isPortableSettingsReady()) {
    const portable = getPortableSetting(String(key));
    if (portable !== undefined) return portable as PluginPrefsMap[K];
  }
  return Zotero.Prefs.get(`${PREFS_PREFIX}.${key}`, true) as PluginPrefsMap[K];
}

/**
 * Set preference value.
 * Wrapper of `Zotero.Prefs.set`.
 * @param key
 * @param value
 */
export function setPref<K extends keyof PluginPrefsMap>(
  key: K,
  value: PluginPrefsMap[K],
) {
  const result = Zotero.Prefs.set(`${PREFS_PREFIX}.${key}`, value, true);
  setPortableSetting(String(key), value);
  return result;
}

/**
 * Clear preference value.
 * Wrapper of `Zotero.Prefs.clear`.
 * @param key
 */
export function clearPref(key: string) {
  return Zotero.Prefs.clear(`${PREFS_PREFIX}.${key}`, true);
}
