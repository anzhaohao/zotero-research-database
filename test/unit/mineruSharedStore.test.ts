import { expect } from "chai";
import JSZip from "jszip";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claimSharedMinerUWork,
  findSharedMinerUCache,
  findSharedMinerUCacheForAttachment,
  rewriteSharedMinerUMarkdown,
  sharedMinerUPaperDirectory,
  writeSharedMinerUResult,
  type SharedMinerUIdentity,
} from "../../src/services/mineruSharedStore";

function replaceGlobal(name: string, value: unknown): () => void {
  const target = globalThis as unknown as Record<string, unknown>;
  const hadOwnValue = Object.prototype.hasOwnProperty.call(target, name);
  const previous = target[name];
  target[name] = value;
  return () => {
    if (hadOwnValue) target[name] = previous;
    else delete target[name];
  };
}

async function expectRejection(
  promise: Promise<unknown>,
  message?: string,
): Promise<void> {
  let reason: unknown;
  try {
    await promise;
  } catch (error) {
    reason = error;
  }
  expect(reason, "Expected the operation to reject").to.be.instanceOf(Error);
  if (message) expect((reason as Error).message).to.contain(message);
}

describe("shared MinerU store", function () {
  let root: string;
  let restores: Array<() => void>;
  let failNextCommit: (target: string) => boolean = () => false;

  const identity: SharedMinerUIdentity = {
    libraryID: 1,
    attachmentKey: "PDFKEY12",
    pdfSha256:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pdfFileName: "paper.pdf",
  };

  beforeEach(async function () {
    root = await mkdtemp(path.join(tmpdir(), "shared-mineru-test-"));
    restores = [
      replaceGlobal("PathUtils", {
        join: path.join,
        filename: path.basename,
        tempDir: tmpdir(),
      }),
      replaceGlobal("Zotero", {
        File: {
          getContentsAsync: async (filePath: string) =>
            readFile(filePath, "utf8"),
        },
      }),
      replaceGlobal("IOUtils", {
        exists: async (filePath: string) => {
          try {
            await stat(filePath);
            return true;
          } catch {
            return false;
          }
        },
        makeDirectory: async (
          directory: string,
          options?: { ignoreExisting?: boolean },
        ) => {
          try {
            await mkdir(directory, { recursive: true });
          } catch (error) {
            if (!options?.ignoreExisting) throw error;
          }
        },
        writeUTF8: async (
          filePath: string,
          contents: string,
          options?: { overwrite?: boolean },
        ) => {
          await writeFile(filePath, contents, {
            encoding: "utf8",
            flag: options?.overwrite === false ? "wx" : "w",
          });
        },
        write: async (
          filePath: string,
          bytes: Uint8Array,
          options?: { overwrite?: boolean },
        ) => {
          await writeFile(filePath, bytes, {
            flag: options?.overwrite === false ? "wx" : "w",
          });
        },
        read: async (filePath: string) =>
          new Uint8Array(await readFile(filePath)),
        move: async (
          source: string,
          target: string,
          options?: { overwrite?: boolean },
        ) => {
          if (failNextCommit(target)) {
            failNextCommit = () => false;
            throw new Error("injected commit failure");
          }
          if (options?.overwrite)
            await rm(target, { recursive: true, force: true });
          await rename(source, target);
        },
        remove: async (
          filePath: string,
          options?: { recursive?: boolean; ignoreAbsent?: boolean },
        ) => {
          try {
            await rm(filePath, {
              recursive: options?.recursive,
              force: options?.ignoreAbsent,
            });
          } catch (error) {
            if (!options?.ignoreAbsent) throw error;
          }
        },
        getChildren: async (directory: string) =>
          (await readdir(directory)).map((name) => path.join(directory, name)),
        stat: async (filePath: string) => {
          const info = await stat(filePath);
          return {
            type: info.isDirectory() ? "directory" : "file",
            size: info.size,
            lastModified: info.mtimeMs,
          };
        },
      }),
    ];
  });

  afterEach(async function () {
    for (const restore of restores.reverse()) restore();
    await rm(root, { recursive: true, force: true });
  });

  async function writeResult(
    markdown: string,
    overwrite = false,
    archive?: Uint8Array,
  ): Promise<string> {
    return writeSharedMinerUResult({
      root,
      identity,
      result: {
        markdown,
        figures: [],
        archive,
        markdownArchivePath: archive ? "paper/full.md" : undefined,
      },
      sourceMode: "self-hosted",
      overwrite,
    });
  }

  it("stores the original ZIP, rewrites assets, and indexes the attachment", async function () {
    const zip = new JSZip();
    zip.file("paper/full.md", "![plot](images/plot.png)\n\nBody");
    zip.file("paper/images/plot.png", Uint8Array.from([1, 2, 3]));
    zip.file("paper/structured_content.json", '{"pages":[]}');
    const archive = await zip.generateAsync({ type: "uint8array" });

    const paperDirectory = await writeResult(
      "![plot](images/plot.png)\n\nBody",
      false,
      archive,
    );

    expect(await findSharedMinerUCache(root, identity.pdfSha256)).to.equal(
      paperDirectory,
    );
    expect(
      await findSharedMinerUCacheForAttachment(
        root,
        identity.libraryID,
        identity.attachmentKey,
      ),
    ).to.equal(paperDirectory);
    expect(
      await readFile(path.join(paperDirectory, "full.md"), "utf8"),
    ).to.equal("![plot](raw/paper/images/plot.png)\n\nBody");
    expect(
      new Uint8Array(
        await readFile(path.join(paperDirectory, "raw", "result.zip")),
      ),
    ).to.deep.equal(archive);
  });

  it("rejects incomplete generations and changed file sizes", async function () {
    const paperDirectory = await writeResult("# Complete");
    await writeFile(path.join(paperDirectory, "full.md"), "# Changed size");
    expect(await findSharedMinerUCache(root, identity.pdfSha256)).to.equal("");
  });

  it("does not invent structured JSON for a Markdown-only legacy result", async function () {
    const paperDirectory = await writeResult("# Legacy Markdown");
    expect(await findSharedMinerUCache(root, identity.pdfSha256)).to.equal(
      paperDirectory,
    );
    await expectRejection(
      stat(path.join(paperDirectory, "raw", "structured_content.json")),
    );
    await expectRejection(
      stat(path.join(paperDirectory, "raw", "content_list.json")),
    );
  });

  it("serializes concurrent work and rechecks the cache after locking", async function () {
    this.timeout(10_000);
    let conversions = 0;
    const worker = async () => {
      const claim = await claimSharedMinerUWork({
        root,
        identity,
        timeoutMs: 5_000,
      });
      if (claim.cacheHit) return;
      try {
        conversions += 1;
        await new Promise((resolve) => setTimeout(resolve, 75));
        await writeResult("# Parsed once");
      } finally {
        await claim.release();
      }
    };

    await Promise.all([worker(), worker()]);

    expect(conversions).to.equal(1);
    expect(await findSharedMinerUCache(root, identity.pdfSha256)).not.to.equal(
      "",
    );
  });

  it("forces a new generation and atomically replaces valid cached content", async function () {
    const paperDirectory = await writeResult("# Old");
    const claim = await claimSharedMinerUWork({
      root,
      identity,
      timeoutMs: 5_000,
      forceRefresh: true,
    });
    expect(claim.cacheHit).to.equal(false);
    try {
      await writeResult("# New", true);
    } finally {
      await claim.release();
    }
    expect(
      await readFile(path.join(paperDirectory, "full.md"), "utf8"),
    ).to.equal("# New");
  });

  it("restores the previous generation when the replacement commit fails", async function () {
    const paperDirectory = await writeResult("# Stable old version");
    failNextCommit = (target) => target === paperDirectory;

    await expectRejection(
      writeResult("# Uncommitted new version", true),
      "injected commit failure",
    );

    expect(
      await readFile(path.join(paperDirectory, "full.md"), "utf8"),
    ).to.equal("# Stable old version");
    expect(await findSharedMinerUCache(root, identity.pdfSha256)).to.equal(
      paperDirectory,
    );
  });

  it("leaves no active generation when staging fails", async function () {
    const paperDirectory = sharedMinerUPaperDirectory(root, identity.pdfSha256);
    failNextCommit = (target) => target === paperDirectory;
    await expectRejection(
      writeResult("# Incomplete"),
      "injected commit failure",
    );
    expect(await findSharedMinerUCache(root, identity.pdfSha256)).to.equal("");
    expect(await readdir(path.join(root, "papers"))).to.deep.equal([]);
  });

  it("rewrites only local Markdown image targets", function () {
    expect(
      rewriteSharedMinerUMarkdown(
        "![a](images/a.png) ![b](https://example.test/b.png) ![c](/c.png)",
        "nested/full.md",
      ),
    ).to.equal(
      "![a](raw/nested/images/a.png) ![b](https://example.test/b.png) ![c](/c.png)",
    );
  });
});
