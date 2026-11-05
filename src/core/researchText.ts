/**
 * Normalize legacy plain text for the restricted Markdown renderer. The stored
 * value is never changed; Markdown parsing itself is handled by react-markdown.
 */
export function researchMarkdownSource(value: unknown, fieldName = ""): string {
  return displayLines(value, fieldName)
    .map((line) => normalizeLegacyLine(line, fieldName))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function displayLines(value: unknown, fieldName: string): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry) => `- ${String(entry)}`);
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
        return parsed.map((entry) => `- ${String(entry)}`);
      if (parsed && typeof parsed === "object")
        return objectLines(parsed as Record<string, unknown>, fieldName);
    } catch {
      // Malformed JSON remains visible as ordinary text.
    }
  }
  return source.split(/\n/).flatMap((line) => {
    const text = stripRepeatedFieldName(line.trim(), fieldName);
    // Only recover compact legacy lists in an already numbered line, and only
    // at another labelled item. Ordinary prose such as "Fig. 2、Fig. 3" or
    // "x - y" must never acquire synthetic line breaks or list punctuation.
    if (!/^\d{1,3}(?:[)、]|\.(?!\d))[ \t]*/.test(text)) return [text];
    return text
      .replace(
        /(?:[ \t]+|(?<=[。；;!?！？]))(?=\d{1,3}(?:[)、]|\.(?!\d))[ \t]*(?:\*\*)?[^：:\r\n。；;!?！？（）()]{1,14}[：:])/g,
        "\n",
      )
      .split("\n");
  });
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
      return entry.map((item) => `- ${key}：${String(item)}`);
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

function normalizeLegacyLine(value: string, fieldName: string): string {
  let line = stripRepeatedFieldName(value.trim(), fieldName);
  line = line
    .replace(/^(?:[-•·▪◦]\s*|\*(?!\*)\s*)/, "- ")
    .replace(/^(\d{1,3})(?:\.(?!\d)|[)、])\s*/, "$1. ")
    .replace(/^[（(][一二三四五六七八九十\d]+[）)]\s*/, "- ")
    .replace(
      /^((?:- |\d{1,3}\. )?\*\*[^*：:\r\n]{1,14}[：:]\*\*)(?=\S)/,
      "$1 ",
    );
  const listPrefix = line.match(/^(?:- |\d{1,3}\. )/)?.[0] || "";
  const body = line.slice(listPrefix.length);
  if (/^(?:[*_`{[]|[a-z][a-z\d+.-]*:\/\/)/i.test(body)) {
    return line;
  }
  const label = body.match(/^([^：:]{1,14})[：:]\s*(.+)$/);
  return label
    ? `${listPrefix}**${label[1].trim()}：** ${label[2].trim()}`
    : line;
}
