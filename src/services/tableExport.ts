import type { ViewColor } from "../domain/types";

export interface TableExportColumn {
  id: string;
  label: string;
}

export interface TableExportRow {
  key: string;
  values: Record<string, string>;
  color?: ViewColor;
  cellColors?: Record<string, ViewColor>;
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function csvCell(value: unknown): string {
  return `"${text(value).replaceAll('"', '""')}"`;
}

export function tableToCSV(
  columns: TableExportColumn[],
  rows: TableExportRow[],
): string {
  return [
    columns.map((column) => csvCell(column.label)),
    ...rows.map((row) =>
      columns.map((column) => csvCell(row.values[column.id])),
    ),
  ]
    .map((line) => line.join(","))
    .join("\r\n");
}

function escapeHTML(value: unknown): string {
  return text(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function tableToHTML(
  columns: TableExportColumn[],
  rows: TableExportRow[],
  title = "Zotero Research Database",
): string {
  const head = columns
    .map((column) => `<th>${escapeHTML(column.label)}</th>`)
    .join("");
  const body = rows
    .map((row) => {
      const rowStyle =
        row.color && row.color !== "none" ? ` class="color-${row.color}"` : "";
      const cells = columns
        .map((column) => {
          const color = row.cellColors?.[column.id];
          const style =
            color && color !== "none" ? ` class="color-${color}"` : "";
          return `<td${style}>${escapeHTML(row.values[column.id]).replaceAll("\n", "<br>")}</td>`;
        })
        .join("");
      return `<tr${rowStyle}>${cells}</tr>`;
    })
    .join("");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escapeHTML(title)}</title><style>body{font-family:system-ui,sans-serif;margin:24px;color:#202124}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d9dde5;padding:7px;vertical-align:top;white-space:pre-wrap}th{background:#f1f3f6;text-align:left}.color-blue,.color-green,.color-yellow,.color-orange,.color-red,.color-purple,.color-gray{background:color-mix(in srgb,var(--c),white 80%)}.color-blue{--c:#2383e2}.color-green{--c:#35a66f}.color-yellow{--c:#d99b19}.color-orange{--c:#e4772f}.color-red{--c:#d14b55}.color-purple{--c:#8b62c9}.color-gray{--c:#88909d}@media print{body{margin:8mm}th{break-after:avoid}}</style><h1>${escapeHTML(title)}</h1><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></html>`;
}

const colors: Record<ViewColor, string> = {
  none: "FFFFFF",
  blue: "DDEEFF",
  green: "DDF4E6",
  yellow: "FFF1C7",
  orange: "FFE3D1",
  red: "FFE0E2",
  purple: "EDE2FF",
  gray: "ECEEF2",
};

function xlsxEscape(value: unknown): string {
  return escapeHTML(text(value)).replaceAll("\n", "&#10;");
}

function columnName(index: number): string {
  let result = "";
  let n = index + 1;
  while (n) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

const crc32Table = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** Build a UTF-8 ZIP using the portable STORED method supported by XLSX. */
function buildStoredZip(
  files: Array<{ name: string; content: string }>,
): Uint8Array {
  if (files.length > 0xffff) throw new Error("XLSX 文件数量超过 ZIP32 限制");
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    if (name.byteLength > 0xffff || data.byteLength > 0xffffffff)
      throw new Error("XLSX 内容超过 ZIP32 限制");
    const checksum = crc32(data);
    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, data.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, data.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.byteLength;
  }
  const centralSize = centralParts.reduce(
    (total, part) => total + part.byteLength,
    0,
  );
  if (localOffset > 0xffffffff || centralSize > 0xffffffff)
    throw new Error("XLSX 内容超过 ZIP32 限制");
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  return joinBytes([...localParts, ...centralParts, end]);
}

/** Generate a small standards-compliant XLSX without a Node filesystem. */
export async function tableToXLSX(
  columns: TableExportColumn[],
  rows: TableExportRow[],
): Promise<Blob> {
  const colorOrder = Object.keys(colors).filter(
    (color): color is Exclude<ViewColor, "none"> => color !== "none",
  );
  const styleFor = (color?: ViewColor) => {
    if (!color || color === "none") return 0;
    return colorOrder.indexOf(color) + 1;
  };
  const fills = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ];
  for (const color of colorOrder.map((token) => colors[token]))
    fills.push(
      `<fill><patternFill patternType="solid"><fgColor rgb="FF${color}"/><bgColor indexed="64"/></patternFill></fill>`,
    );
  const styles = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"><alignment vertical="top" wrapText="1"/></xf>',
    ...colorOrder.map(
      (_color, index) =>
        `<xf numFmtId="0" fontId="0" fillId="${index + 2}" borderId="0" applyFill="1"><alignment vertical="top" wrapText="1"/></xf>`,
    ),
  ];
  const sheetRows = [
    `<row r="1">${columns.map((column, i) => `<c r="${columnName(i)}1" t="inlineStr"><is><t>${xlsxEscape(column.label)}</t></is></c>`).join("")}</row>`,
    ...rows.map((row, rowIndex) => {
      const r = rowIndex + 2;
      return `<row r="${r}">${columns
        .map((column, i) => {
          const color = row.cellColors?.[column.id] || row.color;
          const style = styleFor(color);
          return `<c r="${columnName(i)}${r}" s="${style}" t="inlineStr"><is><t>${xlsxEscape(row.values[column.id])}</t></is></c>`;
        })
        .join("")}</row>`;
    }),
  ].join("");
  const bytes = buildStoredZip([
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Research Database" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/worksheets/sheet1.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    },
    {
      name: "xl/styles.xml",
      content: `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="0"/><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="${styles.length}">${styles.join("")}</cellXfs></styleSheet>`,
    },
  ]);
  const buffer = Uint8Array.from(bytes).buffer;
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function printTableHTML(
  html: string,
  owner: Window = (globalThis as any).window,
): void {
  const popup = owner.open("", "zrdb-print");
  if (!popup) throw new Error("无法打开系统打印预览");
  popup.document.open();
  popup.document.write(
    html.replace(
      "</html>",
      "<script>window.onload=()=>window.print();</script></html>",
    ),
  );
  popup.document.close();
}

export function downloadBlob(
  blob: Blob,
  filename: string,
  owner: Document = (globalThis as any).document,
): void {
  const url = owner.defaultView?.URL.createObjectURL(blob);
  if (!url) throw new Error("当前 Zotero 窗口不支持文件下载");
  const link = owner.createElement("a");
  link.href = url;
  link.download = filename;
  owner.body?.appendChild(link);
  link.click();
  link.remove();
  owner.defaultView?.setTimeout(
    () => owner.defaultView?.URL.revokeObjectURL(url),
    1000,
  );
}
