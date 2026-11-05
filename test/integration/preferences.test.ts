import { assert } from "chai";
import { config } from "../../package.json";
import { ResearchRepository } from "../../src/storage/repository";
import {
  openResearchPreferences,
  type ResearchPreferencesSection,
} from "../../src/ui/preferencesNavigation";
import { clickControl } from "../uiHelpers";
import { DATA_ROOT_SETTINGS, getDataRoot } from "../../src/storage/dataRoot";
import { TRANSLATED_TITLE_FIELD_ID } from "../../src/domain/defaults";
import type { WorkspaceState } from "../../src/domain/types";
import { createEmptyRecord, setManualValue } from "../../src/core/records";

type PrefValue = string | boolean | number;
type Control = HTMLInputElement | HTMLSelectElement;
const PREFIX = config.prefsPrefix + ".";

function nativeError(error: unknown, stage: string): Error {
  const property = (key: string): string => {
    try {
      return String((error as Record<string, unknown> | null)?.[key] ?? "");
    } catch {
      return "(unreadable cross-realm property)";
    }
  };
  const result = new Error(
    "[preferences regression: " +
      stage +
      "]\n" +
      "name: " +
      property("name") +
      "\n" +
      "message: " +
      (property("message") || String(error)) +
      "\n" +
      "source stack: " +
      property("stack"),
  );
  result.name = "PreferencesRegressionError";
  // Scaffold sends failures through JSON.stringify(error); native Error
  // message/stack properties are otherwise omitted and the CLI prints undefined.
  for (const key of ["message", "stack"] as const) {
    Object.defineProperty(result, key, {
      value: result[key] || "",
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

async function eventually(
  check: () => boolean | Promise<boolean>,
  message: () => string,
) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(message());
    await Zotero.Promise.delay(25);
  }
}

function snapshotUserPrefs(): Map<string, PrefValue> {
  const result = new Map<string, PrefValue>();
  for (const key of Services.prefs.getChildList(PREFIX)) {
    if (Services.prefs.prefHasUserValue(key))
      result.set(key, Zotero.Prefs.get(key, true) as PrefValue);
  }
  return result;
}

function restoreUserPrefs(snapshot: Map<string, PrefValue>) {
  for (const key of Services.prefs.getChildList(PREFIX)) {
    if (Services.prefs.prefHasUserValue(key)) Services.prefs.clearUserPref(key);
  }
  for (const [key, value] of snapshot) Zotero.Prefs.set(key, value, true);
}

function control(win: Window, key: string): Control {
  const result = win.document.querySelector<Control>(
    '[data-pref="' + key + '"]',
  );
  assert.exists(result, "preference control " + key);
  return result!;
}

async function clickVisible(win: Window, element: HTMLElement) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    await Zotero.Promise.delay(100);
    const rect = element.getBoundingClientRect();
    const hit = win.document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (element === hit || element.contains(hit)) {
      clickControl(win as unknown as _ZoteroTypes.MainWindow, element);
      return;
    }
  }
  const rect = element.getBoundingClientRect();
  const hit = win.document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  throw new Error(
    `control ${element.id || element.className} remained unclickable; ` +
      JSON.stringify({
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        viewport: { width: win.innerWidth, height: win.innerHeight },
        hit: hit?.id || hit?.className || hit?.localName,
      }),
  );
}

async function closePreferences(win: Window | undefined) {
  if (!win) return;
  if (!win.closed) win.close();
  await eventually(
    () => {
      if (!win.closed) return false;
      const windows = Services.wm.getEnumerator("zotero:pref");
      while (windows.hasMoreElements()) {
        if ((windows.getNext() as unknown as Window) === win) return false;
      }
      // The most-recent index can lag behind the enumerator during teardown.
      return (
        (Services.wm.getMostRecentWindow("zotero:pref") as unknown) !== win
      );
    },
    () =>
      "preferences window did not finish closing and leave the window mediator",
  );
}

function windowDiagnostics(win: Window | undefined): string {
  try {
    if (!win) return "window unavailable";
    if (win.closed) return "window closed";
    const doc = win.document;
    const root = doc.getElementById("zrdb-preferences-root");
    return JSON.stringify({
      readyState: doc.readyState,
      root: Boolean(root),
      bound: root?.getAttribute("data-zrdb-bound"),
      roots: doc.querySelectorAll("#zrdb-preferences-root").length,
      tabs: doc.querySelectorAll("[data-pref-tab]").length,
      fields: doc.querySelectorAll("#zrdb-fields-list .zrdb-pref-field").length,
      status: doc.getElementById("zrdb-pref-status")?.textContent,
    });
  } catch (error) {
    return nativeError(error, "reading window diagnostics").message;
  }
}

function mostRecentPreferencesWindow(): Window | undefined {
  try {
    return Services.wm.getMostRecentWindow("zotero:pref") as unknown as
      Window | undefined;
  } catch {
    // Diagnostic fallback must not mask the original failure (e.g. Services
    // being unavailable in the test realm).
    return undefined;
  }
}

describe("preferences persistence in the real Zotero settings window", function () {
  it("saves typed settings, restores checkboxes after reopening, and initializes fields once", async function () {
    this.timeout(60_000);
    let isolated = false;
    let snapshot: Map<string, PrefValue> | undefined;
    let win: Window | undefined;
    let stage = "initialization";
    let failure: Error | undefined;
    // Exercise the same repository and local-data module cache as the loaded
    // plugin. A separately bundled repository would overwrite item history
    // with its own stale workspace snapshot during these cross-window checks.
    const controller = (
      Zotero[config.addonInstance] as any
    ).data.controllers.get(Zotero.getMainWindow());
    const repository = controller.repository as ResearchRepository;
    let originalWorkspace: WorkspaceState | undefined;
    let workspaceTouched = false;
    let historyItem: Zotero.Item | undefined;
    let testFieldID: string | undefined;
    let titleInitiallyVisible: boolean | undefined;
    const windowErrors: string[] = [];
    const trackedWindows = new Set<Window>();
    const onWindowError = (event: Event) => {
      const error = event as ErrorEvent;
      windowErrors.push(
        nativeError(error.error ?? error.message, "window error").message,
      );
    };
    const open = async (section: ResearchPreferencesSection) => {
      stage = "open section " + section;
      win = await openResearchPreferences(section);
      if (!trackedWindows.has(win)) {
        win.addEventListener("error", onWindowError);
        trackedWindows.add(win);
      }
      const root = win.document.getElementById("zrdb-preferences-root");
      assert.equal(
        root?.getAttribute("data-zrdb-bound"),
        "1",
        "controller is bound",
      );
      assert.equal(
        win.document
          .querySelector('[data-pref-tab="' + section + '"]')
          ?.getAttribute("aria-selected"),
        "true",
        section + " tab selected",
      );
      return win;
    };
    const expected: Record<string, PrefValue> = {
      zoteroFigureEnabled: true,
      zoteroFigureShowFigures: false,
      zoteroFigureShowTables: true,
      zoteroFigureShowFormulas: true,
      mineruFigureFallback: false,
      figureImageQuality: "standard",
      motionEnabled: true,
      defaultRowHeight: 216,
      agentApiKey: "ZRDB preferences local API key",
      agentModel: "ZRDB preferences 测试 model",
      agentReasoningEffort: "high",
      agentProtocol: "responses",
      mineruOfficialToken: "ZRDB preferences saved MinerU token",
      mineruEnableFormula: false,
      mineruEnableTable: true,
    };
    try {
      stage = "verify isolated profile";
      assert.match(
        PathUtils.profileDir.replace(/\\/g, "/"),
        /\/\.scaffold\/test\/profile\/?$/i,
        "preferences regression is restricted to the isolated test profile",
      );
      isolated = true;
      stage = "snapshot original preferences";
      snapshot = snapshotUserPrefs();
      stage = "close existing isolated preferences window";
      await closePreferences(
        Services.wm.getMostRecentWindow("zotero:pref") as unknown as
          Window | undefined,
      );
      stage = "seed baseline preferences";
      for (const [key, value] of Object.entries(expected)) {
        const initial = typeof value === "boolean" ? !value : value;
        Zotero.Prefs.set(PREFIX + key, initial, true);
      }
      Zotero.Prefs.set(PREFIX + "defaultRowHeight", 144, true);
      Zotero.Prefs.set(PREFIX + "figureImageQuality", "high", true);
      Zotero.Prefs.set(PREFIX + "agentModel", "initial model", true);
      Zotero.Prefs.set(PREFIX + "agentKind", "codex-cli", true);
      Zotero.Prefs.set(PREFIX + "agentArgs", "[]", true);
      Zotero.Prefs.set(PREFIX + "agentProviders", "", true);
      Zotero.Prefs.set(PREFIX + "agentProviderID", "default", true);
      Zotero.Prefs.set(PREFIX + "mineruMode", "self-hosted", true);
      Zotero.Prefs.set(
        PREFIX + "mineruSelfHostedEndpoint",
        "http://127.0.0.1:18000",
        true,
      );
      Zotero.Prefs.set(
        PREFIX + "mineruSharedStoreDirectory",
        "E:\\software\\Zotero\\mineru-shared-store",
        true,
      );
      Zotero.Prefs.set(PREFIX + "artifactStorageRoot", "", true);

      const seededControls: Array<{
        key: string;
        expected: boolean;
        actual: boolean;
      }> = [];
      const first = await open("figures");
      for (const key of [
        "zoteroFigureEnabled",
        "zoteroFigureShowFigures",
        "zoteroFigureShowTables",
        "zoteroFigureShowFormulas",
        "mineruFigureFallback",
      ]) {
        stage = "toggle real checkbox " + key;
        const input = control(first, key) as HTMLInputElement;
        assert.equal(input.namespaceURI, "http://www.w3.org/1999/xhtml");
        assert.equal(input.localName, "input");
        assert.equal(input.type, "checkbox");
        seededControls.push({
          key,
          expected: !expected[key],
          actual: input.checked,
        });
        if (input.checked !== expected[key]) await clickVisible(first, input);
        assert.strictEqual(input.checked, expected[key], key + " UI selection");
      }
      const setValue = (key: string, value: string) => {
        const element = control(win!, key);
        element.value = value;
        element.dispatchEvent(new win!.Event("input", { bubbles: true }));
        element.dispatchEvent(new win!.Event("change", { bubbles: true }));
      };
      setValue("figureImageQuality", "standard");
      assert.strictEqual(
        await open("general"),
        first,
        "section change reuses window",
      );
      stage = "change numeric and general checkbox values";
      setValue("defaultRowHeight", "216");
      const motion = control(win!, "motionEnabled") as HTMLInputElement;
      if (!motion.checked) await clickVisible(win!, motion);
      await open("agent");
      stage = "verify model picker choices";
      const agentKind = control(win!, "agentKind") as HTMLSelectElement;
      assert.exists(
        agentKind.querySelector('option[value="openai-compatible"]'),
        "OpenAI-compatible third-party models are configurable",
      );
      const executableControl = control(
        win!,
        "agentExecutable",
      ) as HTMLInputElement;
      const executableField = executableControl.closest(
        "[data-agent-kinds]",
      ) as HTMLElement | null;
      assert.isFalse(
        executableField?.hidden,
        "Codex exposes a manual executable path when automatic discovery fails",
      );
      assert.notExists(
        agentKind.querySelector('option[value="hana-agent"]'),
        "retired Hana settings are absent",
      );
      assert.strictEqual(
        (control(win!, "agentApiKey") as HTMLInputElement).type,
        "password",
        "API keys use a password control",
      );
      const modelSelect = win!.document.getElementById(
        "zrdb-agent-model-select",
      ) as HTMLSelectElement | null;
      assert.exists(modelSelect, "model picker is a real select control");
      assert.exists(
        modelSelect?.querySelector('option[value="gpt-5.6-sol"]'),
        "Codex model choices are visible",
      );
      assert.isAtLeast(
        modelSelect?.options.length ?? 0,
        4,
        "model picker lists real choices instead of an empty list",
      );
      if (modelSelect) {
        modelSelect.value = "gpt-5.6-sol";
        modelSelect.dispatchEvent(new win!.Event("change", { bubbles: true }));
        assert.strictEqual(
          (control(win!, "agentModel") as HTMLInputElement).value,
          "gpt-5.6-sol",
          "selecting a model updates the persisted control",
        );
        const concurrency = win!.document.getElementById(
          "zrdb-agent-concurrency",
        ) as HTMLInputElement;
        assert.exists(concurrency, "model concurrency is editable");
        concurrency.value = "4";
        const other = Array.from(modelSelect.options).find(
          (option) =>
            option.value &&
            option.value !== "__custom__" &&
            option.value !== "gpt-5.6-sol",
        )!;
        modelSelect.value = other.value;
        modelSelect.dispatchEvent(new win!.Event("change", { bubbles: true }));
        assert.equal(
          concurrency.value,
          "1",
          "a new CLI model defaults to one field",
        );
        concurrency.value = "2";
        modelSelect.value = "gpt-5.6-sol";
        modelSelect.dispatchEvent(new win!.Event("change", { bubbles: true }));
        assert.equal(
          concurrency.value,
          "4",
          "switching back restores the model concurrency",
        );
      }
      stage = "switch assistants and reload their model choices";
      agentKind.value = "claude-code";
      agentKind.dispatchEvent(new win!.Event("change", { bubbles: true }));
      assert.isFalse(
        executableField?.hidden,
        "Claude Code exposes the same manual executable path control",
      );
      assert.strictEqual(
        executableControl.value,
        "",
        "switching CLIs leaves executable discovery automatic",
      );
      assert.strictEqual(
        (control(win!, "agentModel") as HTMLInputElement).value,
        "",
        "switching assistants clears the previous model immediately",
      );
      assert.exists(
        modelSelect?.querySelector('option[value="fable"]'),
        "Claude Code exposes the fable alias",
      );
      assert.notExists(
        modelSelect?.querySelector('option[value="ds"]'),
        "a model from another assistant cannot leak into Claude Code",
      );
      if (modelSelect) {
        modelSelect.value = "fable";
        modelSelect.dispatchEvent(new win!.Event("change", { bubbles: true }));
        assert.strictEqual(
          (control(win!, "agentModel") as HTMLInputElement).value,
          "fable",
        );
      }
      stage = "change string value";
      setValue("agentApiKey", String(expected.agentApiKey));
      setValue("agentModel", String(expected.agentModel));
      setValue("agentReasoningEffort", String(expected.agentReasoningEffort));
      setValue("agentProtocol", String(expected.agentProtocol));
      (
        win!.document.getElementById(
          "zrdb-agent-concurrency",
        ) as HTMLInputElement
      ).value = "3";
      await open("mineru");
      stage = "verify MinerU token control";
      assert.strictEqual(
        (control(win!, "mineruOfficialToken") as HTMLInputElement).type,
        "password",
        "MinerU API tokens use a password control",
      );
      setValue("mineruMode", "official-api");
      setValue("mineruOfficialEndpoint", "https://mineru.net/api/v4");
      setValue("mineruOfficialToken", String(expected.mineruOfficialToken));
      for (const key of ["mineruEnableFormula", "mineruEnableTable"]) {
        stage = "toggle MinerU checkbox " + key;
        const input = control(win!, key) as HTMLInputElement;
        if (input.checked !== expected[key]) await clickVisible(win!, input);
      }
      stage = "save local settings via real button";
      const save = win!.document.getElementById(
        "zrdb-pref-save",
      ) as HTMLElement;
      assert.exists(save);
      await clickVisible(win!, save);
      await eventually(
        () =>
          Boolean(
            win!.document
              .getElementById("zrdb-pref-status")
              ?.textContent?.includes("已保存本机设置"),
          ),
        () => "save did not succeed; " + windowDiagnostics(win),
      );
      stage = "read actual Zotero preference values and native types";
      for (const [key, value] of Object.entries(expected)) {
        const actual = Zotero.Prefs.get(PREFIX + key, true);
        assert.strictEqual(
          actual,
          value,
          key + " persisted value (typeof " + typeof actual + ")",
        );
        const nativeType =
          typeof value === "boolean"
            ? 128
            : typeof value === "number"
              ? 64
              : 32;
        assert.equal(
          Services.prefs.getPrefType(PREFIX + key),
          nativeType,
          key + " native preference type",
        );
      }
      const savedProviders = JSON.parse(
        String(Zotero.Prefs.get(PREFIX + "agentProviders", true) || "[]"),
      ) as Array<Record<string, unknown>>;
      assert.lengthOf(savedProviders, 1, "saving creates the provider list");
      assert.equal(
        (savedProviders[0].modelConcurrency as Record<string, number>)[
          JSON.stringify(["codex-cli", "gpt-5.6-sol"])
        ],
        4,
      );
      assert.equal(
        (savedProviders[0].modelConcurrency as Record<string, number>)[
          JSON.stringify(["claude-code", expected.agentModel])
        ],
        3,
      );
      assert.include(savedProviders[0], {
        id: "default",
        model: expected.agentModel,
        apiKey: expected.agentApiKey,
        apiProtocol: expected.agentProtocol,
        reasoningEffort: expected.agentReasoningEffort,
      });
      // Save/readback runs before checking the seed, so a failing old version
      // reports its real setter behavior rather than assuming string pollution.
      stage = "check initial typed preference loading";
      for (const sample of seededControls)
        assert.strictEqual(
          sample.actual,
          sample.expected,
          sample.key + " loaded checkbox state",
        );

      stage = "close saved preferences";
      await closePreferences(win);
      const reopened = await open("figures");
      assert.notStrictEqual(
        reopened,
        first,
        "reopening creates a new settings document",
      );
      stage = "verify saved controls after reopening";
      for (const [key, value] of Object.entries(expected)) {
        const element = control(reopened, key);
        if (typeof value === "boolean")
          assert.strictEqual(
            (element as HTMLInputElement).checked,
            value,
            key + " restored checkbox",
          );
        else
          assert.equal(element.value, String(value), key + " restored value");
      }

      stage = "manage multiple providers in the real settings window";
      await open("agent");
      assert.equal(
        (
          win!.document.getElementById(
            "zrdb-agent-concurrency",
          ) as HTMLInputElement
        ).value,
        "3",
        "model concurrency survives closing and reopening settings",
      );
      const providerSelect = win!.document.getElementById(
        "zrdb-agent-provider-select",
      ) as HTMLSelectElement;
      assert.exists(providerSelect);
      assert.strictEqual(providerSelect.value, "default");
      assert.strictEqual(providerSelect.options.length, 1);
      const protocolSelect = control(
        win!,
        "agentProtocol",
      ) as HTMLSelectElement;
      assert.exists(protocolSelect.querySelector('option[value="responses"]'));
      assert.exists(
        protocolSelect.querySelector('option[value="chat-completions"]'),
      );

      const secondModel = "ZRDB preferences second model";
      setValue("agentModel", secondModel);
      setValue("agentReasoningEffort", "medium");
      const originalPrompt = win!.prompt;
      (win as any).prompt = () => "ZRDB 第二供应商";
      try {
        await clickVisible(
          win!,
          win!.document.getElementById(
            "zrdb-agent-provider-save",
          ) as HTMLElement,
        );
      } finally {
        (win as any).prompt = originalPrompt;
      }
      await eventually(
        () => providerSelect.options.length === 2,
        () => "new provider was not added; " + windowDiagnostics(win),
      );
      const secondProviderID = providerSelect.value;
      assert.notEqual(secondProviderID, "default");
      const currentProviders = JSON.parse(
        String(Zotero.Prefs.get(PREFIX + "agentProviders", true) || "[]"),
      ) as Array<Record<string, unknown>>;
      const secondProvider = currentProviders.find(
        (entry) => entry.id === secondProviderID,
      );
      assert.exists(secondProvider);
      assert.include(secondProvider!, {
        name: "ZRDB 第二供应商",
        model: secondModel,
        reasoningEffort: "medium",
        apiProtocol: "responses",
        apiKey: expected.agentApiKey,
      });

      providerSelect.value = "default";
      providerSelect.dispatchEvent(new win!.Event("change", { bubbles: true }));
      await eventually(
        () =>
          (control(win!, "agentModel") as HTMLInputElement).value ===
            String(expected.agentModel) &&
          Zotero.Prefs.get(PREFIX + "agentProviderID", true) === "default",
        () => "switching did not restore the default provider",
      );
      providerSelect.value = secondProviderID;
      providerSelect.dispatchEvent(new win!.Event("change", { bubbles: true }));
      await eventually(
        () =>
          (control(win!, "agentModel") as HTMLInputElement).value ===
          secondModel,
        () => "switching did not restore the second provider",
      );
      await clickVisible(
        win!,
        win!.document.getElementById(
          "zrdb-agent-provider-delete",
        ) as HTMLElement,
      );
      await eventually(
        () => providerSelect.options.length === 1,
        () => "deleting did not switch to the remaining provider",
      );
      assert.strictEqual(providerSelect.value, "default");
      assert.strictEqual(
        (control(win!, "agentModel") as HTMLInputElement).value,
        String(expected.agentModel),
      );
      assert.isTrue(
        (
          win!.document.getElementById(
            "zrdb-agent-provider-delete",
          ) as HTMLButtonElement
        ).disabled,
        "the final provider cannot be deleted",
      );

      stage = "restrict API reasoning choices without a network request";
      const currentAgentKind = control(win!, "agentKind") as HTMLSelectElement;
      currentAgentKind.value = "openai-compatible";
      protocolSelect.dispatchEvent(new win!.Event("change", { bubbles: true }));
      const effortSelect = control(
        win!,
        "agentReasoningEffort",
      ) as HTMLSelectElement;
      assert.isFalse(
        (effortSelect.closest("label") as HTMLElement).hidden,
        "API reasoning effort is visible",
      );
      for (const value of ["xhigh", "max"]) {
        const option = effortSelect.querySelector(
          'option[value="' + value + '"]',
        ) as HTMLOptionElement;
        assert.isTrue(option.disabled, value + " is disabled for API profiles");
        assert.isTrue(option.hidden, value + " is hidden for API profiles");
      }
      currentAgentKind.value = "claude-code";
      protocolSelect.dispatchEvent(new win!.Event("change", { bubbles: true }));

      const workspace = await repository.loadWorkspace();
      originalWorkspace = JSON.parse(
        JSON.stringify(workspace),
      ) as WorkspaceState;
      const editableFields = workspace.fields.filter(
        (field) => !field.archived && field.id !== TRANSLATED_TITLE_FIELD_ID,
      );
      await open("fields");
      stage = "wait for field editor initialization";
      await eventually(
        () =>
          win!.document.querySelectorAll("#zrdb-fields-list .zrdb-pref-field")
            .length === editableFields.length,
        () => "field rows did not initialize; " + windowDiagnostics(win),
      );
      const nativeRows = [
        ...win!.document.querySelectorAll<HTMLElement>(
          "#zrdb-fields-list .zrdb-pref-native-column",
        ),
      ];
      assert.deepEqual(
        nativeRows.map((row) => row.dataset.columnId),
        ["pdfPreview", "title", "basicInfo", "figureGallery"],
      );
      for (const row of nativeRows) {
        assert.exists(
          row.querySelector('input[type="checkbox"][data-column-visibility]'),
        );
        assert.notExists(row.querySelector("textarea, button, select"));
      }
      const rows = [
        ...win!.document.querySelectorAll<HTMLElement>(
          "#zrdb-fields-list .zrdb-pref-field",
        ),
      ];
      for (const [index, field] of editableFields.entries()) {
        const name = rows[index].querySelector<HTMLInputElement>(
          'input[placeholder="自定义标题"]',
        );
        assert.exists(name, field.id + " field name editor");
        assert.equal(name!.value, field.name);
        assert.exists(
          rows[index].querySelector('textarea[aria-label="给 Agent 的提示词"]'),
        );
        assert.exists(rows[index].querySelector(".zrdb-field-delete"));
        assert.notExists(rows[index].querySelector("select"));
        assert.equal(rows[index].querySelectorAll("input").length, 2);
      }
      stage = "repeat opening fields without duplicating controller bindings";
      assert.strictEqual(await open("fields"), reopened);
      assert.equal(
        win!.document.querySelectorAll("#zrdb-preferences-root").length,
        1,
      );
      const add = win!.document.getElementById("zrdb-add-field") as HTMLElement;
      assert.exists(add);
      await clickVisible(win!, add);
      assert.equal(
        win!.document.querySelectorAll("#zrdb-fields-list .zrdb-pref-field")
          .length,
        editableFields.length + 1,
        "one click adds one unsaved field after repeated opening",
      );
      const addedRow = win!.document.querySelector<HTMLElement>(
        "#zrdb-fields-list .zrdb-pref-field:last-child",
      );
      assert.exists(addedRow);
      const addedFieldID = addedRow!.dataset.fieldId!;
      testFieldID = addedFieldID;
      const remove = addedRow!.querySelector<HTMLElement>(".zrdb-field-delete");
      assert.exists(remove);
      await clickVisible(win!, remove!);
      const archived = win!.document.getElementById(
        "zrdb-archived-fields",
      ) as HTMLDetailsElement;
      assert.equal(archived.hidden, false);
      const summary = archived.querySelector<HTMLElement>("summary");
      assert.exists(summary);
      await clickVisible(win!, summary!);
      assert.equal(archived.open, true);
      const restore = archived.querySelector<HTMLElement>(
        `[data-field-id="${addedFieldID}"] .zrdb-field-restore`,
      );
      assert.exists(restore);
      await clickVisible(win!, restore!);
      assert.equal(
        win!.document.querySelectorAll("#zrdb-fields-list .zrdb-pref-field")
          .length,
        editableFields.length + 1,
        "restoring returns the field without clearing its historical values",
      );
      assert.equal(
        win!.document.querySelector<HTMLElement>(
          "#zrdb-fields-list .zrdb-pref-field:last-child",
        )?.dataset.fieldId,
        addedFieldID,
      );

      stage = "edit and save shared column visibility";
      const restoredRow = win!.document.querySelector<HTMLElement>(
        `#zrdb-fields-list [data-field-id="${addedFieldID}"]`,
      );
      assert.exists(restoredRow);
      const titleInput = restoredRow!.querySelector<HTMLInputElement>(
        'input[placeholder="自定义标题"]',
      );
      const promptInput = restoredRow!.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="给 Agent 的提示词"]',
      );
      assert.exists(titleInput);
      assert.exists(promptInput);
      titleInput!.value = "集成测试字段";
      titleInput!.dispatchEvent(new win!.Event("change", { bubbles: true }));
      promptInput!.value = "提取用于集成测试的内容";
      promptInput!.dispatchEvent(new win!.Event("change", { bubbles: true }));
      for (const id of ["title", addedFieldID]) {
        const visibility = win!.document.querySelector<HTMLInputElement>(
          `#zrdb-fields-list input[data-column-visibility="${id}"]`,
        );
        assert.exists(visibility);
        if (id === "title") titleInitiallyVisible = visibility!.checked;
        if (visibility!.checked) await clickVisible(win!, visibility!);
      }
      const saveFields = win!.document.getElementById(
        "zrdb-save-fields",
      ) as HTMLElement;
      assert.exists(saveFields);
      workspaceTouched = true;
      await clickVisible(win!, saveFields);
      await eventually(
        async () => {
          const saved = await repository.loadWorkspace();
          return saved.fields.some((field) => field.id === addedFieldID);
        },
        () => "field and column settings were not saved",
      );
      const saved = await repository.loadWorkspace();
      const savedField = saved.fields.find(
        (field) => field.id === addedFieldID,
      );
      assert.exists(savedField);
      assert.equal(savedField!.name, "集成测试字段");
      assert.equal(
        savedField!.extraction.instruction,
        "提取用于集成测试的内容",
      );
      assert.equal(savedField!.extraction.enabled, true);
      assert.isNotEmpty(saved.views);
      for (const view of saved.views) {
        assert.deepEqual(
          view.layout.visibleColumnIDs,
          saved.views[0].layout.visibleColumnIDs,
          `${view.id} uses shared visibility`,
        );
        assert.notInclude(view.layout.visibleColumnIDs, "title");
        assert.notInclude(view.layout.visibleColumnIDs, addedFieldID);
      }
      for (const field of saved.fields.filter((field) => !field.archived))
        assert.equal(field.extraction.enabled, true, `${field.id} extraction`);

      stage = "archive and restore a saved field without losing history";
      historyItem = new Zotero.Item("journalArticle");
      historyItem.libraryID = Zotero.Libraries.userLibraryID;
      historyItem.setField("title", "ZRDB field archive history test");
      await historyItem.saveTx();
      await repository.saveRecord(
        historyItem,
        setManualValue(
          createEmptyRecord(historyItem.libraryID, historyItem.key),
          addedFieldID,
          "归档后仍需保留",
        ),
        saved.fields,
      );
      const savedRow = win!.document.querySelector<HTMLElement>(
        `#zrdb-fields-list [data-field-id="${addedFieldID}"]`,
      );
      await clickVisible(
        win!,
        savedRow!.querySelector<HTMLElement>(".zrdb-field-delete")!,
      );
      await clickVisible(win!, saveFields);
      await eventually(
        async () =>
          Boolean(
            (await repository.loadWorkspace()).fields.find(
              (field) => field.id === addedFieldID,
            )?.archived,
          ),
        () => "archived field state was not saved",
      );
      assert.equal(
        (await repository.loadRecord(historyItem))?.fields[addedFieldID]?.value,
        "归档后仍需保留",
      );

      const savedArchive = win!.document.getElementById(
        "zrdb-archived-fields",
      ) as HTMLDetailsElement;
      if (!savedArchive.open) {
        await clickVisible(win!, savedArchive.querySelector("summary")!);
      }
      await clickVisible(
        win!,
        savedArchive.querySelector<HTMLElement>(
          `[data-field-id="${addedFieldID}"] .zrdb-field-restore`,
        )!,
      );
      await clickVisible(win!, saveFields);
      await eventually(
        async () =>
          !(await repository.loadWorkspace()).fields.find(
            (field) => field.id === addedFieldID,
          )?.archived,
        () => "restored field state was not saved",
      );
      const restored = await repository.loadWorkspace();
      const restoredField = restored.fields.find(
        (field) => field.id === addedFieldID,
      );
      assert.equal(restoredField?.name, "集成测试字段");
      assert.equal(
        restoredField?.extraction.instruction,
        "提取用于集成测试的内容",
      );
      assert.notInclude(
        restored.views[0].layout.visibleColumnIDs,
        addedFieldID,
        "restoring preserves the hidden state",
      );
      assert.equal(
        (await repository.loadRecord(historyItem))?.fields[addedFieldID]?.value,
        "归档后仍需保留",
      );
    } catch (error) {
      const candidate =
        win || (isolated ? mostRecentPreferencesWindow() : undefined);
      failure = nativeError(error, stage + "; " + windowDiagnostics(candidate));
      if (windowErrors.length)
        failure.message += "\n" + windowErrors.join("\n");
    }
    if (isolated) {
      if (workspaceTouched && win && !win.closed) {
        try {
          await open("fields");
          if (titleInitiallyVisible !== undefined) {
            const titleVisibility =
              win.document.querySelector<HTMLInputElement>(
                '#zrdb-fields-list input[data-column-visibility="title"]',
              );
            if (
              titleVisibility &&
              titleVisibility.checked !== titleInitiallyVisible
            )
              await clickVisible(win, titleVisibility);
          }
          if (testFieldID) {
            const testRow = win.document.querySelector<HTMLElement>(
              `#zrdb-fields-list [data-field-id="${testFieldID}"]`,
            );
            const remove =
              testRow?.querySelector<HTMLElement>(".zrdb-field-delete");
            if (remove) await clickVisible(win, remove);
          }
          const cleanupSave = win.document.getElementById(
            "zrdb-save-fields",
          ) as HTMLElement | null;
          if (cleanupSave) await clickVisible(win, cleanupSave);
          await eventually(
            async () => {
              const current = await repository.loadWorkspace();
              const testField = current.fields.find(
                (field) => field.id === testFieldID,
              );
              return (
                (!testField || testField.archived) &&
                (titleInitiallyVisible === undefined ||
                  current.views.every((view) =>
                    titleInitiallyVisible
                      ? view.layout.visibleColumnIDs.includes("title")
                      : !view.layout.visibleColumnIDs.includes("title"),
                  ))
              );
            },
            () => "live field and column state was not restored",
          );
        } catch (error) {
          const cleanup = nativeError(error, "restore live field controls");
          if (failure) failure.message += "\n" + cleanup.message;
          else failure = cleanup;
        }
      }
      try {
        for (const tracked of trackedWindows)
          if (!tracked.closed)
            tracked.removeEventListener("error", onWindowError);
        await closePreferences(win || mostRecentPreferencesWindow());
      } catch (error) {
        const cleanup = nativeError(error, "close isolated preferences window");
        if (failure) failure.message += "\n" + cleanup.message;
        else failure = cleanup;
      }
      // Preference restoration still runs if closing the window failed.
      if (snapshot) {
        try {
          restoreUserPrefs(snapshot);
        } catch (error) {
          const cleanup = nativeError(error, "restore isolated preferences");
          if (failure) failure.message += "\n" + cleanup.message;
          else failure = cleanup;
        }
      }
      try {
        if (workspaceTouched && originalWorkspace)
          await repository.saveWorkspace(originalWorkspace);
        if (historyItem?.id) await historyItem.eraseTx();
      } catch (error) {
        const cleanup = nativeError(error, "restore isolated workspace");
        if (failure) failure.message += "\n" + cleanup.message;
        else failure = cleanup;
      }
    }
    if (failure) throw failure;
  });
});
