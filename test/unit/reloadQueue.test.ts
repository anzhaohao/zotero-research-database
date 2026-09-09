import assert from "node:assert/strict";
import { describe, it } from "mocha";
import {
  ReloadQueue,
  reconcileRows,
} from "../../src/ui/features/table/reloadQueue";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("incremental reload queue", () => {
  it("coalesces a burst and preserves dirty keys while switching ranges in flight", async () => {
    type Request = { range: string; dirty: Set<string> };
    const runs: string[] = [];
    const published: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new ReloadQueue<Request>(
      (a, b) => ({ range: b.range, dirty: new Set([...a.dirty, ...b.dirty]) }),
      async (request, isCurrent) => {
        runs.push(`${request.range}:${[...request.dirty].join(",")}`);
        if (request.range === "old") await gate;
        if (isCurrent()) published.push(request.range);
      },
    );
    const first = queue.enqueue({ range: "old", dirty: new Set(["a"]) });
    await tick();
    const second = queue.enqueue({ range: "middle", dirty: new Set(["b"]) });
    const third = queue.enqueue({ range: "new", dirty: new Set(["c"]) });
    assert.equal(first, second);
    assert.equal(second, third);
    release();
    await third;
    assert.deepEqual(runs, ["old:a", "new:a,b,c"]);
    assert.deepEqual(published, ["new"]);
  });

  it("recovers after a rejected batch and does not publish after disposal", async () => {
    let attempts = 0;
    const published: number[] = [];
    const queue = new ReloadQueue<number>(
      (_a, b) => b,
      async (request, current) => {
        attempts += 1;
        if (request === 1) throw new Error("read failed");
        await tick();
        if (current()) published.push(request);
      },
    );
    await assert.rejects(queue.enqueue(1), /read failed/);
    const disposed = queue.enqueue(2);
    await Promise.resolve();
    queue.invalidate();
    await disposed;
    await queue.enqueue(3);
    assert.equal(attempts, 3);
    assert.deepEqual(published, [3]);
  });

  it("keeps unchanged row identities in a 10000-row incremental update", () => {
    const current = new Map(
      Array.from({ length: 10000 }, (_, i) => [String(i), { value: i }]),
    );
    const next = new Map(current);
    next.set("150", { value: -1 });
    next.set("200", { value: 200 });
    const result = reconcileRows(current, next, (a, b) => a.value === b.value);
    assert.notEqual(result, current);
    assert.notEqual(result.get("150"), current.get("150"));
    assert.equal(result.get("200"), current.get("200"));
    assert.equal(result.get("9999"), current.get("9999"));
    assert.equal(
      reconcileRows(result, new Map(result), (a, b) => a.value === b.value),
      result,
    );
  });
});
