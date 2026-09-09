import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { expect } from "chai";
import { config } from "../../package.json";
import { resetDataRootScope } from "../../src/storage/dataRoot";
import {
  flushPortableSettings,
  getPortableSetting,
  initializePortableSettings,
  isPortableSettingsReady,
  resetPortableSettingsScope,
} from "../../src/storage/settingsStore";
import { getPref, setPref } from "../../src/utils/prefs";

describe("portable settings persistence", function () {
  let root: string;
  let prefs: Map<string, unknown>;
  let previous: Record<string, unknown>;
  let failWrites: boolean;
  let holdWrites: Promise<void> | undefined;
  const runtime = globalThis as any;
  const prefKey = (key: string) => `${config.prefsPrefix}.${key}`;
  const settingsPath = () => join(root, "settings.json");
  const readSettings = async () =>
    JSON.parse(await readFile(settingsPath(), "utf8"));
  const seedSettings = (values: Record<string, unknown>) =>
    writeFile(
      settingsPath(),
      JSON.stringify({ schemaVersion: 1, values }),
      "utf8",
    );

  beforeEach(async function () {
    root = await mkdtemp(join(tmpdir(), "zrdb-settings-"));
    previous = {
      IOUtils: runtime.IOUtils,
      PathUtils: runtime.PathUtils,
      Zotero: runtime.Zotero,
    };
    prefs = new Map([[prefKey("dataRoot"), root]]);
    failWrites = false;
    holdWrites = undefined;
    resetDataRootScope();
    resetPortableSettingsScope();
    runtime.PathUtils = {
      profileDir: join(root, "profile"),
      join,
      normalize,
      isAbsolute,
    };
    runtime.Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: unknown) => prefs.set(key, value),
      },
      logError: () => undefined,
    };
    runtime.IOUtils = {
      exists: (path: string) =>
        access(path).then(
          () => true,
          () => false,
        ),
      read: async (path: string) => new Uint8Array(await readFile(path)),
      writeUTF8: async (path: string, content: string) => {
        await holdWrites;
        if (failWrites) throw new Error("simulated disk full");
        await writeFile(path, content, "utf8");
        return content.length;
      },
      makeDirectory: (path: string) => mkdir(path, { recursive: true }),
      move: (source: string, target: string) => rename(source, target),
      remove: (path: string) => rm(path, { force: true }),
    };
  });

  afterEach(async function () {
    await flushPortableSettings().catch(() => undefined);
    resetPortableSettingsScope();
    resetDataRootScope();
    Object.assign(runtime, previous);
    await rm(root, { recursive: true, force: true });
  });

  it("waits for disk and never reloads old values during a repeated initialization", async function () {
    await seedSettings({ agentModel: "old", motionEnabled: true });
    await initializePortableSettings();
    let release!: () => void;
    holdWrites = new Promise<void>((resolve) => {
      release = resolve;
    });
    setPref("agentModel", "new");
    setPref("motionEnabled", false);
    let flushed = false;
    const saving = flushPortableSettings().then(() => {
      flushed = true;
    });
    try {
      await initializePortableSettings();
      expect(flushed).to.equal(false);
      expect(getPref("agentModel")).to.equal("new");
      expect((await readSettings()).values.agentModel).to.equal("old");
    } finally {
      release();
      await saving;
    }
    expect((await readSettings()).values).to.include({
      agentModel: "new",
      motionEnabled: false,
    });
    resetPortableSettingsScope();
    prefs.set(prefKey("agentModel"), "stale-pref");
    await initializePortableSettings();
    expect(getPref("agentModel")).to.equal("new");
    expect(getPref("motionEnabled")).to.equal(false);
  });

  it("excludes local credentials and the bootstrap pointer when loading, reading and writing", async function () {
    prefs.set(prefKey("artifactImportToken"), "local-secret");
    await seedSettings({
      agentModel: "old",
      artifactImportToken: "copied-secret",
      dataRoot: "wrong-root",
      unknown: "unknown",
    });
    await initializePortableSettings();
    expect(getPref("artifactImportToken")).to.equal("local-secret");
    expect(getPref("dataRoot")).to.equal(root);
    expect(getPortableSetting("artifactImportToken")).to.equal(undefined);
    setPref("artifactImportToken", "rotated-secret");
    setPref("dataRoot", root);
    setPref("agentModel", "new");
    await flushPortableSettings();
    expect((await readSettings()).values).to.deep.equal({ agentModel: "new" });
    expect(getPref("artifactImportToken")).to.equal("rotated-secret");
  });

  it("reports failed persistence and permits a later save to retry", async function () {
    await seedSettings({ agentModel: "old" });
    await initializePortableSettings();
    failWrites = true;
    setPref("agentModel", "new");
    let failure: unknown;
    try {
      await flushPortableSettings();
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).to.include("simulated disk full");
    expect((await readSettings()).values.agentModel).to.equal("old");
    failWrites = false;
    setPref("agentModel", "retry");
    await flushPortableSettings();
    expect((await readSettings()).values.agentModel).to.equal("retry");
  });

  it("retries initialization after the first settings write fails", async function () {
    const originalWrite = runtime.IOUtils.writeUTF8;
    runtime.IOUtils.writeUTF8 = async (path: string, content: string) => {
      if (path.startsWith(settingsPath()))
        throw new Error("first settings write failed");
      return originalWrite(path, content);
    };
    let failure: unknown;
    try {
      await initializePortableSettings();
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).to.include("first settings write failed");
    expect(isPortableSettingsReady()).to.equal(false);
    runtime.IOUtils.writeUTF8 = originalWrite;
    await initializePortableSettings();
    setPref("agentModel", "retry");
    await flushPortableSettings();
    expect((await readSettings()).values.agentModel).to.equal("retry");
  });

  it("preserves invalid JSON and schemas instead of replacing them with preferences", async function () {
    for (const content of [
      "{broken",
      '{"schemaVersion":2,"values":{}}',
      '{"schemaVersion":1,"values":[]}',
    ]) {
      resetPortableSettingsScope();
      await writeFile(settingsPath(), content, "utf8");
      let failure: unknown;
      try {
        await initializePortableSettings();
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      setPref("agentModel", "must-not-overwrite");
      await flushPortableSettings().catch(() => undefined);
      expect(await readFile(settingsPath(), "utf8")).to.equal(content);
    }
  });

  it("loads a valid recovery file when the primary settings file is absent", async function () {
    await writeFile(
      `${settingsPath()}.bak`,
      JSON.stringify({ schemaVersion: 1, values: { agentModel: "recovered" } }),
      "utf8",
    );
    await initializePortableSettings();
    expect(getPref("agentModel")).to.equal("recovered");
    setPref("motionEnabled", false);
    await flushPortableSettings();
    expect((await readSettings()).values.agentModel).to.equal("recovered");
  });
});
