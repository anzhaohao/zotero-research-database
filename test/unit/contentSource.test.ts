import { expect } from "chai";
import {
  resolveSourceText,
  type ContentSourceRepository,
} from "../../src/services/contentSource";

describe("paper content source", function () {
  async function resolveWithCache(
    cacheReads: string[],
    completeness = [true, true],
  ) {
    const previousZotero = (globalThis as any).Zotero;
    const pdf = {
      id: 2,
      key: "PDF00002",
      attachmentFilename: "paper.pdf",
      isAttachment: () => true,
      isPDFAttachment: () => true,
      getField: () => "paper.pdf",
      getFilePathAsync: async () => "C:\\papers\\paper.pdf",
    } as unknown as Zotero.Item;
    const item = {
      key: "ITEM0001",
      getAttachments: () => [2],
      getBestAttachment: async () => pdf,
    } as unknown as Zotero.Item;
    const repository = {
      loadArtifacts: async () => [],
      loadPrimaryPdfKey: async () => undefined,
      savePrimaryPdfKey: async () => undefined,
    } as ContentSourceRepository;
    let indexCalls = 0;
    (globalThis as any).Zotero = {
      Items: { getAsync: async () => [pdf] },
      Fulltext: {
        getItemCacheFile: () => ({ path: "C:\\cache\\paper.txt" }),
        isFullyIndexed: async () => completeness.shift() ?? false,
        indexItems: async () => {
          indexCalls += 1;
        },
      },
      File: {
        getContentsAsync: async () => cacheReads.shift() || "",
      },
      logError: () => undefined,
    };
    try {
      const source = await resolveSourceText(item, repository);
      return { source, indexCalls };
    } finally {
      (globalThis as any).Zotero = previousZotero;
    }
  }

  it("reuses an existing full-text cache without reindexing", async function () {
    const { source, indexCalls } = await resolveWithCache([
      "cached paper text",
    ]);

    expect(indexCalls).to.equal(0);
    expect(source.text).to.equal("cached paper text");
    expect(source.type).to.equal("pdf-fulltext");
    expect(source.pdfPath).to.equal("C:\\papers\\paper.pdf");
  });

  it("indexes only when no readable cache exists", async function () {
    const { source, indexCalls } = await resolveWithCache([
      "",
      "indexed paper text",
    ]);

    expect(indexCalls).to.equal(1);
    expect(source.text).to.equal("indexed paper text");
  });

  it("completes a partial index before using cached text", async function () {
    const { source, indexCalls } = await resolveWithCache(
      ["first page only", "entire paper"],
      [false, true],
    );
    expect(indexCalls).to.equal(1);
    expect(source.text).to.equal("entire paper");
  });

  it("never returns a partial cache as full text when reindexing stays incomplete", async function () {
    const { source, indexCalls } = await resolveWithCache(
      ["first page only", "still first page only"],
      [false, false],
    );
    expect(indexCalls).to.equal(1);
    expect(source.text).to.equal("");
    expect(source.pdfPath).to.equal("C:\\papers\\paper.pdf");
  });
});
