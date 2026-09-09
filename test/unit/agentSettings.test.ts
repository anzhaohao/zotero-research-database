import { expect } from "chai";
import {
  getAgentModelPresets,
  parseAgentProfile,
} from "../../src/services/agentSettings";

describe("external Agent settings", function () {
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

  it("supplies the verified Claude Code and HanaAgent local presets", function () {
    const common = {
      executable: "",
      args: "[]",
      endpoint: "",
      model: "",
      timeoutMs: 30000,
    };
    const claude = parseAgentProfile({ ...common, kind: "claude-code" });
    expect(claude.executable).to.equal(
      "C:\\Users\\anzhaofeng\\.local\\bin\\claude.exe",
    );
    const hana = parseAgentProfile({ ...common, kind: "hana-agent" });
    expect(hana.executable).to.equal("E:\\software\\Hanako\\HanaAgent.exe");
    expect(hana.endpoint).to.equal(
      "C:\\Users\\anzhaofeng\\.hanako\\server-info.json",
    );
  });

  it("offers model suggestions per assistant while keeping newer models editable", function () {
    expect(
      getAgentModelPresets("codex-cli").map((option) => option.value),
    ).to.include.members(["", "gpt-5.6-sol"]);
    expect(
      getAgentModelPresets("claude-code").map((option) => option.value),
    ).to.include("claude-sonnet-4-5");
    expect(getAgentModelPresets("hana-agent")).to.deep.equal([]);
    expect(getAgentModelPresets("ollama")).to.deep.equal([]);
  });
});
