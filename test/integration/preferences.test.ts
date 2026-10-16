import { assert } from "chai";
import { config } from "../../package.json";
import { ResearchRepository } from "../../src/storage/repository";
import {
  openResearchPreferences,
  type ResearchPreferencesSection,
} from "../../src/ui/preferencesNavigation";
import { clickControl } from "../uiHelpers";
import { DATA_ROOT_SETTINGS, getDataRoot } from "../../src/storage/dataRoot";

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

async function eventually(check: () => boolean, message: () => string) {
  const deadline = Date.now() + 8000;
  while (!check()) {
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
  element.scrollIntoView({ block: "center", inline: "nearest" });
  await Zotero.Promise.delay(60);
  clickControl(win as unknown as _ZoteroTypes.MainWindow, element);
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
      agentModel: "ZRDB preferences 测试 model",
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
      Zotero.Prefs.set(PREFIX + "mineruMode", "self-hosted", true);
      Zotero.Prefs.set(
        PREFIX + "mineruSelfHostedEndpoint",
        "http://127.0.0.1:18000",
        true,
      );
      Zotero.Prefs.set(PREFIX + "mineruArgs", "[]", true);
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
      }
      stage = "change string value";
      setValue("agentModel", String(expected.agentModel));
      await open("mineru");
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
      const workspace = await new ResearchRepository().loadWorkspace();
      await open("fields");
      stage = "wait for field editor initialization";
      await eventually(
        () =>
          win!.document.querySelectorAll("#zrdb-fields-list .zrdb-pref-field")
            .length === workspace.fields.length,
        () => "field rows did not initialize; " + windowDiagnostics(win),
      );
      const rows = [
        ...win!.document.querySelectorAll<HTMLElement>(
          "#zrdb-fields-list .zrdb-pref-field",
        ),
      ];
      for (const [index, field] of workspace.fields.entries()) {
        const name = rows[index].querySelector<HTMLInputElement>(
          'input[placeholder="字段名称"]',
        );
        assert.exists(name, field.id + " field name editor");
        assert.equal(name!.value, field.name);
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
        workspace.fields.length + 1,
        "one click adds one unsaved field after repeated opening",
      );
    } catch (error) {
      const candidate =
        win || (isolated ? mostRecentPreferencesWindow() : undefined);
      failure = nativeError(error, stage + "; " + windowDiagnostics(candidate));
      if (windowErrors.length)
        failure.message += "\n" + windowErrors.join("\n");
    }
    if (isolated) {
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
    }
    if (failure) throw failure;
  });
});
