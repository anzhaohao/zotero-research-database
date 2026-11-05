import { assert } from "chai";
import { config } from "../../package.json";
import {
  scheduleDirectoryMigration,
  completeDirectoryMigration,
  pendingDirectoryMigration,
} from "../../src/storage/directoryMigration";
import { getDataRoot, resetDataRootScope } from "../../src/storage/dataRoot";
import {
  completeDataRecovery,
  scheduleDataRecovery,
} from "../../src/storage/dataRecovery";
import { parseLocalPayload } from "../../src/storage/localData";

describe("native restart directory migration", function () {
  it("restores a complete legacy research library with native IO after restart", async function () {
    const key = config.prefsPrefix + ".dataRoot",
      previous = Zotero.Prefs.get(key, true);
    const root = PathUtils.join(
      PathUtils.tempDir,
      "zrdb-recovery-native-" + Date.now(),
    );
    try {
      await IOUtils.makeDirectory(root);
      const fixturePath = String(
        Zotero.Prefs.get(
          "extensions.zotero-research-database.test.liveAgentFixture",
          true,
        ) || "",
      );
      const source = fixturePath
        ? await IOUtils.readUTF8(
            JSON.parse(await IOUtils.readUTF8(fixturePath)).databasePath,
          )
        : JSON.stringify({
            schemaVersion: 1,
            items: {},
            marker: "old library",
          });
      const sourceFile = PathUtils.join(root, "old-database.json"),
        targetFile = PathUtils.join(root, "database.json"),
        backupFile = PathUtils.join(root, "before.json");
      await IOUtils.writeUTF8(sourceFile, source);
      const initial = JSON.stringify({ schemaVersion: 1, items: {} });
      await IOUtils.writeUTF8(targetFile, initial);
      Zotero.Prefs.set(key, root, true);
      resetDataRootScope();
      await scheduleDataRecovery(sourceFile, backupFile);
      assert.equal(await IOUtils.readUTF8(targetFile), initial);
      assert.isTrue(await completeDataRecovery());
      assert.equal(await IOUtils.readUTF8(targetFile), source);
      assert.deepEqual(
        parseLocalPayload(JSON.parse(await IOUtils.readUTF8(targetFile))),
        parseLocalPayload(JSON.parse(source)),
      );
      assert.equal(await IOUtils.readUTF8(backupFile), initial);
    } finally {
      if (previous === undefined) Zotero.Prefs.clear(key, true);
      else Zotero.Prefs.set(key, previous, true);
      resetDataRootScope();
      await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
    }
  });

  it("copies and verifies native files then relinks the original Zotero attachment", async function () {
    this.timeout(30_000);
    const keys = [
      "dataRoot",
      "artifactStorageRoot",
      "mineruSharedStoreDirectory",
      "pendingDirectoryMigration",
    ];
    const previous = keys.map((key) =>
      Zotero.Prefs.get(config.prefsPrefix + "." + key, true),
    );
    const root = PathUtils.join(
      PathUtils.tempDir,
      "zrdb-migration-native-" + Date.now(),
    );
    const source = PathUtils.join(root, "source"),
      target = PathUtils.join(root, "target");
    const sourceArtifacts = PathUtils.join(root, "old-artifacts"),
      targetArtifacts = PathUtils.join(root, "new-artifacts");
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", "ZRDB native migration validation");
    await paper.saveTx();
    try {
      await IOUtils.makeDirectory(source, { createAncestors: true });
      await IOUtils.makeDirectory(sourceArtifacts);
      await IOUtils.writeUTF8(
        PathUtils.join(source, "database.json"),
        JSON.stringify({ schemaVersion: 1, items: {}, marker: "latest" }),
      );
      await IOUtils.writeUTF8(
        PathUtils.join(source, "settings.json"),
        JSON.stringify({
          schemaVersion: 1,
          values: { density: "comfortable" },
        }),
      );
      const originalPath = PathUtils.join(sourceArtifacts, "paper.md");
      await IOUtils.writeUTF8(originalPath, "完整论文与图片关联");
      const attachment = await Zotero.Attachments.linkFromFile({
        file: originalPath,
        parentItemID: paper.id,
      });
      const key = attachment.key;
      Zotero.Prefs.set(config.prefsPrefix + ".dataRoot", source, true);
      resetDataRootScope();
      scheduleDirectoryMigration({
        dataRoot: target,
        artifactStorageRoot: targetArtifacts,
        mineruSharedStoreDirectory: "",
        sourceArtifactRoot: sourceArtifacts,
        sourceSharedRoot: "",
      });
      assert.equal(getDataRoot(), source);
      assert.isTrue(await IOUtils.exists(originalPath));
      await completeDirectoryMigration();
      assert.equal(getDataRoot(), target);
      assert.isUndefined(pendingDirectoryMigration());
      assert.equal(attachment.key, key);
      assert.equal(
        await attachment.getFilePathAsync(),
        PathUtils.join(targetArtifacts, "paper.md"),
      );
      assert.equal(
        await IOUtils.readUTF8(PathUtils.join(targetArtifacts, "paper.md")),
        "完整论文与图片关联",
      );
      assert.isTrue(await IOUtils.exists(originalPath));
      assert.equal(
        JSON.parse(
          await IOUtils.readUTF8(PathUtils.join(target, "database.json")),
        ).marker,
        "latest",
      );
    } finally {
      for (let index = 0; index < keys.length; index++) {
        const key = config.prefsPrefix + "." + keys[index];
        if (previous[index] === undefined) Zotero.Prefs.clear(key, true);
        else Zotero.Prefs.set(key, previous[index] as any, true);
      }
      resetDataRootScope();
      await paper.eraseTx();
      await IOUtils.remove(root, { recursive: true, ignoreAbsent: true });
    }
  });
});
