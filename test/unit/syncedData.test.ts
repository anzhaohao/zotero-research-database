import { expect } from "chai";
import { createEmptyRecord, setManualValue } from "../../src/core/records";
import {
  createItemInternalState,
  parseItemInternalState,
} from "../../src/storage/syncedData";

describe("Zotero synced internal data", function () {
  it("round-trips one item record, figures, artifacts and primary PDF", function () {
    const record = setManualValue(
      createEmptyRecord(1, "ABCD1234"),
      "research-question",
      "怎样保持 Extra 干净？",
    );
    const parsed = parseItemInternalState({
      ...createItemInternalState(1, "ABCD1234"),
      record,
      primaryPdfAttachmentKey: "pdf00001",
      figures: [
        {
          id: "fig-1",
          parentItemKey: "ABCD1234",
          attachmentKey: "image001",
          kind: "figure",
          caption: "结构图",
          pageIndex: 0,
          sha256: "a".repeat(64),
        },
      ],
      artifacts: [
        {
          attachmentKey: "image001",
          role: "figure",
          sha256: "a".repeat(64),
          figureID: "fig-1",
        },
      ],
    });
    expect(parsed.record).to.deep.equal(record);
    expect(parsed.primaryPdfAttachmentKey).to.equal("PDF00001");
    expect(parsed.figures[0].attachmentKey).to.equal("IMAGE001");
    expect(parsed.artifacts[0].sha256).to.equal("a".repeat(64));
  });

  it("rejects malformed synced data before it can replace legacy Extra", function () {
    expect(() =>
      parseItemInternalState({
        schemaVersion: 1,
        libraryID: 1,
        itemKey: "ABCD1234",
        figures: [],
        artifacts: [{ attachmentKey: "bad", role: "figure" }],
        updatedAt: new Date().toISOString(),
      }),
    ).to.throw("附件产物记录格式无效");
  });
});
