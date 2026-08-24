import type { ComparisonSnapshot, FieldDefinition } from "../domain/types";

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join("、");
  return String(value);
}

function csvCell(value: unknown): string {
  return `"${text(value).replaceAll('"', '""')}"`;
}

export function snapshotToCSV(
  snapshot: ComparisonSnapshot,
  definitions: FieldDefinition[],
): string {
  const fields = definitions.filter((field) =>
    snapshot.fieldIDs.includes(field.id),
  );
  const header = ["标题", "作者", "年份", ...fields.map((field) => field.name)];
  const rows = snapshot.rows.map((row) => [
    row.title,
    row.creators,
    row.year,
    ...fields.map((field) => row.values[field.id]),
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

export function snapshotToMarkdown(
  snapshot: ComparisonSnapshot,
  definitions: FieldDefinition[],
): string {
  const fields = definitions.filter((field) =>
    snapshot.fieldIDs.includes(field.id),
  );
  const header = ["论文", ...fields.map((field) => field.name)];
  const divider = header.map(() => "---");
  const rows = snapshot.rows.map((row) => [
    row.title,
    ...fields.map((field) => text(row.values[field.id]).replaceAll("|", "\\|")),
  ]);
  const table = [header, divider, ...rows]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
  return `${table}\n\n# 综合结论\n\n${snapshot.synthesis || "尚未生成。"}\n`;
}

export function snapshotToHTML(
  snapshot: ComparisonSnapshot,
  definitions: FieldDefinition[],
): string {
  const esc = (value: unknown) =>
    text(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const fields = definitions.filter((field) =>
    snapshot.fieldIDs.includes(field.id),
  );
  const head = ["论文", ...fields.map((field) => field.name)]
    .map((value) => `<th>${esc(value)}</th>`)
    .join("");
  const rows = snapshot.rows
    .map(
      (row) =>
        `<tr><td>${esc(row.title)}</td>${fields
          .map((field) => `<td>${esc(row.values[field.id])}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${esc(snapshot.name)}</title><style>body{font-family:system-ui,sans-serif;margin:32px;color:#172033}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccd3df;padding:10px;vertical-align:top}th{background:#eef3f9}h1{color:#163a63}</style><h1>${esc(snapshot.name)}</h1><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table><h2>综合结论</h2><p>${esc(snapshot.synthesis || "尚未生成。").replaceAll("\n", "<br>")}</p></html>`;
}
