import { expect } from "chai";
import { parseAgentProfile } from "../../src/services/agentSettings";

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
});
