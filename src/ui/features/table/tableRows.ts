import { readLru, writeLru } from "../../../core/lruCache";

export type TableFlatRow<Item> =
  { type: "group"; label: string } | { type: "item"; item: Item };

type CachedTableFlatRow =
  { type: "group"; label: string } | { type: "item"; itemKey: string };

/**
 * Flattens the table's optional grouping into the row model consumed by the
 * virtualizer. The caller owns the display rules for a group's value so this
 * helper stays independent from Zotero and the research-record schema.
 */
export function buildTableFlatRows<Item>(
  items: readonly Item[],
  groupBy: string,
  getGroupLabel: (item: Item, groupBy: string) => string,
): TableFlatRow<Item>[] {
  if (!groupBy) return items.map((item) => ({ type: "item", item }));

  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const label = getGroupLabel(item, groupBy) || "未设置";
    const group = groups.get(label);
    if (group) group.push(item);
    else groups.set(label, [item]);
  }

  return [...groups.entries()].flatMap(([label, groupedItems]) => [
    { type: "group" as const, label: `${label}（${groupedItems.length}）` },
    ...groupedItems.map((item) => ({ type: "item" as const, item })),
  ]);
}

/**
 * Reuses the grouping structure across renders while materializing current
 * item references for every call. Zotero recreates the visible item array
 * during refreshes, so caching the original row objects would otherwise keep
 * stale item instances alive. The cache key includes the visible keys and
 * resolved group labels, which invalidates the structure when either changes.
 */
export class TableFlatRowsCache<Item extends { key: string }> {
  private readonly cache = new Map<string, CachedTableFlatRow[]>();

  constructor(private readonly limit = 12) {}

  get(
    items: readonly Item[],
    groupBy: string,
    getGroupLabel: (item: Item, groupBy: string) => string,
  ): TableFlatRow<Item>[] {
    const labels = groupBy
      ? items.map((item) => getGroupLabel(item, groupBy) || "未设置")
      : [];
    const signature = JSON.stringify([
      groupBy,
      items.map((item) => item.key),
      labels,
    ]);
    const cached = readLru(this.cache, signature);
    const byKey = new Map(items.map((item) => [item.key, item]));

    if (cached) return this.materialize(cached, byKey);

    const rows: CachedTableFlatRow[] = [];
    if (!groupBy) {
      for (const item of items) rows.push({ type: "item", itemKey: item.key });
    } else {
      const groups = new Map<string, string[]>();
      for (let index = 0; index < items.length; index++) {
        const label = labels[index];
        const key = items[index].key;
        const group = groups.get(label);
        if (group) group.push(key);
        else groups.set(label, [key]);
      }
      for (const [label, keys] of groups) {
        rows.push({ type: "group", label: `${label}（${keys.length}）` });
        for (const itemKey of keys) rows.push({ type: "item", itemKey });
      }
    }

    writeLru(this.cache, signature, rows, this.limit);
    return this.materialize(rows, byKey);
  }

  clear(): void {
    this.cache.clear();
  }

  private materialize(
    rows: readonly CachedTableFlatRow[],
    byKey: ReadonlyMap<string, Item>,
  ): TableFlatRow<Item>[] {
    const result: TableFlatRow<Item>[] = [];
    for (const row of rows) {
      if (row.type === "group") {
        result.push(row);
        continue;
      }
      const item = byKey.get(row.itemKey);
      if (item) result.push({ type: "item", item });
    }
    return result;
  }
}
