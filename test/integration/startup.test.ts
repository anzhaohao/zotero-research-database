import { assert } from "chai";
import { clickControl } from "../uiHelpers";
import { config } from "../../package.json";
import {
  CodexAgentBridge,
  HanaAgentBridge,
} from "../../src/services/externalAgent";
import { readLocalCodexModelCatalog } from "../../src/services/codexModels";
import { importArtifacts } from "../../src/services/artifactEndpoint";
import { TRANSLATED_TITLE_FIELD_ID } from "../../src/domain/defaults";
import { ResearchRepository } from "../../src/storage/repository";
import { migrateLegacyInternalTags } from "../../src/services/artifactMetadata";
import { setPref } from "../../src/utils/prefs";
import type { ItemInternalState } from "../../src/domain/types";
import {
  writeArtifactExtra,
  writeFigureExtra,
  writePrimaryPdfExtra,
  writeRecordExtra,
} from "../../src/core/extraProperties";
import { createEmptyRecord, setManualValue } from "../../src/core/records";
import { mineruResultFromDirectory } from "../../src/services/mineru";
import {
  clearPdfThumbnailCache,
  getPdfPageCount,
  getPdfThumbnail,
} from "../../src/services/pdfThumbnail";

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

async function readLocalItemState(
  item: Zotero.Item,
): Promise<ItemInternalState | undefined> {
  const path = PathUtils.join(
    PathUtils.profileDir,
    "zotero-research-database",
    "research-data-v1.json",
  );
  if (!(await IOUtils.exists(path))) return undefined;
  const payload = JSON.parse(await IOUtils.readUTF8(path)) as {
    items?: Record<string, ItemInternalState>;
  };
  return payload.items?.[`${item.libraryID}:${item.key.toUpperCase()}`];
}

describe("startup", function () {
  it("round-trips a title through Translate for Zotero 2.4.6 without changing Zotero metadata", async function () {
    this.timeout(120_000);
    const integrationEnabled = Boolean(
      Zotero.Prefs.get(
        "extensions.zotero-research-database.test.pdfTranslateXpiInstalled",
        true,
      ),
    );
    if (!integrationEnabled) this.skip();

    for (let attempt = 0; attempt < 50; attempt++) {
      if (typeof (Zotero as any).PDFTranslate?.api?.translate === "function") {
        break;
      }
      await Zotero.Promise.delay(100);
    }
    assert.equal(
      typeof (Zotero as any).PDFTranslate?.api?.translate,
      "function",
    );

    const item = new Zotero.Item("journalArticle");
    item.libraryID = Zotero.Libraries.userLibraryID;
    item.setField("title", "Deep learning for image recognition");
    item.setField(
      "extra",
      "Citation Key: zrdb-translate-integration\nJCR: Q1\n用户自由文本",
    );
    await item.saveTx();
    const titleBefore = String(item.getField("title") || "");
    const extraBefore = String(item.getField("extra") || "");

    try {
      const task = await (Zotero as any).PDFTranslate.api.translate(
        titleBefore,
        {
          pluginID: config.addonID,
          itemID: item.id,
          langfrom: "en",
          langto: "zh-CN",
        },
      );
      assert.equal(
        task?.status,
        "success",
        `Translate for Zotero task failed: ${JSON.stringify(task)}`,
      );
      assert.isString(task?.result);
      const translated = String(task.result).trim();
      assert.isNotEmpty(translated);

      const audit = {
        executor: "external-agent" as const,
        executorVersion: "Translate for Zotero 2.4.6",
        inputType: "manual" as const,
        inputHash: "",
        generatedAt: new Date().toISOString(),
        templateVersion: 1,
      };
      await new ResearchRepository().saveTranslatedTitle(
        item,
        translated,
        audit,
      );
      await Zotero.Promise.delay(300);

      const localState = await readLocalItemState(item);
      assert.equal(
        localState?.record?.fields[TRANSLATED_TITLE_FIELD_ID]?.value,
        translated,
      );
      const reloaded = await Zotero.Items.getAsync(item.id);
      assert.equal(String(reloaded?.getField("title") || ""), titleBefore);
      assert.equal(String(reloaded?.getField("extra") || ""), extraBefore);
    } finally {
      await item.eraseTx();
    }
  });

  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("should resolve the installed Codex CLI without invoking a model", async function () {
    const result = await new CodexAgentBridge().probe();
    assert.match(result.version, /codex/i);
    assert.match(result.executable, /codex\.exe$/i);
  });

  it("should complete a Codex structured JSON round-trip in the Zotero sandbox", async function () {
    this.timeout(120_000);
    if (
      !Zotero.Prefs.get(
        "extensions.zotero-research-database.test.externalAgentEnabled",
        true,
      )
    )
      this.skip();
    // Relay providers only accept the qualified catalog id, so the round trip
    // uses the local catalog instead of the plugin's built-in suggestions.
    try {
      const catalog = await readLocalCodexModelCatalog();
      const relayModel =
        catalog.models.find((model) => model.value.includes("::"))?.value ??
        catalog.defaultModel;
      await new CodexAgentBridge({
        model: relayModel,
        timeoutMs: 90_000,
      }).testStructuredOutput();
    } catch (error) {
      assert.fail(`catalog codex round trip failed: ${String(error)}`);
    }
  });

  it("should recover a bare relay model name from the local Codex catalog", async function () {
    this.timeout(180_000);
    if (
      !Zotero.Prefs.get(
        "extensions.zotero-research-database.test.externalAgentEnabled",
        true,
      )
    )
      this.skip();
    const catalog = await readLocalCodexModelCatalog();
    const qualified = catalog.models
      .map((model) => model.value)
      .filter((value) => value.includes("::"))
      .find(
        (value) =>
          catalog.models.filter(
            (other) =>
              other.value.split("::").pop() === value.split("::").pop(),
          ).length === 1,
      );
    if (!qualified) this.skip();
    const bare = qualified.split("::").pop() as string;
    try {
      await new CodexAgentBridge({
        model: bare,
        timeoutMs: 120_000,
      }).testStructuredOutput();
    } catch (error) {
      assert.fail(`bare model ${bare} was not repaired: ${String(error)}`);
    }
  });

  it("should reach the local HanaAgent from the Zotero sandbox", async function () {
    if (
      !Zotero.Prefs.get(
        "extensions.zotero-research-database.test.externalAgentEnabled",
        true,
      )
    )
      this.skip();
    const serverInfo = "C:\\Users\\anzhaofeng\\.hanako\\server-info.json";
    if (!(await IOUtils.exists(serverInfo))) this.skip();
    let result: Awaited<ReturnType<HanaAgentBridge["probe"]>>;
    try {
      result = await new HanaAgentBridge({
        kind: "hana-agent",
        executable: "E:\\software\\Hanako\\HanaAgent.exe",
        endpoint: serverInfo,
        timeoutMs: 30_000,
      }).probe();
    } catch (error) {
      const row = error as {
        name?: unknown;
        message?: unknown;
        cause?: { name?: unknown; message?: unknown };
      };
      assert.fail(
        [
          String(row?.name || "Error"),
          String(row?.message || error),
          row?.cause
            ? `${String(row.cause.name || "Cause")}: ${String(row.cause.message || row.cause)}`
            : "",
        ]
          .filter(Boolean)
          .join(" | "),
      );
    }
    assert.match(result.version, /^\d+\.\d+\.\d+$/);
    assert.match(result.executable, /HanaAgent\.exe$/i);
  });

  it("should complete a HanaAgent WebSocket JSON round-trip in the Zotero sandbox", async function () {
    this.timeout(120_000);
    if (
      !Zotero.Prefs.get(
        "extensions.zotero-research-database.test.externalAgentEnabled",
        true,
      )
    )
      this.skip();
    const serverInfo = "C:\\Users\\anzhaofeng\\.hanako\\server-info.json";
    if (!(await IOUtils.exists(serverInfo))) this.skip();
    const bridge = new HanaAgentBridge({
      kind: "hana-agent",
      executable: "E:\\software\\Hanako\\HanaAgent.exe",
      endpoint: serverInfo,
      timeoutMs: 90_000,
    });
    await bridge.testStructuredOutput();
  });

  it("should migrate legacy Extra into local storage without touching user metadata", async function () {
    const item = new Zotero.Item("journalArticle");
    item.libraryID = Zotero.Libraries.userLibraryID;
    item.setField("title", "ZRDB Extra migration test");
    await item.saveTx();
    const record = setManualValue(
      createEmptyRecord(item.libraryID, item.key),
      "research-value",
      "保留的研究价值",
    );
    let extra = writeRecordExtra(
      "Citation Key: migration-test\nJCR: Q1\n用户自由文本",
      record,
    );
    extra = writeFigureExtra(extra, [
      {
        id: "migration-fig-1",
        parentItemKey: item.key,
        attachmentKey: "IMAGE001",
        kind: "figure",
        caption: "迁移图",
        pageIndex: 1,
        sha256: "a".repeat(64),
      },
    ]);
    extra = writeArtifactExtra(extra, [
      {
        attachmentKey: "IMAGE001",
        role: "figure",
        figureID: "migration-fig-1",
        sha256: "a".repeat(64),
      },
    ]);
    extra = writePrimaryPdfExtra(extra, "PDF00001");
    item.setField("extra", extra);
    await item.saveTx();

    try {
      const repository = new ResearchRepository();
      const migrated = await repository.loadRecord(item);
      assert.equal(migrated?.fields["research-value"]?.value, "保留的研究价值");
      assert.lengthOf(await repository.loadFigures(item), 1);
      assert.lengthOf(await repository.loadArtifacts(item), 1);
      assert.equal(await repository.loadPrimaryPdfKey(item), "PDF00001");
      const cleaned = String(item.getField("extra") || "");
      assert.include(cleaned, "Citation Key: migration-test");
      assert.include(cleaned, "JCR: Q1");
      assert.include(cleaned, "用户自由文本");
      assert.notInclude(cleaned, "ZRDB.");
      assert.isNull(
        (Zotero as any).SyncedSettings.get(
          item.libraryID,
          `zoteroResearchDatabase.item.${item.key.toUpperCase()}.v1`,
        ),
      );
    } finally {
      await item.eraseTx();
    }
  });

  it("should replace the native XUL item pane in database modes", async function () {
    const win = Zotero.getMainWindow();
    assert.exists(win);
    const doc = win.document;
    const tableItem = new Zotero.Item("journalArticle");
    tableItem.libraryID = Zotero.Libraries.userLibraryID;
    tableItem.setField("title", "ZRDB table geometry test");
    tableItem.setField("date", "2026");
    tableItem.setField("DOI", "10.0000/zrdb.test");
    tableItem.setCreators([
      { firstName: "Test", lastName: "Author", creatorType: "author" },
    ]);
    await tableItem.saveTx();
    const dividerItem = new Zotero.Item("journalArticle");
    dividerItem.libraryID = Zotero.Libraries.userLibraryID;
    dividerItem.setField("title", "中文标题不需要翻译");
    dividerItem.setField("date", "2025");
    await dividerItem.saveTx();
    await (win.ZoteroPane as any).selectItem(tableItem.id, true);
    await Zotero.Promise.delay(100);
    const nativePane = doc.querySelector("#zotero-items-pane");
    const customPane = doc.querySelector<HTMLElement>(
      `#${config.addonRef}-custom-pane`,
    );
    const toggleButton = doc.querySelector<HTMLElement>(
      `#${config.addonRef}-view-toggle`,
    );
    assert.exists(nativePane);
    assert.exists(customPane);
    assert.exists(toggleButton);
    const itemsContainer = doc.querySelector<HTMLElement>(
      "#zotero-items-pane-container",
    );
    assert.exists(itemsContainer);
    const sidePaneWidths = ["#zotero-collections-pane", "#zotero-item-pane"]
      .map((selector) => doc.querySelector<HTMLElement>(selector))
      .filter((pane): pane is HTMLElement => Boolean(pane))
      .map((pane) => ({ pane, width: pane.getBoundingClientRect().width }));
    const initialToggleRect = toggleButton!.getBoundingClientRect();
    assert.isAbove(initialToggleRect.width, 0, "view toggle width");
    assert.isAbove(initialToggleRect.height, 0, "view toggle height");
    const nativeToggle = toggleButton!.localName === "toolbarbutton";
    assert.oneOf(toggleButton!.localName, ["toolbarbutton", "button"]);
    assert.equal(toggleButton!.getAttribute("data-mode"), "default");
    assert.notExists(doc.querySelector(`#${config.addonRef}-view-switcher`));
    assert.notExists(doc.querySelector('[data-mode="cards"]'));
    const errorsBefore = ((Zotero as any).getErrors?.(true) || []) as string[];

    if (nativeToggle) {
      assert.equal(
        toggleButton!.namespaceURI,
        "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul",
      );
      assert.equal(toggleButton!.getAttribute("data-toggle-kind"), "native");
      assert.include(
        toggleButton!.getAttribute("image") || "",
        "view-table.svg",
      );
    } else {
      assert.equal(
        toggleButton!.getAttribute("data-toggle-kind"),
        "html-fallback",
      );
      const tableIcon = toggleButton!.querySelector<SVGSVGElement>(
        '[data-toggle-icon="table"]',
      );
      const defaultIcon = toggleButton!.querySelector<SVGSVGElement>(
        '[data-toggle-icon="default"]',
      );
      assert.exists(tableIcon);
      assert.exists(defaultIcon);
      for (const icon of [tableIcon!, defaultIcon!]) {
        assert.equal(icon.namespaceURI, "http://www.w3.org/2000/svg");
        assert.equal(icon.getAttribute("stroke"), "currentColor");
        assert.isAbove(icon.getBoundingClientRect().width, 0);
        assert.notEqual(win.getComputedStyle(icon).stroke, "none");
      }
    }

    clickControl(win, toggleButton!);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (customPane!.querySelector(".zrdb-app")) break;
      await Zotero.Promise.delay(50);
    }
    await Zotero.Promise.delay(250);
    const newErrors = (
      ((Zotero as any).getErrors?.(true) || []) as string[]
    ).slice(errorsBefore.length);
    assert.isFalse(
      nativePane!.hasAttribute("hidden"),
      "native pane keeps its layout",
    );
    assert.isFalse(
      customPane!.hidden,
      "database pane is shown after activation",
    );
    assert.equal(win.getComputedStyle(nativePane!).visibility, "hidden");
    assert.notEqual(win.getComputedStyle(nativePane!).display, "none");
    assert.notEqual(win.getComputedStyle(customPane!).display, "none");
    assert.strictEqual(customPane!.parentElement, itemsContainer);
    assert.equal(win.getComputedStyle(customPane!).position, "absolute");
    assert.closeTo(
      customPane!.getBoundingClientRect().width,
      itemsContainer!.getBoundingClientRect().width,
      1,
    );
    for (const { pane, width } of sidePaneWidths) {
      assert.closeTo(
        pane.getBoundingClientRect().width,
        width,
        1,
        `${pane.id} width remains unchanged while the database view is open`,
      );
    }
    assert.exists(
      customPane!.querySelector(".zrdb-app"),
      `custom pane HTML: ${customPane!.innerHTML}; errors: ${JSON.stringify(newErrors)}`,
    );
    assert.isFalse(toggleButton!.hasAttribute("hidden"));
    assert.equal(toggleButton!.getAttribute("data-mode"), "table");
    assert.isTrue(toggleButton!.classList.contains("active"));
    if (nativeToggle)
      assert.include(
        toggleButton!.getAttribute("image") || "",
        "view-list.svg",
      );
    const nativeToolbar = doc.querySelector<HTMLElement>(
      "#zotero-items-toolbar",
    );
    assert.exists(nativeToolbar);
    assert.strictEqual(toggleButton!.parentElement, nativeToolbar);
    if (nativeToggle)
      assert.notEqual(win.getComputedStyle(toggleButton!).position, "absolute");
    else assert.equal(win.getComputedStyle(toggleButton!).position, "absolute");
    const toolbarRect = nativeToolbar!.getBoundingClientRect();
    const toggleRect = toggleButton!.getBoundingClientRect();
    assert.isAtLeast(toggleRect.left, toolbarRect.left);
    assert.isAtMost(toggleRect.right, toolbarRect.right);
    const stableToggleLeft = toggleRect.left;
    const actionbar = customPane!.querySelector<HTMLElement>(".zrdb-actionbar");
    const titlebar = customPane!.querySelector<HTMLElement>(".zrdb-titlebar");
    const contextStrip = customPane!.querySelector<HTMLElement>(
      ".zrdb-context-strip",
    );
    const functionbar =
      customPane!.querySelector<HTMLElement>(".zrdb-functionbar");
    assert.exists(actionbar);
    assert.exists(titlebar);
    assert.exists(contextStrip);
    assert.exists(functionbar);
    const researchApp = customPane!.querySelector<HTMLElement>(".zrdb-app");
    assert.exists(researchApp);
    assert.equal(researchApp!.getAttribute("data-theme"), "zotero");
    assert.notExists(customPane!.querySelector('[aria-label="切换明暗模式"]'));
    assert.strictEqual(contextStrip!.parentElement, titlebar);
    assert.strictEqual(functionbar!.parentElement, titlebar);
    assert.strictEqual(
      contextStrip!.querySelector(".zrdb-source-status")?.parentElement,
      contextStrip,
    );
    assert.strictEqual(
      functionbar!.querySelector(".zrdb-search-wrap")?.parentElement,
      functionbar,
    );
    assert.notExists(customPane!.querySelector(".zrdb-style-chip"));
    assert.notInclude(titlebar!.textContent || "", "学术工作台");
    assert.notExists(customPane!.querySelector(".zrdb-commandbar"));
    assert.equal(win.getComputedStyle(actionbar!).flexDirection, "row");
    assert.equal(win.getComputedStyle(titlebar!).flexWrap, "nowrap");
    assert.isAtMost(
      contextStrip!.getBoundingClientRect().right,
      functionbar!.getBoundingClientRect().left,
    );
    const toolbarCenters = [
      ".zrdb-database-title",
      ".zrdb-search-wrap",
      ".zrdb-menu-trigger",
    ].map((selector) => {
      const element = titlebar!.querySelector<HTMLElement>(selector);
      assert.exists(element, selector);
      const rect = element!.getBoundingClientRect();
      return rect.top + rect.height / 2;
    });
    for (const center of toolbarCenters.slice(1))
      assert.closeTo(center, toolbarCenters[0], 3);
    assert.lengthOf(customPane!.querySelectorAll(".zrdb-menu-trigger"), 3);
    assert.notExists(customPane!.querySelector(".zrdb-inline-view-switcher"));
    assert.exists(customPane!.querySelector('[aria-label="视图与导出"]'));
    const toolsTrigger = customPane!.querySelector<HTMLButtonElement>(
      '[aria-label="字段与工具"]',
    );
    assert.exists(toolsTrigger, "fields/tools toolbar trigger");
    const firstDatabaseRow =
      customPane!.querySelector<HTMLElement>(".zrdb-table-row");
    assert.exists(firstDatabaseRow, "database row for external-tool selection");
    firstDatabaseRow!.click();
    await Zotero.Promise.delay(40);
    const activePane = doc.querySelector<HTMLElement>(
      `#${config.addonRef}-custom-pane`,
    )!;
    const activeToolsTrigger = activePane.querySelector<HTMLButtonElement>(
      '[aria-label="字段与工具"]',
    );
    assert.exists(
      activeToolsTrigger,
      "fields/tools toolbar trigger after row selection",
    );
    activeToolsTrigger!.click();
    await Zotero.Promise.delay(40);
    const columnVisibilityButton = [
      ...activePane.querySelectorAll<HTMLButtonElement>(
        ".zrdb-toolbar-menu button",
      ),
    ].find((button) => button.textContent?.includes("列布局"));
    assert.exists(columnVisibilityButton, "unified field and column entry");
    assert.include(columnVisibilityButton!.textContent || "", "列布局");
    columnVisibilityButton!.click();
    await Zotero.Promise.delay(40);
    const columnVisibilityModal = customPane!.querySelector<HTMLElement>(
      '.zrdb-modal[aria-label="当前视图列布局"]',
    );
    assert.exists(columnVisibilityModal);
    assert.include(columnVisibilityModal!.textContent || "", "标题");
    assert.include(columnVisibilityModal!.textContent || "", "基础信息");
    assert.notExists(columnVisibilityModal!.querySelector('[role="tablist"]'));
    assert.notInclude(columnVisibilityModal!.textContent || "", "自定义字段");
    assert.exists(
      [
        ...columnVisibilityModal!.querySelectorAll<HTMLButtonElement>("button"),
      ].find((button) => button.textContent?.includes("打开字段设置")),
      "global field definitions have a single settings entry",
    );
    assert.isAtLeast(
      columnVisibilityModal!.querySelectorAll(".zrdb-column-manager-grip")
        .length,
      3,
      "every native and custom column can be dragged from the unified manager",
    );
    assert.isAtLeast(
      columnVisibilityModal!.querySelectorAll('input[type="checkbox"]').length,
      3,
      "native and custom columns expose saved visibility checkboxes",
    );
    const managerRows = [
      ...columnVisibilityModal!.querySelectorAll<HTMLElement>(
        ".zrdb-column-manager-row",
      ),
    ];
    const titleManagerRow = managerRows.find((row) =>
      row.querySelector("strong")?.textContent?.includes("标题"),
    );
    const basicManagerRow = managerRows.find((row) =>
      row.querySelector("strong")?.textContent?.includes("基础信息"),
    );
    const managerGrip = basicManagerRow?.querySelector<HTMLButtonElement>(
      ".zrdb-column-manager-grip",
    );
    assert.exists(titleManagerRow);
    assert.exists(managerGrip);
    const managerGripRect = managerGrip!.getBoundingClientRect();
    const managerTitleRect = titleManagerRow!.getBoundingClientRect();
    managerGrip!.dispatchEvent(
      new win.PointerEvent("pointerdown", {
        bubbles: true,
        clientX: managerGripRect.left + managerGripRect.width / 2,
        clientY: managerGripRect.top + managerGripRect.height / 2,
        pointerId: 29,
        button: 0,
        buttons: 1,
      }),
    );
    titleManagerRow!.dispatchEvent(
      new win.PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: managerTitleRect.left + 4,
        clientY: managerTitleRect.top + 2,
        pointerId: 29,
        buttons: 1,
      }),
    );
    titleManagerRow!.dispatchEvent(
      new win.PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        clientX: managerTitleRect.left + 4,
        clientY: managerTitleRect.top + 2,
        pointerId: 29,
      }),
    );
    await Zotero.Promise.delay(40);
    const reorderedManagerRows = [
      ...columnVisibilityModal!.querySelectorAll<HTMLElement>(
        ".zrdb-column-manager-row",
      ),
    ];
    const reorderedManagerTitleIndex = reorderedManagerRows.findIndex((row) =>
      row.querySelector("strong")?.textContent?.includes("标题"),
    );
    const reorderedManagerBasicIndex = reorderedManagerRows.findIndex((row) =>
      row.querySelector("strong")?.textContent?.includes("基础信息"),
    );
    assert.isBelow(reorderedManagerBasicIndex, reorderedManagerTitleIndex);
    [...columnVisibilityModal!.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("保存列布局"))!
      .click();
    await Zotero.Promise.delay(80);
    const pinMenu = [
      ...customPane!.querySelectorAll<HTMLDetailsElement>(
        "details.zrdb-menu-submenu",
      ),
    ].find(
      (menu) => menu.querySelector("summary span")?.textContent === "固定列",
    );
    assert.exists(pinMenu, "pin choices are grouped in a submenu");
    assert.isFalse(pinMenu!.open, "pin choices start collapsed");
    pinMenu!.querySelector<HTMLElement>("summary")!.click();
    assert.isTrue(pinMenu!.open, "pin choices expand on demand");
    const pinGroup = pinMenu!.querySelector<HTMLElement>(
      '.zrdb-menu-choice-group[role="group"]',
    );
    assert.exists(pinGroup, "explicit pinned-column choices");
    const basicPin = [
      ...pinGroup!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("基础信息"));
    assert.exists(basicPin, "basic information pin choice");
    basicPin!.click();
    await Zotero.Promise.delay(100);
    const selectedBasicPin = [
      ...customPane!.querySelectorAll<HTMLButtonElement>(
        '.zrdb-menu-choice[aria-checked="true"]',
      ),
    ].find((button) => button.textContent?.includes("基础信息"));
    assert.exists(selectedBasicPin, "selected pinned-column choice");
    assert.include(
      customPane!.querySelector<HTMLElement>(".zrdb-header-cell.is-pinned")
        ?.textContent || "",
      "基础信息",
    );
    const currentPinGroup = customPane!.querySelector<HTMLElement>(
      '.zrdb-menu-choice-group[role="group"]',
    );
    const titlePin = [
      ...currentPinGroup!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("标题"));
    assert.exists(titlePin, "title can be pinned together with basic info");
    titlePin!.click();
    for (let attempt = 0; attempt < 20; attempt++) {
      if (
        customPane!.querySelectorAll(".zrdb-header-cell.is-pinned").length === 2
      ) {
        break;
      }
      await Zotero.Promise.delay(50);
    }
    const pinnedLabels = [
      ...customPane!.querySelectorAll<HTMLElement>(
        ".zrdb-header-cell.is-pinned",
      ),
    ].map((header) => header.textContent || "");
    assert.lengthOf(pinnedLabels, 2);
    assert.include(pinnedLabels[0], "基础信息");
    assert.include(pinnedLabels[1], "标题");
    const pinnedHeaders = [
      ...customPane!.querySelectorAll<HTMLElement>(
        ".zrdb-header-cell.is-pinned",
      ),
    ];
    const firstPinnedLeft = Number.parseFloat(
      pinnedHeaders[0].style.left || "0",
    );
    const secondPinnedLeft = Number.parseFloat(
      pinnedHeaders[1].style.left || "0",
    );
    assert.equal(firstPinnedLeft, 0);
    assert.closeTo(
      secondPinnedLeft,
      Number.parseFloat(pinnedHeaders[0].style.width),
      1,
      "the second pinned column uses the first pinned width as sticky offset",
    );
    const refreshedTitlePin = [
      ...customPane!.querySelectorAll<HTMLButtonElement>(
        '.zrdb-menu-choice-group[role="group"] button',
      ),
    ].find((button) => button.textContent?.includes("标题"));
    refreshedTitlePin!.click();
    await Zotero.Promise.delay(100);
    const clearPinned = [
      ...customPane!.querySelectorAll<HTMLButtonElement>(
        '.zrdb-menu-choice-group[role="group"] button',
      ),
    ].find((button) => button.textContent?.includes("清除全部固定"));
    assert.exists(clearPinned);
    clearPinned!.click();
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!customPane!.querySelector(".zrdb-header-cell.is-pinned")) break;
      await Zotero.Promise.delay(50);
    }
    assert.lengthOf(
      customPane!.querySelectorAll(".zrdb-header-cell.is-pinned"),
      0,
      "clearing pins leaves no sticky header",
    );
    const unpinnedHeaders = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-header-cell"),
    ];
    assert.isBelow(
      unpinnedHeaders.findIndex((header) =>
        header.textContent?.includes("基础信息"),
      ),
      unpinnedHeaders.findIndex((header) =>
        header.textContent?.includes("标题"),
      ),
      "unpinning restores the shared columnOrder instead of pin insertion order",
    );
    const processingMenu = [
      ...customPane!.querySelectorAll<HTMLDetailsElement>(
        "details.zrdb-menu-submenu",
      ),
    ].find(
      (menu) => menu.querySelector("summary span")?.textContent === "处理工具",
    );
    assert.exists(
      processingMenu,
      "processing actions are grouped in a submenu",
    );
    assert.isFalse(processingMenu!.open, "processing actions start collapsed");
    processingMenu!.querySelector<HTMLElement>("summary")!.click();
    const mineruShortcut = [
      ...processingMenu!.querySelectorAll<HTMLButtonElement>(".zrdb-menu-item"),
    ].find((button) => button.textContent?.includes("MinerU 转换"));
    assert.exists(mineruShortcut, "dedicated MinerU conversion menu item");
    mineruShortcut!.click();
    await Zotero.Promise.delay(80);
    let externalToolsDialog = customPane!.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="文献处理"]',
    );
    assert.exists(externalToolsDialog, "MinerU shortcut dialog");
    let toolTabs = [
      ...externalToolsDialog!.querySelectorAll<HTMLButtonElement>(
        ".zrdb-tool-tabs button",
      ),
    ];
    assert.lengthOf(toolTabs, 2);
    assert.strictEqual(
      toolTabs
        .find((button) => button.textContent?.includes("MinerU 转换"))
        ?.getAttribute("aria-pressed"),
      "true",
      "MinerU shortcut opens the conversion tab directly",
    );
    assert.lengthOf(
      externalToolsDialog!.querySelectorAll(
        'select option[value="local-client"], select option[value="official-api"], select option[value="self-hosted"]',
      ),
      0,
      "conversion dialog does not duplicate long-term MinerU configuration",
    );
    assert.include(externalToolsDialog!.textContent || "", "转换选中 1 篇");
    assert.include(externalToolsDialog!.textContent || "", "打开 MinerU 设置");
    assert.include(
      externalToolsDialog!.textContent || "",
      "请在客户端点击“立即解析”",
    );
    externalToolsDialog!
      .querySelector<HTMLButtonElement>("header button")!
      .click();
    await Zotero.Promise.delay(40);

    const primaryPdfItem = [
      ...customPane!.querySelectorAll<HTMLButtonElement>(".zrdb-menu-item"),
    ].find((button) => button.textContent?.includes("管理主 PDF"));
    assert.exists(
      primaryPdfItem,
      "per-item main PDF management stays available",
    );
    primaryPdfItem!.click();
    await Zotero.Promise.delay(80);
    externalToolsDialog = customPane!.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="文献处理"]',
    );
    assert.exists(externalToolsDialog, "current paper processing dialog");
    toolTabs = [
      ...externalToolsDialog!.querySelectorAll<HTMLButtonElement>(
        ".zrdb-tool-tabs button",
      ),
    ];
    assert.lengthOf(toolTabs, 2);
    assert.strictEqual(
      toolTabs
        .find((button) => button.textContent?.includes("主 PDF"))
        ?.getAttribute("aria-pressed"),
      "true",
      "main PDF entry opens per-item PDF management directly",
    );
    assert.lengthOf(
      externalToolsDialog!.querySelectorAll(
        'select option[value="codex-cli"], select option[value="claude-code"], select option[value="hana-agent"], select option[value="ollama"], select option[value="custom-json-process"]',
      ),
      0,
      "processing dialog does not duplicate Agent configuration",
    );
    assert.include(externalToolsDialog!.textContent || "", "转换此篇");
    externalToolsDialog!
      .querySelector<HTMLButtonElement>("header button")!
      .click();
    await Zotero.Promise.delay(40);
    assert.notInclude(newErrors.join("\n"), "zoteroResearchDatabase.js");
    assert.exists(customPane!.querySelector('[data-mode="table"]'));
    assert.isAbove(customPane!.getBoundingClientRect().height, 0);
    const headers = [...customPane!.querySelectorAll(".zrdb-header-cell")].map(
      (element) => element.textContent || "",
    );
    assert.isTrue(headers.some((label) => label.includes("预览")));
    assert.isTrue(headers.some((label) => label.includes("基础信息")));
    assert.isTrue(
      headers.some((label) => label.includes("论文图表")),
      "default layout includes the figure gallery",
    );
    assert.isFalse(headers.some((label) => label.trim() === "作者"));
    assert.isFalse(headers.some((label) => label.trim() === "年份"));
    assert.isFalse(headers.some((label) => label.trim() === "日期"));
    assert.isFalse(headers.some((label) => label.trim() === "DOI"));
    const foreignTitleRow = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-table-row"),
    ].find((row) => row.textContent?.includes("ZRDB table geometry test"));
    const chineseTitleRow = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-table-row"),
    ].find((row) => row.textContent?.includes("中文标题不需要翻译"));
    assert.exists(
      foreignTitleRow?.querySelector(".zrdb-title-translate"),
      "foreign titles expose the Chinese translation action",
    );
    assert.notExists(
      chineseTitleRow?.querySelector(".zrdb-title-translate"),
      "Chinese titles remain unchanged",
    );

    const galleryProbe = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLElement;
    galleryProbe.className = "zrdb-figure-gallery";
    galleryProbe.style.width = "440px";
    const figureFrameProbe = doc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    ) as HTMLElement;
    figureFrameProbe.className = "zrdb-figure-image-frame";
    galleryProbe.append(figureFrameProbe);
    customPane!.append(galleryProbe);
    const galleryStyle = win.getComputedStyle(galleryProbe);
    assert.equal(galleryStyle.display, "grid");
    assert.lengthOf(
      galleryStyle.gridTemplateColumns.split(/\s+/).filter(Boolean),
      2,
    );
    assert.equal(win.getComputedStyle(figureFrameProbe).borderRadius, "9px");
    galleryProbe.remove();

    const previewStack = customPane!.querySelector<HTMLElement>(
      ".zrdb-pdf-thumbnail-stack",
    );
    assert.exists(
      previewStack,
      "PDF preview renders as a scrollable thumbnail stack",
    );
    assert.include(
      ["auto", "scroll"],
      win.getComputedStyle(previewStack!).overflowY,
    );
    const previewHeader = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-header-cell"),
    ].find((element) => element.dataset.columnId === "pdfPreview");
    assert.exists(previewHeader, "PDF preview header");
    assert.equal(
      previewStack!.style.getPropertyValue("--zrdb-pdf-thumbnail-width"),
      "148px",
      "a fresh default 162px preview column renders a legible 148px bitmap",
    );
    const previewResizer = previewHeader!.querySelector<HTMLElement>(
      ".zrdb-column-resizer",
    );
    assert.exists(previewResizer, "PDF preview column can be resized");
    const previewResizeRect = previewResizer!.getBoundingClientRect();
    const previewStartX = previewResizeRect.left + 2;
    previewResizer!.dispatchEvent(
      new win.PointerEvent("pointerdown", {
        bubbles: true,
        clientX: previewStartX,
        pointerId: 29,
        buttons: 1,
      }),
    );
    win.dispatchEvent(
      new win.PointerEvent("pointermove", {
        bubbles: true,
        clientX: previewStartX + 36,
        pointerId: 29,
        buttons: 1,
      }),
    );
    await Zotero.Promise.delay(40);
    win.dispatchEvent(
      new win.PointerEvent("pointerup", {
        bubbles: true,
        clientX: previewStartX + 36,
        pointerId: 29,
      }),
    );
    await Zotero.Promise.delay(100);
    const resizedPreviewStack = customPane!.querySelector<HTMLElement>(
      ".zrdb-pdf-thumbnail-stack",
    );
    assert.equal(
      resizedPreviewStack!.style.getPropertyValue("--zrdb-pdf-thumbnail-width"),
      "184px",
      "resizing the preview column refreshes the PDF.js target bitmap width",
    );

    const originalTitleCopy = [
      ...customPane!.querySelectorAll<HTMLButtonElement>(
        ".zrdb-original-title-copy",
      ),
    ].find((button) =>
      button
        .closest(".zrdb-table-row")
        ?.textContent?.includes("ZRDB table geometry test"),
    );
    assert.exists(
      originalTitleCopy,
      `title-copy buttons: ${JSON.stringify(
        [
          ...customPane!.querySelectorAll<HTMLButtonElement>(
            ".zrdb-original-title-copy",
          ),
        ].map((button) => ({
          disabled: button.disabled,
          title: button.title,
          label: button.getAttribute("aria-label"),
        })),
      )}; errors: ${JSON.stringify((Zotero as any).getErrors?.(true) || [])}`,
    );
    assert.notExists(customPane!.querySelector(".zrdb-citation-row"));
    assert.notExists(customPane!.querySelector('[aria-label="切换引用格式"]'));
    const internalUtilities = (Zotero.Utilities as any).Internal;
    const originalClipboardCopy = internalUtilities.copyTextToClipboard;
    let copiedTitle = "";
    try {
      internalUtilities.copyTextToClipboard = (value: string) => {
        copiedTitle = value;
      };
      originalTitleCopy!.click();
      await Zotero.Promise.delay(40);
      assert.equal(copiedTitle, String(tableItem.getField("title")));
      assert.equal(originalTitleCopy!.dataset.copyState, "copied");
      assert.equal(
        originalTitleCopy!.getAttribute("aria-label"),
        "原标题已复制",
      );
    } finally {
      internalUtilities.copyTextToClipboard = originalClipboardCopy;
    }
    const copyStyle = win.getComputedStyle(originalTitleCopy!);
    assert.equal(copyStyle.borderTopWidth, "0px");
    assert.equal(copyStyle.backgroundColor, "rgba(0, 0, 0, 0)");
    const titleHeading = originalTitleCopy!.closest<HTMLElement>(
      ".zrdb-paper-title-heading",
    );
    assert.exists(titleHeading, "copy icon is part of the title cell");
    assert.exists(titleHeading!.querySelector("strong"));
    assert.notExists(
      originalTitleCopy!.closest(".zrdb-basic-info"),
      "copy icon is not duplicated in basic information",
    );
    const basicLabel =
      foreignTitleRow?.querySelector<HTMLElement>(".zrdb-basic-row b");
    const basicValue = foreignTitleRow?.querySelector<HTMLElement>(
      ".zrdb-basic-row span",
    );
    assert.exists(basicLabel);
    assert.exists(basicValue);
    assert.isAtLeast(
      Number.parseFloat(win.getComputedStyle(basicLabel!).fontSize),
      11,
    );
    assert.isAtLeast(
      Number.parseFloat(win.getComputedStyle(basicValue!).fontSize),
      13,
    );

    const viewsMenuTrigger = customPane!.querySelector<HTMLButtonElement>(
      '[aria-label="视图与导出"]',
    );
    assert.exists(viewsMenuTrigger);
    viewsMenuTrigger!.click();
    await Zotero.Promise.delay(25);
    const viewsMenu = viewsMenuTrigger!.closest(".zrdb-toolbar-menu");
    assert.exists(viewsMenu);
    assert.notInclude(viewsMenu!.textContent || "", "引用格式");
    viewsMenuTrigger!.click();

    const basicInfoCell =
      foreignTitleRow?.querySelector<HTMLElement>(
        ".zrdb-basic-info",
      )?.parentElement;
    assert.exists(basicInfoCell);
    basicInfoCell!.click();
    await Zotero.Promise.delay(25);
    assert.notExists(basicInfoCell!.querySelector('[aria-label="复制内容"]'));

    const scroll = customPane!.querySelector<HTMLElement>(".zrdb-table-scroll");
    const header = customPane!.querySelector<HTMLElement>(".zrdb-table-header");
    assert.exists(scroll);
    assert.exists(header);
    assert.strictEqual(header!.parentElement, scroll);
    let titleHeader = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-header-cell"),
    ].find((element) => element.textContent?.includes("标题"));
    assert.exists(titleHeader);
    const titleLeft = titleHeader!.getBoundingClientRect().left;
    scroll!.scrollLeft = 120;
    scroll!.dispatchEvent(new win.Event("scroll", { bubbles: true }));
    await Zotero.Promise.delay(25);
    assert.isAbove(scroll!.scrollLeft, 0);
    assert.closeTo(
      titleLeft - titleHeader!.getBoundingClientRect().left,
      scroll!.scrollLeft,
      2,
    );
    scroll!.scrollLeft = 0;

    const basicHeader = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-header-cell"),
    ].find((element) => element.textContent?.includes("基础信息"));
    assert.exists(basicHeader);
    assert.isFalse(titleHeader!.draggable);
    const titleGrip =
      titleHeader!.querySelector<HTMLButtonElement>(".zrdb-column-grip");
    assert.exists(titleGrip);
    assert.isFalse(titleGrip!.draggable);
    assert.lengthOf(titleGrip!.querySelectorAll("i"), 6);
    const gripRect = titleGrip!.getBoundingClientRect();
    titleGrip!.dispatchEvent(
      new win.PointerEvent("pointerdown", {
        bubbles: true,
        clientX: gripRect.left + gripRect.width / 2,
        clientY: gripRect.top + gripRect.height / 2,
        pointerId: 30,
        button: 0,
        buttons: 1,
      }),
    );
    const edgeScrollRect = scroll!.getBoundingClientRect();
    const edgeScrollStart = scroll!.scrollLeft;
    win.dispatchEvent(
      new win.PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: edgeScrollRect.right - 1,
        clientY: gripRect.top + gripRect.height / 2,
        pointerId: 30,
        buttons: 1,
      }),
    );
    await Zotero.Promise.delay(48);
    const edgeScrollFirstFrame = scroll!.scrollLeft;
    await Zotero.Promise.delay(48);
    const edgeScrollSecondFrame = scroll!.scrollLeft;
    assert.isAbove(
      edgeScrollFirstFrame,
      edgeScrollStart,
      "dragging into the right gutter starts horizontal scrolling",
    );
    assert.isAbove(
      edgeScrollSecondFrame,
      edgeScrollFirstFrame,
      "horizontal scrolling continues while the pointer remains at the edge",
    );
    await Zotero.Promise.delay(240);
    assert.isTrue(titleHeader!.classList.contains("is-dragging"));
    const basicRect = basicHeader!.getBoundingClientRect();
    basicHeader!.dispatchEvent(
      new win.PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        clientX: basicRect.right - 1,
        clientY: basicRect.top + basicRect.height / 2,
        pointerId: 30,
        buttons: 1,
      }),
    );
    basicHeader!.dispatchEvent(
      new win.PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        clientX: basicRect.right - 1,
        clientY: basicRect.top + basicRect.height / 2,
        pointerId: 30,
      }),
    );
    const edgeScrollAtRelease = scroll!.scrollLeft;
    await Zotero.Promise.delay(48);
    assert.equal(
      scroll!.scrollLeft,
      edgeScrollAtRelease,
      "horizontal scrolling stops after the column drag is released",
    );
    await Zotero.Promise.delay(120);
    const reorderedHeaders = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-header-cell"),
    ];
    const reorderedTitleIndex = reorderedHeaders.findIndex((element) =>
      element.textContent?.includes("标题"),
    );
    const reorderedBasicIndex = reorderedHeaders.findIndex((element) =>
      element.textContent?.includes("基础信息"),
    );
    assert.isAbove(reorderedTitleIndex, reorderedBasicIndex);
    titleHeader = reorderedHeaders[reorderedTitleIndex];

    const columnResizer = titleHeader!.querySelector<HTMLElement>(
      ".zrdb-column-resizer",
    );
    assert.exists(columnResizer);
    const titleRect = titleHeader!.getBoundingClientRect();
    const columnResizerRect = columnResizer!.getBoundingClientRect();
    assert.isAtLeast(columnResizerRect.left, titleRect.left);
    assert.isAtMost(columnResizerRect.right, titleRect.right + 0.5);
    const widthBefore = Number.parseFloat(titleHeader!.style.width);
    const startX = columnResizerRect.left + 2;
    columnResizer!.dispatchEvent(
      new win.PointerEvent("pointerdown", {
        bubbles: true,
        clientX: startX,
        pointerId: 31,
        buttons: 1,
      }),
    );
    win.dispatchEvent(
      new win.PointerEvent("pointermove", {
        bubbles: true,
        clientX: startX + 48,
        pointerId: 31,
        buttons: 1,
      }),
    );
    await Zotero.Promise.delay(40);
    win.dispatchEvent(
      new win.PointerEvent("pointerup", {
        bubbles: true,
        clientX: startX + 48,
        pointerId: 31,
      }),
    );
    await Zotero.Promise.delay(100);
    const resizedTitle = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-header-cell"),
    ].find((element) => element.textContent?.includes("标题"));
    assert.exists(resizedTitle);
    assert.closeTo(
      Number.parseFloat(resizedTitle!.style.width),
      widthBefore + 48,
      2,
    );

    scroll!.scrollLeft = scroll!.scrollWidth;
    scroll!.dispatchEvent(new win.Event("scroll"));
    await Zotero.Promise.delay(50);
    const headersAtRight = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-header-cell"),
    ];
    const rightmostHeader = headersAtRight.at(-1)!;
    const rightmostResizer = rightmostHeader.querySelector<HTMLElement>(
      ".zrdb-column-resizer",
    );
    assert.exists(rightmostResizer, "rightmost column resizer");
    const rightmostRect = rightmostResizer!.getBoundingClientRect();
    const scrollerRect = scroll!.getBoundingClientRect();
    assert.isAtMost(rightmostRect.right, scrollerRect.right - 8);
    const rightmostWidthBefore = Number.parseFloat(rightmostHeader.style.width);
    const rightmostStartX = rightmostRect.left + 2;
    rightmostResizer!.dispatchEvent(
      new win.PointerEvent("pointerdown", {
        bubbles: true,
        clientX: rightmostStartX,
        pointerId: 34,
        buttons: 1,
      }),
    );
    win.dispatchEvent(
      new win.PointerEvent("pointermove", {
        bubbles: true,
        clientX: rightmostStartX + 36,
        pointerId: 34,
        buttons: 1,
      }),
    );
    await Zotero.Promise.delay(40);
    win.dispatchEvent(
      new win.PointerEvent("pointerup", {
        bubbles: true,
        clientX: rightmostStartX + 36,
        pointerId: 34,
      }),
    );
    await Zotero.Promise.delay(100);
    const resizedRightmost = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-header-cell"),
    ].at(-1)!;
    assert.closeTo(
      Number.parseFloat(resizedRightmost.style.width),
      rightmostWidthBefore + 36,
      2,
    );
    scroll!.scrollLeft = 0;

    const firstRow = customPane!.querySelector<HTMLElement>(".zrdb-table-row");
    assert.exists(firstRow);
    const initialRows = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-table-row"),
    ];
    assert.isAtLeast(initialRows.length, 2);
    const rowDividerStyle = win.getComputedStyle(firstRow!, "::before");
    assert.equal(rowDividerStyle.display, "block");
    assert.equal(rowDividerStyle.height, "1.5px");
    assert.equal(rowDividerStyle.bottom, "0px");
    assert.notEqual(rowDividerStyle.backgroundColor, "rgba(0, 0, 0, 0)");
    const lastInitialRow = initialRows.find((row) =>
      row.classList.contains("is-last-row"),
    );
    assert.exists(lastInitialRow);
    assert.equal(
      win.getComputedStyle(lastInitialRow!, "::before").display,
      "none",
    );
    const rowResizeCue =
      firstRow!.querySelector<HTMLElement>(".zrdb-row-resizer");
    assert.exists(rowResizeCue);
    const rowResizeCueStyle = win.getComputedStyle(rowResizeCue!, "::after");
    assert.equal(rowResizeCueStyle.height, "1.5px");
    assert.equal(rowResizeCueStyle.bottom, "0px");
    assert.closeTo(firstRow!.getBoundingClientRect().height, 270, 2);
    const rowResizer =
      firstRow!.querySelector<HTMLElement>(".zrdb-row-resizer");
    assert.exists(rowResizer);
    const rowRect = firstRow!.getBoundingClientRect();
    const rowResizerRect = rowResizer!.getBoundingClientRect();
    assert.isAtLeast(rowResizerRect.top, rowRect.top);
    assert.isAtMost(rowResizerRect.bottom, rowRect.bottom + 0.5);
    const rowHeightBefore = rowRect.height;
    const startY = rowResizerRect.top + 2;
    rowResizer!.dispatchEvent(
      new win.PointerEvent("pointerdown", {
        bubbles: true,
        clientY: startY,
        pointerId: 32,
        buttons: 1,
      }),
    );
    win.dispatchEvent(
      new win.PointerEvent("pointermove", {
        bubbles: true,
        clientY: startY + 36,
        pointerId: 32,
        buttons: 1,
      }),
    );
    await Zotero.Promise.delay(40);
    win.dispatchEvent(
      new win.PointerEvent("pointerup", {
        bubbles: true,
        clientY: startY + 36,
        pointerId: 32,
      }),
    );
    await Zotero.Promise.delay(100);
    const resizedRow =
      customPane!.querySelector<HTMLElement>(".zrdb-table-row");
    assert.exists(resizedRow);
    assert.closeTo(
      resizedRow!.getBoundingClientRect().height,
      rowHeightBefore + 36,
      2,
    );

    const arrangeMenuTrigger = customPane!.querySelector<HTMLButtonElement>(
      '[aria-label="排列：排序、分组与升降序"]',
    );
    assert.exists(arrangeMenuTrigger);
    arrangeMenuTrigger!.click();
    await Zotero.Promise.delay(25);
    const arrangeMenu = arrangeMenuTrigger!.closest(".zrdb-toolbar-menu");
    const rowHeightMenuButton = [
      ...arrangeMenu!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("统一调整行高"));
    assert.exists(rowHeightMenuButton);
    rowHeightMenuButton!.click();
    await Zotero.Promise.delay(25);
    const rowHeightModal = customPane!.querySelector<HTMLElement>(
      '.zrdb-modal[aria-label="统一调整行高"]',
    );
    assert.exists(rowHeightModal);
    assert.lengthOf(
      rowHeightModal!.querySelectorAll(".zrdb-row-height-node"),
      5,
    );
    for (const label of [
      "220 紧凑",
      "240 标准",
      "270 舒适",
      "300 宽松",
      "340 展开",
    ]) {
      assert.exists(rowHeightModal!.querySelector(`[aria-label="${label}"]`));
    }
    const rowHeightSlider = rowHeightModal!.querySelector<HTMLInputElement>(
      '[aria-label="统一行高"]',
    );
    const widePreset = rowHeightModal!.querySelector<HTMLButtonElement>(
      '[aria-label="300 宽松"]',
    );
    assert.exists(rowHeightSlider);
    assert.exists(widePreset);
    widePreset!.click();
    await Zotero.Promise.delay(25);
    assert.equal(rowHeightSlider!.value, "300");
    const applyRowHeight = [
      ...rowHeightModal!.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.includes("统一全部行"));
    assert.exists(applyRowHeight);
    applyRowHeight!.click();
    await Zotero.Promise.delay(150);
    assert.notExists(
      customPane!.querySelector('.zrdb-modal[aria-label="统一调整行高"]'),
    );
    const unifiedRows = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-table-row"),
    ];
    assert.isNotEmpty(unifiedRows);
    for (const row of unifiedRows)
      assert.closeTo(row.getBoundingClientRect().height, 300, 2);
    const unifiedRow = unifiedRows[0];

    const workspace = await new ResearchRepository().loadWorkspace();
    const manualField = workspace.fields.find(
      (field) => !field.archived && field.id !== TRANSLATED_TITLE_FIELD_ID,
    );
    assert.exists(manualField);
    const tableHeaders = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-header-cell"),
    ];
    const manualColumnIndex = tableHeaders.findIndex((header) =>
      header.textContent?.includes(manualField!.name),
    );
    assert.isAtLeast(manualColumnIndex, 0);
    const tableItemRow = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-table-row"),
    ].find((row) => row.textContent?.includes("ZRDB table geometry test"));
    assert.exists(tableItemRow);
    const editableCell = [
      ...tableItemRow!.querySelectorAll<HTMLElement>(".zrdb-table-cell"),
    ][manualColumnIndex];
    assert.exists(editableCell);
    editableCell!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await Zotero.Promise.delay(25);
    const selectedColumn = customPane!.querySelectorAll(
      ".zrdb-table-cell.is-column-selected",
    );
    assert.isAtLeast(selectedColumn.length, 2);
    editableCell!.dispatchEvent(
      new win.MouseEvent("dblclick", { bubbles: true }),
    );
    await Zotero.Promise.delay(25);
    assert.isTrue(editableCell!.classList.contains("is-active"));
    const editButton = editableCell!.querySelector<HTMLButtonElement>(
      '.zrdb-cell-actions [aria-label="编辑"]',
    );
    assert.exists(editButton);
    editButton!.click();
    await Zotero.Promise.delay(25);
    const finishButton = customPane!.querySelector<HTMLButtonElement>(
      '.zrdb-edit-actions [aria-label="完成编辑"]',
    );
    const cancelButton = customPane!.querySelector<HTMLButtonElement>(
      '.zrdb-edit-actions [aria-label="取消编辑"]',
    );
    assert.exists(finishButton);
    assert.exists(cancelButton);
    const manualValue = "手动保存回归内容";
    const manualEditor = customPane!.querySelector<HTMLTextAreaElement>(
      ".zrdb-inline-editor.multiline",
    );
    assert.exists(manualEditor);
    const textareaValueSetter = Object.getOwnPropertyDescriptor(
      win.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    assert.exists(textareaValueSetter);
    textareaValueSetter!.call(manualEditor, manualValue);
    manualEditor!.dispatchEvent(new win.Event("input", { bubbles: true }));
    await Zotero.Promise.delay(25);
    finishButton!.click();
    await Zotero.Promise.delay(300);
    assert.notExists(customPane!.querySelector(".zrdb-edit-actions"));
    const storedRecord = (await readLocalItemState(tableItem))?.record;
    assert.equal(storedRecord?.fields[manualField!.id]?.value, manualValue);
    assert.notInclude(String(tableItem.getField("extra") || ""), "ZRDB.");
    const reloadedRecord = (await readLocalItemState(tableItem))?.record;
    assert.equal(reloadedRecord?.fields[manualField!.id]?.value, manualValue);
    const nativeRows = (Zotero.ItemPaneManager as any).customInfoRowData
      .options as any[];
    const nativeResearchRow = nativeRows.find((row) =>
      String(row.rowID).includes(`property-${manualField!.id}`),
    );
    assert.exists(nativeResearchRow);
    assert.equal(
      nativeResearchRow.onGetData({
        rowID: nativeResearchRow.rowID,
        item: tableItem,
        tabType: "library",
        editable: true,
      }),
      manualValue,
    );
    Zotero.ItemPaneManager.refreshInfoRow(nativeResearchRow.rowID);
    await Zotero.Promise.delay(120);
    const nativeResearchElement = doc.querySelector<HTMLElement>(
      `[data-custom-row-id="${win.CSS.escape(nativeResearchRow.rowID)}"]`,
    );
    assert.exists(nativeResearchElement);
    assert.equal(
      nativeResearchElement!.querySelector(".meta-label label")?.textContent,
      manualField!.name,
    );
    const reloadedTableItemRow = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-table-row"),
    ].find((row) => row.textContent?.includes("ZRDB table geometry test"));
    assert.include(reloadedTableItemRow?.textContent || "", manualValue);
    const nativeEditedValue = "原生信息行保存回归内容";
    nativeResearchRow.onSetData({
      rowID: nativeResearchRow.rowID,
      item: tableItem,
      tabType: "library",
      editable: true,
      value: nativeEditedValue,
    });
    for (let attempt = 0; attempt < 40; attempt++) {
      const value = (await readLocalItemState(tableItem))?.record?.fields[
        manualField!.id
      ]?.value;
      if (value === nativeEditedValue) break;
      await Zotero.Promise.delay(50);
    }
    assert.equal(
      (await readLocalItemState(tableItem))?.record?.fields[manualField!.id]
        ?.value,
      nativeEditedValue,
    );
    let nativeUpdatedTableRow: HTMLElement | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      nativeUpdatedTableRow = [
        ...customPane!.querySelectorAll<HTMLElement>(".zrdb-table-row"),
      ].find((row) => row.textContent?.includes("ZRDB table geometry test"));
      if (nativeUpdatedTableRow?.textContent?.includes(nativeEditedValue))
        break;
      await Zotero.Promise.delay(50);
    }
    assert.include(nativeUpdatedTableRow?.textContent || "", nativeEditedValue);

    const tableBody =
      customPane!.querySelector<HTMLElement>(".zrdb-table-body");
    assert.exists(tableBody);
    assert.isAtLeast(
      Number.parseFloat(win.getComputedStyle(tableBody!).paddingBottom),
      20,
    );
    scroll!.scrollTop = scroll!.scrollHeight;
    scroll!.dispatchEvent(new win.Event("scroll", { bubbles: true }));
    await Zotero.Promise.delay(120);
    const bottomRows = [
      ...customPane!.querySelectorAll<HTMLElement>(".zrdb-table-row"),
    ];
    const bottomRow = bottomRows[bottomRows.length - 1];
    assert.exists(bottomRow);
    const bottomResizer =
      bottomRow!.querySelector<HTMLElement>(".zrdb-row-resizer");
    assert.exists(bottomResizer);
    assert.equal(bottomResizer!.getAttribute("aria-label"), "拖动调整行高");
    const bottomResizerRect = bottomResizer!.getBoundingClientRect();
    const scrollRect = scroll!.getBoundingClientRect();
    assert.isAtMost(
      bottomResizerRect.bottom,
      scrollRect.top + scroll!.clientHeight - 12,
    );
    const bottomHeightBefore = bottomRow!.getBoundingClientRect().height;
    const bottomStartY = bottomResizerRect.top + 2;
    bottomResizer!.dispatchEvent(
      new win.PointerEvent("pointerdown", {
        bubbles: true,
        clientY: bottomStartY,
        pointerId: 33,
        buttons: 1,
      }),
    );
    win.dispatchEvent(
      new win.PointerEvent("pointermove", {
        bubbles: true,
        clientY: bottomStartY + 24,
        pointerId: 33,
        buttons: 1,
      }),
    );
    await Zotero.Promise.delay(40);
    win.dispatchEvent(
      new win.PointerEvent("pointerup", {
        bubbles: true,
        clientY: bottomStartY + 24,
        pointerId: 33,
      }),
    );
    await Zotero.Promise.delay(100);
    assert.closeTo(
      bottomRow!.getBoundingClientRect().height,
      bottomHeightBefore + 24,
      2,
    );

    clickControl(win, toggleButton!);
    await Zotero.Promise.delay(100);
    assert.isFalse(
      nativePane!.hasAttribute("hidden"),
      "native pane keeps its layout",
    );
    assert.isFalse(nativePane!.classList.contains("zrdb-native-pane-hidden"));
    assert.isTrue(customPane!.hidden);
    assert.notEqual(win.getComputedStyle(nativePane!).display, "none");
    assert.equal(toggleButton!.getAttribute("data-mode"), "default");
    assert.isFalse(toggleButton!.classList.contains("active"));
    assert.isFalse(toggleButton!.hasAttribute("hidden"));
    if (nativeToggle)
      assert.include(
        toggleButton!.getAttribute("image") || "",
        "view-table.svg",
      );
    assert.closeTo(
      toggleButton!.getBoundingClientRect().left,
      stableToggleLeft,
      0.5,
    );
    await tableItem.eraseTx();
    await dividerItem.eraseTx();
  });

  it("keeps the toolbar toggle visible at the configured edge", async function () {
    const win = Zotero.getMainWindow();
    assert.exists(win);
    const doc = win.document;
    const toolbar = doc.querySelector<HTMLElement>("#zotero-items-toolbar");
    assert.exists(toolbar);
    const originalPosition = String(
      Zotero.Prefs.get(`${config.prefsPrefix}.viewTogglePosition`, true) ||
        "right",
    );

    try {
      setPref("viewTogglePosition", "left");
      await Zotero.Promise.delay(100);
      const leftToggle = doc.querySelector<HTMLElement>(
        `#${config.addonRef}-view-toggle`,
      );
      assert.exists(leftToggle);
      assert.strictEqual(toolbar!.firstElementChild, leftToggle);
      const leftRect = leftToggle!.getBoundingClientRect();
      assert.isAbove(leftRect.width, 0, "left toggle width");
      assert.isAbove(leftRect.height, 0, "left toggle height");

      setPref("viewTogglePosition", "right");
      await Zotero.Promise.delay(100);
      const rightToggle = doc.querySelector<HTMLElement>(
        `#${config.addonRef}-view-toggle`,
      );
      assert.exists(rightToggle);
      const rightAnchor = toolbar!.querySelector(
        "#zotero-tb-toggle-item-pane-stacked",
      );
      if (rightAnchor)
        assert.strictEqual(rightAnchor.previousElementSibling, rightToggle);
      else assert.strictEqual(toolbar!.lastElementChild, rightToggle);
      const rightRect = rightToggle!.getBoundingClientRect();
      assert.isAbove(rightRect.width, 0, "right toggle width");
      assert.isAbove(rightRect.height, 0, "right toggle height");
    } finally {
      setPref(
        "viewTogglePosition",
        originalPosition === "left" ? "left" : "right",
      );
      await Zotero.Promise.delay(100);
    }
  });

  it("should refresh database rows when the active Zotero collection changes", async function () {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const first = new Zotero.Item("journalArticle");
    first.libraryID = Zotero.Libraries.userLibraryID;
    first.setField("title", "ZRDB collection source A");
    await first.saveTx();
    const second = new Zotero.Item("journalArticle");
    second.libraryID = Zotero.Libraries.userLibraryID;
    second.setField("title", "ZRDB collection source B");
    await second.saveTx();

    const customPane = doc.querySelector<HTMLElement>(
      `#${config.addonRef}-custom-pane`,
    );
    const toggleButton = doc.querySelector<HTMLButtonElement>(
      `#${config.addonRef}-view-toggle`,
    );
    const collectionTree = doc.querySelector<HTMLElement>(
      "#zotero-collections-tree",
    );
    assert.exists(customPane);
    assert.exists(toggleButton);
    assert.exists(collectionTree);

    const zoteroPane = win.ZoteroPane as any;
    const controller = (
      Zotero[config.addonInstance] as any
    ).data.controllers.get(win) as any;
    const originalGetSortedItems = zoteroPane.getSortedItems;
    const originalLibraryTabActive = controller.libraryTabActive;
    let currentItems = [first];
    zoteroPane.getSortedItems = () => currentItems;
    try {
      if (toggleButton!.getAttribute("data-mode") !== "table")
        clickControl(win, toggleButton!);
      const waitForRows = async (title: string, absentTitle: string) => {
        for (let attempt = 0; attempt < 60; attempt++) {
          const text = customPane!.textContent || "";
          if (text.includes(title) && !text.includes(absentTitle)) return;
          await Zotero.Promise.delay(50);
        }
        assert.include(customPane!.textContent || "", title);
        assert.notInclude(customPane!.textContent || "", absentTitle);
      };

      await waitForRows("ZRDB collection source A", "ZRDB collection source B");
      const firstRoot = controller.root;
      const toolbarButtonCountBefore = doc.querySelectorAll(
        `#${config.addonRef}-view-toggle`,
      ).length;
      // Returning from the PDF reader should refresh the existing React tree
      // with the current library range instead of rebuilding the root.
      controller.handleNotification("select", "tab", ["reader-return-test"], {
        "reader-return-test": { type: "reader" },
      });
      assert.isFalse(controller.libraryTabActive);
      currentItems = [second];
      controller.handleNotification("select", "tab", ["library-return-test"], {
        "library-return-test": { type: "library" },
      });
      await waitForRows("ZRDB collection source B", "ZRDB collection source A");
      assert.include(customPane!.textContent || "", "当前范围 · 1 篇");
      assert.isTrue(controller.libraryTabActive);
      assert.equal(controller.root, firstRoot);
      assert.equal(
        doc.querySelectorAll(`#${config.addonRef}-view-toggle`).length,
        toolbarButtonCountBefore,
      );
    } finally {
      zoteroPane.getSortedItems = originalGetSortedItems;
      controller.libraryTabActive = originalLibraryTabActive;
      if (toggleButton!.getAttribute("data-mode") === "table")
        clickControl(win, toggleButton!);
      await first.eraseTx();
      await second.eraseTx();
    }
  });

  it("should open the resolved PDF from an ordinary cell without leaking control double-clicks", async function () {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "ZRDB real PDF row double-click test");
    parent.setField("date", "2026");
    await parent.saveTx();
    const path = PathUtils.join(
      PathUtils.tempDir,
      `zrdb-row-open-${Date.now()}.pdf`,
    );
    await IOUtils.writeUTF8(path, "%PDF-1.4\n%%EOF\n");
    const pdf = await Zotero.Attachments.importFromFile({
      file: path,
      parentItemID: parent.id,
    });
    pdf.setField("title", "PDF");
    await pdf.saveTx();

    const toggleButton = doc.querySelector<HTMLButtonElement>(
      `#${config.addonRef}-view-toggle`,
    );
    const customPane = doc.querySelector<HTMLElement>(
      `#${config.addonRef}-custom-pane`,
    );
    const originalFileOpen = (Zotero.FileHandlers as any).open;
    const openedIDs: number[] = [];
    try {
      (Zotero.FileHandlers as any).open = (item: Zotero.Item) => {
        openedIDs.push(item.id);
      };
      await win.ZoteroPane.selectItem(parent.id, true);
      if (toggleButton?.getAttribute("data-mode") !== "table")
        clickControl(win, toggleButton!);
      let row: HTMLElement | undefined;
      for (let attempt = 0; attempt < 60; attempt++) {
        row = [
          ...customPane!.querySelectorAll<HTMLElement>(".zrdb-table-row"),
        ].find((entry) =>
          entry.textContent?.includes(parent.getField("title")),
        );
        if (row) break;
        await Zotero.Promise.delay(50);
      }
      assert.exists(row);
      // Basic information may legitimately be hidden in a user-saved view.
      // Any ordinary (non-control) cell must keep the shared PDF double-click
      // route, so prefer it but fall back to the title cell.
      const ordinaryCell =
        row!.querySelector<HTMLElement>(".zrdb-basic-info")?.parentElement ||
        row!.querySelector<HTMLElement>(".zrdb-paper-title")?.parentElement;
      assert.exists(ordinaryCell);
      ordinaryCell!.dispatchEvent(
        new win.MouseEvent("dblclick", { bubbles: true }),
      );
      for (let attempt = 0; attempt < 20 && !openedIDs.length; attempt++)
        await Zotero.Promise.delay(25);
      assert.deepEqual(openedIDs, [pdf.id]);

      const protectedTargets: Element[] = [];
      const translate = row!.querySelector(".zrdb-title-translate");
      const originalTitleCopy = row!.querySelector(".zrdb-original-title-copy");
      if (translate) protectedTargets.push(translate);
      if (originalTitleCopy) protectedTargets.push(originalTitleCopy);

      ordinaryCell!.click();
      await Zotero.Promise.delay(25);
      const actionButton = ordinaryCell!.querySelector(
        ".zrdb-cell-actions button",
      );
      if (actionButton) protectedTargets.push(actionButton);

      const editor = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "textarea",
      );
      editor.className = "zrdb-inline-editor";
      ordinaryCell!.append(editor);
      protectedTargets.push(editor);
      const figureButton = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button",
      );
      figureButton.className = "zrdb-figure-thumb";
      ordinaryCell!.append(figureButton);
      protectedTargets.push(figureButton);

      for (const target of protectedTargets) {
        target.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
        await Zotero.Promise.delay(20);
        assert.deepEqual(
          openedIDs,
          [pdf.id],
          `${(target as HTMLElement).className || target.tagName} does not trigger the row PDF route`,
        );
      }
      editor.remove();
      figureButton.remove();
    } finally {
      (Zotero.FileHandlers as any).open = originalFileOpen;
      if (toggleButton?.getAttribute("data-mode") === "table")
        clickControl(win, toggleButton);
      await Zotero.Promise.delay(80);
      await parent.eraseTx();
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });

  it("should deduplicate imported figure child attachments and update the manifest", async function () {
    let parent: Zotero.Item | undefined;
    let path = "";
    try {
      parent = new Zotero.Item("journalArticle");
      parent.libraryID = Zotero.Libraries.userLibraryID;
      parent.setField("title", "ZRDB figure import test");
      await parent.saveTx();
      path = PathUtils.join(PathUtils.tempDir, `zrdb-figure-${Date.now()}.png`);
      const base64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
      const bytes = Uint8Array.from(atob(base64), (character) =>
        character.charCodeAt(0),
      );
      await (IOUtils as any).write(path, bytes);
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const request = {
        libraryID: parent.libraryID,
        parentItemKey: parent.key,
        workflowRunID: "figure-test",
        artifacts: [
          {
            role: "figure" as const,
            path,
            sha256: hash,
            title: "Figure 1",
            figure: {
              id: "fig-1",
              caption: "测试图",
              pageIndex: 0,
            },
          },
        ],
      };
      const first = (await importArtifacts(request)) as any;
      const second = (await importArtifacts(request)) as any;
      assert.equal(first.artifacts[0].status, "imported");
      assert.equal(second.artifacts[0].status, "unchanged");
      // A rerun with a changed MinerU result retains the child attachment for
      // Zotero's file history, but replaces the current manifest pointer. The
      // database must therefore show exactly one current figure instead of a
      // duplicated/stale figure reference.
      const revisedBytes = Uint8Array.from(bytes);
      revisedBytes[revisedBytes.length - 1] ^= 1;
      const revisedHash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", revisedBytes)),
      )
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      await (IOUtils as any).write(path, revisedBytes);
      const revised = (await importArtifacts({
        ...request,
        workflowRunID: "figure-test-rerun",
        artifacts: [
          {
            ...request.artifacts[0],
            sha256: revisedHash,
          },
        ],
      })) as any;
      assert.equal(revised.artifacts[0].status, "imported");
      const refreshed = await Zotero.Items.getAsync(parent.id);
      const repository = new ResearchRepository();
      const figures = await repository.loadFigures(refreshed);
      assert.lengthOf(figures, 1);
      assert.equal(figures[0].attachmentKey.length, 8);
      assert.equal(figures[0].sha256, revisedHash);
      const artifacts = await repository.loadArtifacts(refreshed);
      const allArtifacts = await repository.loadAllArtifacts(refreshed);
      assert.lengthOf(artifacts, 1);
      assert.lengthOf(allArtifacts, 2);
      assert.equal(artifacts[0].role, "figure");
      assert.equal(artifacts[0].figureID, "fig-1");
      assert.equal(artifacts[0].sha256, revisedHash);
      assert.notInclude(String(refreshed.getField("extra") || ""), "ZRDB.");
      const children = await Zotero.Items.getAsync(refreshed.getAttachments());
      assert.isFalse(
        children.some((child) =>
          child.getTags().some((tag) => tag.tag.startsWith("#ZRDB/")),
        ),
      );
      const win = Zotero.getMainWindow();
      const itemTree = win.ZoteroPane.itemsView as any;
      const visibilityController =
        itemTree.toggleOpenState.__zrdbArtifactVisibilityController;
      assert.isTrue(
        itemTree.toggleOpenState.__zrdbArtifactVisibility === true,
        "real Zotero ItemTree is controlled by the compatibility adapter",
      );
      assert.isTrue(
        itemTree.toggleOpenState.__zrdbArtifactVisibilityEnabled(),
        "managed artifact hiding is enabled",
      );
      // The scaffold test bundle and add-on bundle have separate module
      // globals. Mirror the already-verified manifest through the live add-on
      // repository so this exercises the production notification path.
      await visibilityController.repository.saveManifests(
        refreshed,
        allArtifacts,
        figures,
      );
      await win.ZoteroPane.selectItem(refreshed.id, true);
      await itemTree.refreshAndMaintainSelection();
      const parentRow = itemTree._rowMap[refreshed.id];
      assert.isNumber(
        parentRow,
        "parent is present in the real Zotero ItemTree",
      );
      if (!itemTree.isContainerOpen(parentRow)) {
        await itemTree.toggleOpenState(parentRow);
      }
      assert.isTrue(
        itemTree._rows.some(
          (row: any) => row.ref?.id === refreshed.id && row.level === 0,
        ),
        "parent is a level-0 ItemTree row",
      );
      await visibilityController.refresh();
      await Zotero.Promise.delay(120);
      assert.isFalse(
        itemTree._rows.some((row: any) => row.ref?.id === children[0].id),
        `managed MinerU figure is hidden without deleting the attachment; child=${children[0].key}`,
      );

      // Zotero 10 restores and refreshes open containers inside rowProvider,
      // bypassing ItemTree.toggleOpenState. The provider update listener must
      // remove managed rows again before the update settles.
      itemTree.rowProvider._refreshContainer(parentRow);
      await itemTree.rowProvider.runListeners("update", true, {
        restoreSelection: true,
      });
      assert.isFalse(
        itemTree._rows.some((row: any) => row.ref?.id === children[0].id),
        "Zotero 10 rowProvider rebuild keeps managed artifacts hidden",
      );

      setPref("hideMinerUArtifactsInNativeList", false);
      for (let attempt = 0; attempt < 40; attempt++) {
        if (itemTree._rows.some((row: any) => row.ref?.id === children[0].id)) {
          break;
        }
        await Zotero.Promise.delay(50);
      }
      assert.isTrue(
        itemTree._rows.some((row: any) => row.ref?.id === children[0].id),
        "disabling the local preference restores the native child row",
      );
      setPref("hideMinerUArtifactsInNativeList", true);
      await Zotero.Promise.delay(250);
      assert.isFalse(
        itemTree._rows.some((row: any) => row.ref?.id === children[0].id),
        "re-enabling the preference hides the managed row again",
      );
    } catch (error) {
      const stack =
        error instanceof Error ? error.stack || error.message : String(error);
      throw new Error(`figure dedup test diagnostic:\n${stack}`, {
        cause: error,
      });
    } finally {
      setPref("hideMinerUArtifactsInNativeList", true);
      if (path) await IOUtils.remove(path, { ignoreAbsent: true });
      if (parent) await parent.eraseTx();
    }
  });

  it("renders a PNG thumbnail for a valid local PDF in the Zotero sandbox", async function () {
    this.timeout(60_000);
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "ZRDB PDF thumbnail sandbox test");
    await parent.saveTx();
    const path = PathUtils.join(
      PathUtils.tempDir,
      `zrdb-thumbnail-${Date.now()}.pdf`,
    );
    await IOUtils.write(path, minimalPdfBytes());
    const attachment = await Zotero.Attachments.importFromFile({
      file: path,
      parentItemID: parent.id,
    });
    attachment.setField("title", "PDF");
    await attachment.saveTx();
    clearPdfThumbnailCache();
    const errors: string[] = [];
    const originalLogError = Zotero.logError;
    (Zotero as any).logError = (error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      return originalLogError.call(Zotero, error);
    };

    try {
      const pageCount = await getPdfPageCount(parent);
      assert.equal(
        pageCount,
        1,
        `page-count rendering failed; thumbnail errors: ${JSON.stringify(errors)}; errors: ${JSON.stringify((Zotero as any).getErrors?.(true) || [])}`,
      );
      const thumbnail = await getPdfThumbnail(parent);
      assert.match(
        thumbnail.dataUrl || "",
        /^data:image\/png;base64,/,
        `thumbnail rendering failed: ${JSON.stringify(thumbnail)}; errors: ${JSON.stringify((Zotero as any).getErrors?.(true) || [])}`,
      );
    } finally {
      (Zotero as any).logError = originalLogError;
      clearPdfThumbnailCache();
      await IOUtils.remove(path, { ignoreAbsent: true });
      await parent.eraseTx();
    }
  });

  it("should migrate legacy internal tags into the parent manifest", async function () {
    const parent = new Zotero.Item("journalArticle");
    parent.libraryID = Zotero.Libraries.userLibraryID;
    parent.setField("title", "ZRDB legacy tag migration test");
    await parent.saveTx();
    const path = PathUtils.join(
      PathUtils.tempDir,
      `zrdb-legacy-${Date.now()}.md`,
    );
    await IOUtils.writeUTF8(path, "# MinerU legacy artifact");
    const attachment = await Zotero.Attachments.importFromFile({
      file: path,
      parentItemID: parent.id,
      title: "【MinerU原文】legacy.md",
    } as any);
    const hash = "a".repeat(64);
    attachment.addTag("keep-user-tag");
    attachment.addTag("#ZRDB/role/mineru-original");
    attachment.addTag(`#ZRDB/sha256/${hash}`);
    attachment.addTag("#ZRDB/run/legacy-run");
    await attachment.saveTx();
    setPref("artifactMetadataMigrationVersion", 0);

    try {
      const result = await migrateLegacyInternalTags();
      assert.isAtLeast(result.migrated, 1);
      const refreshedParent = await Zotero.Items.getAsync(parent.id);
      const artifacts = await new ResearchRepository().loadArtifacts(
        refreshedParent,
      );
      const migrated = artifacts.find(
        (entry) => entry.attachmentKey === attachment.key,
      );
      assert.equal(migrated?.role, "mineru-original");
      assert.equal(migrated?.sha256, hash);
      assert.equal(migrated?.runID, "legacy-run");
      const refreshedAttachment = await Zotero.Items.getAsync(attachment.id);
      const tags = refreshedAttachment.getTags().map((entry) => entry.tag);
      assert.include(tags, "keep-user-tag");
      assert.isFalse(tags.some((tag) => tag.startsWith("#ZRDB/")));
      assert.isFalse(
        (await Zotero.Tags.getAll(parent.libraryID)).some((entry) =>
          entry.tag.startsWith("#ZRDB/"),
        ),
      );
    } finally {
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });

  it("should read a completed MinerU Desktop directory without touching the library", async function () {
    const directory = PathUtils.join(
      PathUtils.tempDir,
      `zrdb-mineru-desktop-test-${Date.now()}`,
    );
    const images = PathUtils.join(directory, "images");
    try {
      await IOUtils.makeDirectory(images, { createAncestors: true });
      await IOUtils.writeUTF8(
        PathUtils.join(directory, "full.md"),
        "# Desktop result\n\n正文",
      );
      await IOUtils.writeUTF8(
        PathUtils.join(directory, "content_list.json"),
        JSON.stringify([
          {
            type: "image",
            img_path: "images/figure.png",
            image_caption: ["Desktop Figure"],
            page_idx: 1,
            bbox: [100, 200, 500, 700],
          },
        ]),
      );
      await (IOUtils as any).write(
        PathUtils.join(images, "figure.png"),
        Uint8Array.from([1, 2, 3, 4]),
      );

      const result = await mineruResultFromDirectory(directory, "paper");
      assert.equal(result.markdown, "# Desktop result\n\n正文");
      assert.lengthOf(result.figures, 1);
      assert.equal(result.figures[0].caption, "Desktop Figure");
      assert.equal(result.figures[0].pageIndex, 1);
      assert.deepEqual([...result.figures[0].bytes], [1, 2, 3, 4]);
    } finally {
      await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
    }
  });

  it("should pause database renders while a reader tab is active", async function () {
    const win = Zotero.getMainWindow();
    const controller = (
      Zotero[config.addonInstance] as any
    ).data.controllers.get(win) as any;
    assert.exists(controller);

    const originalRender = controller.render;
    const originalMode = controller.mode;
    const originalLibraryTabActive = controller.libraryTabActive;
    const tabs = win.Zotero_Tabs as any;
    const originalGetTab = tabs._getTab;
    const originalSelectedID = tabs._selectedID;
    let renderCount = 0;
    controller.render = async () => {
      renderCount++;
    };
    controller.mode = "table";
    controller.libraryTabActive = true;

    try {
      // Zotero_Tabs.selectedType is a non-configurable getter backed by
      // _getTab(). Replace that backing lookup so this test exercises the
      // same authoritative reader/library state used in production.
      tabs._getTab = () => ({ tab: { type: "reader" }, tabIndex: 0 });
      controller.handleNotification("select", "tab", ["reader-test"], {
        "reader-test": { type: "reader" },
      });
      controller.refreshListener();
      controller.handleNotification("modify", "item", [999999999], {});
      await Zotero.Promise.delay(120);
      assert.equal(renderCount, 0);

      tabs._getTab = () => ({ tab: { type: "library" }, tabIndex: 0 });
      controller.handleNotification("select", "tab", ["library-test"], {
        "library-test": { type: "library" },
      });
      controller.refreshListener();
      controller.refreshListener();
      await Zotero.Promise.delay(120);
      assert.equal(renderCount, 1);
    } finally {
      controller.cancelScheduledRefresh();
      controller.render = originalRender;
      controller.mode = originalMode;
      controller.libraryTabActive = originalLibraryTabActive;
      tabs._getTab = originalGetTab;
      tabs._selectedID = originalSelectedID;
    }
  });
});
