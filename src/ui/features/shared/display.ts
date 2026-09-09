import { TRANSLATED_TITLE_FIELD_ID } from "../../../domain/defaults";
import type { ItemResearchRecord } from "../../../domain/types";

export function creators(item: Zotero.Item): string {
  return item
    .getCreators()
    .map((creator) => (creator as any).name || creator.lastName || "")
    .filter(Boolean)
    .join("、");
}

export function year(item: Zotero.Item): string {
  return String(item.getField("year") || item.getField("date") || "").slice(
    0,
    4,
  );
}

export function itemField(item: Zotero.Item, field: string): string {
  try {
    return String(item.getField(field as any) || "");
  } catch {
    return "";
  }
}

export function journalBadges(item: Zotero.Item): string[] {
  const values = item
    .getTags()
    .map((tag) => tag.tag.trim())
    .filter((tag) =>
      /(?:^|\b)(?:SCI|SSCI|EI|CSCD|CSSCI|JCR|Q[1-4])(?:\b|$)|北大核心|北核|核心库|中科院|分区/i.test(
        tag,
      ),
    );
  const extra = itemField(item, "extra");
  for (const line of extra.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:期刊分区|分区|journal\s*(?:zone|partition)|index(?:ed)?)[：:]\s*(.+)$/i,
    );
    if (match) values.push(...match[1].split(/[，,;；|]/));
  }
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].slice(0, 6);
}

export function translatedTitle(
  item: Zotero.Item,
  record: ItemResearchRecord | undefined,
): string {
  const title = itemField(item, "title");
  if (/\p{Script=Han}/u.test(title)) return "";
  return displayValue(record?.fields[TRANSLATED_TITLE_FIELD_ID]?.value).trim();
}

export function basicInfoText(item: Zotero.Item): string {
  const institution =
    itemField(item, "university") ||
    itemField(item, "institution") ||
    itemField(item, "publisher") ||
    "未记录";
  const journal =
    itemField(item, "publicationTitle") ||
    itemField(item, "proceedingsTitle") ||
    itemField(item, "bookTitle") ||
    "未记录";
  const doi = itemField(item, "DOI") || "未记录";
  const badges = journalBadges(item);
  return [
    `作者：${creators(item) || "未记录"}`,
    `年份：${year(item) || "未记录"}`,
    `期刊：${journal}`,
    `机构：${institution}`,
    `DOI：${doi}`,
    badges.length ? `期刊分区：${badges.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

export function nativeValue(item: Zotero.Item, id: string): string {
  if (id === "title") return String(item.getField("title") || "未命名文献");
  if (id === "creators") return creators(item);
  if (id === "year") return year(item);
  if (id === "basicInfo") {
    return basicInfoText(item);
  }
  if (id === "tags")
    return item
      .getTags()
      .map((tag) => tag.tag)
      .join("，");
  if (["date", "DOI", "url"].includes(id))
    return String(item.getField(id as any) || "");
  return "";
}

export function sortValue(
  item: Zotero.Item,
  fieldID: string,
  records: Map<string, ItemResearchRecord>,
): string {
  if (["title", "creators", "year"].includes(fieldID))
    return nativeValue(item, fieldID);
  return displayValue(records.get(item.key)?.fields[fieldID]?.value);
}
