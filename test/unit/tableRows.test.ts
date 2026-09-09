import { assert } from "chai";
import {
  buildTableFlatRows,
  TableFlatRowsCache,
} from "../../src/ui/features/table/tableRows";

describe("table row model", function () {
  it("preserves item order when grouping is disabled", function () {
    const items = [{ key: "A" }, { key: "B" }];

    assert.deepEqual(
      buildTableFlatRows(items, "", () => "ignored"),
      [
        { type: "item", item: items[0] },
        { type: "item", item: items[1] },
      ],
    );
  });

  it("creates stable group headers and keeps first-seen group order", function () {
    const items = [
      { key: "A", year: "2024" },
      { key: "B", year: "2023" },
      { key: "C", year: "2024" },
      { key: "D", year: "" },
    ];

    const rows = buildTableFlatRows(items, "year", (item) => item.year);

    assert.deepEqual(rows, [
      { type: "group", label: "2024（2）" },
      { type: "item", item: items[0] },
      { type: "item", item: items[2] },
      { type: "group", label: "2023（1）" },
      { type: "item", item: items[1] },
      { type: "group", label: "未设置（1）" },
      { type: "item", item: items[3] },
    ]);
  });

  it("lets the caller resolve a custom group label", function () {
    const items = [{ key: "A", value: 1 }];

    const rows = buildTableFlatRows(items, "custom", (item, field) =>
      field === "custom" ? `值-${item.value}` : "",
    );

    assert.deepEqual(rows[0], { type: "group", label: "值-1（1）" });
  });

  it("reuses grouping structure but materializes current item references", function () {
    const cache = new TableFlatRowsCache<{ key: string; year: string }>();
    const first = [
      { key: "A", year: "2024" },
      { key: "B", year: "2023" },
    ];
    const second = [
      { key: "A", year: "2024" },
      { key: "B", year: "2023" },
    ];

    const firstRows = cache.get(first, "year", (item) => item.year);
    const secondRows = cache.get(second, "year", (item) => item.year);

    assert.notStrictEqual(firstRows[1], secondRows[1]);
    assert.strictEqual(
      (
        secondRows[1] as {
          type: "item";
          item: (typeof second)[number];
        }
      ).item,
      second[0],
    );
    assert.deepEqual(secondRows, [
      { type: "group", label: "2024（1）" },
      { type: "item", item: second[0] },
      { type: "group", label: "2023（1）" },
      { type: "item", item: second[1] },
    ]);
  });

  it("evicts old row structures at the configured cache limit", function () {
    const cache = new TableFlatRowsCache<{ key: string }>(1);
    const first = [{ key: "A" }];
    const second = [{ key: "B" }];

    cache.get(first, "", () => "");
    cache.get(second, "", () => "");
    const rows = cache.get(first, "", () => "");

    assert.deepEqual(rows, [{ type: "item", item: first[0] }]);
  });
});
