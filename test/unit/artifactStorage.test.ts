import { expect } from "chai";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARTIFACT_STORAGE_MANIFEST,
  buildArtifactRelativePath,
  chooseArtifactFileName,
  cleanupOwnedArtifactDirectory,
  isAbsolutePath,
  parseArtifactStorageManifest,
  registerArtifactStorageNotifier,
  sanitizeArtifactFileName,
} from "../../src/services/artifactStorage";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function expectMissing(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("expected path to be absent: " + path);
}

function installFileApi(root: string) {
  const previous = {
    IOUtils: (globalThis as any).IOUtils,
    PathUtils: (globalThis as any).PathUtils,
    Zotero: (globalThis as any).Zotero,
  };
  (globalThis as any).PathUtils = {
    tempDir: tmpdir(),
    join,
    normalize: (value: string) => value,
    filename: (value: string) => value.split(/[\\/]/).pop(),
  };
  (globalThis as any).IOUtils = {
    exists: async (path: string) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    read: async (path: string) => new Uint8Array(await readFile(path)),
    remove: async (
      path: string,
      options?: { recursive?: boolean; ignoreAbsent?: boolean },
    ) => {
      try {
        await rm(path, {
          recursive: options?.recursive ?? false,
          force: options?.ignoreAbsent ?? false,
        });
      } catch (error) {
        if (!options?.ignoreAbsent) throw error;
      }
    },
    getChildren: async (path: string) =>
      (await import("node:fs/promises"))
        .readdir(path)
        .then((names) => names.map((name) => join(path, name))),
  };
  (globalThis as any).Zotero = {
    Libraries: { userLibraryID: 1 },
    File: { pathToFile: () => ({ isSymlink: () => false }) },
    Prefs: { get: () => root },
    logError: () => undefined,
  };
  return () => {
    (globalThis as any).IOUtils = previous.IOUtils;
    (globalThis as any).PathUtils = previous.PathUtils;
    (globalThis as any).Zotero = previous.Zotero;
  };
}

describe("artifact storage planning", function () {
  it("uses the stable item key and sanitizes the target filename", function () {
    expect(buildArtifactRelativePath("ABCD1234", "figure:1?.png ")).to.equal(
      "ABCD1234/figure_1_.png",
    );
  });

  it("rejects item keys that could escape the per-item directory", function () {
    expect(() => buildArtifactRelativePath("../escape", "file.md")).to.throw(
      "无效的 Zotero itemKey",
    );
  });

  it("removes Windows-invalid characters and trailing dots", function () {
    expect(sanitizeArtifactFileName(' report<>:"|?*.md. ')).to.equal(
      "report_______.md",
    );
    expect(sanitizeArtifactFileName("...")).to.equal("artifact");
  });

  it("adds a deterministic case-insensitive conflict suffix", function () {
    expect(
      chooseArtifactFileName("figure.png", ["Figure.png", "figure-2.png"]),
    ).to.equal("figure-3.png");
    expect(chooseArtifactFileName("notes", ["notes"])).to.equal("notes-2");
  });

  it("accepts Windows and POSIX absolute roots but not relative roots", function () {
    expect(isAbsolutePath("C:\\research-artifacts")).to.equal(true);
    expect(isAbsolutePath("\\\\server\\share\\artifacts")).to.equal(true);
    expect(isAbsolutePath("/var/lib/research-artifacts")).to.equal(true);
    expect(isAbsolutePath("relative/artifacts")).to.equal(false);
  });

  it("parses and normalizes a valid sidecar manifest", function () {
    const manifest = parseArtifactStorageManifest(
      JSON.stringify({
        schemaVersion: 1,
        itemKey: "ABCD1234",
        files: [
          {
            relativePath: "ABCD1234/figure.png",
            attachmentKey: "image001",
            sha256: "A".repeat(64),
            role: "figure",
            figureID: "fig-1",
          },
        ],
      }),
      "ABCD1234",
    );

    expect(manifest.files[0]).to.deep.include({
      attachmentKey: "IMAGE001",
      sha256: "a".repeat(64),
      relativePath: "ABCD1234/figure.png",
      role: "figure",
      figureID: "fig-1",
    });
  });

  it("rejects sidecar paths that contain traversal or unsupported records", function () {
    expect(() =>
      parseArtifactStorageManifest(
        JSON.stringify({
          schemaVersion: 1,
          itemKey: "ABCD1234",
          files: [
            {
              relativePath: "ABCD1234/../outside.md",
              attachmentKey: "NOTE0001",
              sha256: "b".repeat(64),
              role: "snapshot",
            },
          ],
        }),
        "ABCD1234",
      ),
    ).to.throw("清单包含无效文件记录");
  });

  it("rejects cross-item, sidecar, and reserved Windows filenames", function () {
    for (const relativePath of [
      "OTHER001/owned.md",
      "ABCD1234/.zrdb-manifest.json",
      "ABCD1234/CON.txt",
    ]) {
      expect(() =>
        parseArtifactStorageManifest(
          JSON.stringify({
            schemaVersion: 1,
            itemKey: "ABCD1234",
            files: [
              {
                relativePath,
                attachmentKey: "NOTE0001",
                sha256: "b".repeat(64),
                role: "snapshot",
              },
            ],
          }),
          "ABCD1234",
        ),
      ).to.throw("清单包含无效文件记录");
    }
  });

  it("deletes only unchanged owned files and preserves user edits", async function () {
    const root = await mkdtemp(join(tmpdir(), "zrdb-cleanup-"));
    const restore = installFileApi(root);
    const itemKey = "ABCD1234";
    const directory = join(root, itemKey);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "owned.md"), "owned-original");
      await writeFile(join(directory, "edited.md"), "edited-by-user");
      await writeFile(join(directory, "keep.txt"), "unowned");
      await writeFile(
        join(directory, ARTIFACT_STORAGE_MANIFEST),
        JSON.stringify({
          schemaVersion: 1,
          itemKey,
          files: [
            {
              relativePath: itemKey + "/owned.md",
              attachmentKey: "NOTE0001",
              sha256: digest("owned-original"),
              role: "translation",
            },
            {
              relativePath: itemKey + "/edited.md",
              attachmentKey: "NOTE0002",
              sha256: digest("edited-original"),
              role: "figure",
            },
          ],
        }),
      );

      await cleanupOwnedArtifactDirectory(itemKey, root);

      await expectMissing(join(directory, "owned.md"));
      expect(await readFile(join(directory, "edited.md"), "utf8")).to.equal(
        "edited-by-user",
      );
      expect(await readFile(join(directory, "keep.txt"), "utf8")).to.equal(
        "unowned",
      );
      await expectMissing(join(directory, ARTIFACT_STORAGE_MANIFEST));
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not clean a same-key item from another library", async function () {
    const root = await mkdtemp(join(tmpdir(), "zrdb-notifier-"));
    const restore = installFileApi(root);
    const itemKey = "ABCD1234";
    const directory = join(root, itemKey);
    let observer: any;
    const previousNotifier = (globalThis as any).Zotero.Notifier;
    (globalThis as any).Zotero.Notifier = {
      registerObserver: (value: any) => {
        observer = value;
        return "observer-1";
      },
      unregisterObserver: () => undefined,
    };
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "owned.md"), "owned");
      await writeFile(
        join(directory, ARTIFACT_STORAGE_MANIFEST),
        JSON.stringify({
          schemaVersion: 1,
          itemKey,
          files: [
            {
              relativePath: itemKey + "/owned.md",
              attachmentKey: "NOTE0001",
              sha256: digest("owned"),
              role: "translation",
            },
          ],
        }),
      );
      await registerArtifactStorageNotifier();

      await observer.notify("delete", "item", [7], {
        7: { libraryID: 2, key: itemKey },
      });
      expect(await readFile(join(directory, "owned.md"), "utf8")).to.equal(
        "owned",
      );

      await observer.notify("delete", "item", [7], {
        7: { libraryID: 1, key: itemKey },
      });
      await expectMissing(join(directory, "owned.md"));
    } finally {
      (globalThis as any).Zotero.Notifier = previousNotifier;
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
