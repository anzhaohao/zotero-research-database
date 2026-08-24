export type ResearchDisplayBlockKind = "heading" | "paragraph" | "bullet";

export interface ResearchDisplayBlock {
  kind: ResearchDisplayBlockKind;
  text: string;
  marker?: string;
  label?: string;
}

/**
 * Convert stored research text into display-only blocks. The caller keeps and
 * edits the original value; this function never serializes the normalized view.
 */
export function researchDisplayBlocks(
  value: unknown,
  fieldName = "",
): ResearchDisplayBlock[] {
  const lines = displayLines(value, fieldName);
  const blocks: ResearchDisplayBlock[] = [];
  for (const source of lines) {
    let line = cleanInlineMarkdown(source).trim();
    if (!line) continue;
    line = stripRepeatedFieldName(line, fieldName);
    if (!line) continue;

    const heading = line.match(/^#{1,6}\s*(.+)$/);
    if (heading) {
      blocks.push({ kind: "heading", text: heading[1].trim() });
      continue;
    }
    const bullet = line.match(
      /^(?:([-*•·▪◦])|(\d{1,3}[.)、])|([（(][一二三四五六七八九十\d]+[）)]))\s*(.+)$/,
    );
    if (bullet) {
      blocks.push({
        kind: "bullet",
        marker: bullet[1] ? "•" : bullet[2] || bullet[3],
        ...labelledText(bullet[4]),
      });
      continue;
    }
    blocks.push({ kind: "paragraph", ...labelledText(line) });
  }
  return blocks;
}

function displayLines(value: unknown, fieldName: string): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry) => `• ${String(entry)}`);
  if (typeof value === "object")
    return objectLines(value as Record<string, unknown>, fieldName);
  const source = String(value)
    .replace(/^\s*```(?:json|markdown|md|text)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!source) return [];
  if (/^[{[]/.test(source)) {
    try {
      const parsed = JSON.parse(source) as unknown;
      if (Array.isArray(parsed))
        return parsed.map((entry) => `• ${String(entry)}`);
      if (parsed && typeof parsed === "object")
        return objectLines(parsed as Record<string, unknown>, fieldName);
    } catch {
      // Malformed JSON remains visible as ordinary text.
    }
  }
  return source
    .replace(
      /(?<=[\p{Script=Han}A-Za-z。；;!?！？])\s*(?=[2-9][.)、]\s*)/gu,
      "\n",
    )
    .replace(
      /[ \t]+(?=(?:[-*•·▪◦]\s+|\d{1,3}[.)、]\s*|[（(][一二三四五六七八九十\d]+[）)]\s*))/g,
      "\n",
    )
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function objectLines(
  value: Record<string, unknown>,
  fieldName: string,
): string[] {
  const matchingKey = Object.keys(value).find(
    (key) =>
      key.trim().toLocaleLowerCase() === fieldName.trim().toLocaleLowerCase(),
  );
  if (matchingKey) return displayLines(value[matchingKey], fieldName);
  return Object.entries(value).flatMap(([key, entry]) => {
    if (Array.isArray(entry))
      return entry.map((item) => `• ${key}：${String(item)}`);
    if (entry && typeof entry === "object")
      return [`${key}：${JSON.stringify(entry)}`];
    return [`${key}：${String(entry ?? "")}`];
  });
}

function stripRepeatedFieldName(value: string, fieldName: string): string {
  const name = fieldName.trim();
  if (!name) return value;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(new RegExp(`^${escaped}\\s*[：:]\\s*`, "i"), "");
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[ \t]{2,}/g, " ");
}

function labelledText(value: string): {
  text: string;
  label?: string;
} {
  const match = value.trim().match(/^([^：:]{1,14})[：:]\s*(.+)$/);
  return match
    ? { label: match[1].trim(), text: match[2].trim() }
    : { text: value.trim() };
}
