import { type ColumnDefinition } from "./tableColumns";

export interface EditingCell {
  item: Zotero.Item;
  column: ColumnDefinition;
}
