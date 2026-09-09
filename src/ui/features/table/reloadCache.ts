export interface CachedMapLoadPlan<Key, Value> {
  cached: Map<Key, Value>;
  missingKeys: Key[];
}

export interface ReloadRequest<State> {
  state: State;
  refreshFigures: boolean;
  refreshRecords: boolean;
}

/**
 * Coalesces reload requests that arrive while another reload is running.
 * The latest state snapshot wins, while either request can require a forced
 * records or figures refresh.
 */
export function mergeReloadRequests<State>(
  current: ReloadRequest<State> | undefined,
  next: ReloadRequest<State>,
): ReloadRequest<State> {
  return {
    state: next.state,
    refreshFigures: Boolean(current?.refreshFigures || next.refreshFigures),
    refreshRecords: Boolean(current?.refreshRecords || next.refreshRecords),
  };
}

/**
 * Builds a bounded load plan for a visible range. Entries outside the range
 * are intentionally discarded so a long browsing session does not grow the
 * in-memory cache without limit.
 */
export function planCachedMapLoad<Key, Value>(
  keys: readonly Key[],
  cache: ReadonlyMap<Key, Value>,
  force = false,
): CachedMapLoadPlan<Key, Value> {
  const cached = new Map<Key, Value>();
  const missingKeys: Key[] = [];
  const seen = new Set<Key>();

  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (!force && cache.has(key)) cached.set(key, cache.get(key)!);
    else missingKeys.push(key);
  }

  return { cached, missingKeys };
}

/**
 * Merges loaded values back in the requested order, preferring fresh values
 * and retaining only keys that are still visible.
 */
export function mergeCachedMapLoad<Key, Value>(
  keys: readonly Key[],
  cached: ReadonlyMap<Key, Value>,
  loaded: ReadonlyMap<Key, Value>,
): Map<Key, Value> {
  const result = new Map<Key, Value>();
  const seen = new Set<Key>();

  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (loaded.has(key)) result.set(key, loaded.get(key)!);
    else if (cached.has(key)) result.set(key, cached.get(key)!);
  }

  return result;
}

/**
 * Compares map entries in iteration order so callers can keep the previous
 * React state object when a reload did not change the visible data. Values are
 * intentionally compared by reference: the repository owns record identity,
 * and a newly materialized value must trigger a render even when its fields
 * happen to be equal.
 */
export function mapEntriesEqual<Key, Value>(
  left: ReadonlyMap<Key, Value>,
  right: ReadonlyMap<Key, Value>,
): boolean {
  if (left.size !== right.size) return false;

  const leftEntries = left.entries();
  const rightEntries = right.entries();
  while (true) {
    const leftEntry = leftEntries.next();
    const rightEntry = rightEntries.next();
    if (leftEntry.done || rightEntry.done)
      return leftEntry.done === rightEntry.done;
    if (
      leftEntry.value[0] !== rightEntry.value[0] ||
      leftEntry.value[1] !== rightEntry.value[1]
    )
      return false;
  }
}
