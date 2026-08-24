import { expect } from "chai";
import { resolvePrimaryPdf } from "../../src/services/primaryPdf";

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
});
