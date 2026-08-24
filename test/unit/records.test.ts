import { expect } from "chai";
import {
  applyAgentValues,
  createEmptyRecord,
  setFieldLock,
  setManualValue,
} from "../../src/core/records";

describe("research record locking", function () {
  const audit = {
    executor: "codex" as const,
    executorVersion: "codex-cli 0.142.5",
    inputType: "mineru-markdown" as const,
    inputHash: "abc",
    generatedAt: "2026-07-31T00:00:00Z",
    templateVersion: 1,
  };

  it("protects manually edited values from external Agent overwrite", function () {
    const manual = setManualValue(
      createEmptyRecord(1, "ABCD1234"),
      "question",
      "人工判断",
    );
    const next = applyAgentValues(manual, { question: "Agent 判断" }, audit);
    expect(next.fields.question.value).to.equal("人工判断");
  });

  it("allows overwrite after an explicit unlock", function () {
    const manual = setManualValue(
      createEmptyRecord(1, "ABCD1234"),
      "question",
      "人工判断",
    );
    const unlocked = setFieldLock(manual, "question", false);
    const next = applyAgentValues(unlocked, { question: "Agent 判断" }, audit);
    expect(next.fields.question.value).to.equal("Agent 判断");
    expect(next.fields.question.locked).to.equal(false);
  });
});
