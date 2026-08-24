export function partitionPinnedIDs(
  orderedIDs: string[],
  pinnedIDs: string[],
): string[] {
  const pinned = new Set(pinnedIDs);
  return [
    ...orderedIDs.filter((id) => pinned.has(id)),
    ...orderedIDs.filter((id) => !pinned.has(id)),
  ];
}

export function togglePinnedColumnIDs(
  columnOrder: string[],
  pinnedIDs: string[],
  columnID: string,
): string[] {
  const pinned = new Set(pinnedIDs);
  if (!columnID) pinned.clear();
  else if (pinned.has(columnID)) pinned.delete(columnID);
  else pinned.add(columnID);
  return columnOrder.filter((id) => pinned.has(id));
}

export function reorderColumnIDs(
  columnOrder: string[],
  from: string,
  to: string,
  after: boolean,
): string[] {
  if (!from || from === to) return [...columnOrder];
  const order = columnOrder.filter((id) => id !== from);
  const targetIndex = order.indexOf(to);
  if (targetIndex < 0) return [...columnOrder];
  order.splice(targetIndex + (after ? 1 : 0), 0, from);
  return order;
}

export function reorderColumnLayout(
  columnOrder: string[],
  pinnedIDs: string[],
  from: string,
  to: string,
  after: boolean,
  targetPinned: boolean,
): { columnOrder: string[]; pinnedColumnIDs: string[] } {
  const nextOrder = reorderColumnIDs(columnOrder, from, to, after);
  if (nextOrder === columnOrder || !from || from === to) {
    return { columnOrder: nextOrder, pinnedColumnIDs: [...pinnedIDs] };
  }
  const pinned = new Set(pinnedIDs);
  if (targetPinned) pinned.add(from);
  else pinned.delete(from);
  return {
    columnOrder: nextOrder,
    pinnedColumnIDs: nextOrder.filter((id) => pinned.has(id)),
  };
}

export function edgeAutoScrollDirection(
  pointerX: number,
  left: number,
  right: number,
  edgeSize = 48,
): -1 | 0 | 1 {
  if (pointerX <= left + edgeSize) return -1;
  if (pointerX >= right - edgeSize) return 1;
  return 0;
}

export function pinnedLeftOffset(
  columnID: string,
  renderedColumnIDs: string[],
  pinnedIDs: string[],
  columnWidths: Record<string, number>,
  fallbackWidth = 180,
): number | undefined {
  const pinned = new Set(pinnedIDs);
  if (!pinned.has(columnID)) return undefined;
  let left = 0;
  for (const id of renderedColumnIDs) {
    if (id === columnID) return left;
    if (pinned.has(id)) left += columnWidths[id] || fallbackWidth;
  }
  return left;
}
