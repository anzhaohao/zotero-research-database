import assert from "node:assert/strict";
import { describe, it } from "mocha";
import {
  mapEntriesEqual,
  mergeCachedMapLoad,
  mergeReloadRequests,
  planCachedMapLoad,
} from "../../src/ui/features/table/reloadCache";

describe("visible-range reload cache", () => {
  it("loads only missing keys and keeps the requested order", () => {
    const plan = planCachedMapLoad(
      ["b", "a", "b", "c"],
      new Map([
        ["a", 1],
        ["z", 99],
      ]),
    );

    assert.deepEqual([...plan.cached], [["a", 1]]);
    assert.deepEqual(plan.missingKeys, ["b", "c"]);
  });

  it("can force a refresh without retaining stale cached values", () => {
    const plan = planCachedMapLoad(["a", "b"], new Map([["a", 1]]), true);

    assert.deepEqual([...plan.cached], []);
    assert.deepEqual(plan.missingKeys, ["a", "b"]);
  });

  it("merges fresh values and drops keys outside the visible range", () => {
    const result = mergeCachedMapLoad(
      ["c", "a", "c", "b"],
      new Map([
        ["a", 1],
        ["b", 2],
        ["z", 99],
      ]),
      new Map([
        ["c", 3],
        ["a", 10],
      ]),
    );

    assert.deepEqual(
      [...result],
      [
        ["c", 3],
        ["a", 10],
        ["b", 2],
      ],
    );
  });

  it("recognizes identical ordered entries so React state can be reused", () => {
    const shared = { value: 1 };
    const current = new Map([
      ["a", shared],
      ["b", { value: 2 }],
    ]);
    const same = new Map(current);

    assert.equal(mapEntriesEqual(current, same), true);
    assert.equal(
      mapEntriesEqual(
        current,
        new Map([
          ["b", current.get("b")!],
          ["a", shared],
        ]),
      ),
      false,
    );
    assert.equal(
      mapEntriesEqual(
        current,
        new Map([
          ["a", { value: 1 }],
          ["b", current.get("b")!],
        ]),
      ),
      false,
    );
  });

  it("coalesces refresh flags while keeping the newest state snapshot", () => {
    const first = { revision: 1 };
    const second = { revision: 2 };
    assert.deepEqual(
      mergeReloadRequests(
        {
          state: first,
          refreshFigures: false,
          refreshRecords: true,
        },
        {
          state: second,
          refreshFigures: true,
          refreshRecords: false,
        },
      ),
      {
        state: second,
        refreshFigures: true,
        refreshRecords: true,
      },
    );
  });
});
