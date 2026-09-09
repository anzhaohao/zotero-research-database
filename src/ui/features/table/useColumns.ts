import { useMemo } from "react";
import type { FieldDefinition, ViewLayout } from "../../../domain/types";
import { buildVisibleColumns, type ColumnDefinition } from "./tableColumns";

export function useColumns(
  fields: FieldDefinition[],
  layout: ViewLayout,
): ColumnDefinition[] {
  return useMemo(() => buildVisibleColumns(fields, layout), [fields, layout]);
}
