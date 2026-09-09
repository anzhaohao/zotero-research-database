import { assert } from "chai";
import { importArtifacts } from "../../src/services/artifactEndpoint";
import {
  ARTIFACT_STORAGE_MANIFEST,
  ARTIFACT_STORAGE_MIGRATION_PREF,
  cleanupOwnedArtifactDirectory,
  migrateStoredArtifacts,
  readArtifactStorageManifest,
  registerArtifactStorageNotifier,
  scanBrokenArtifactLinks,
  setArtifactStorageRoot,
  sha256File,
  unregisterArtifactStorageNotifier,
} from "../../src/services/artifactStorage";
import { ResearchRepository } from "../../src/storage/repository";
import { getPref, setPref } from "../../src/utils/prefs";

function tempPath(label: string): string {
  return PathUtils.join(
    PathUtils.tempDir,
    `zrdb-p3-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

async function makeDirectory(path: string): Promise<void> {
  await IOUtils.makeDirectory(path, { createAncestors: true });
}

async function writeText(path: string, value: string): Promise<void> {
  await IOUtils.writeUTF8(path, value);
}

async function removeTree(path: string): Promise<void> {
  await (IOUtils as any).remove(path, {
    ignoreAbsent: true,
    recursive: true,
  });
}

function comparablePath(path: string): string {
  return path
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLocaleLowerCase();
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  attempts = 40,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await Zotero.Promise.delay(50);
  }
}

describe("P3 linked artifact storage", function () {
  it("stores MinerU artifacts as linked files with a stable manifest", async function () {
    this.timeout(60_000);
    const previousRoot = String(getPref("artifactStorageRoot") || "");
    const root = tempPath("linked");
    const sourceRoot = tempPath("linked-sources");
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "ZRDB P3 linked artifact storage");
    await parent.saveTx();

    try {
      setArtifactStorageRoot(root);
      await makeDirectory(PathUtils.join(sourceRoot, "run-a"));
      await makeDirectory(PathUtils.join(sourceRoot, "run-b"));
      const originalPath = PathUtils.join(sourceRoot, "run-a", "result.md");
      const translationPath = PathUtils.join(sourceRoot, "run-b", "result.md");
      await writeText(originalPath, "# MinerU original\n");
      await writeText(translationPath, "# Chinese translation\n");
      const originalHash = await sha256File(originalPath);
      const translationHash = await sha256File(translationPath);

      const first = (await importArtifacts({
        libraryID: parent.libraryID,
        parentItemKey: parent.key,
        workflowRunID: "p3-linked-run-1",
        artifacts: [
          {
            role: "mineru-original",
            path: originalPath,
            sha256: originalHash,
            title: "MinerU original",
          },
          {
            role: "translation",
            path: translationPath,
            sha256: translationHash,
            title: "Chinese translation",
          },
        ],
      })) as any;
      assert.deepEqual(
        first.artifacts.map((entry: any) => entry.status),
        ["imported", "imported"],
      );

      const repository = new ResearchRepository();
      const reloaded = await Zotero.Items.getAsync(parent.id);
      const artifacts = await repository.loadArtifacts(reloaded);
      assert.lengthOf(artifacts, 2);
      assert.isTrue(artifacts.every((artifact) => artifact.relativePath));

      const manifest = await readArtifactStorageManifest(root, parent.key);
      assert.lengthOf(manifest.files, 2);
      assert.include(
        manifest.files.map((entry) => entry.relativePath),
        `${parent.key}/result.md`,
      );
      assert.include(
        manifest.files.map((entry) => entry.relativePath),
        `${parent.key}/result-2.md`,
      );
      assert.isTrue(
        await IOUtils.exists(
          PathUtils.join(root, parent.key, ARTIFACT_STORAGE_MANIFEST),
        ),
      );

      const children = await Zotero.Items.getAsync(reloaded.getAttachments());
      const managedChildren = children.filter((child) =>
        artifacts.some((artifact) => artifact.attachmentKey === child.key),
      );
      assert.lengthOf(managedChildren, 2);
      for (const artifact of artifacts) {
        const attachment = managedChildren.find(
          (child) => child.key === artifact.attachmentKey,
        )!;
        assert.equal(
          attachment.attachmentLinkMode,
          2,
          `artifact ${artifact.role} must use linked-file mode`,
        );
        const actualPath = await attachment.getFilePathAsync();
        const expectedPath = PathUtils.join(
          root,
          ...artifact.relativePath!.split(/[\\/]/),
        );
        assert.equal(
          comparablePath(String(actualPath)),
          comparablePath(expectedPath),
        );
        const actualHash = await sha256File(String(actualPath));
        assert.equal(actualHash, artifact.sha256);
      }

      const duplicate = (await importArtifacts({
        libraryID: parent.libraryID,
        parentItemKey: parent.key,
        workflowRunID: "p3-linked-run-2",
        artifacts: [
          {
            role: "translation",
            path: translationPath,
            sha256: translationHash,
            title: "Chinese translation",
          },
        ],
      })) as any;
      assert.equal(duplicate.artifacts[0].status, "unchanged");
      assert.lengthOf(await repository.loadArtifacts(reloaded), 2);
      assert.lengthOf(
        (await readArtifactStorageManifest(root, parent.key)).files,
        2,
      );

      const brokenEntry = manifest.files.find((entry) =>
        entry.relativePath.endsWith("result-2.md"),
      )!;
      await IOUtils.remove(
        PathUtils.join(root, ...brokenEntry.relativePath.split(/[\\/]/)),
        {
          ignoreAbsent: false,
        },
      );
      const broken = await scanBrokenArtifactLinks(root);
      assert.deepInclude(broken, {
        itemKey: parent.key,
        attachmentKey: brokenEntry.attachmentKey,
        relativePath: brokenEntry.relativePath,
        reason: "linked file 不存在",
      });
    } catch (error) {
      const details =
        error && typeof error === "object"
          ? Object.getOwnPropertyNames(error as object)
              .map((key) => `${key}=${String((error as any)[key])}`)
              .join("; ")
          : String(error);
      throw new Error(`P3 linked storage test failed: ${details}`);
    } finally {
      setArtifactStorageRoot(previousRoot);
      await parent.eraseTx();
      await removeTree(root);
      await removeTree(sourceRoot);
    }
  });

  it("migrates stored artifacts without moving the primary PDF and preserves the source until cleanup", async function () {
    this.timeout(60_000);
    const previousRoot = String(getPref("artifactStorageRoot") || "");
    const previousMigrationVersion = Number(
      getPref(ARTIFACT_STORAGE_MIGRATION_PREF) || 0,
    );
    const root = tempPath("migration");
    const sourceRoot = tempPath("migration-sources");
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "ZRDB P3 stored migration");
    await parent.saveTx();

    try {
      setArtifactStorageRoot(root);
      setPref(ARTIFACT_STORAGE_MIGRATION_PREF, 0);
      await makeDirectory(sourceRoot);
      const pdfPath = PathUtils.join(sourceRoot, "paper.pdf");
      const markdownPath = PathUtils.join(sourceRoot, "stored-result.md");
      await writeText(pdfPath, "%PDF-1.4\nP3 primary PDF\n");
      await writeText(markdownPath, "# Stored artifact\n");

      const primaryPdf = await Zotero.Attachments.importFromFile({
        file: pdfPath,
        parentItemID: parent.id,
        title: "paper.pdf",
      } as any);
      const storedArtifact = await Zotero.Attachments.importFromFile({
        file: markdownPath,
        parentItemID: parent.id,
        title: "stored-result.md",
      } as any);
      assert.notEqual(
        primaryPdf.attachmentLinkMode,
        2,
        "the primary PDF must remain a stored attachment",
      );
      const storedHash = await sha256File(
        await storedArtifact.getFilePathAsync(),
      );
      const repository = new ResearchRepository();
      await repository.saveManifests(parent, [
        {
          attachmentKey: storedArtifact.key,
          role: "translation",
          sha256: storedHash,
          runID: "p3-stored-run",
        },
      ]);

      const itemDirectory = PathUtils.join(root, parent.key);
      await makeDirectory(itemDirectory);
      const userFile = PathUtils.join(itemDirectory, "keep-user-file.txt");
      await writeText(userFile, "must survive plugin cleanup");

      const migration = await migrateStoredArtifacts();
      assert.equal(migration.migrated, 1);
      assert.equal(migration.broken, 0);
      assert.deepEqual(migration.failures, []);
      assert.equal(
        Number(getPref(ARTIFACT_STORAGE_MIGRATION_PREF)),
        1,
        "successful migration records its version",
      );

      const reloaded = await Zotero.Items.getAsync(parent.id);
      const migratedArtifacts = await repository.loadArtifacts(reloaded);
      const migratedArtifact = migratedArtifacts[0];
      assert.equal(migratedArtifact.role, "translation");
      assert.isString(migratedArtifact.relativePath);
      const children = await Zotero.Items.getAsync(reloaded.getAttachments());
      assert.isTrue(
        children.some((child) => child.key === storedArtifact.key),
        "the old stored artifact attachment remains as a rollback source",
      );
      const migratedAttachment = children.find(
        (child) => child.key === migratedArtifact.attachmentKey,
      )!;
      assert.equal(migratedAttachment.attachmentLinkMode, 2);
      const migratedPath = await migratedAttachment.getFilePathAsync();
      assert.equal(await sha256File(migratedPath), storedHash);
      assert.isTrue(await IOUtils.exists(migratedPath));
      assert.isTrue(await IOUtils.exists(userFile));
      assert.isTrue(
        await IOUtils.exists(
          PathUtils.join(root, parent.key, ARTIFACT_STORAGE_MANIFEST),
        ),
      );
      assert.isTrue(
        children.some((child) => child.key === primaryPdf.key),
        "the primary PDF remains attached",
      );

      const notifierID = await registerArtifactStorageNotifier();
      try {
        await parent.eraseTx();
        await waitFor(
          async () =>
            !(await IOUtils.exists(
              PathUtils.join(root, parent.key, ARTIFACT_STORAGE_MANIFEST),
            )),
        );
        assert.isFalse(
          await IOUtils.exists(migratedPath),
          "plugin-owned linked files are deleted after parent deletion",
        );
      } finally {
        unregisterArtifactStorageNotifier(notifierID);
      }
      assert.isFalse(
        await IOUtils.exists(
          PathUtils.join(root, parent.key, ARTIFACT_STORAGE_MANIFEST),
        ),
      );
      assert.isTrue(
        await IOUtils.exists(userFile),
        "unowned files in the item directory are retained",
      );
    } catch (error) {
      const details =
        error && typeof error === "object"
          ? Object.getOwnPropertyNames(error as object)
              .map((key) => `${key}=${String((error as any)[key])}`)
              .join("; ")
          : String(error);
      throw new Error(`P3 linked storage test failed: ${details}`);
    } finally {
      setArtifactStorageRoot(previousRoot);
      setPref(ARTIFACT_STORAGE_MIGRATION_PREF, previousMigrationVersion);
      await cleanupOwnedArtifactDirectory(parent.key, root).catch(
        () => undefined,
      );
      await parent.eraseTx().catch(() => undefined);
      await removeTree(root);
      await removeTree(sourceRoot);
    }
  });
});
