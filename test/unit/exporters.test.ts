import { expect } from "chai";
import {
  snapshotToCSV,
  snapshotToHTML,
  snapshotToMarkdown,
} from "../../src/core/exporters";
import { createDefaultFields } from "../../src/domain/defaults";
import type { ComparisonSnapshot } from "../../src/domain/types";

describe("comparison exports", function () {
  const snapshot: ComparisonSnapshot = {
    id: "snapshot-1",
    name: "两篇论文比较",
    fieldIDs: ["research-question"],
    rows: [
      {
        itemKey: "A",
        title: "标题，含“逗号”",
        creators: "张三",
        year: "2026",
        values: { "research-question": "问题 A | 问题 B" },
      },
    ],
    synthesis: "存在明显差异。",
    createdAt: "2026-07-31T00:00:00Z",
    exportAttachmentIDs: [],
  };

  it("exports valid CSV quoting", function () {
    const csv = snapshotToCSV(snapshot, createDefaultFields());
    expect(csv).to.include('"标题，含“逗号”"');
    expect(csv).to.include('"问题 A | 问题 B"');
  });

  it("escapes Markdown pipes and HTML", function () {
    expect(snapshotToMarkdown(snapshot, createDefaultFields())).to.include(
      "问题 A \\| 问题 B",
    );
    const html = snapshotToHTML(snapshot, createDefaultFields());
    expect(html).to.include('<meta charset="utf-8">');
    expect(html).to.include("存在明显差异");
  });
});
