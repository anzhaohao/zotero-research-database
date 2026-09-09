import { TRANSLATED_TITLE_FIELD_ID } from "../../../domain/defaults";
import type { FieldDefinition, ViewLayout } from "../../../domain/types";
import { partitionPinnedIDs } from "../../../core/viewLayout";
import type { EditableNativeField } from "../../../storage/repository";

export interface ColumnDefinition {
  id: string;
  label: string;
  field?: FieldDefinition;
  nativeField?: EditableNativeField;
  kind?: "pdfPreview" | "basicInfo" | "figureGallery";
}

export const nativeColumns: readonly ColumnDefinition[] = [
  { id: "pdfPreview", label: "预览", kind: "pdfPreview" },
  { id: "title", label: "标题", nativeField: "title" },
  { id: "basicInfo", label: "基础信息", kind: "basicInfo" },
  { id: "figureGallery", label: "论文图表", kind: "figureGallery" },
  { id: "creators", label: "作者" },
  { id: "year", label: "年份" },
  { id: "date", label: "日期", nativeField: "date" },
  { id: "DOI", label: "DOI", nativeField: "DOI" },
  { id: "url", label: "URL", nativeField: "url" },
  { id: "tags", label: "标签", nativeField: "tags" },
];

export function buildColumnDefinitions(
  fields: readonly FieldDefinition[],
): ColumnDefinition[] {
  return [
    ...nativeColumns,
    ...fields
      .filter(
        (field) => !field.archived && field.id !== TRANSLATED_TITLE_FIELD_ID,
      )
      .map((field) => ({ id: field.id, label: field.name, field })),
  ];
}

export function buildVisibleColumns(
  fields: readonly FieldDefinition[],
  layout: ViewLayout,
): ColumnDefinition[] {
  const all = buildColumnDefinitions(fields);
  const order = [...layout.columnOrder, ...all.map((column) => column.id)];
  const visible = new Set(layout.visibleColumnIDs || []);
  const showsBasicInfo = visible.has("basicInfo");
  const combinedMetadata = new Set(["creators", "year", "date", "DOI"]);
  const ordered = [...new Set(order)]
    .map((id) => all.find((column) => column.id === id))
    .filter((column): column is ColumnDefinition => {
      if (!column) return false;
      if (showsBasicInfo && combinedMetadata.has(column.id)) return false;
      return visible.has(column.id);
    })
    .map((column) => ({
      ...column,
      label: layout.columnLabels[column.id] || column.label,
    }));
  const byID = new Map(ordered.map((column) => [column.id, column]));
  return partitionPinnedIDs(
    ordered.map((column) => column.id),
    layout.pinnedColumnIDs,
  ).map((id) => byID.get(id)!);
}
