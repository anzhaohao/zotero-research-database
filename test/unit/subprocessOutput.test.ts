import { expect } from "chai";
import { captureSubprocessOutput } from "../../src/services/subprocessOutput";
import { extractCodexFailureDetail } from "../../src/services/externalAgent";

describe("native subprocess output", function () {
  it("reads through the final diagnostic after a split CLI banner", async function () {
    const chunks = [
      "OpenAI Codex v",
      "0.166.0\n",
      "unexpected status 503 Service Unavailable\n",
      "ERROR: Reconnecting... 1/5",
      "",
    ];
    const output = captureSubprocessOutput({
      readString: async () => chunks.shift() || "",
    });
    const text = await output.done;
    expect(text).to.include("OpenAI Codex v0.166.0");
    expect(extractCodexFailureDetail("", text)).to.include(
      "503 Service Unavailable",
    );
    expect(chunks).to.have.length(0);
  });

  it("continues draining after the retained output limit", async function () {
    const chunks = ["a".repeat(30), "b".repeat(30), "c".repeat(30), ""];
    const output = captureSubprocessOutput(
      { readString: async () => chunks.shift() || "" },
      20,
    );
    expect(await output.done).to.equal("c".repeat(20));
    expect(chunks).to.have.length(0);
  });

  it("exposes received diagnostics while the process is still running", async function () {
    let calls = 0;
    let finish!: (value: string) => void;
    const output = captureSubprocessOutput({
      readString: async () =>
        ++calls === 1
          ? "HTTP 503"
          : new Promise((resolve) => {
              finish = resolve;
            }),
    });
    await Promise.resolve();
    expect(output.text).to.equal("HTTP 503");
    finish("");
    expect(await output.done).to.equal("HTTP 503");
  });

  it("handles an absent stderr pipe", async function () {
    expect(await captureSubprocessOutput().done).to.equal("");
  });
});
