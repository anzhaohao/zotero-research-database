import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "chai";
import { DATA_ROOT_DATABASE, setDataRoot } from "../../src/storage/dataRoot";
import { ResearchLocalStore } from "../../src/storage/localData";
import { createStorageRuntime } from "./storageRuntime";

describe("local research database recovery", function () {
  it("restores a valid backup when the primary file is corrupt", async function () {
    const runtime = await createStorageRuntime();
    try {
      const root = join(runtime.directory, "portable");
      setDataRoot(root);
      runtime.restart();
      const database = join(root, DATA_ROOT_DATABASE);
      await (globalThis as any).IOUtils.makeDirectory(root, {
        createAncestors: true,
      });
      await writeFile(database, "{broken", "utf8");
      await writeFile(
        `${database}.bak`,
        JSON.stringify({ schemaVersion: 1, items: {} }),
        "utf8",
      );
      const store = new ResearchLocalStore();
      await store.ready();
      expect(JSON.parse(await readFile(database, "utf8"))).to.deep.equal({
        schemaVersion: 1,
        items: {},
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects when both primary and backup are invalid without overwriting either", async function () {
    const runtime = await createStorageRuntime();
    try {
      const root = join(runtime.directory, "portable");
      setDataRoot(root);
      runtime.restart();
      const database = join(root, DATA_ROOT_DATABASE);
      await (globalThis as any).IOUtils.makeDirectory(root, {
        createAncestors: true,
      });
      await writeFile(database, "primary-invalid", "utf8");
      await writeFile(`${database}.bak`, "backup-invalid", "utf8");
      const store = new ResearchLocalStore();
      let failed = false;
      try {
        await store.ready();
      } catch {
        failed = true;
      }
      expect(failed).to.equal(true);
      expect(await readFile(database, "utf8")).to.equal("primary-invalid");
      expect(await readFile(`${database}.bak`, "utf8")).to.equal(
        "backup-invalid",
      );
      expect(
        await access(database).then(
          () => true,
          () => false,
        ),
      ).to.equal(true);
    } finally {
      await runtime.close();
    }
  });
});
