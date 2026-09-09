import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { readLru, writeLru } from "../../src/core/lruCache";

describe("bounded LRU cache", () => {
  it("promotes reads and evicts the least-recently-used entry", () => {
    const cache = new Map<string, number>();
    writeLru(cache, "a", 1, 2);
    writeLru(cache, "b", 2, 2);
    assert.equal(readLru(cache, "a"), 1);
    writeLru(cache, "c", 3, 2);

    assert.deepEqual(
      [...cache],
      [
        ["a", 1],
        ["c", 3],
      ],
    );
  });

  it("updates an existing key without duplicating it", () => {
    const cache = new Map<string, number>([["a", 1]]);
    writeLru(cache, "a", 2, 2);

    assert.deepEqual([...cache], [["a", 2]]);
  });

  it("keeps at least one entry for an invalid limit", () => {
    const cache = new Map<string, number>();
    writeLru(cache, "a", 1, 0);
    writeLru(cache, "b", 2, -1);

    assert.deepEqual([...cache], [["b", 2]]);
  });
});
