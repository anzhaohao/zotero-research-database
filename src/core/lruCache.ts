/** Reads a value and promotes it to the most-recently-used position. */
export function readLru<K, V>(cache: Map<K, V>, key: K): V | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key)!;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/** Writes a value and evicts the least-recently-used entries over the limit. */
export function writeLru<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  limit: number,
): void {
  const maxEntries = Math.max(1, Math.floor(limit));
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
