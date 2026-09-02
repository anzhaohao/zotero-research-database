export interface RefreshPolicyItem {
  id: number;
  isRegularItem?: () => boolean;
}

export function itemNotificationTouchesView<T extends RefreshPolicyItem>(
  ids: Array<string | number>,
  sortedItems: T[],
  resolveItem: (id: number) => T | undefined,
  isWorkspaceItem: (item: T) => boolean,
): boolean {
  const regularCandidates: T[] = [];
  for (const id of ids) {
    const numericID = typeof id === "number" ? id : Number(id);
    if (!Number.isFinite(numericID)) continue;

    const item = resolveItem(numericID);
    if (!item?.isRegularItem?.()) continue;
    if (isWorkspaceItem(item)) return true;
    regularCandidates.push(item);
  }

  if (!regularCandidates.length) return false;
  const visibleRegularItemIDs = new Set(
    sortedItems
      .filter((item) => item?.isRegularItem?.())
      .map((item) => item.id),
  );
  return regularCandidates.some((item) => visibleRegularItemIDs.has(item.id));
}

export function selectedTabType(
  ids: Array<string | number>,
  extraData: Record<string | number, { type?: unknown }> | undefined,
  fallbackType: unknown,
): string {
  const selectedID = ids[0];
  const notifiedType =
    selectedID === undefined ? undefined : extraData?.[selectedID]?.type;
  return typeof notifiedType === "string"
    ? notifiedType
    : String(fallbackType || "");
}

export function isLibraryTabType(type: unknown): boolean {
  return type === "library";
}
