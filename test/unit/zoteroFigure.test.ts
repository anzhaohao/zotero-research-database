import { expect } from "chai";
import {
  cleanupObsoleteFigureCache,
  galleryEntries,
  hasZoteroFigure,
  invalidateZoteroFigureCache,
  listZoteroFigures,
  normalizeGalleryEntry,
  openZoteroFigureParserUI,
  readZoteroFigureImage,
  zoteroFigureImageSignature,
} from "../../src/services/zoteroFigure";

const originalZotero = (globalThis as any).Zotero;
const originalIOUtils = (globalThis as any).IOUtils;
const originalPathUtils = (globalThis as any).PathUtils;

describe("Zotero Figure runtime adapter", function () {
  afterEach(function () {
    invalidateZoteroFigureCache();
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).IOUtils = originalIOUtils;
    (globalThis as any).PathUtils = originalPathUtils;
  });

  it("loads one gallery snapshot per library until an explicit refresh", async function () {
    let calls = 0;
    (globalThis as any).Zotero = {
      ZoteroFigure: {
        api: {
          gallery: {
            loadLibrary: async () => {
              calls += 1;
              return {
                entries: [
                  {
                    id: "1:PDF00001:figure-1",
                    documentItemID: 41,
                    kind: "figure",
                  },
                  {
                    id: "1:PDF00002:figure-1",
                    documentItemID: 42,
                    kind: "figure",
                  },
                ],
              };
            },
          },
        },
      },
    };
    const kinds = new Set(["figure", "table", "formula"] as const);
    const first = await Promise.all([
      listZoteroFigures({ id: 41, libraryID: 1 } as Zotero.Item, kinds),
      listZoteroFigures({ id: 42, libraryID: 1 } as Zotero.Item, kinds),
    ]);
    expect(calls).to.equal(1);
    expect(first[0][0].cacheRevision).to.equal(0);
    invalidateZoteroFigureCache(1);
    const refreshed = await listZoteroFigures(
      { id: 41, libraryID: 1 } as Zotero.Item,
      kinds,
    );
    expect(calls).to.equal(2);
    expect(refreshed[0].cacheRevision).to.equal(1);
  });

  it("reports an unavailable parser UI without pretending it opened", async function () {
    (globalThis as any).Zotero = { ZoteroFigure: { api: { gallery: {} } } };
    expect(await openZoteroFigureParserUI()).to.equal(false);
  });

  it("changes the image signature when a library refresh advances revision", function () {
    const record = {
      provider: "zotero-figure",
      id: "zotero-figure:1:A:1",
      entryID: "1:A:1",
      itemID: 42,
      kind: "figure",
      caption: "",
      pageIndex: 0,
      cacheRevision: 0,
    } as const;
    expect(zoteroFigureImageSignature(record)).to.equal("1:A:1:0");
    expect(
      zoteroFigureImageSignature({ ...record, cacheRevision: 1 }),
    ).to.equal("1:A:1:1");
  });

  it("removes only old revisions from the same library and item cache", async function () {
    const removed: string[] = [];
    (globalThis as any).PathUtils = {
      profileDir: "C:\\profile",
      join: (...parts: string[]) => parts.join("/"),
    };
    const itemDirectory =
      "C:\\profile/zotero-research-database/figure-cache/1/ITEM0001";
    (globalThis as any).IOUtils = {
      exists: async () => true,
      getChildren: async () => [
        `${itemDirectory}/0`,
        `${itemDirectory}/2`,
        `${itemDirectory}/notes`,
        "C:\\profile/zotero-research-database/figure-cache/1/ITEM0002/0",
      ],
      remove: async (path: string) => {
        removed.push(path);
      },
    };
    (globalThis as any).Zotero = { logError: () => undefined };
    await cleanupObsoleteFigureCache({
      provider: "zotero-figure",
      id: "zotero-figure:1:A:1",
      entryID: "1:A:1",
      libraryID: 1,
      itemID: 42,
      itemKey: "ITEM0001",
      kind: "figure",
      caption: "",
      pageIndex: 0,
      cacheRevision: 2,
    });
    expect(removed).to.deep.equal([`${itemDirectory}/0`]);
  });

  it("normalizes figure, table and formula entries without persistence fields", function () {
    expect(
      normalizeGalleryEntry({
        id: "1:ABCD1234:figure-1",
        documentItemID: 42,
        type: "formula",
        comment: "E = mc²",
        pageIndex: 3,
        bbox: [0.1, 0.2, 0.7, 0.8],
        latex: "E=mc^2",
      }),
    ).to.deep.include({
      provider: "zotero-figure",
      itemID: 42,
      kind: "formula",
      pageIndex: 3,
      latex: "E=mc^2",
    });
    expect(normalizeGalleryEntry({ id: "x", documentItemID: 42 })).to.equal(
      undefined,
    );
  });

  it("uses the documented loadLibrary snapshot and filters by document item", async function () {
    let requestedLibrary = 0;
    (globalThis as any).Zotero = {
      ZoteroFigure: {
        api: {
          gallery: {
            loadLibrary: async (libraryID: number) => {
              requestedLibrary = libraryID;
              return {
                entries: [
                  {
                    id: "1:ABCD1234:figure-1",
                    documentItemID: 42,
                    kind: "figure",
                    pageIndex: 0,
                  },
                  {
                    id: "1:ABCD1234:table-1",
                    documentItemID: 99,
                    kind: "table",
                    pageIndex: 1,
                  },
                ],
              };
            },
          },
        },
      },
    };
    expect(hasZoteroFigure()).to.equal(true);
    expect(await galleryEntries(1)).to.have.length(2);
    const records = await listZoteroFigures(
      { id: 42, libraryID: 1 } as Zotero.Item,
      new Set(["figure", "table", "formula"]),
    );
    expect(requestedLibrary).to.equal(1);
    expect(records).to.have.length(1);
    expect(records[0].entryID).to.equal("1:ABCD1234:figure-1");
  });

  it("decodes the Zotero Figure 1.0.1 base64 image response with its MIME type", async function () {
    let written: Uint8Array | undefined;
    let generatedMime = "";
    (globalThis as any).PathUtils = {
      profileDir: "C:\\profile",
      join: (...parts: string[]) => parts.join("/"),
    };
    (globalThis as any).IOUtils = {
      exists: async () => false,
      makeDirectory: async () => undefined,
      write: async (_path: string, bytes: Uint8Array) => {
        written = bytes;
      },
    };
    (globalThis as any).Zotero = {
      ZoteroFigure: {
        api: {
          gallery: {
            readImage: async () => ({
              base64: "AQIDBA==",
              mimeType: "image/webp",
            }),
          },
        },
      },
      File: {
        generateDataURI: (_path: string, mime: string) => {
          generatedMime = mime;
          return `data:${mime};base64,AQIDBA==`;
        },
      },
    };
    const image = await readZoteroFigureImage({
      provider: "zotero-figure",
      id: "zotero-figure:1:A:1",
      entryID: "1:A:1",
      itemID: 42,
      kind: "figure",
      caption: "",
      pageIndex: 0,
    });
    expect([...written!]).to.deep.equal([1, 2, 3, 4]);
    expect(image.path).to.match(/\.webp$/);
    expect(generatedMime).to.equal("image/webp");
    expect(image.dataUrl).to.equal("data:image/webp;base64,AQIDBA==");
  });
});
