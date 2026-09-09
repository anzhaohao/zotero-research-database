import { useCallback } from "react";
import type { ItemResearchRecord, ViewLayout } from "../../../domain/types";
import type { ColumnDefinition } from "../table/tableColumns";
import { displayValue, nativeValue } from "../shared/display";
import {
  downloadBlob,
  printTableHTML,
  tableToCSV,
  tableToHTML,
  tableToXLSX,
  type TableExportColumn,
  type TableExportRow,
} from "../../../services/tableExport";

export type TableExportFormat = "csv" | "xlsx" | "html" | "pdf";
export type TableExportScope = "filtered" | "selected" | "all";

export function useTableExport({
  currentViewName,
  exportColumns,
  filteredItems,
  layout,
  items: allItems,
  zoteroWindow,
  records,
  selected,
}: {
  currentViewName?: string;
  exportColumns: ColumnDefinition[];
  filteredItems: Zotero.Item[];
  layout: ViewLayout;
  items: Zotero.Item[];
  zoteroWindow: _ZoteroTypes.MainWindow;
  records: Map<string, ItemResearchRecord>;
  selected: Set<string>;
}) {
  const exportTable = useCallback(
    async (
      format: "csv" | "xlsx" | "html" | "pdf",
      scope: "filtered" | "selected" | "all",
    ) => {
      const items =
        scope === "selected"
          ? allItems.filter((item) => selected.has(item.key))
          : scope === "all"
            ? allItems
            : filteredItems;
      if (!items.length) {
        zoteroWindow.alert("没有可导出的文献");
        return;
      }
      const columns: TableExportColumn[] = exportColumns.map(
        ({ id, label }) => ({ id, label }),
      );
      const rows: TableExportRow[] = items.map((item) => ({
        key: item.key,
        values: Object.fromEntries(
          exportColumns.map((column) => [
            column.id,
            column.field
              ? displayValue(
                  records.get(item.key)?.fields[column.field.id]?.value,
                )
              : nativeValue(item, column.id),
          ]),
        ),
        color: layout.rowColors[item.key],
        cellColors: Object.fromEntries(
          exportColumns.map((column) => [
            column.id,
            layout.cellColors[`${item.key}:${column.id}`],
          ]),
        ),
      }));
      const filename = `zotero-research-database-${new Date().toISOString().slice(0, 10)}`;
      if (format === "csv")
        downloadBlob(
          new Blob(["\ufeff", tableToCSV(columns, rows)], {
            type: "text/csv;charset=utf-8",
          }),
          `${filename}.csv`,
          zoteroWindow.document,
        );
      else if (format === "html")
        downloadBlob(
          new Blob(
            [tableToHTML(columns, rows, currentViewName || "研究数据库")],
            { type: "text/html;charset=utf-8" },
          ),
          `${filename}.html`,
          zoteroWindow.document,
        );
      else if (format === "xlsx")
        downloadBlob(
          await tableToXLSX(columns, rows),
          `${filename}.xlsx`,
          zoteroWindow.document,
        );
      else
        printTableHTML(
          tableToHTML(columns, rows, currentViewName || "研究数据库"),
          zoteroWindow as unknown as Window,
        );
    },
    [
      currentViewName,
      exportColumns,
      filteredItems,
      layout,
      allItems,
      zoteroWindow,
      records,
      selected,
    ],
  );

  return exportTable;
}
