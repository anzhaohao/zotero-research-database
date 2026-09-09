import { expect } from "chai";
import { NativeArtifactVisibilityController } from "../../src/ui/nativeArtifactVisibility";
import type { ResearchRepository } from "../../src/storage/repository";

describe("native MinerU artifact visibility", function () {
  it("filters only manifest-managed MinerU rows and restores methods", async function () {
    const parent = {
      key: "PARENT01",
      libraryID: 1,
      isRegularItem: () => true,
    } as Zotero.Item;
    const managed = { key: "FIGURE01", parentItemID: 101 } as Zotero.Item;
    const userAttachment = { key: "USERPDF1" } as Zotero.Item;
    let containerOpen = true;
    let toggleCalls = 0;
    const originalToggle = async () => {
      toggleCalls += 1;
      containerOpen = !containerOpen;
    };
    let refreshCalls = 0;
    const originalRefresh = async () => {
      refreshCalls += 1;
    };
    let rowMapRefreshes = 0;
    const tree = {
      _rows: [
        { level: 0, ref: parent },
        { level: 1, ref: managed },
        { level: 1, ref: userAttachment },
      ],
      _refreshRowMap: () => {
        rowMapRefreshes += 1;
      },
      _rowMap: { 101: 0 },
      isContainerOpen: () => containerOpen,
      toggleOpenState: originalToggle,
      refreshAndMaintainSelection: originalRefresh,
      tree: { invalidate() {} },
    };
    const artifacts = [
      {
        attachmentKey: "FIGURE01",
        role: "figure",
        sha256: "hash",
      },
      { attachmentKey: "USERPDF1", role: "translation" },
    ];
    const repository = {
      loadArtifacts: async () => artifacts,
      loadAllArtifacts: async () => artifacts,
    } as unknown as ResearchRepository;
    const controller = new NativeArtifactVisibilityController(tree, repository);

    expect(controller.install(true)).to.equal(true);
    await controller.refresh();
    expect(tree._rows.map((row) => row.ref.key)).to.deep.equal([
      "PARENT01",
      "USERPDF1",
    ]);
    expect(rowMapRefreshes).to.be.greaterThan(0);
    expect(tree.toggleOpenState).not.to.equal(originalToggle);

    await controller.setEnabled(false);
    expect(toggleCalls).to.equal(2);
    expect(containerOpen).to.equal(true);

    // Zotero may rebuild native rows while the preference remains enabled.
    // Re-applying the same value must filter managed children again.
    tree._rows.splice(1, 0, { level: 1, ref: managed });
    await controller.setEnabled(true);
    expect(tree._rows.map((row) => row.ref.key)).to.deep.equal([
      "PARENT01",
      "USERPDF1",
    ]);

    controller.destroy();
    expect(tree.toggleOpenState).to.equal(originalToggle);
    expect(tree.refreshAndMaintainSelection).to.equal(originalRefresh);
    await Promise.resolve();
    expect(refreshCalls).to.be.greaterThan(0);
  });

  it("fails open and warns exactly once on an incompatible Zotero ItemTree", function () {
    const originalZotero = (globalThis as any).Zotero;
    const warnings: string[] = [];
    (globalThis as any).Zotero = {
      warn: (message: string) => warnings.push(message),
    };
    const rows = [{ level: 0, ref: { key: "VISIBLE1" } }];
    try {
      const first = new NativeArtifactVisibilityController({ _rows: rows });
      const second = new NativeArtifactVisibilityController({ _rows: rows });
      expect(first.install(true)).to.equal(false);
      expect(second.install(true)).to.equal(false);
      expect(rows).to.have.length(1);
      expect(rows[0].ref.key).to.equal("VISIBLE1");
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include("安全降级为显示全部原生子附件");
    } finally {
      (globalThis as any).Zotero = originalZotero;
    }
  });
});
