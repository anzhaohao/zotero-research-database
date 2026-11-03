import { expect } from "chai";
import { formatAgentError, showAgentError } from "../../src/ui/agentError";
import type { AgentProfile } from "../../src/services/externalAgent";

describe("Agent error presentation", function () {
  const profile: AgentProfile = {
    kind: "claude-code",
    model: "fable",
    reasoningEffort: "high",
    apiKey: "local-secret",
    args: [],
    timeoutMs: 30000,
  };

  it("includes runtime context and nested diagnostics without credentials", function () {
    const message = formatAgentError(
      "Agent 检查失败",
      new Error(
        "request failed for local-secret; Authorization: Bearer bearer-secret",
        { cause: new Error("token=token-secret") },
      ),
      profile,
    );
    expect(message).to.include("Claude Code");
    expect(message).to.include("fable");
    expect(message).to.include("high");
    expect(message).to.include("底层原因");
    expect(message).to.not.include("local-secret");
    expect(message).to.not.include("bearer-secret");
    expect(message).to.not.include("token-secret");
  });

  it("uses the Zotero window alert for the formatted error", function () {
    let alertMessage = "";
    showAgentError(
      {
        alert: (message?: string) => {
          alertMessage = String(message);
        },
      },
      "提取任务失败",
      new Error("stderr: model unavailable"),
      profile,
    );
    expect(alertMessage).to.include("提取任务失败");
    expect(alertMessage).to.include("stderr: model unavailable");
  });
});
