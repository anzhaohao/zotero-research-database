import { assert } from "chai";
import {
  writeSharedMinerUResult,
  findSharedMinerUCache,
} from "../../src/services/mineruSharedStore";
import { copyDirectoryMigration } from "../../src/storage/directoryMigration";
import {
  mineruFileIO,
  mineruImageDataURI,
} from "../../src/services/mineruFileIO";
import { mineruResultFromDirectory } from "../../src/services/mineru";
import {
  createManagedAttachment,
  setArtifactStorageRoot,
} from "../../src/services/artifactStorage";
import { getPref } from "../../src/utils/prefs";

describe("MinerU Windows long-path storage", function () {
  this.timeout(30_000);

  for (const length of [260, 500, 1000])
    it(`writes, reopens, replaces, migrates and removes ${length}-character paths using native IO`, async function () {
      const base = PathUtils.join(PathUtils.tempDir, "zrdb-path-" + Date.now());
      let root = base;
      while (root.length < length)
        root = PathUtils.join(
          root,
          "中文" +
            "r".repeat(Math.min(70, Math.max(1, length - root.length - 3))),
        );
      const destination = base + "-migrated";
      const hash = "b".repeat(64);
      const image = "nested-paper/images/" + "长".repeat(300) + ".jpg";
      const markdown = "![figure](" + image + ")";
      const manifest = JSON.stringify([
        {
          type: "image",
          img_path: image,
          image_caption: ["Figure"],
          page_idx: 0,
        },
      ]);
      const options = {
        root,
        identity: {
          libraryID: 1,
          attachmentKey: "PATHTEST",
          pdfSha256: hash,
          pdfFileName: "paper.pdf",
        },
        result: {
          markdown,
          figures: [],
          archive: new Uint8Array([1]),
          markdownArchivePath: "full.md",
          archiveEntries: [
            { name: "full.md", bytes: new TextEncoder().encode(markdown) },
            {
              name: "content_list.json",
              bytes: new TextEncoder().encode(manifest),
            },
            { name: image, bytes: new Uint8Array([1, 2, 3]) },
          ],
        },
        sourceMode: "official-api" as const,
      };
      try {
        const directory = await writeSharedMinerUResult(options);
        const stored = (
          JSON.parse(
            await mineruFileIO.readUTF8(
              PathUtils.join(directory, "parse.json"),
            ),
          ) as { files: Array<{ path: string; originalPaths?: string[] }> }
        ).files.find((f) => f.originalPaths?.includes(image))!;
        const imagePath = PathUtils.join(directory, ...stored.path.split("/"));
        assert.isAbove(imagePath.length, 260);
        assert.deepEqual([...(await mineruFileIO.read(imagePath))], [1, 2, 3]);
        assert.equal(await findSharedMinerUCache(root, hash), directory);
        const reread = await mineruResultFromDirectory(directory);
        assert.lengthOf(reread.figures, 1);
        assert.equal(
          reread.figures[0].id,
          "mineru:figure:" + encodeURIComponent(image),
        );
        assert.include(reread.markdown, stored.path);
        await writeSharedMinerUResult({ ...options, overwrite: true });
        assert.equal(await findSharedMinerUCache(root, hash), directory);
        assert.lengthOf(
          await mineruFileIO.getChildren(PathUtils.join(root, "papers")),
          1,
        );
        const copied = await copyDirectoryMigration({
          schemaVersion: 1,
          sourceRoot: root,
          pairs: [{ source: root, target: destination }],
          preferences: {
            dataRoot: destination,
            artifactStorageRoot: "",
            mineruSharedStoreDirectory: "",
          },
        });
        assert.isAbove(copied, 0);
        assert.equal(
          await findSharedMinerUCache(destination, hash),
          PathUtils.join(destination, "papers", hash),
        );
        assert.lengthOf(
          (
            await mineruResultFromDirectory(
              PathUtils.join(destination, "papers", hash),
            )
          ).figures,
          1,
        );
      } finally {
        await mineruFileIO.remove(destination, {
          recursive: true,
          ignoreAbsent: true,
        });
        await mineruFileIO.remove(base, {
          recursive: true,
          ignoreAbsent: true,
        });
      }
      assert.isFalse(await mineruFileIO.exists(base));
    });

  it("imports and reopens a Zotero image from a long artifact root", async function () {
    const base = PathUtils.join(
      PathUtils.tempDir,
      "zrdb-linked-path-" + Date.now(),
    );
    let root = base;
    while (root.length < 500)
      root = PathUtils.join(root, "中文" + "r".repeat(60));
    const previous = String(getPref("artifactStorageRoot") || "");
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "Long path image fixture");
    await parent.saveTx();
    try {
      await mineruFileIO.makeDirectory(base, { ignoreExisting: true });
      const source = PathUtils.join(base, "image.png");
      const png = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3eoAAAAASUVORK5CYII=",
        ),
        (c) => c.charCodeAt(0),
      );
      await mineruFileIO.write(source, png);
      setArtifactStorageRoot(root);
      let imported;
      try {
        imported = await createManagedAttachment(
          parent,
          source,
          "Long path figure",
          { role: "figure", figureID: "long-path" },
        );
      } catch (error) {
        throw new Error(
          "long-path artifact creation failed: " + String(error),
          {
            cause: error,
          },
        );
      }
      const { attachment, relativePath } = imported;
      assert.isString(relativePath);
      assert.isTrue(
        typeof attachment.isStoredFileAttachment === "function"
          ? attachment.isStoredFileAttachment()
          : attachment.attachmentLinkMode === 0,
        "超长共享路径应退回 Zotero storage 附件",
      );
      assert.notInclude(relativePath!, "\\\\?\\");
      const linked = await attachment.getFilePathAsync();
      assert.isString(linked);
      assert.deepEqual(
        [...(await mineruFileIO.read(String(linked)))],
        [...png],
      );
      let data;
      try {
        data = await mineruImageDataURI(String(linked), "image/png");
      } catch (error) {
        throw new Error("long-path image display failed: " + String(error), {
          cause: error,
        });
      }
      assert.match(data, /^data:image\/png;base64,/);
    } finally {
      setArtifactStorageRoot(previous);
      await parent.eraseTx();
      await mineruFileIO.remove(base, { recursive: true, ignoreAbsent: true });
    }
  });
});
