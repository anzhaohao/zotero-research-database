import { expect } from "chai";
import {
  edgeAutoScrollDirection,
  getSharedVisibleColumnIDs,
  partitionPinnedIDs,
  pinnedLeftOffset,
  reorderColumnLayout,
  reorderColumnIDs,
  syncSharedVisibleColumnIDs,
  togglePinnedColumnIDs,
} from "../../src/core/viewLayout";
import { createDefaultLayout } from "../../src/domain/defaults";
import type { SavedView } from "../../src/domain/types";

function view(id: string, visibleColumnIDs: string[]): SavedView {
  return {
    id,
    name: id,
    mode: "table",
    filterText: "",
    layout: { ...createDefaultLayout(), visibleColumnIDs },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("shared table column layout", function () {
  it("reads global visibility from the built-in table before other views", function () {
    const views = [
      view("saved-first", ["title"]),
      view("builtin-table", ["basicInfo"]),
    ];
    expect(getSharedVisibleColumnIDs(views, ["pdfPreview"])).to.deep.equal([
      "basicInfo",
    ]);
    expect(getSharedVisibleColumnIDs([views[0]], ["pdfPreview"])).to.deep.equal(
      ["title"],
    );
    expect(getSharedVisibleColumnIDs([], ["pdfPreview"])).to.deep.equal([
      "pdfPreview",
    ]);
  });

  it("synchronizes visibility to every view without changing other layout state", function () {
    const views = [
      view("builtin-table", ["title"]),
      view("saved", ["pdfPreview"]),
    ];
    views[1].layout.columnWidths.title = 511;
    const synced = syncSharedVisibleColumnIDs(views, [
      "title",
      "research-question",
    ]);

    expect(synced.map((entry) => entry.layout.visibleColumnIDs)).to.deep.equal([
      ["title", "research-question"],
      ["title", "research-question"],
    ]);
    expect(synced[1].layout.columnWidths.title).to.equal(511);
    expect(views[0].layout.visibleColumnIDs).to.deep.equal(["title"]);
    synced[0].layout.visibleColumnIDs.push("basicInfo");
    expect(synced[1].layout.visibleColumnIDs).not.to.include("basicInfo");
  });

  it("keeps multiple pins in the shared column order with cumulative offsets", function () {
    const order = ["pdfPreview", "title", "basicInfo", "research-value"];
    let pinned = togglePinnedColumnIDs(order, [], "basicInfo");
    pinned = togglePinnedColumnIDs(order, pinned, "title");

    expect(pinned).to.deep.equal(["title", "basicInfo"]);
    expect(partitionPinnedIDs(order, pinned)).to.deep.equal([
      "title",
      "basicInfo",
      "pdfPreview",
      "research-value",
    ]);
    expect(
      pinnedLeftOffset("basicInfo", partitionPinnedIDs(order, pinned), pinned, {
        title: 338,
        basicInfo: 374,
      }),
    ).to.equal(338);
  });

  it("uses one reorder result while pinned and preserves it after unpinning", function () {
    const original = ["pdfPreview", "title", "basicInfo", "research-value"];
    const reordered = reorderColumnIDs(original, "basicInfo", "title", false);
    const pinned = togglePinnedColumnIDs(
      reordered,
      togglePinnedColumnIDs(reordered, [], "basicInfo"),
      "title",
    );

    expect(reordered).to.deep.equal([
      "pdfPreview",
      "basicInfo",
      "title",
      "research-value",
    ]);
    expect(partitionPinnedIDs(reordered, pinned).slice(0, 2)).to.deep.equal([
      "basicInfo",
      "title",
    ]);
    expect(togglePinnedColumnIDs(reordered, pinned, "")).to.deep.equal([]);
    expect(partitionPinnedIDs(reordered, [])).to.deep.equal(reordered);
  });

  it("syncs pin state when a column crosses the pinned boundary", function () {
    expect(
      reorderColumnLayout(
        ["title", "basicInfo", "year"],
        ["title"],
        "title",
        "year",
        false,
        false,
      ),
    ).to.deep.equal({
      columnOrder: ["basicInfo", "title", "year"],
      pinnedColumnIDs: [],
    });
    expect(
      reorderColumnLayout(
        ["title", "basicInfo", "year"],
        [],
        "year",
        "title",
        false,
        true,
      ).pinnedColumnIDs,
    ).to.deep.equal(["year"]);
  });

  it("keeps edge auto-scroll constrained to the horizontal gutters", function () {
    expect(edgeAutoScrollDirection(100, 100, 900)).to.equal(-1);
    expect(edgeAutoScrollDirection(147, 100, 900)).to.equal(-1);
    expect(edgeAutoScrollDirection(148, 100, 900)).to.equal(-1);
    expect(edgeAutoScrollDirection(851, 100, 900)).to.equal(0);
    expect(edgeAutoScrollDirection(852, 100, 900)).to.equal(1);
    expect(edgeAutoScrollDirection(900, 100, 900)).to.equal(1);
  });
});
