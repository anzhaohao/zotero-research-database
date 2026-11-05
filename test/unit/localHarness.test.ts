import { expect } from "chai";
import {
  localHarnessProvider,
  localPromptInvocation,
} from "../../src/services/localHarness";
import { parseAgentProfile } from "../../src/services/agentSettings";

describe("local CLI configuration", function () {
  const input = {
    id: "cli",
    name: "My CLI",
    kind: "custom-prompt-cli",
    executable: "C:\\Tools\\my cli.exe",
    args: '["--print","{prompt}"]',
  };

  it("accepts arbitrary local programs and preserves their adapter", function () {
    const provider = localHarnessProvider(input);
    expect(provider).to.include({
      name: "My CLI",
      kind: "custom-prompt-cli",
      executable: input.executable,
    });
    expect(
      parseAgentProfile({ ...provider, args: JSON.stringify(provider.args) })
        .kind,
    ).to.equal("custom-prompt-cli");
    expect(
      localHarnessProvider({ ...input, kind: "custom-json-process" }).kind,
    ).to.equal("custom-json-process");
  });

  it("allows built-in discovery but requires a command for other CLIs", function () {
    expect(
      localHarnessProvider({ ...input, kind: "codex-cli", executable: "" })
        .executable,
    ).to.equal(undefined);
    expect(
      localHarnessProvider({ ...input, kind: "claude-code", executable: "" })
        .executable,
    ).to.equal(undefined);
    expect(() => localHarnessProvider({ ...input, executable: "" })).to.throw(
      "程序路径",
    );
    expect(() => localHarnessProvider({ ...input, name: " " })).to.throw(
      "名称",
    );
    expect(() => localHarnessProvider({ ...input, args: "--print" })).to.throw(
      "JSON",
    );
    expect(() => localHarnessProvider({ ...input, kind: "unknown" })).to.throw(
      "调用方式",
    );
  });

  it("preserves model settings while editing and does not copy settings across adapters", function () {
    const previous = {
      ...localHarnessProvider(input),
      model: "model-a",
      reasoningEffort: "high" as const,
      modelConcurrency: { '["custom-prompt-cli","model-a"]': 2 },
    };
    expect(localHarnessProvider({ ...input, previous })).to.include({
      model: "model-a",
      reasoningEffort: "high",
    });
    expect(
      localHarnessProvider({ ...input, previous, kind: "claude-code" }).model,
    ).to.equal(undefined);
  });

  it("sends the prompt and schema to stdin by default", function () {
    const result = localPromptInvocation(["--print"], "paper", {
      type: "object",
    });
    expect(result.arguments).to.deep.equal(["--print"]);
    expect(result.stdin).to.include("paper").and.include('"type":"object"');
  });

  it("expands only declared placeholders as literal argument values", function () {
    const result = localPromptInvocation(
      [
        "--prompt",
        "{prompt}",
        "--model={model}",
        "{effort}",
        "{schema}",
        "$HOME;$(echo secret)",
      ],
      "paper {model}",
      { type: "object" },
      "my model",
      "high",
    );
    expect(result.stdin).to.equal("");
    expect(result.arguments[1]).to.include("paper {model}");
    expect(result.arguments.slice(2)).to.deep.equal([
      "--model=my model",
      "high",
      '{"type":"object"}',
      "$HOME;$(echo secret)",
    ]);
  });
});
