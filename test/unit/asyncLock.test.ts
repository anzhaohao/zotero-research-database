import { expect } from "chai";
import { KeyedAsyncLock } from "../../src/core/asyncLock";

describe("keyed async lock", function () {
  it("serializes the same key while allowing different keys", async function () {
    const lock = new KeyedAsyncLock();
    const events: string[] = [];
    let release!: () => void;
    const first = lock.run("item", async () => {
      events.push("first-start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      events.push("first-end");
      return 1;
    });
    await Promise.resolve();
    const second = lock.run("item", async () => {
      events.push("second");
      return 2;
    });
    const unrelated = lock.run("other", async () => {
      events.push("other");
      return 3;
    });
    await unrelated;
    expect(events).to.deep.equal(["first-start", "other"]);
    release();
    await Promise.all([first, second]);
    expect(events).to.deep.equal([
      "first-start",
      "other",
      "first-end",
      "second",
    ]);
  });

  it("continues after a rejected operation", async function () {
    const lock = new KeyedAsyncLock();
    let rejected = false;
    try {
      await lock.run("item", async () => {
        throw new Error("boom");
      });
    } catch {
      rejected = true;
    }
    expect(rejected).to.equal(true);
    expect(await lock.run("item", async () => 42)).to.equal(42);
  });
});
