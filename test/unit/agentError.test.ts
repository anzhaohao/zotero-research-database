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

  it("adds a gateway timeout recovery hint", function () {
    const message = formatAgentError(
      "提取任务失败",
      new Error("Responses API 请求失败：HTTP 524，上游模型响应超时"),
      {
        kind: "openai-compatible",
        endpoint: "https://example.com/v1",
        model: "provider/model",
        apiProtocol: "responses",
        reasoningEffort: "high",
        timeoutMs: 30000,
      },
    );
    expect(message).to.include("降低思考强度");
    expect(message).to.include("Chat Completions");
  });

  it("identifies an unavailable CLI upstream instead of suggesting weaker reasoning", function () {
    const message = formatAgentError(
      "提取任务失败",
      new Error(
        "Codex 任务超过 60 秒；最近诊断：unexpected status 503 Service Unavailable",
      ),
      { ...profile, kind: "codex-cli" },
    );
    expect(message).to.include("供应商或上游服务当前不可用");
    expect(message).to.include("切换已通过连接测试的供应商");
    expect(message).not.to.include("降低思考强度");
  });

  it("includes the selected API protocol and normalized request URL", function () {
    const message = formatAgentError(
      "提取任务失败",
      new Error("request failed"),
      {
        kind: "openai-compatible",
        endpoint: "https://example.com/v1/responses/",
        model: "provider/model",
        apiProtocol: "responses",
        reasoningEffort: "medium",
        timeoutMs: 30000,
      },
    );
    expect(message).to.include("接口协议：Responses API");
    expect(message).to.include("请求地址：https://example.com/v1/responses");
    expect(message).to.include("思考强度：medium");
  });
});
