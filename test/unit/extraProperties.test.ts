import { expect } from "chai";
import {
  parseArtifactExtra,
  parseFigureExtra,
  parsePrimaryPdfExtra,
  parseRecordExtra,
  parseWorkspaceExtra,
  hasManagedItemExtra,
  hasManagedWorkspaceExtra,
  stripManagedItemExtra,
  stripManagedWorkspaceExtra,
  writeRecordExtra,
  writeArtifactExtra,
  writeFigureExtra,
  writePrimaryPdfExtra,
  writeWorkspaceExtra,
} from "../../src/core/extraProperties";
import { createEmptyRecord, setManualValue } from "../../src/core/records";
import { createDefaultWorkspace } from "../../src/domain/defaults";

describe("Extra property storage", function () {
  it("preserves unrelated Extra metadata while round-tripping typed values", function () {
    const base = "Citation Key: smith2026\ntex.some-field: keep\nfree text";
    const record = setManualValue(
      createEmptyRecord(1, "ABCD1234"),
      "research-question",
      "第一行\n第二行",
    );
    const extra = writeRecordExtra(base, record);
    expect(extra).to.include("Citation Key: smith2026");
    expect(extra).to.include("tex.some-field: keep");
    expect(extra).to.include("free text");
    expect(parseRecordExtra(extra)).to.deep.equal(record);
  });

  it("updates only its own namespaced lines", function () {
    const first = setManualValue(
      createEmptyRecord(1, "ABCD1234"),
      "question",
      "旧值",
    );
    const second = setManualValue(first, "question", "新值");
    const extra = writeRecordExtra(
      writeRecordExtra("Custom: untouched", first),
      second,
    );
    expect(extra.match(/^ZRDB\.Record:/gm)).to.have.length(1);
    expect(extra.match(/^ZRDB\.Property\.question:/gm)).to.have.length(1);
    expect(extra).to.include("Custom: untouched");
    expect(parseRecordExtra(extra)).to.deep.equal(second);
  });

  it("refuses to overwrite malformed managed data", function () {
    expect(() =>
      writeRecordExtra(
        "ZRDB.Record: not-json",
        createEmptyRecord(1, "ABCD1234"),
      ),
    ).to.throw("不是有效 JSON");
  });

  it("stores workspace state in the system item's Extra", function () {
    const state = createDefaultWorkspace();
    const extra = writeWorkspaceExtra("Existing: keep", state);
    expect(extra).to.include("ZRDB Workspace: 1");
    expect(extra).to.include("Existing: keep");
    expect(parseWorkspaceExtra(extra)).to.deep.equal(state);
  });

  it("round-trips a figure manifest without touching research properties", function () {
    const base = 'ZRDB.Property.question: {"value":"保留"}\nCitation Key: keep';
    const figures = [
      {
        id: "fig-1",
        parentItemKey: "ABCD1234",
        attachmentKey: "IMAGE001",
        sourcePdfAttachmentKey: "PDF00001",
        kind: "figure" as const,
        caption: "实验装置图",
        pageIndex: 2,
        rect: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
        sha256: "a".repeat(64),
      },
    ];
    const extra = writeFigureExtra(base, figures);
    expect(extra).to.include("ZRDB.Property.question");
    expect(extra).to.include("Citation Key: keep");
    expect(parseFigureExtra(extra)).to.deep.equal(figures);
  });

  it("stores attachment role and hashes without creating Zotero tags", function () {
    const artifacts = [
      {
        attachmentKey: "IMAGE001",
        role: "figure" as const,
        sha256: "b".repeat(64),
        runID: "mineru-run-1",
        figureID: "fig-1",
      },
      {
        attachmentKey: "MARKDN01",
        role: "mineru-original" as const,
        sha256: "c".repeat(64),
      },
    ];
    const extra = writeArtifactExtra("Citation Key: keep", artifacts);
    expect(extra).to.include("ZRDB.Artifacts:");
    expect(extra).to.include("Citation Key: keep");
    expect(extra).not.to.include("#ZRDB/");
    const parsed = parseArtifactExtra(extra);
    expect(parsed).to.have.length(2);
    expect(parsed[0]).to.deep.include(artifacts[0]);
    expect(parsed[1]).to.deep.include(artifacts[1]);
  });

  it("stores one primary PDF key without touching unrelated Extra data", function () {
    const first = writePrimaryPdfExtra(
      "Citation Key: keep\nCustom: untouched",
      "PDF00001",
    );
    expect(parsePrimaryPdfExtra(first)).to.equal("PDF00001");
    expect(first).to.include("Citation Key: keep");
    expect(first).to.include("Custom: untouched");

    const replaced = writePrimaryPdfExtra(first, "PDF00002");
    expect(parsePrimaryPdfExtra(replaced)).to.equal("PDF00002");
    expect(replaced.match(/^ZRDB\.PrimaryPDF:/gm)).to.have.length(1);

    const cleared = writePrimaryPdfExtra(replaced);
    expect(parsePrimaryPdfExtra(cleared)).to.equal(undefined);
    expect(cleared).to.include("Citation Key: keep");
  });

  it("removes only legacy ZRDB item lines during migration", function () {
    const extra = [
      "Citation Key: keep-me",
      'ZRDB.Record: {"schemaVersion":1}',
      'ZRDB.Property.question: {"value":"legacy"}',
      'ZRDB.Figures: {"schemaVersion":1,"figures":[]}',
      'ZRDB.Artifacts: {"schemaVersion":1,"artifacts":[]}',
      "ZRDB.PrimaryPDF: PDF00001",
      "JCR: Q1",
      "用户自由文本",
    ].join("\r\n");
    expect(hasManagedItemExtra(extra)).to.equal(true);
    const cleaned = stripManagedItemExtra(extra);
    expect(hasManagedItemExtra(cleaned)).to.equal(false);
    expect(cleaned).to.equal(
      ["Citation Key: keep-me", "JCR: Q1", "用户自由文本"].join("\r\n"),
    );
  });

  it("removes only the old workspace payload and marker", function () {
    const extra = [
      "Custom: keep",
      "ZRDB Workspace: 1",
      'ZRDB.Workspace: {"schemaVersion":10}',
      "Another: keep-too",
    ].join("\n");
    expect(hasManagedWorkspaceExtra(extra)).to.equal(true);
    const cleaned = stripManagedWorkspaceExtra(extra);
    expect(hasManagedWorkspaceExtra(cleaned)).to.equal(false);
    expect(cleaned).to.equal("Custom: keep\nAnother: keep-too");
  });
});
