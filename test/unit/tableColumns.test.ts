import { assert } from "chai";
import type { FieldDefinition, ViewLayout } from "../../src/domain/types";
import {
  buildColumnDefinitions,
  buildVisibleColumns,
} from "../../src/ui/features/table/tableColumns";

function field(id: string, name = id, archived = false): FieldDefinition {
  return {
    id,
    name,
    description: "",
    type: "text",
    options: [],
    extraction: {
      enabled: false,
      instruction: "",
      outputLanguage: "中文",
      templateVersion: 1,
    },
    archived,
  };
}

function layout(overrides: Partial<ViewLayout> = {}): ViewLayout {
  return {
    columnOrder: [],
    columnWidths: {},
    rowHeight: 240,
    rowHeights: {},
    cardWidth: 320,
    cardDensity: "comfortable",
    visibleColumnIDs: [],
    columnLabels: {},
    cellColors: {},
    rowColors: {},
    citationStyle: "apa7",
    pinnedColumnIDs: [],
    ...overrides,
  };
}

describe("shared table column model", function () {
  it("filters archived and built-in translated-title fields", function () {
    const columns = buildColumnDefinitions([
      field("translated-title", "中文标题"),
      field("active", "研究结论"),
      field("archived", "旧字段", true),
    ]);

    assert.deepEqual(
      columns.filter((column) => column.field).map((column) => column.id),
      ["active"],
    );
  });

  it("applies order, aliases, basic-info collapsing and pinning", function () {
    const columns = buildVisibleColumns(
      [field("active", "研究结论")],
      layout({
        columnOrder: ["active", "title", "basicInfo", "missing"],
        visibleColumnIDs: ["title", "basicInfo", "active"],
        columnLabels: { active: "结论别名" },
        pinnedColumnIDs: ["active"],
      }),
    );

    assert.deepEqual(
      columns.map((column) => column.id),
      ["active", "title", "basicInfo"],
    );
    assert.equal(columns[0].label, "结论别名");
  });

  it("hides individual metadata columns while basic-info is shown", function () {
    const columns = buildVisibleColumns(
      [],
      layout({
        visibleColumnIDs: ["basicInfo", "creators", "DOI"],
      }),
    );

    assert.include(
      columns.map((column) => column.id),
      "basicInfo",
    );
    assert.notInclude(
      columns.map((column) => column.id),
      "creators",
    );
    assert.notInclude(
      columns.map((column) => column.id),
      "DOI",
    );
  });

  it("keeps an explicitly empty layout hidden without reviving columns", function () {
    const columns = buildVisibleColumns([field("active")], layout());
    assert.isEmpty(columns);
  });
});
