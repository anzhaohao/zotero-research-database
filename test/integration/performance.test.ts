import { assert } from "chai";
import React, { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ItemResearchRecord,
  WorkspaceState,
} from "../../src/domain/types";
import { createEmptyRecord } from "../../src/core/records";
import {
  clearPdfThumbnailCache,
  getPdfThumbnail,
  getPdfThumbnailCacheStats,
} from "../../src/services/pdfThumbnail";
import { TableFlatRowsCache } from "../../src/ui/features/table/tableRows";
import { useResearchData } from "../../src/ui/features/table/useResearchData";
import { setPref } from "../../src/utils/prefs";

type SyntheticItem = Zotero.Item & {
  key: string;
  libraryID: number;
};

type HookSnapshot = {
  records: Map<string, ItemResearchRecord>;
  figures: Map<string, unknown[]>;
  reloadRecords: (
    state: WorkspaceState,
    refreshFigures?: boolean,
    refreshRecords?: boolean,
    dirty?: { records?: string[]; figures?: string[] },
  ) => Promise<void>;
};

const TEST_LIBRARY_ID = 987654;

function syntheticItem(
  key: string,
  libraryID = TEST_LIBRARY_ID,
): SyntheticItem {
  return {
    key,
    libraryID,
    id: Number.parseInt(key.slice(1), 10) || 1,
    isRegularItem: () => true,
    isAttachment: () => false,
    getField: () => "",
  } as unknown as SyntheticItem;
}

function workspace(): WorkspaceState {
  return {
    schemaVersion: 13,
    fields: [],
    views: [
      {
        id: "builtin-table",
        name: "Synthetic table",
        mode: "table",
        visibleFieldIDs: [],
        filterText: "",
        layout: {
          columnOrder: [],
          columnWidths: {},
          rowHeight: 32,
          rowHeights: {},
          cardWidth: 280,
          cardDensity: "comfortable",
          visibleColumnIDs: [],
          columnLabels: {},
          cellColors: {},
          rowColors: {},
          citationStyle: "zotero",
          pinnedColumnIDs: [],
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    comparisons: [],
    snapshots: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function delay(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(
  check: () => boolean,
  message: string,
  timeout = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(10);
  }
}

function mountHook(
  items: SyntheticItem[],
  repository: any,
  state: WorkspaceState,
  onSnapshot: (snapshot: HookSnapshot) => void,
): {
  root: Root;
  container: HTMLElement;
  render: (nextItems: SyntheticItem[]) => void;
} {
  const container = document.createElement("div");
  container.setAttribute("data-zrdb-performance-host", "true");
  document.body.append(container);
  function Probe({ currentItems }: { currentItems: SyntheticItem[] }) {
    const result = useResearchData({
      items: currentItems,
      repository,
      workspace: state,
      activeViewID: "builtin-table",
      mode: "table",
    });
    useEffect(() => {
      onSnapshot({
        records: result.records,
        figures: result.figures,
        reloadRecords: result.reloadRecords,
      });
    }, [result.records, result.figures, result.reloadRecords]);
    return React.createElement("span", {
      "data-record-count": result.records.size,
    });
  }
  const root = createRoot(container);
  const render = (nextItems: SyntheticItem[]) =>
    root.render(React.createElement(Probe, { currentItems: nextItems }));
  render(items);
  return { root, container, render };
}

function minimalPdfBytes(): Uint8Array {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 140] /Resources << >> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(source.length);
    source += object;
  }
  const xrefOffset = source.length;
  source += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

describe("host performance and bounded caches", function () {
  it("loads 10,000 Zotero-like items with bounded parallelism and identity reuse", async function () {
    this.timeout(120_000);
    const items = Array.from({ length: 10_000 }, (_, index) =>
      syntheticItem(`K${String(index + 1).padStart(5, "0")}`),
    );
    const nextCollection = Array.from({ length: 64 }, (_, index) =>
      syntheticItem(`N${String(index + 1).padStart(4, "0")}`),
    );
    const counts = new Map<string, number>();
    let active = 0;
    let maxActive = 0;
    let delayMs = 0;
    const recordByKey = new Map<string, ItemResearchRecord>();
    const repository = {
      async loadRecord(item: SyntheticItem) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(delayMs);
        active -= 1;
        counts.set(item.key, (counts.get(item.key) || 0) + 1);
        let value = recordByKey.get(item.key);
        if (!value) {
          value = createEmptyRecord(item.libraryID, item.key);
          recordByKey.set(item.key, value);
        }
        return value;
      },
      async loadFigures() {
        return [];
      },
    };
    const state = workspace();
    const prefRoot = "extensions.zotero-research-database.";
    const oldFigureEnabled = Zotero.Prefs.get(
      `${prefRoot}zoteroFigureEnabled`,
      true,
    );
    const oldMineruFallback = Zotero.Prefs.get(
      `${prefRoot}mineruFigureFallback`,
      true,
    );
    setPref("zoteroFigureEnabled", false);
    setPref("mineruFigureFallback", false);
    const snapshots: HookSnapshot[] = [];
    const mounted = mountHook(items, repository, state, (snapshot) =>
      snapshots.push(snapshot),
    );
    try {
      await eventually(
        () =>
          snapshots.some((snapshot) => snapshot.records.size === items.length),
        "10,000 synthetic records did not finish loading",
        90_000,
      );
      const first = snapshots.find(
        (snapshot) => snapshot.records.size === items.length,
      )!;
      assert.isAtMost(
        maxActive,
        8,
        "record loading exceeded the eight-worker bound",
      );
      const coldCount = [...counts.values()].reduce(
        (sum, value) => sum + value,
        0,
      );
      assert.equal(coldCount, items.length);
      const coldStart = performance.now();
      await first.reloadRecords(state);
      const coldReloadMs = performance.now() - coldStart;
      const stable = snapshots[snapshots.length - 1];
      assert.equal(
        [...counts.values()].reduce((sum, value) => sum + value, 0),
        coldCount,
        "stable reload read a cached record",
      );
      assert.strictEqual(
        stable.records,
        first.records,
        "stable reload replaced the Map",
      );
      assert.strictEqual(
        stable.records.get(items[0].key),
        first.records.get(items[0].key),
        "stable reload replaced an unchanged record",
      );

      const dirtyKey = items[4321].key;
      await stable.reloadRecords(state, false, false, { records: [dirtyKey] });
      assert.equal(counts.get(dirtyKey), 2);
      assert.equal(
        [...counts.entries()].filter(
          ([key]) => key !== dirtyKey && counts.get(key) === 2,
        ).length,
        0,
        "dirty reload loaded a second record",
      );
      console.log(
        `[ZRDB performance] 10k records cold=${coldReloadMs.toFixed(1)}ms maxConcurrency=${maxActive} cache=${coldCount}`,
      );

      // A forced reload keeps the first collection in flight long enough for
      // the render below to replace it, without making this host stress test
      // wait for a second 10,000-item cold pass.
      delayMs = 2;
      const beforeSwitch = snapshots[snapshots.length - 1];
      const staleReload = beforeSwitch.reloadRecords(state, false, true);
      await delay(1);
      mounted.render(nextCollection);
      await staleReload;
      await eventually(
        () =>
          snapshots.some(
            (snapshot) => snapshot.records.size === nextCollection.length,
          ),
        "new collection did not publish after an in-flight stale reload",
      );
      const latest = snapshots[snapshots.length - 1];
      assert.deepEqual(
        [...latest.records.keys()],
        nextCollection.map((item) => item.key),
      );
      assert.isFalse(
        latest.records.has(items[0].key),
        "old collection result was published",
      );
    } finally {
      mounted.root.unmount();
      mounted.container.remove();
      setPref("zoteroFigureEnabled", oldFigureEnabled as boolean);
      setPref("mineruFigureFallback", oldMineruFallback as boolean);
    }
  });

  it("keeps TableFlatRowsCache bounded while materializing fresh item references", function () {
    const items = Array.from({ length: 10_000 }, (_, index) =>
      syntheticItem(`R${String(index + 1).padStart(5, "0")}`),
    );
    const cache = new TableFlatRowsCache<SyntheticItem>();
    const label = (item: SyntheticItem) =>
      `group-${Number(item.key.slice(1)) % 17}`;
    const sameGroup = (item: SyntheticItem) => {
      void item;
      return "one-group";
    };
    const sameGroupColdStart = performance.now();
    const sameGroupCold = cache.get(items, "same-group", sameGroup);
    const sameGroupColdMs = performance.now() - sameGroupColdStart;
    const sameGroupHotStart = performance.now();
    const sameGroupHot = cache.get(items, "same-group", sameGroup);
    const sameGroupHotMs = performance.now() - sameGroupHotStart;
    assert.equal(sameGroupCold.length, items.length + 1);
    assert.equal(sameGroupHot.length, sameGroupCold.length);
    const coldStart = performance.now();
    const cold = cache.get(items, "collection", label);
    const coldMs = performance.now() - coldStart;
    const hotStart = performance.now();
    const hot = cache.get(items, "collection", label);
    const hotMs = performance.now() - hotStart;
    assert.equal(cold.length, hot.length);
    assert.strictEqual((hot[1] as { item: SyntheticItem }).item, items[0]);
    const replacements = items.map((item) => syntheticItem(item.key));
    const refreshed = cache.get(replacements, "collection", label);
    assert.strictEqual(
      (refreshed[1] as { item: SyntheticItem }).item,
      replacements[0],
      "a cache hit retained an obsolete Zotero item reference",
    );
    for (let index = 0; index < 30; index++)
      cache.get(items, `group-${index}`, label);
    assert.isAtMost(
      (cache as any).cache.size,
      12,
      "LRU cache exceeded its twelve-entry bound",
    );
    console.log(
      `[ZRDB performance] table rows sameGroupCold=${sameGroupColdMs.toFixed(1)}ms sameGroupHot=${sameGroupHotMs.toFixed(1)}ms multiCold=${coldMs.toFixed(1)}ms multiHot=${hotMs.toFixed(1)}ms rows=${cold.length} cache=${(cache as any).cache.size}`,
    );
  });

  it("renders 51 real PDF widths with a 50-entry thumbnail cache", async function () {
    this.timeout(120_000);
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "ZRDB PDF cache performance sandbox test");
    await parent.saveTx();
    const path = PathUtils.join(
      PathUtils.tempDir,
      `zrdb-performance-${Date.now()}.pdf`,
    );
    let attachment: Zotero.Item | undefined;
    let sourceReads = 0;
    const originalRead = (IOUtils as any).read;
    try {
      await IOUtils.write(path, minimalPdfBytes());
      attachment = await Zotero.Attachments.importFromFile({
        file: path,
        parentItemID: parent.id,
      });
      attachment.setField("title", "PDF");
      await attachment.saveTx();
      const storedPdfPath = await attachment.getFilePathAsync();
      assert.isString(storedPdfPath);
      clearPdfThumbnailCache();
      (IOUtils as any).read = async (readPath: string) => {
        if (readPath === storedPdfPath) sourceReads += 1;
        return originalRead.call(IOUtils, readPath);
      };
      const widths = Array.from({ length: 51 }, (_, index) => 100 + index);
      for (const width of widths) {
        const result = await getPdfThumbnail(parent, width, 1);
        assert.match(result.dataUrl || "", /^data:image\/png;base64,/);
      }
      const afterWidths = sourceReads;
      const stats = getPdfThumbnailCacheStats();
      assert.isAtMost(stats.thumbnails, 50);
      assert.equal(stats.thumbnailLimit, 50);
      await getPdfThumbnail(parent, widths[widths.length - 1], 1);
      assert.equal(
        sourceReads,
        afterWidths,
        "a thumbnail cache hit reread or rerendered the PDF",
      );
      assert.isAtLeast(
        sourceReads,
        51,
        "the 51 distinct widths did not read the source PDF",
      );
      console.log(
        `[ZRDB performance] PDF widths=${widths.length} sourceReads=${sourceReads} thumbnails=${stats.thumbnails}`,
      );
    } finally {
      (IOUtils as any).read = originalRead;
      clearPdfThumbnailCache();
      await IOUtils.remove(path, { ignoreAbsent: true });
      await attachment?.eraseTx().catch(() => undefined);
      await parent.eraseTx();
    }
  });
});
