import { expect } from "chai";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStorageRuntime } from "./storageRuntime";
import { getDataRoot } from "../../src/storage/dataRoot";
import {
  completeDirectoryMigration,
  pendingDirectoryMigration,
  scheduleDirectoryMigration,
} from "../../src/storage/directoryMigration";

async function setup() {
  const runtime = await createStorageRuntime();
  const host = (globalThis as any).Zotero;
  host.Libraries = { userLibraryID: 1 };
  host.Items = { getAll: async () => [] };
  host.Prefs.clear = (key: string) => runtime.prefs.delete(key);
  host.logError = () => undefined;
  await mkdir(runtime.legacyRoot, { recursive: true });
  await writeFile(
    join(runtime.legacyRoot, "research-data-v1.json"),
    JSON.stringify({ schemaVersion: 1, items: {} }),
  );
  const target = join(runtime.directory, "target");
  const artifactSource = join(runtime.directory, "old-artifacts");
  const artifactTarget = join(runtime.directory, "new-artifacts");
  return { ...runtime, target, artifactSource, artifactTarget, host };
}

describe("restart directory migration", function () {
  it("validates the database before switching and preserves arbitrary JSON artifact bytes", async function () {
    const runtime = await setup();
    try {
      await mkdir(runtime.artifactSource, { recursive: true });
      const content = JSON.stringify({ path: runtime.artifactSource });
      await writeFile(join(runtime.artifactSource, "result.json"), content);
      scheduleDirectoryMigration({
        dataRoot: runtime.target,
        artifactStorageRoot: runtime.artifactTarget,
        mineruSharedStoreDirectory: "",
        sourceArtifactRoot: runtime.artifactSource,
        sourceSharedRoot: "",
      });
      await writeFile(
        join(runtime.legacyRoot, "research-data-v1.json"),
        JSON.stringify({ schemaVersion: 1, items: { broken: "invalid" } }),
      );
      let failure: unknown;
      try {
        await completeDirectoryMigration();
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).to.include("记录格式无效");
      expect(getDataRoot()).to.equal(runtime.legacyRoot);
      await writeFile(
        join(runtime.legacyRoot, "research-data-v1.json"),
        JSON.stringify({ schemaVersion: 1, items: {} }),
      );
      await completeDirectoryMigration();
      expect(
        await readFile(join(runtime.artifactTarget, "result.json"), "utf8"),
      ).to.equal(content);
    } finally {
      await runtime.close();
    }
  });

  it("rolls back failed preference commits and can retry transformed settings", async function () {
    const runtime = await setup();
    try {
      await writeFile(
        join(runtime.legacyRoot, "settings.json"),
        JSON.stringify({
          schemaVersion: 1,
          values: { mineruSharedStoreDirectory: "old", keep: "unchanged" },
        }),
      );
      scheduleDirectoryMigration({
        dataRoot: runtime.target,
        artifactStorageRoot: runtime.artifactTarget,
        mineruSharedStoreDirectory: "",
        sourceArtifactRoot: "",
        sourceSharedRoot: "",
      });
      const set = runtime.host.Prefs.set;
      runtime.host.Prefs.set = (key: string, value: unknown) => {
        if (key.endsWith(".artifactStorageRoot"))
          throw new Error("pref commit failure");
        return set(key, value);
      };
      let failure: unknown;
      try {
        await completeDirectoryMigration();
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).to.include("pref commit failure");
      expect(runtime.prefs.get(runtime.rootPref)).to.equal(undefined);
      expect(pendingDirectoryMigration()).not.to.equal(undefined);
      runtime.host.Prefs.set = set;
      await completeDirectoryMigration();
      expect(getDataRoot()).to.equal(runtime.target);
      expect(
        JSON.parse(
          await readFile(join(runtime.target, "settings.json"), "utf8"),
        ).values.keep,
      ).to.equal("unchanged");
    } finally {
      await runtime.close();
    }
  });

  it("returns to the default directory with its readable legacy database filename", async function () {
    const runtime = await setup();
    try {
      await mkdir(runtime.target, { recursive: true });
      await writeFile(
        join(runtime.target, "database.json"),
        JSON.stringify({ schemaVersion: 1, items: {}, marker: "selected" }),
      );
      runtime.prefs.set(runtime.rootPref, runtime.target);
      runtime.restart();
      // Identical target contents can be safely reused; differing contents must refuse.
      await writeFile(
        join(runtime.legacyRoot, "research-data-v1.json"),
        JSON.stringify({ schemaVersion: 1, items: {}, marker: "selected" }),
      );
      scheduleDirectoryMigration({
        dataRoot: "",
        artifactStorageRoot: "",
        mineruSharedStoreDirectory: "",
        sourceArtifactRoot: "",
        sourceSharedRoot: "",
      });
      await completeDirectoryMigration();
      expect(getDataRoot()).to.equal(runtime.legacyRoot);
      expect(
        JSON.parse(
          await readFile(
            join(runtime.legacyRoot, "research-data-v1.json"),
            "utf8",
          ),
        ).marker,
      ).to.equal("selected");
    } finally {
      await runtime.close();
    }
  });

  it("schedules without changing live roots and copies the final pre-restart state", async function () {
    const runtime = await setup();
    try {
      scheduleDirectoryMigration({
        dataRoot: runtime.target,
        artifactStorageRoot: runtime.artifactTarget,
        mineruSharedStoreDirectory: "",
        sourceArtifactRoot: runtime.artifactSource,
        sourceSharedRoot: "",
      });
      expect(getDataRoot()).to.equal(runtime.legacyRoot);
      expect(runtime.prefs.get(runtime.rootPref)).to.equal(undefined);
      await writeFile(
        join(runtime.legacyRoot, "research-data-v1.json"),
        JSON.stringify({ schemaVersion: 1, items: {}, final: "latest edit" }),
      );
      await completeDirectoryMigration();
      expect(
        JSON.parse(
          await readFile(join(runtime.target, "database.json"), "utf8"),
        ).final,
      ).to.equal("latest edit");
      expect(getDataRoot()).to.equal(runtime.target);
      expect(pendingDirectoryMigration()).to.equal(undefined);
      expect(
        JSON.parse(
          await readFile(
            join(runtime.legacyRoot, "research-data-v1.json"),
            "utf8",
          ),
        ).final,
      ).to.equal("latest edit");
    } finally {
      await runtime.close();
    }
  });

  it("copies separate artifacts and relinks the same attachment without duplicates", async function () {
    const runtime = await setup();
    try {
      await mkdir(runtime.artifactSource, { recursive: true });
      const source = join(runtime.artifactSource, "paper.md");
      await writeFile(source, "论文原文");
      let file = source;
      const item = {
        isAttachment: () => true,
        getFilePathAsync: async () => file,
        relinkAttachmentFile: async (path: string) => {
          file = path;
        },
      };
      runtime.host.Items.getAll = async () => [item];
      scheduleDirectoryMigration({
        dataRoot: runtime.target,
        artifactStorageRoot: runtime.artifactTarget,
        mineruSharedStoreDirectory: "",
        sourceArtifactRoot: runtime.artifactSource,
        sourceSharedRoot: "",
      });
      await completeDirectoryMigration();
      expect(file).to.equal(join(runtime.artifactTarget, "paper.md"));
      expect(await readFile(file, "utf8")).to.equal("论文原文");
      expect(await readFile(source, "utf8")).to.equal("论文原文");
    } finally {
      await runtime.close();
    }
  });

  it("refuses conflicting destination files and keeps the original active pointer", async function () {
    const runtime = await setup();
    try {
      await mkdir(runtime.target, { recursive: true });
      await writeFile(
        join(runtime.target, "database.json"),
        "existing user data",
      );
      scheduleDirectoryMigration({
        dataRoot: runtime.target,
        artifactStorageRoot: "",
        mineruSharedStoreDirectory: "",
        sourceArtifactRoot: "",
        sourceSharedRoot: "",
      });
      let failure: unknown;
      try {
        await completeDirectoryMigration();
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).to.include("未覆盖或切换");
      expect(getDataRoot()).to.equal(runtime.legacyRoot);
      expect(
        await readFile(join(runtime.target, "database.json"), "utf8"),
      ).to.equal("existing user data");
      expect(pendingDirectoryMigration()).not.to.equal(undefined);
    } finally {
      await runtime.close();
    }
  });

  it("retries after interrupted copying and verifies bytes before switching", async function () {
    const runtime = await setup();
    try {
      await mkdir(runtime.artifactSource, { recursive: true });
      await writeFile(join(runtime.artifactSource, "paper.md"), "source bytes");
      scheduleDirectoryMigration({
        dataRoot: runtime.target,
        artifactStorageRoot: runtime.artifactTarget,
        mineruSharedStoreDirectory: "",
        sourceArtifactRoot: runtime.artifactSource,
        sourceSharedRoot: "",
      });
      const io = (globalThis as any).IOUtils;
      const write = io.write;
      io.write = async (path: string, bytes: Uint8Array) =>
        write(path, path.includes("paper.md") ? new Uint8Array([0]) : bytes);
      let failure: unknown;
      try {
        await completeDirectoryMigration();
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).to.include("校验失败");
      expect(getDataRoot()).to.equal(runtime.legacyRoot);
      io.write = write;
      await completeDirectoryMigration();
      expect(getDataRoot()).to.equal(runtime.target);
      expect(
        await readFile(join(runtime.artifactTarget, "paper.md"), "utf8"),
      ).to.equal("source bytes");
    } finally {
      await runtime.close();
    }
  });

  it("preserves settings and rejects nested roots", async function () {
    const runtime = await setup();
    try {
      await writeFile(
        join(runtime.legacyRoot, "settings.json"),
        JSON.stringify({
          schemaVersion: 1,
          values: { density: "comfortable", mineruSharedStoreDirectory: "old" },
        }),
      );
      expect(() =>
        scheduleDirectoryMigration({
          dataRoot: join(runtime.legacyRoot, "child"),
          artifactStorageRoot: "",
          mineruSharedStoreDirectory: "",
          sourceArtifactRoot: "",
          sourceSharedRoot: "",
        }),
      ).to.throw("互相嵌套");
      scheduleDirectoryMigration({
        dataRoot: runtime.target,
        artifactStorageRoot: "",
        mineruSharedStoreDirectory: "",
        sourceArtifactRoot: "",
        sourceSharedRoot: "",
      });
      await completeDirectoryMigration();
      const settings = JSON.parse(
        await readFile(join(runtime.target, "settings.json"), "utf8"),
      );
      expect(settings.values.density).to.equal("comfortable");
      expect(settings.values.mineruSharedStoreDirectory).to.equal("");
    } finally {
      await runtime.close();
    }
  });

  it("restores attachment links when relinking fails and leaves a recoverable plan", async function () {
    const runtime = await setup();
    try {
      await mkdir(runtime.artifactSource, { recursive: true });
      const source = join(runtime.artifactSource, "paper.md");
      await writeFile(source, "source bytes");
      let file = source;
      let fail = true;
      runtime.host.Items.getAll = async () => [
        {
          isAttachment: () => true,
          getFilePathAsync: async () => file,
          relinkAttachmentFile: async (path: string) => {
            file = path;
            if (fail && path !== source) throw new Error("relink failed");
          },
        },
      ];
      scheduleDirectoryMigration({
        dataRoot: runtime.target,
        artifactStorageRoot: runtime.artifactTarget,
        mineruSharedStoreDirectory: "",
        sourceArtifactRoot: runtime.artifactSource,
        sourceSharedRoot: "",
      });
      try {
        await completeDirectoryMigration();
      } catch {
        // The injected relink failure must leave the original link intact.
      }
      expect(file).to.equal(source);
      expect(getDataRoot()).to.equal(runtime.legacyRoot);
      fail = false;
      await completeDirectoryMigration();
      expect(file).to.equal(join(runtime.artifactTarget, "paper.md"));
    } finally {
      await runtime.close();
    }
  });
});
