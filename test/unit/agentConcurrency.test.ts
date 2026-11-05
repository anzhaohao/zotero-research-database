import { expect } from "chai";
import { createDefaultFields } from "../../src/domain/defaults";
import {
  agentConcurrency,
  agentModelKey,
  parseAgentConcurrency,
  parseModelConcurrency,
} from "../../src/services/agentConcurrency";
import {
  ConcurrentAgentBridge,
  type AgentBridge,
  type AgentProfile,
  type AgentResult,
} from "../../src/services/externalAgent";

const profile: AgentProfile = {
  kind: "codex-cli",
  model: "model-a",
  timeoutMs: 1000,
};
const delay = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("per-model field concurrency", function () {
  it("keeps model and assistant identities distinct with compatible defaults", function () {
    const modelConcurrency = { [agentModelKey(profile)]: 4 };
    expect(agentConcurrency({ ...profile, modelConcurrency })).to.equal(4);
    expect(
      agentConcurrency({ ...profile, model: "other", modelConcurrency }),
    ).to.equal(1);
    expect(
      agentConcurrency({
        ...profile,
        kind: "openai-compatible",
        modelConcurrency,
      }),
    ).to.equal(3);
    expect(
      agentConcurrency({ ...profile, kind: "claude-code", modelConcurrency }),
    ).to.equal(1);
    expect(
      parseModelConcurrency(JSON.stringify(modelConcurrency)),
    ).to.deep.equal(modelConcurrency);
    expect(parseModelConcurrency(undefined)).to.deep.equal({});
  });

  it("rejects invalid concurrency without replacing damaged settings", function () {
    for (const value of [0, 9, 1.5, "", null, NaN, "abc", true, [2], {}])
      expect(() => parseAgentConcurrency(value)).to.throw("整数");
    expect(() => parseModelConcurrency("{bad")).to.throw("损坏");
    expect(() => parseModelConcurrency({ x: 99 })).to.throw("整数");
    expect(() => parseModelConcurrency([])).to.throw("对象");
  });

  for (const count of [1, 2, 8]) {
    it(`limits active field requests to ${count} and saves each completed field`, async function () {
      const fields = createDefaultFields()
        .filter((f) => !f.archived)
        .slice(0, 6);
      let active = 0,
        peak = 0;
      const saved: string[] = [];
      const bridge = new ConcurrentAgentBridge(
        { ...profile, modelConcurrency: { [agentModelKey(profile)]: count } },
        () =>
          fakeBridge(async (selected) => {
            active++;
            peak = Math.max(peak, active);
            expect(selected).to.have.length(1);
            await delay();
            active--;
            return {
              value: { [selected[0].id]: "grounded result" },
              executorVersion: "fake",
            };
          }),
      );
      const result = await bridge.extractFields(
        fields,
        "full source",
        undefined,
        async (partial) => {
          saved.push(...Object.keys(partial.value));
        },
      );
      expect(peak).to.equal(Math.min(count, fields.length));
      expect(saved).to.have.members(fields.map((f) => f.id));
      expect(Object.keys(result.value)).to.have.members(saved);
    });
  }

  it("retains completed fields and stops the queue after upstream failure", async function () {
    const fields = createDefaultFields()
      .filter((f) => !f.archived)
      .slice(0, 4);
    let started = 0;
    const saved: unknown[] = [];
    const bridge = new ConcurrentAgentBridge(profile, () =>
      fakeBridge(async (selected) => {
        started++;
        if (started === 2)
          throw new Error("unexpected status 503 Service Unavailable");
        return {
          value: { [selected[0].id]: "valid result" },
          executorVersion: "fake",
        };
      }),
    );
    let error = "";
    try {
      await bridge.extractFields(
        fields,
        "source",
        undefined,
        async (result) => {
          saved.push(result.value);
        },
      );
    } catch (e) {
      error = String(e);
    }
    expect(started).to.equal(2);
    expect(saved).to.have.length(1);
    expect(error).to.include("503").and.include("尚未发送");
  });

  it("cancels the remaining queue if a partial result cannot be saved", async function () {
    const fields = createDefaultFields()
      .filter((f) => !f.archived)
      .slice(0, 4);
    let started = 0,
      cancelled = 0;
    const bridge = new ConcurrentAgentBridge(profile, () => ({
      ...fakeBridge(async (selected) => {
        started++;
        return {
          value: { [selected[0].id]: "valid" },
          executorVersion: "fake",
        };
      }),
      cancel() {
        cancelled++;
      },
    }));
    let error = "";
    try {
      await bridge.extractFields(fields, "source", undefined, async () => {
        throw new Error("disk full");
      });
    } catch (e) {
      error = String(e);
    }
    expect(error).to.include("disk full");
    expect(started).to.equal(1);
    expect(cancelled).to.equal(1);
  });

  it("does not start more fields after cancellation", async function () {
    const fields = createDefaultFields()
      .filter((f) => !f.archived)
      .slice(0, 4);
    let started = 0;
    const bridge = new ConcurrentAgentBridge(profile, () =>
      fakeBridge(async (selected) => {
        started++;
        return {
          value: { [selected[0].id]: "valid" },
          executorVersion: "fake",
        };
      }),
    );
    let error = "";
    try {
      await bridge.extractFields(fields, "source", undefined, async () => {
        bridge.cancel();
      });
    } catch (e) {
      error = String(e);
    }
    expect(started).to.equal(1);
    expect(error).to.include("已取消");
  });
});

function fakeBridge(extractFields: AgentBridge["extractFields"]): AgentBridge {
  return {
    kind: "codex-cli",
    extractFields,
    cancel() {},
    async probe() {
      return { executable: "fake", version: "fake" };
    },
    async testStructuredOutput() {},
    async synthesizeComparison(): Promise<AgentResult<string>> {
      return { value: "comparison", executorVersion: "fake" };
    },
  };
}
