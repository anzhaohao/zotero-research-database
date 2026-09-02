import { expect } from "chai";
import {
  isLibraryTabType,
  itemNotificationTouchesView,
  selectedTabType,
  type RefreshPolicyItem,
} from "../../src/ui/refreshPolicy";

interface TestItem extends RefreshPolicyItem {
  kind: "regular" | "attachment" | "annotation" | "note" | "workspace";
}

function item(id: number, kind: TestItem["kind"]): TestItem {
  return {
    id,
    kind,
    isRegularItem: () => kind === "regular" || kind === "workspace",
  };
}

const current = item(1, "regular");
const outside = item(2, "regular");
const attachment = item(3, "attachment");
const annotation = item(4, "annotation");
const note = item(5, "note");
const workspace = item(6, "workspace");
const items = new Map(
  [current, outside, attachment, annotation, note, workspace].map((value) => [
    value.id,
    value,
  ]),
);
const touchesView = (ids: Array<string | number>) =>
  itemNotificationTouchesView(
    ids,
    [current, attachment, annotation, note],
    (id) => items.get(id),
    (candidate) => candidate.kind === "workspace",
  );

describe("database view refresh policy", function () {
  it("refreshes only for visible regular items or the workspace item", function () {
    expect(touchesView([current.id])).to.equal(true);
    expect(touchesView([workspace.id])).to.equal(true);
    expect(touchesView([outside.id])).to.equal(false);
  });

  it("ignores attachment, annotation, note, and invalid notifications", function () {
    expect(touchesView([attachment.id])).to.equal(false);
    expect(touchesView([annotation.id])).to.equal(false);
    expect(touchesView([note.id])).to.equal(false);
    expect(touchesView(["not-an-item-id"])).to.equal(false);
  });

  it("uses the selected tab notification type with a safe fallback", function () {
    expect(
      selectedTabType(
        ["reader-1"],
        { "reader-1": { type: "reader" } },
        "library",
      ),
    ).to.equal("reader");
    expect(selectedTabType([], {}, "library")).to.equal("library");
  });

  it("recognizes Zotero's library content type rather than its tab ID", function () {
    expect(isLibraryTabType("library")).to.equal(true);
    expect(isLibraryTabType("zotero-pane")).to.equal(false);
    expect(isLibraryTabType("reader")).to.equal(false);
  });
});
