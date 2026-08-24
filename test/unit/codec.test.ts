import { expect } from "chai";
import {
  buildRecordNote,
  buildWorkspaceNote,
  parseRecordNote,
  parseWorkspaceNote,
} from "../../src/core/codec";
import {
  BUILTIN_FIELD_PROMPTS,
  LEGACY_BUILTIN_FIELD_PROMPTS,
  createDefaultLayout,
  createDefaultWorkspace,
} from "../../src/domain/defaults";
import { createEmptyRecord, setManualValue } from "../../src/core/records";

describe("structured Zotero notes", function () {
  it("round-trips a Chinese record without losing HTML-sensitive text", function () {
    const workspace = createDefaultWorkspace();
    const record = setManualValue(
      createEmptyRecord(1, "ABCD1234"),
      "research-question",
      "为什么 A < B，同时 C & D？",
    );
    const parsed = parseRecordNote(buildRecordNote(record, workspace.fields));
    expect(parsed).to.deep.equal(record);
    expect(parsed.fields["research-question"].locked).to.equal(true);
  });

  it("round-trips the workspace schema", function () {
    const workspace = createDefaultWorkspace();
    workspace.views.push({
      id: "view-1",
      name: "阅读队列",
      mode: "table",
      visibleFieldIDs: ["research-question"],
      filterText: "",
      layout: {
        columnOrder: ["title"],
        columnWidths: { title: 400 },
        rowHeight: 48,
        rowHeights: {},
        cardWidth: 300,
        cardDensity: "comfortable",
      },
      createdAt: "2026-07-31T00:00:00Z",
      updatedAt: "2026-07-31T00:00:00Z",
    });
    expect(parseWorkspaceNote(buildWorkspaceNote(workspace))).to.deep.equal(
      workspace,
    );
  });

  it("migrates a legacy card view to the remaining table view", function () {
    const workspace = createDefaultWorkspace();
    workspace.views.push({
      id: "legacy-cards",
      name: "旧卡片收藏",
      mode: "cards",
      visibleFieldIDs: ["research-question"],
      filterText: "",
      layout: createDefaultLayout(),
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z",
    } as any);

    const parsed = parseWorkspaceNote(buildWorkspaceNote(workspace));

    expect(parsed.views[0].mode).to.equal("table");
    expect(parsed.views[0].name).to.equal("旧卡片收藏");
  });

  it("migrates legacy AI fields and drops obsolete provider settings", function () {
    const workspace = createDefaultWorkspace();
    const legacy = {
      ...workspace,
      fields: [
        {
          id: "question",
          name: "研究问题",
          description: "",
          type: "ai",
          options: [],
          ai: {
            enabled: true,
            prompt: "提取研究问题",
            outputLanguage: "中文",
            templateVersion: 3,
          },
        },
      ],
      providerProfiles: [{ id: "obsolete-provider" }],
    };

    const parsed = parseWorkspaceNote(buildWorkspaceNote(legacy as any));
    const question = parsed.fields.find((field) => field.id === "question");
    expect(question?.type).to.equal("longText");
    expect(question?.extraction).to.deep.equal({
      enabled: true,
      instruction: "提取研究问题",
      outputLanguage: "中文",
      templateVersion: 3,
    });
    const translatedTitle = parsed.fields.find(
      (field) => field.id === "translated-title",
    );
    expect(translatedTitle?.extraction.enabled).to.equal(true);
    expect(parsed).not.to.have.property("providerProfiles");
  });

  it("upgrades only untouched schema 10 built-in prompts", function () {
    for (const prompt of Object.values(BUILTIN_FIELD_PROMPTS)) {
      expect(prompt).to.include("未明确");
      expect(prompt).to.include("不得编造");
    }
    const workspace = createDefaultWorkspace();
    const question = workspace.fields.find(
      (field) => field.id === "research-question",
    )!;
    question.description = LEGACY_BUILTIN_FIELD_PROMPTS[question.id];
    question.extraction.instruction = LEGACY_BUILTIN_FIELD_PROMPTS[question.id];
    question.extraction.templateVersion = 1;
    const custom = workspace.fields.find(
      (field) => field.id === "research-significance",
    )!;
    custom.description = "我的自定义说明";
    custom.extraction.instruction = "我的自定义提示词";
    const newerTemplate = workspace.fields.find(
      (field) => field.id === "research-value",
    )!;
    newerTemplate.description = LEGACY_BUILTIN_FIELD_PROMPTS[newerTemplate.id];
    newerTemplate.extraction.instruction =
      LEGACY_BUILTIN_FIELD_PROMPTS[newerTemplate.id];
    newerTemplate.extraction.templateVersion = 3;
    const legacy = { ...workspace, schemaVersion: 10 };

    const parsed = parseWorkspaceNote(buildWorkspaceNote(legacy as any));
    const migrated = parsed.fields.find(
      (field) => field.id === "research-question",
    )!;
    const preserved = parsed.fields.find(
      (field) => field.id === "research-significance",
    )!;
    expect(parsed.schemaVersion).to.equal(13);
    expect(migrated.extraction.instruction).to.equal(
      BUILTIN_FIELD_PROMPTS["research-question"],
    );
    expect(migrated.extraction.templateVersion).to.equal(2);
    expect(preserved.description).to.equal("我的自定义说明");
    expect(preserved.extraction.instruction).to.equal("我的自定义提示词");
    const preservedNewerTemplate = parsed.fields.find(
      (field) => field.id === "research-value",
    )!;
    expect(preservedNewerTemplate.description).to.equal(
      LEGACY_BUILTIN_FIELD_PROMPTS["research-value"],
    );
    expect(preservedNewerTemplate.extraction.templateVersion).to.equal(3);
  });

  it("adds 0.3 view metadata without changing old field values", function () {
    const legacy = {
      ...createDefaultWorkspace(),
      schemaVersion: 1,
      views: [
        {
          id: "builtin-table",
          name: "旧表格",
          mode: "table",
          visibleFieldIDs: ["research-question"],
          filterText: "",
          layout: {
            columnOrder: ["title", "research-question"],
            columnWidths: { title: 410 },
            rowHeight: 48,
            rowHeights: { A: 80 },
            cardWidth: 300,
            cardDensity: "comfortable",
          },
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-01T00:00:00Z",
        },
      ],
    };
    const parsed = parseWorkspaceNote(buildWorkspaceNote(legacy as any));
    expect(parsed.schemaVersion).to.equal(13);
    expect(parsed.views[0].layout.rowHeight).to.equal(270);
    expect(parsed.views[0].layout.columnWidths.title).to.equal(410);
    expect(parsed.views[0].layout.rowHeights.A).to.equal(80);
    expect(parsed.views[0].layout.visibleColumnIDs).to.include("pdfPreview");
    expect(parsed.views[0].layout.columnLabels).to.deep.equal({});
    expect(parsed.views[0].layout.cellColors).to.deep.equal({});
  });

  it("adds the 0.4 figure gallery to an existing 0.3 view", function () {
    const workspace = createDefaultWorkspace();
    const payload = {
      ...workspace,
      schemaVersion: 2,
      views: [
        {
          id: "builtin-table",
          name: "0.3 表格",
          mode: "table",
          visibleFieldIDs: [],
          visibleColumnIDs: ["pdfPreview", "title", "basicInfo"],
          filterText: "",
          layout: {
            columnOrder: ["pdfPreview", "title", "basicInfo"],
            columnWidths: { pdfPreview: 112, title: 320, basicInfo: 230 },
            rowHeight: 120,
            rowHeights: {},
            cardWidth: 300,
            cardDensity: "comfortable",
            visibleColumnIDs: ["pdfPreview", "title", "basicInfo"],
            columnLabels: {},
            cellColors: {},
            rowColors: {},
            pinnedColumnIDs: ["pdfPreview"],
          },
          createdAt: "2026-08-01T00:00:00Z",
          updatedAt: "2026-08-01T00:00:00Z",
        },
      ],
    };
    const parsed = parseWorkspaceNote(buildWorkspaceNote(payload as any));
    expect(parsed.views[0].layout.columnOrder).to.include("figureGallery");
    expect(parsed.views[0].layout.visibleColumnIDs).to.include("figureGallery");
    expect(parsed.views[0].visibleColumnIDs).to.include("figureGallery");
  });

  it("upgrades the default row height and removes metadata duplicated by basic info", function () {
    const workspace = createDefaultWorkspace();
    const payload = {
      ...workspace,
      schemaVersion: 3,
      views: [
        {
          id: "builtin-table",
          name: "旧版默认表格",
          mode: "table",
          visibleFieldIDs: [],
          visibleColumnIDs: ["title", "basicInfo", "creators", "year", "date"],
          filterText: "",
          layout: {
            ...workspace.views[0]?.layout,
            columnOrder: ["title", "basicInfo", "creators", "year", "date"],
            columnWidths: {},
            rowHeight: 120,
            rowHeights: { CUSTOM: 210 },
            cardWidth: 300,
            cardDensity: "comfortable",
            visibleColumnIDs: [
              "title",
              "basicInfo",
              "creators",
              "year",
              "date",
            ],
            columnLabels: {},
            cellColors: {},
            rowColors: {},
            pinnedColumnIDs: [],
          },
          createdAt: "2026-08-03T00:00:00Z",
          updatedAt: "2026-08-03T00:00:00Z",
        },
      ],
    };
    const parsed = parseWorkspaceNote(buildWorkspaceNote(payload as any));
    expect(parsed.schemaVersion).to.equal(13);
    expect(parsed.views[0].layout.rowHeight).to.equal(270);
    expect(parsed.views[0].layout.rowHeights.CUSTOM).to.equal(210);
    expect(parsed.views[0].layout.visibleColumnIDs).not.to.include("creators");
    expect(parsed.views[0].layout.visibleColumnIDs).not.to.include("year");
    expect(parsed.views[0].layout.visibleColumnIDs).not.to.include("date");
    expect(parsed.views[0].layout.visibleColumnIDs).not.to.include("DOI");
  });

  it("adds citation style and removes the old automatically pinned PDF column", function () {
    const workspace = createDefaultWorkspace();
    const payload = {
      ...workspace,
      schemaVersion: 4,
      views: [
        {
          id: "builtin-table",
          name: "旧学术表格",
          mode: "table",
          visibleFieldIDs: ["research-question"],
          visibleColumnIDs: ["pdfPreview", "title", "basicInfo"],
          filterText: "",
          layout: {
            ...workspace.views[0]?.layout,
            columnOrder: ["pdfPreview", "title", "basicInfo"],
            columnWidths: {},
            rowHeight: 160,
            rowHeights: {},
            cardWidth: 300,
            cardDensity: "comfortable",
            visibleColumnIDs: ["pdfPreview", "title", "basicInfo"],
            columnLabels: {},
            cellColors: {},
            rowColors: {},
            pinnedColumnIDs: ["pdfPreview"],
          },
          createdAt: "2026-08-03T00:00:00Z",
          updatedAt: "2026-08-03T00:00:00Z",
        },
      ],
    };
    const parsed = parseWorkspaceNote(buildWorkspaceNote(payload as any));
    expect(parsed.views[0].layout.rowHeight).to.equal(270);
    expect(parsed.views[0].layout.pinnedColumnIDs).to.deep.equal([]);
    expect(parsed.views[0].layout.citationStyle).to.equal("zotero");
  });

  it("upgrades only the schema 5 built-in table default height", function () {
    const workspace = createDefaultWorkspace();
    const baseView = {
      name: "表格",
      mode: "table" as const,
      visibleFieldIDs: [],
      visibleColumnIDs: ["title", "basicInfo"],
      filterText: "",
      layout: {
        ...workspace.views[0]?.layout,
        columnOrder: ["title", "basicInfo"],
        columnWidths: {},
        rowHeight: 260,
        rowHeights: { PAPER1: 410 },
        cardWidth: 300,
        cardDensity: "comfortable" as const,
        visibleColumnIDs: ["title", "basicInfo"],
        columnLabels: {},
        cellColors: {},
        rowColors: {},
        pinnedColumnIDs: [],
      },
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z",
    };
    const payload = {
      ...workspace,
      schemaVersion: 5,
      views: [
        { ...baseView, id: "builtin-table" },
        { ...baseView, id: "saved-user-view", name: "我的紧凑视图" },
      ],
    };

    const parsed = parseWorkspaceNote(buildWorkspaceNote(payload as any));
    expect(parsed.schemaVersion).to.equal(13);
    expect(parsed.views[0].layout.rowHeight).to.equal(270);
    expect(parsed.views[0].layout.rowHeights.PAPER1).to.equal(410);
    expect(parsed.views[1].layout.rowHeight).to.equal(260);
  });

  it("upgrades schema 6 built-in 48px rows without changing saved compact views", function () {
    const workspace = createDefaultWorkspace();
    const compactLayout = {
      ...createDefaultLayout(),
      rowHeight: 48,
      rowHeights: { CUSTOM_PAPER: 196 },
    };
    const commonView = {
      name: "紧凑表格",
      mode: "table" as const,
      visibleFieldIDs: [],
      visibleColumnIDs: compactLayout.visibleColumnIDs,
      filterText: "",
      layout: compactLayout,
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z",
    };
    const payload = {
      ...workspace,
      schemaVersion: 6,
      views: [
        { ...commonView, id: "builtin-table", name: "默认表格" },
        { ...commonView, id: "saved-compact", name: "我的紧凑视图" },
      ],
    };

    const parsed = parseWorkspaceNote(buildWorkspaceNote(payload as any));
    expect(parsed.schemaVersion).to.equal(13);
    expect(parsed.views[0].layout.rowHeight).to.equal(270);
    expect(parsed.views[0].layout.rowHeights.CUSTOM_PAPER).to.equal(196);
    expect(parsed.views[1].layout.rowHeight).to.equal(48);
    expect(parsed.views[1].layout.rowHeights.CUSTOM_PAPER).to.equal(196);
  });

  it("tightens only the schema 7 built-in default row height", function () {
    const workspace = createDefaultWorkspace();
    const previousDefaultLayout = {
      ...createDefaultLayout(),
      rowHeight: 320,
      rowHeights: { CUSTOM_PAPER: 212 },
    };
    const commonView = {
      name: "表格",
      mode: "table" as const,
      visibleFieldIDs: [],
      visibleColumnIDs: previousDefaultLayout.visibleColumnIDs,
      filterText: "",
      layout: previousDefaultLayout,
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z",
    };
    const payload = {
      ...workspace,
      schemaVersion: 7,
      views: [
        { ...commonView, id: "builtin-table", name: "默认表格" },
        { ...commonView, id: "saved-reading-view", name: "我的阅读视图" },
      ],
    };

    const parsed = parseWorkspaceNote(buildWorkspaceNote(payload as any));
    expect(parsed.schemaVersion).to.equal(13);
    expect(parsed.views[0].layout.rowHeight).to.equal(270);
    expect(parsed.views[0].layout.rowHeights.CUSTOM_PAPER).to.equal(212);
    expect(parsed.views[1].layout.rowHeight).to.equal(320);
    expect(parsed.views[1].layout.rowHeights.CUSTOM_PAPER).to.equal(212);
  });

  it("widens only the schema 8 built-in 240px row height", function () {
    const workspace = createDefaultWorkspace();
    const previousDefaultLayout = {
      ...createDefaultLayout(),
      rowHeight: 240,
      rowHeights: { CUSTOM_PAPER: 226 },
    };
    const commonView = {
      name: "表格",
      mode: "table" as const,
      visibleFieldIDs: [],
      visibleColumnIDs: previousDefaultLayout.visibleColumnIDs,
      filterText: "",
      layout: previousDefaultLayout,
      createdAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:00Z",
    };
    const payload = {
      ...workspace,
      schemaVersion: 8,
      views: [
        { ...commonView, id: "builtin-table", name: "默认表格" },
        { ...commonView, id: "saved-240-view", name: "我的 240px 视图" },
      ],
    };

    const parsed = parseWorkspaceNote(buildWorkspaceNote(payload as any));
    expect(parsed.schemaVersion).to.equal(13);
    expect(parsed.views[0].layout.rowHeight).to.equal(270);
    expect(parsed.views[0].layout.rowHeights.CUSTOM_PAPER).to.equal(226);
    expect(parsed.views[1].layout.rowHeight).to.equal(240);
    expect(parsed.views[1].layout.rowHeights.CUSTOM_PAPER).to.equal(226);
  });

  it("widens only the schema 9 built-in default figure gallery", function () {
    const workspace = createDefaultWorkspace();
    const layout = {
      ...createDefaultLayout(),
      columnWidths: {
        ...createDefaultLayout().columnWidths,
        figureGallery: 280,
      },
    };
    const view = {
      name: "表格",
      mode: "table" as const,
      visibleFieldIDs: [],
      visibleColumnIDs: layout.visibleColumnIDs,
      filterText: "",
      layout,
      createdAt: "2026-08-04T00:00:00Z",
      updatedAt: "2026-08-04T00:00:00Z",
    };
    const parsed = parseWorkspaceNote(
      buildWorkspaceNote({
        ...workspace,
        schemaVersion: 9,
        views: [
          { ...view, id: "builtin-table" },
          { ...view, id: "saved-gallery", name: "我的窄图表列" },
        ],
      } as any),
    );

    expect(parsed.schemaVersion).to.equal(13);
    expect(parsed.views[0].layout.columnWidths.figureGallery).to.equal(440);
    expect(parsed.views[1].layout.columnWidths.figureGallery).to.equal(280);
  });

  it("widens only the untouched schema 11 built-in PDF preview", function () {
    const workspace = createDefaultWorkspace();
    const layout = {
      ...createDefaultLayout(),
      columnWidths: {
        ...createDefaultLayout().columnWidths,
        pdfPreview: 126,
      },
    };
    const view = {
      name: "表格",
      mode: "table" as const,
      visibleFieldIDs: [],
      visibleColumnIDs: layout.visibleColumnIDs,
      filterText: "",
      layout,
      createdAt: "2026-08-16T00:00:00Z",
      updatedAt: "2026-08-16T00:00:00Z",
    };
    const parsed = parseWorkspaceNote(
      buildWorkspaceNote({
        ...workspace,
        schemaVersion: 11,
        views: [
          { ...view, id: "builtin-table" },
          { ...view, id: "saved-narrow-preview", name: "我的窄预览" },
        ],
      } as any),
    );

    expect(parsed.schemaVersion).to.equal(13);
    expect(parsed.views[0].layout.columnWidths.pdfPreview).to.equal(162);
    expect(parsed.views[1].layout.columnWidths.pdfPreview).to.equal(126);
  });

  it("keeps per-view figure kinds and makes the default gallery visible", function () {
    const workspace = createDefaultWorkspace();
    const layout = {
      ...createDefaultLayout(),
      figureKinds: ["table"] as const,
    };
    const parsed = parseWorkspaceNote(
      buildWorkspaceNote({
        ...workspace,
        schemaVersion: 12,
        views: [
          {
            id: "saved-figure-kinds",
            name: "仅表格",
            mode: "table",
            visibleFieldIDs: [],
            visibleColumnIDs: layout.visibleColumnIDs,
            figureKinds: ["table"],
            filterText: "",
            layout,
            createdAt: "2026-08-20T00:00:00Z",
            updatedAt: "2026-08-20T00:00:00Z",
          },
        ],
      } as any),
    );
    expect(createDefaultLayout().visibleColumnIDs).to.include("figureGallery");
    expect(parsed.schemaVersion).to.equal(13);
    expect(parsed.views[0].figureKinds).to.deep.equal(["table"]);
    expect(parsed.views[0].layout.figureKinds).to.deep.equal(["table"]);
  });
});
