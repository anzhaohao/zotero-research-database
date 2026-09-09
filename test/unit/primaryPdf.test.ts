import { expect } from "chai";
import {
  resolvePrimaryPdf,
  setPrimaryPdf,
} from "../../src/services/primaryPdf";

function attachment(key: string, title: string): Zotero.Item {
  return {
    id: Number(key.slice(-1)),
    key,
    isAttachment: () => true,
    isPDFAttachment: () => true,
    getField: (field: string) => (field === "title" ? title : ""),
  } as unknown as Zotero.Item;
}

describe("primary PDF selection", function () {
  it("prefers an explicit key and otherwise a child titled PDF", async function () {
    const first = attachment("PDF00001", "Supplement");
    const named = attachment("PDF00002", "PDF");
    const explicitItem = {
      libraryID: 1,
      key: "ITEM0001",
      isRegularItem: () => true,
      getField: () => "",
    } as unknown as Zotero.Item;
    const automaticItem = {
      libraryID: 1,
      key: "ITEM0002",
      isRegularItem: () => true,
      getField: () => "",
      getNotes: () => [],
      getBestAttachment: async () => first,
    } as unknown as Zotero.Item;
    const previous = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
      Libraries: { userLibraryID: 1 },
      SyncedSettings: {
        get: (_libraryID: number, setting: string) =>
          setting.includes("ITEM0001")
            ? {
                schemaVersion: 1,
                libraryID: 1,
                itemKey: "ITEM0001",
                figures: [],
                artifacts: [],
                primaryPdfAttachmentKey: "PDF00001",
                updatedAt: new Date().toISOString(),
              }
            : null,
        set: async () => undefined,
        clear: async () => undefined,
      },
      Items: { getAsync: async () => [] },
    };
    try {
      expect(
        (await resolvePrimaryPdf(explicitItem, [first, named]))?.attachment,
      ).to.equal(first);
      const automatic = await resolvePrimaryPdf(automaticItem, [first, named]);
      expect(automatic?.attachment).to.equal(named);
      expect(automatic?.source).to.equal("named-pdf");
    } finally {
      (globalThis as any).Zotero = previous;
    }
  });

  it("uses an injected repository without sharing module state", async function () {
    const first = attachment("PDF00001", "Supplement");
    const named = attachment("PDF00002", "Main");
    const item = {
      libraryID: 1,
      key: "ITEM0003",
      isRegularItem: () => true,
      getField: () => "",
      getAttachments: () => [],
    } as unknown as Zotero.Item;
    const saved: Array<string | undefined> = [];
    const repository = {
      loadPrimaryPdfKey: async () => named.key,
      savePrimaryPdfKey: async (
        _item: Zotero.Item,
        key?: string,
      ): Promise<void> => {
        saved.push(key);
      },
    };
    const previous = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
      Items: { getAsync: async () => [first, named] },
    };

    try {
      const resolved = await resolvePrimaryPdf(
        item,
        [first, named],
        repository,
      );
      expect(resolved?.attachment).to.equal(named);
      expect(resolved?.source).to.equal("explicit");

      await setPrimaryPdf(item, first.key, repository);
      await setPrimaryPdf(item, undefined, repository);
      expect(saved).to.deep.equal([first.key, undefined]);

      try {
        await setPrimaryPdf(item, "PDF99999", repository);
        throw new Error("expected invalid attachment key to be rejected");
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal("所选附件不是该条目下的 PDF");
      }
    } finally {
      (globalThis as any).Zotero = previous;
    }
  });

  it("falls back from best attachment to the first PDF", async function () {
    const first = attachment("PDF00003", "Supplement");
    const second = attachment("PDF00004", "Appendix");
    const repository = {
      loadPrimaryPdfKey: async () => undefined,
      savePrimaryPdfKey: async () => undefined,
    };
    const bestItem = {
      key: "ITEM0004",
      getBestAttachment: async () => second,
    } as unknown as Zotero.Item;
    const best = await resolvePrimaryPdf(bestItem, [first, second], repository);
    expect(best?.attachment).to.equal(second);
    expect(best?.source).to.equal("best-attachment");

    const firstOnlyItem = { key: "ITEM0005" } as unknown as Zotero.Item;
    const firstOnly = await resolvePrimaryPdf(
      firstOnlyItem,
      [first, second],
      repository,
    );
    expect(firstOnly?.attachment).to.equal(first);
    expect(firstOnly?.source).to.equal("first-pdf");
  });
});
