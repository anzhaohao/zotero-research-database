import { assert } from "chai";
import { clickControl } from "../uiHelpers";
import { config } from "../../package.json";
import { setPref } from "../../src/utils/prefs";

// Geometry alone is insufficient: an opaque overlay can cover a non-zero box.
describe("view toggle visibility", function () {
  it("keeps the database overlay below Zotero's native toolbar", async function () {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const controller = (
      Zotero[config.addonInstance] as any
    ).data.controllers.get(win);
    const toolbar = doc.getElementById("zotero-toolbar-item-tree")!;
    const itemToolbar = doc.getElementById("zotero-items-toolbar")!;
    const native = doc.getElementById("zotero-items-pane")!;
    const addButton = doc.getElementById("zotero-tb-add")!;
    const previousMode = doc
      .getElementById(`${config.addonRef}-view-toggle`)
      ?.getAttribute("data-mode");
    const previousPosition = String(
      Zotero.Prefs.get(`${config.prefsPrefix}.viewTogglePosition`, true) ||
        "right",
    );

    const waitForToggleAt = async (
      position: "left" | "right",
    ): Promise<Element> => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const toggle = doc.getElementById(`${config.addonRef}-view-toggle`);
        const edge =
          position === "left"
            ? itemToolbar.firstElementChild
            : itemToolbar.querySelector("#zotero-tb-toggle-item-pane-stacked")
                ?.previousElementSibling || itemToolbar.lastElementChild;
        if (toggle && edge === toggle) return toggle;
        await Zotero.Promise.delay(50);
      }
      assert.fail(`${position} toggle was not placed at the configured edge`);
    };

    const assertToolbarControlsReachable = (toggle: Element): void => {
      for (const button of [toggle, addButton]) {
        const bounds = button.getBoundingClientRect();
        const hit = doc.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        assert.isTrue(
          button === hit || button.contains(hit),
          `${button.id} must be reachable by the pointer; hit ${hit?.id || hit?.localName}`,
        );
      }
    };

    try {
      for (const position of ["left", "right"] as const) {
        setPref("viewTogglePosition", position);
        const toggle = await waitForToggleAt(position);

        controller.setMode("table");
        await Zotero.Promise.delay(300);
        const pane = doc.getElementById(`${config.addonRef}-custom-pane`)!;
        const rect = pane.getBoundingClientRect();
        const nativeRect = native.getBoundingClientRect();
        const toolbarRect = toolbar.getBoundingClientRect();
        assert.isAtLeast(
          rect.top,
          toolbarRect.bottom - 1,
          "database must not cover native toolbar",
        );
        for (const edge of ["top", "left", "right", "bottom"] as const) {
          assert.closeTo(
            rect[edge],
            nativeRect[edge],
            1,
            `overlay ${edge} matches item list only`,
          );
        }
        assertToolbarControlsReachable(toggle);

        clickControl(win, toggle);
        assert.equal(
          toggle.getAttribute("data-mode"),
          "default",
          `${position} toggle returns to the native list with one pointer click`,
        );
        clickControl(win, toggle);
        assert.equal(
          toggle.getAttribute("data-mode"),
          "table",
          `${position} toggle opens the database with one pointer click`,
        );
      }
    } finally {
      setPref(
        "viewTogglePosition",
        previousPosition === "left" ? "left" : "right",
      );
      controller.setMode(previousMode === "table" ? "table" : "default");
    }
  });
});
