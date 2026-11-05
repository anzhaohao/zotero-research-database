import { assert } from "chai";
import { createAgentBridge } from "../../src/services/externalAgent";
import { createDefaultFields } from "../../src/domain/defaults";
import { openResearchPreferences } from "../../src/ui/preferencesNavigation";
import {
  listLocalHarnessModels,
  detectLocalHarness,
} from "../../src/services/localHarnessModels";
import { config } from "../../package.json";

describe("local harness CLI in the Zotero host", function () {
  this.timeout(30_000);
  let directory: string;
  let executable: string;
  let script: string;

  before(async function () {
    assert.match(
      PathUtils.profileDir.replace(/\\/g, "/"),
      /\/\.scaffold\/test\/profile\/?$/i,
    );
    executable = String(
      Zotero.Prefs.get(
        "extensions.zotero-research-database.test.localCliNode",
        true,
      ),
    );
    assert.isTrue(
      await IOUtils.exists(executable),
      "test runtime executable exists",
    );
    directory = PathUtils.join(
      PathUtils.tempDir,
      "zrdb-cli-fixture-" + Date.now(),
    );
    await IOUtils.makeDirectory(directory);
    script = PathUtils.join(directory, "fixture.cjs");
    await IOUtils.writeUTF8(
      script,
      `
if(process.argv[2]==='hang'){process.stdin.pause();setInterval(()=>{},1000);return;}
let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',x=>text+=x);
process.stdin.on('end',()=>{
 const mode=process.argv[2];
 if(mode==='models'){process.stdout.write(JSON.stringify({data:[{id:'fixture-model-a'},{id:'fixture-model-b'}]}));return;}
 if(mode==='bad') {process.stdout.write('invalid JSON');return;}
 if(mode==='fail') {process.stderr.write('fixture diagnostic');process.exitCode=7;return;}
 const input=mode==='json'?JSON.parse(text):null;
 const prompt=mode==='argv'?process.argv[3]:text;
 const schema=input?.schema || JSON.parse(prompt.trim().split('\\n').at(-1));
 const result=Object.fromEntries(Object.keys(schema.properties).map(key=>[key,key==='ok'?true:'fixture verified']));
 process.stdout.write(JSON.stringify(result));
});`,
    );
  });

  after(async function () {
    if (directory)
      await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
  });

  it("runs arbitrary CLI prompt input through stdin and arguments, then validates field results", async function () {
    for (const mode of ["stdin", "argv"]) {
      const bridge = createAgentBridge({
        kind: "custom-prompt-cli",
        executable,
        args: [script, mode, ...(mode === "argv" ? ["{prompt}"] : [])],
        timeoutMs: 10000,
      });
      assert.equal((await bridge.probe()).executable, executable);
      await bridge.testStructuredOutput();
      const field = createDefaultFields().find((f) => !f.archived)!;
      const result = await bridge.extractFields(
        [field],
        "fixture paper full text",
      );
      assert.equal(result.value[field.id], "fixture verified");
    }
  });

  it("keeps JSON protocol CLIs functional and surfaces invalid output and process errors", async function () {
    const json = createAgentBridge({
      kind: "custom-json-process",
      executable,
      args: [script, "json"],
      timeoutMs: 10000,
    });
    await json.probe();
    await json.testStructuredOutput();
    for (const [mode, expected] of [
      ["bad", "JSON"],
      ["fail", "fixture diagnostic"],
    ]) {
      try {
        await createAgentBridge({
          kind: "custom-prompt-cli",
          executable,
          args: [script, mode],
          timeoutMs: 10000,
        }).testStructuredOutput();
        assert.fail("fixture should fail");
      } catch (error) {
        assert.include(String(error), expected);
      }
    }
  });

  it("times out a CLI that never reads a full paper from stdin", async function () {
    const bridge = createAgentBridge({
      kind: "custom-prompt-cli",
      executable,
      args: [script, "hang"],
      timeoutMs: 250,
    });
    const started = Date.now();
    try {
      await bridge.extractFields(
        [createDefaultFields().find((field) => !field.archived)!],
        "full paper ".repeat(200_000),
      );
      assert.fail("unresponsive CLI should time out");
    } catch (error) {
      assert.include(String(error), "本机 CLI 超时");
    }
    assert.isBelow(Date.now() - started, 10_000);
  });

  it("queries models from the installed Codex app-server without generating content", async function () {
    if (
      !Zotero.Prefs.get(
        "extensions.zotero-research-database.test.liveModelLists",
        true,
      )
    )
      this.skip();
    this.timeout(40_000);
    const path = await detectLocalHarness("codex-cli");
    assert.match(path, /codex(?:\.exe)?$/i);
    const models = await listLocalHarnessModels({
      kind: "codex-cli",
      executable: path,
      timeoutMs: 30_000,
    });
    assert.isAbove(models.length, 0);
    assert.isTrue(
      models.every((model) => typeof model === "string" && Boolean(model)),
    );
  });

  it("detects Claude Code and queries its configured upstream model list without generation", async function () {
    if (
      !Zotero.Prefs.get(
        "extensions.zotero-research-database.test.liveModelLists",
        true,
      )
    )
      this.skip();
    this.timeout(40_000);
    const path = await detectLocalHarness("claude-code");
    assert.match(path, /claude(?:\.exe)?$/i);
    const models = await listLocalHarnessModels({
      kind: "claude-code",
      executable: path,
      timeoutMs: 30_000,
    });
    assert.isAbove(models.length, 0);
  });

  it("saves named CLI assistants without adding suppliers and restores settings after reopening", async function () {
    const prefix = config.prefsPrefix + ".";
    const keys = Services.prefs
      .getChildList(prefix)
      .filter((key) => Services.prefs.prefHasUserValue(key));
    const snapshot = new Map(
      keys.map((key) => [key, Zotero.Prefs.get(key, true)]),
    );
    let win: Window | undefined;
    async function wait(check: () => boolean, stage = "controls") {
      for (let i = 0; i < 200; i++) {
        if (check()) return;
        await Zotero.Promise.delay(20);
      }
      assert.fail(
        "local CLI controls did not update: " +
          stage +
          "; " +
          win?.document.getElementById("zrdb-pref-status")?.textContent,
      );
    }
    async function closePreferences() {
      if (!win) return;
      const closing = win;
      if (!closing.closed) closing.close();
      await wait(() => {
        if (!closing.closed) return false;
        const windows = Services.wm.getEnumerator("zotero:pref");
        while (windows.hasMoreElements())
          if ((windows.getNext() as unknown as Window) === closing)
            return false;
        return (
          (Services.wm.getMostRecentWindow("zotero:pref") as unknown) !==
          closing
        );
      }, "preferences window leaves mediator");
    }
    try {
      win = await openResearchPreferences("agent");
      assert.notExists(
        win.document.getElementById("zrdb-artifact-import-token"),
      );
      assert.notExists(
        Zotero.Server.Endpoints["/zotero-research-db/v1/artifacts/import"],
      );
      const get = (id: string) =>
        win!.document.getElementById(
          "zrdb-local-harness-" + id,
        ) as HTMLInputElement;
      const providers = win.document.getElementById(
        "zrdb-agent-provider-select",
      ) as HTMLSelectElement;
      const providerCount = providers.options.length;
      const select = win.document.querySelector(
        '[data-pref="agentKind"]',
      ) as HTMLSelectElement;
      const original = select.value;
      if (
        Zotero.Prefs.get(
          "extensions.zotero-research-database.test.liveModelLists",
          true,
        )
      ) {
        get("detect").click();
        await wait(() => !get("detect").disabled, "automatic CLI discovery");
        assert.exists(
          select.querySelector('option[value="detected-codex-cli"]'),
        );
        assert.exists(
          select.querySelector('option[value="detected-claude-code"]'),
        );
        assert.equal(providers.options.length, providerCount);
      }
      const ids: string[] = [];
      for (const kind of [
        "codex-cli",
        "claude-code",
        "custom-prompt-cli",
        "custom-json-process",
      ]) {
        get("add").click();
        get("name").value = "Fixture " + kind;
        get("kind").value = kind;
        get("kind").dispatchEvent(new win.Event("change", { bubbles: true }));
        get("path").value = executable;
        get("args").value = JSON.stringify([
          script,
          kind === "custom-json-process" ? "json" : "stdin",
        ]);
        get("model-args").value = JSON.stringify([script, "models"]);
        get("save").click();
        await wait(
          () =>
            select.selectedOptions[0]?.textContent === "Fixture " + kind &&
            get("editor").hidden,
          "save " + kind,
        );
        ids.push(select.value);
      }
      get("edit").click();
      assert.equal(get("path").value, executable);
      get("name").value = "Renamed CLI";
      get("save").click();
      await wait(
        () =>
          select.selectedOptions[0]?.textContent === "Renamed CLI" &&
          get("editor").hidden,
      );
      const last = select.value;
      assert.equal(last, ids[3]);
      const modelsButton = win.document.getElementById(
        "zrdb-agent-model-refresh",
      ) as HTMLButtonElement;
      assert.isFalse(modelsButton.hidden);
      modelsButton.click();
      await wait(
        () =>
          Boolean(
            win!.document.querySelector(
              '#zrdb-agent-model-select option[value="fixture-model-a"]',
            ),
          ),
        "fetch custom CLI models",
      );
      const model = win.document.getElementById(
        "zrdb-agent-model-select",
      ) as HTMLSelectElement;
      model.value = "fixture-model-a";
      model.dispatchEvent(new win.Event("change", { bubbles: true }));
      const effort = win.document.querySelector(
        '[data-pref="agentReasoningEffort"]',
      ) as HTMLSelectElement;
      effort.value = "high";
      const concurrency = win.document.getElementById(
        "zrdb-agent-concurrency",
      ) as HTMLInputElement;
      concurrency.value = "2";
      select.value = "openai-compatible";
      select.dispatchEvent(new win.Event("change", { bubbles: true }));
      await Zotero.Promise.delay(80);
      const endpoint = win.document.querySelector(
        '[data-pref="agentEndpoint"]',
      ) as HTMLInputElement;
      endpoint.value = "http://127.0.0.1:1/v1";
      const customModel = win.document.getElementById(
        "zrdb-agent-model-custom",
      ) as HTMLInputElement;
      customModel.value = "api-fixture";
      effort.value = "medium";
      concurrency.value = "3";
      select.value = last;
      select.dispatchEvent(new win.Event("change", { bubbles: true }));
      await Zotero.Promise.delay(80);
      assert.equal(customModel.value, "fixture-model-a");
      assert.equal(effort.value, "high");
      assert.equal(concurrency.value, "2");
      select.value = "openai-compatible";
      select.dispatchEvent(new win.Event("change", { bubbles: true }));
      await Zotero.Promise.delay(80);
      assert.equal(endpoint.value, "http://127.0.0.1:1/v1");
      assert.equal(customModel.value, "api-fixture");
      assert.equal(effort.value, "medium");
      assert.equal(concurrency.value, "3");
      select.value = last;
      select.dispatchEvent(new win.Event("change", { bubbles: true }));
      await Zotero.Promise.delay(80);
      for (const id of [original, ...ids]) {
        select.value = id;
        select.dispatchEvent(new win.Event("change", { bubbles: true }));
        await wait(() => select.value === id && get("editor").hidden);
        await Zotero.Promise.delay(30);
      }
      assert.equal(
        providers.options.length,
        providerCount,
        "adding assistants must not create suppliers",
      );
      await closePreferences();
      win = await openResearchPreferences("agent");
      const reopened = win.document.getElementById(
        "zrdb-local-harness-kind",
      ) as HTMLSelectElement;
      const reopenedAssistant = win.document.querySelector(
        '[data-pref="agentKind"]',
      ) as HTMLSelectElement;
      assert.exists(reopened);
      assert.equal(reopenedAssistant.value, last);
      assert.equal(
        reopenedAssistant.selectedOptions[0].textContent,
        "Renamed CLI",
      );
      assert.equal(
        (
          win.document.querySelector(
            '[data-pref="agentExecutable"]',
          ) as HTMLInputElement
        ).value,
        executable,
      );
      assert.equal(
        (
          win.document.querySelector(
            '[data-pref="agentArgs"]',
          ) as HTMLInputElement
        ).value,
        JSON.stringify([script, "json"]),
      );
    } finally {
      await closePreferences();
      for (const key of Services.prefs.getChildList(prefix))
        if (Services.prefs.prefHasUserValue(key))
          Services.prefs.clearUserPref(key);
      for (const [key, value] of snapshot)
        Zotero.Prefs.set(key, value as string | number | boolean, true);
    }
  });
});
