import { expect } from "chai";
import { saveLocalHarness } from "../../src/services/localHarness";
import {
  activeAgentProviderID,
  deleteAgentProvider,
  getAgentModelPresets,
  migrateLegacyHarnessProviders,
  parseAgentProfile,
  readActiveAgentProvider,
  readAgentProfile,
  readAgentProviders,
  saveActiveAgentProvider,
  switchAgentProvider,
  type SavedAgentProvider,
} from "../../src/services/agentSettings";

const previousZotero = (globalThis as any).Zotero;

describe("external Agent settings", function () {
  let prefs: Map<string, string | number | boolean>;

  beforeEach(function () {
    prefs = new Map();
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: string | number | boolean) => {
          prefs.set(key, value);
          return true;
        },
      },
    };
  });

  afterEach(function () {
    (globalThis as any).Zotero = previousZotero;
  });

  function setRawPref(key: string, value: string | number | boolean): void {
    prefs.set(`extensions.zotero.zoteroResearchDatabase.${key}`, value);
  }

  function provider(
    id: string,
    name: string,
    model: string,
  ): SavedAgentProvider {
    return {
      id,
      name,
      ...parseAgentProfile({
        kind: "openai-compatible",
        executable: "",
        args: "[]",
        endpoint: `https://${id}.example.com/v1`,
        apiKey: `${id}-secret`,
        model,
        reasoningEffort: "medium",
        apiProtocol: "responses",
        timeoutMs: 30000,
      }),
    };
  }

  it("moves generated CLI suppliers into assistants without losing saved model settings", function () {
    const api = provider("api", "API", "api-model");
    const cli: SavedAgentProvider = {
      id: "local-cli-123",
      name: "My Codex",
      kind: "codex-cli",
      executable: "C:\\Tools\\codex.exe",
      args: [],
      model: "cli-model",
      reasoningEffort: "high",
      timeoutMs: 60000,
    };
    saveActiveAgentProvider(api, [api]);
    saveActiveAgentProvider(cli);
    migrateLegacyHarnessProviders();
    expect(readAgentProviders()).to.have.length(1);
    const current = readActiveAgentProvider();
    expect(current).to.include({
      id: "api",
      assistantID: cli.id,
      model: "cli-model",
      executable: cli.executable,
    });
    expect(current.assistantProfiles?.[cli.id].reasoningEffort).to.equal(
      "high",
    );
    expect(current.assistantProfiles?.["openai-compatible"].apiKey).to.equal(
      api.apiKey,
    );
    migrateLegacyHarnessProviders();
    expect(readAgentProviders()).to.have.length(1);
  });

  it("parses a direct JSON process without constructing a shell command", function () {
    expect(
      parseAgentProfile({
        kind: "custom-json-process",
        executable: "C:\\tools\\paper-agent.exe",
        args: '["--mode","zotero"]',
        endpoint: "",
        model: "",
        timeoutMs: 30000,
      }),
    ).to.deep.equal({
      kind: "custom-json-process",
      executable: "C:\\tools\\paper-agent.exe",
      args: ["--mode", "zotero"],
      endpoint: undefined,
      model: undefined,
      timeoutMs: 30000,
    });
  });

  it("rejects free-form process arguments", function () {
    expect(() =>
      parseAgentProfile({
        kind: "custom-json-process",
        executable: "agent.exe",
        args: "--mode zotero",
        endpoint: "",
        model: "",
        timeoutMs: 30000,
      }),
    ).to.throw("JSON 字符串数组");
  });

  it("uses automatic CLI discovery and retires Hana settings", function () {
    const common = {
      executable: "",
      args: "[]",
      endpoint: "",
      model: "",
      timeoutMs: 30000,
    };
    const claude = parseAgentProfile({ ...common, kind: "claude-code" });
    expect(claude.executable).to.equal(undefined);
    const codex = parseAgentProfile({
      ...common,
      kind: "codex-cli",
      executable: "codex",
    });
    expect(codex.executable).to.equal(undefined);
    expect(
      parseAgentProfile({
        ...common,
        kind: "codex-cli",
        executable: " /opt/custom/codex ",
      }).executable,
    ).to.equal("/opt/custom/codex");
    const hana = parseAgentProfile({ ...common, kind: "hana-agent" });
    expect(hana.kind).to.equal("codex-cli");
  });

  it("keeps an OpenAI-compatible endpoint, API key and custom model", function () {
    const profile = parseAgentProfile({
      kind: "openai-compatible",
      executable: "",
      args: "[]",
      endpoint: "https://example.com/compatible/v1/",
      apiKey: "  local-secret  ",
      model: "  provider/model  ",
      timeoutMs: 30000,
    });
    expect(profile).to.include({
      kind: "openai-compatible",
      endpoint: "https://example.com/compatible/v1/",
      apiKey: "local-secret",
      model: "provider/model",
    });
  });

  it("offers model suggestions per assistant while keeping newer models editable", function () {
    expect(
      getAgentModelPresets("codex-cli").map((option) => option.value),
    ).to.include.members(["", "gpt-5.6-sol"]);
    expect(
      getAgentModelPresets("claude-code").map((option) => option.value),
    ).to.include.members(["fable", "claude-sonnet-4-5"]);
    expect(
      getAgentModelPresets("claude-code").map((option) => option.value),
    ).not.to.include("ds");
    expect(getAgentModelPresets("openai-compatible")).to.deep.equal([]);
    expect(getAgentModelPresets("ollama")).to.deep.equal([]);
  });

  it("persists a supported reasoning effort and ignores invalid values", function () {
    const common = {
      kind: "claude-code",
      executable: "claude",
      args: "[]",
      endpoint: "",
      model: "fable",
      timeoutMs: 30000,
    };
    expect(
      parseAgentProfile({ ...common, reasoningEffort: "high" }).reasoningEffort,
    ).to.equal("high");
    expect(
      parseAgentProfile({ ...common, reasoningEffort: "ultra" })
        .reasoningEffort,
    ).to.equal(undefined);
  });

  it("inherits the legacy single provider without discarding its credentials", function () {
    setRawPref("agentKind", "openai-compatible");
    setRawPref("agentEndpoint", "https://legacy.example.com/v1");
    setRawPref("agentApiKey", "legacy-secret");
    setRawPref("agentModel", "legacy-model");
    setRawPref("agentProtocol", "responses");
    setRawPref("agentReasoningEffort", "high");
    setRawPref("agentTimeoutMs", 45000);

    expect(readAgentProviders()).to.have.length(1);
    expect(readAgentProfile()).to.include({
      kind: "openai-compatible",
      endpoint: "https://legacy.example.com/v1",
      apiKey: "legacy-secret",
      model: "legacy-model",
      apiProtocol: "responses",
      reasoningEffort: "high",
      timeoutMs: 45000,
    });
    expect(activeAgentProviderID()).to.equal("default");
  });

  it("saves, switches, updates and deletes providers without losing settings", function () {
    const first = provider("default", "默认供应商", "model-a");
    const second = provider("second", "第二个", "model-b");
    saveActiveAgentProvider(first);
    saveActiveAgentProvider(second);
    expect(readAgentProviders().map((entry) => entry.id)).to.deep.equal([
      "default",
      "second",
    ]);

    expect(switchAgentProvider("default").model).to.equal("model-a");
    saveActiveAgentProvider({ ...first, model: "model-a-new" });
    expect(readActiveAgentProvider()).to.include({
      id: "default",
      model: "model-a-new",
      apiKey: "default-secret",
    });
    expect(
      readAgentProviders().find((entry) => entry.id === "second"),
    ).to.include({ model: "model-b", apiKey: "second-secret" });

    expect(deleteAgentProvider("default").id).to.equal("second");
    expect(activeAgentProviderID()).to.equal("second");
    expect(readActiveAgentProvider().model).to.equal("model-b");
    expect(() => deleteAgentProvider("second")).to.throw("至少需要保留一个");
  });

  it("keeps assistant-specific API credentials separate and resolves updated CLI paths", function () {
    const api = provider("default", "供应商", "api-model");
    const cli = {
      kind: "custom-prompt-cli" as const,
      executable: "/old/cli",
      model: "cli-model",
      timeoutMs: 30_000,
    };
    saveLocalHarness({ id: "assistant-cli", name: "My CLI", ...cli });
    saveActiveAgentProvider({
      id: api.id,
      name: api.name,
      ...cli,
      assistantID: "assistant-cli",
      assistantProfiles: { "openai-compatible": api, "assistant-cli": cli },
    });
    saveLocalHarness({
      id: "assistant-cli",
      name: "My CLI",
      ...cli,
      executable: "/new/cli",
    });
    expect(readAgentProfile()).to.include({
      executable: "/new/cli",
      model: "cli-model",
      assistantID: "assistant-cli",
    });
    const saved = readAgentProviders()[0];
    expect(saved.apiKey).to.equal(undefined);
    expect(saved.assistantProfiles?.["openai-compatible"]).to.include({
      model: "api-model",
      apiKey: "default-secret",
      apiProtocol: "responses",
    });
    expect(readAgentProviders()).to.have.length(1);
  });

  it("does not overwrite a damaged provider list with legacy settings", function () {
    setRawPref("agentProviders", "{not-json");
    expect(() => readAgentProviders()).to.throw("供应商配置已损坏");
    expect(() =>
      saveActiveAgentProvider(provider("new", "新供应商", "m")),
    ).to.throw("供应商配置已损坏");
    expect(
      prefs.get("extensions.zotero.zoteroResearchDatabase.agentProviders"),
    ).to.equal("{not-json");
  });

  it("keeps the same model's concurrency separate across saved suppliers", function () {
    const key = JSON.stringify(["openai-compatible", "same-model"]);
    const first = {
      ...provider("default", "First", "same-model"),
      modelConcurrency: { [key]: 2 },
    };
    const second = {
      ...provider("second", "Second", "same-model"),
      modelConcurrency: { [key]: 6 },
    };
    saveActiveAgentProvider(first);
    saveActiveAgentProvider(second);
    expect(switchAgentProvider("default").modelConcurrency).to.deep.equal({
      [key]: 2,
    });
    expect(switchAgentProvider("second").modelConcurrency).to.deep.equal({
      [key]: 6,
    });
    expect(
      JSON.parse(
        String(
          prefs.get(
            "extensions.zotero.zoteroResearchDatabase.agentModelConcurrency",
          ),
        ),
      ),
    ).to.deep.equal({ [key]: 6 });
    expect(readAgentProviders()[0].modelConcurrency).to.deep.equal({
      [key]: 2,
    });
  });

  it("rejects duplicate provider IDs and unknown switches", function () {
    const first = provider("same", "一", "a");
    saveActiveAgentProvider(first);
    expect(() =>
      saveActiveAgentProvider(provider("new", "二", "b"), [
        first,
        provider("same", "重复", "c"),
      ]),
    ).to.throw("不能重复");
    expect(() => switchAgentProvider("missing")).to.throw("找不到所选供应商");
  });
});
