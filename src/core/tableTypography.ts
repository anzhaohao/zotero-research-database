export const TABLE_TYPOGRAPHY_DEFAULTS = {
  tableFontFamily: "",
  tableFontSize: 15,
  tableHeadingFontSize: 16,
} as const;

export const TABLE_TYPOGRAPHY_KEYS = [
  "tableFontFamily",
  "tableFontSize",
  "tableHeadingFontSize",
] as const;

export interface TableTypography {
  tableFontFamily: string;
  tableFontSize: number;
  tableHeadingFontSize: number;
}

function size(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  return value == null || value === "" || !Number.isFinite(number)
    ? fallback
    : Math.min(max, Math.max(10, Math.round(number)));
}

export function normalizeTableTypography(
  values: Partial<Record<keyof TableTypography, unknown>>,
): TableTypography {
  return {
    tableFontFamily:
      typeof values.tableFontFamily === "string"
        ? values.tableFontFamily.trim().slice(0, 128)
        : "",
    tableFontSize: size(values.tableFontSize, 15, 28),
    tableHeadingFontSize: size(values.tableHeadingFontSize, 16, 36),
  };
}

export function tableTypographyStyle(values: TableTypography) {
  return {
    "--zrdb-table-font-family": values.tableFontFamily
      ? `${JSON.stringify(values.tableFontFamily)}, system-ui, sans-serif`
      : "system-ui, sans-serif",
    "--zrdb-table-font-size": `${values.tableFontSize}px`,
    "--zrdb-table-heading-font-size": `${values.tableHeadingFontSize}px`,
  };
}
