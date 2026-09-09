import type { CitationStyle } from "../domain/types";

export const citationStyleOptions: Array<{
  value: CitationStyle;
  label: string;
}> = [
  { value: "zotero", label: "Zotero 当前样式" },
  { value: "gbt7714", label: "GB/T 7714" },
  { value: "apa7", label: "APA 7" },
  { value: "nature", label: "Nature" },
  { value: "ieee", label: "IEEE" },
];

const styleFormats: Record<Exclude<CitationStyle, "zotero">, string> = {
  gbt7714:
    "bibliography=http://www.zotero.org/styles/china-national-standard-gb-t-7714-2015-numeric",
  apa7: "bibliography=http://www.zotero.org/styles/apa",
  nature: "bibliography=http://www.zotero.org/styles/nature",
  ieee: "bibliography=http://www.zotero.org/styles/ieee",
};

const cache = new Map<string, string>();

export async function ensureCitationStylesReady(): Promise<void> {
  const styles = (Zotero as any).Styles;
  if (styles?.initialized?.()) return;
  if (typeof styles?.init !== "function")
    throw new Error("Zotero 引用样式运行时不可用");
  await styles.init();
}

function normalizeCitation(value: string): string {
  return value
    .replaceAll("\u00a0", " ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function quickCopyFormat(style: CitationStyle): unknown {
  if (style !== "zotero") return styleFormats[style];
  const format = Zotero.Prefs.get("export.quickCopy.setting");
  try {
    const parsed = (Zotero.QuickCopy as any).unserializeSetting?.(format);
    if (parsed?.mode !== "bibliography") return styleFormats.apa7;
  } catch {
    return styleFormats.apa7;
  }
  return format;
}

/** Format one bibliography entry through Zotero's installed CSL engine. */
export function getCitationText(
  item: Zotero.Item,
  style: CitationStyle,
): string {
  if ((Zotero.Styles as any)?.initialized?.() === false) return "";
  const revision = String(item.version || item.dateModified || "");
  const key = `${item.libraryID}:${item.key}:${revision}:${style}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let text = "";
  try {
    const result = (Zotero.QuickCopy as any).getContentFromItems(
      [item],
      quickCopyFormat(style),
    );
    if (
      result &&
      typeof result === "object" &&
      typeof result.text === "string"
    ) {
      text = normalizeCitation(result.text);
    }
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
  if (cache.size > 1000) cache.clear();
  if (text) cache.set(key, text);
  return text;
}
