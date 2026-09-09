import { expect } from "chai";
import { figureDataSignature } from "../../src/ui/features/figures/figureRecords";

describe("figure data reconciliation signatures", function () {
  it("changes when an artifact display field changes", function () {
    const figure = {
      id: "figure-1",
      parentItemKey: "ITEM0001",
      attachmentKey: "IMAGE0001",
      sourcePdfAttachmentKey: "PDF0001",
      kind: "figure" as const,
      caption: "旧图注",
      pageIndex: 1,
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      sha256: "a".repeat(64),
    };

    expect(figureDataSignature({ ...figure, caption: "新图注" })).to.not.equal(
      figureDataSignature(figure),
    );
    expect(
      figureDataSignature({
        ...figure,
        rect: { ...figure.rect, width: 0.5 },
      }),
    ).to.not.equal(figureDataSignature(figure));
  });

  it("changes when a Zotero Figure image revision changes", function () {
    const figure = {
      provider: "zotero-figure" as const,
      id: "zotero-figure:1:ITEM0001:figure-1",
      entryID: "1:ITEM0001:figure-1",
      itemID: 42,
      kind: "figure" as const,
      caption: "",
      pageIndex: 0,
      cacheRevision: 1,
      imageRef: "image-1",
    };

    expect(figureDataSignature({ ...figure, cacheRevision: 2 })).to.not.equal(
      figureDataSignature(figure),
    );
    expect(
      figureDataSignature({ ...figure, imageRef: "image-2" }),
    ).to.not.equal(figureDataSignature(figure));
  });
});
