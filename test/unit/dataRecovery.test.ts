import { expect } from "chai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStorageRuntime } from "./storageRuntime";
import {
  completeDataRecovery,
  scheduleDataRecovery,
} from "../../src/storage/dataRecovery";

describe("guarded restart data recovery", function () {
  for (const changed of [false, true])
    it(
      changed
        ? "refuses to replace a later user edit"
        : "restores only at restart and removes the completed plan",
      async function () {
        const runtime = await createStorageRuntime();
        try {
          await mkdir(runtime.legacyRoot, { recursive: true });
          const target = join(runtime.legacyRoot, "research-data-v1.json");
          const source = join(runtime.directory, "source.json");
          const backup = join(runtime.directory, "before-recovery.json");
          const initial = JSON.stringify({
            schemaVersion: 1,
            items: {},
            marker: "initial",
          });
          const recovered = JSON.stringify({
            schemaVersion: 1,
            items: {},
            marker: "recovered",
          });
          await writeFile(target, initial);
          await writeFile(source, recovered);
          await scheduleDataRecovery(source, backup);
          expect(await readFile(target, "utf8")).to.equal(initial);
          if (changed)
            await writeFile(
              target,
              JSON.stringify({
                schemaVersion: 1,
                items: {},
                marker: "later edit",
              }),
            );
          let failure: unknown;
          try {
            await completeDataRecovery();
          } catch (error) {
            failure = error;
          }
          if (changed) {
            expect(String(failure)).to.include("已发生变化");
            expect(await readFile(target, "utf8")).to.include("later edit");
          } else {
            expect(failure).to.equal(undefined);
            expect(await readFile(target, "utf8")).to.equal(recovered);
            expect(await completeDataRecovery()).to.equal(false);
          }
          expect(await readFile(backup, "utf8")).to.equal(initial);
        } finally {
          await runtime.close();
        }
      },
    );

  it("keeps the current database when the source or rollback copy is corrupted", async function () {
    const runtime = await createStorageRuntime();
    try {
      await mkdir(runtime.legacyRoot, { recursive: true });
      const target = join(runtime.legacyRoot, "research-data-v1.json"),
        source = join(runtime.directory, "source.json"),
        backup = join(runtime.directory, "backup.json");
      const initial = JSON.stringify({ schemaVersion: 1, items: {} });
      await writeFile(target, initial);
      await writeFile(
        source,
        JSON.stringify({ schemaVersion: 1, items: {}, recovered: true }),
      );
      await scheduleDataRecovery(source, backup);
      await writeFile(backup, "corrupt");
      let failure: unknown;
      try {
        await completeDataRecovery();
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).to.include("备份校验失败");
      expect(await readFile(target, "utf8")).to.equal(initial);
    } finally {
      await runtime.close();
    }
  });
});
