import { expect } from "chai";
import { readAgentAPIResponse } from "../../src/services/agentResponse";

function streamResponse(events: unknown[], truncate = false): Response {
  const bytes = new TextEncoder().encode(
    events
      .map(
        (value) =>
          "data: " +
          (typeof value === "string" ? value : JSON.stringify(value)) +
          "\r\n\r\n",
      )
      .join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        if (!truncate) controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

describe("streaming AI response", function () {
  it("redacts credentials echoed in a streaming gateway error", async function () {
    const response = new Response(
      'data: {"type":"error","message":"provider rejected secret-key"}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
    let failure: unknown;
    try {
      await readAgentAPIResponse(response, "responses", {
        timeoutMs: 1000,
        apiKey: "secret-key",
      });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).to.include("[REDACTED]");
    expect(String(failure)).not.to.include("secret-key");
  });

  it("decodes fragmented UTF-8 and completes only after the final Responses event", async function () {
    const progress: number[] = [];
    const result = await readAgentAPIResponse(
      streamResponse([
        { type: "response.created" },
        { type: "response.output_text.delta", delta: '{"field":"中文"}' },
        {
          type: "response.completed",
          response: { status: "completed", output_text: '{"field":"中文"}' },
        },
      ]),
      "responses",
      {
        timeoutMs: 1000,
        onProgress: (value) => progress.push(value.receivedCharacters),
      },
    );
    expect(JSON.parse(result.output_text)).to.deep.equal({ field: "中文" });
    expect(progress).to.include(14);
  });

  it("collects Chat Completions and requires its terminal marker", async function () {
    const result = await readAgentAPIResponse(
      streamResponse([
        { choices: [{ index: 0, delta: { content: '{"field":' } }] },
        {
          choices: [
            { index: 0, delta: { content: '"value"}' }, finish_reason: "stop" },
          ],
        },
        "[DONE]",
      ]),
      "chat-completions",
      { timeoutMs: 1000 },
    );
    expect(JSON.parse(result.choices[0].message.content)).to.deep.equal({
      field: "value",
    });
  });

  it("rejects complete-looking JSON from an interrupted stream", async function () {
    let failure: unknown;
    try {
      await readAgentAPIResponse(
        streamResponse([
          { type: "response.output_text.delta", delta: '{"field":"value"}' },
        ]),
        "responses",
        { timeoutMs: 1000 },
      );
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).to.include("提前中断");
  });

  it("times out while reading a stalled response body", async function () {
    let failure: unknown;
    try {
      await readAgentAPIResponse(streamResponse([], true), "responses", {
        timeoutMs: 5,
      });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).to.include("响应读取超时");
  });

  it("cancels a pending body read", async function () {
    const controller = new AbortController();
    let failure: unknown;
    const waiting = readAgentAPIResponse(
      streamResponse([], true),
      "responses",
      { timeoutMs: 1000, signal: controller.signal },
    );
    controller.abort();
    try {
      await waiting;
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).to.include("已取消");
  });

  it("rejects truncated Chat output and forwards Responses failures", async function () {
    let failure: unknown;
    try {
      await readAgentAPIResponse(
        streamResponse([
          {
            choices: [
              {
                index: 0,
                delta: { content: "partial" },
                finish_reason: "length",
              },
            ],
          },
          "[DONE]",
        ]),
        "chat-completions",
        { timeoutMs: 1000 },
      );
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).to.include("length");
    const result = await readAgentAPIResponse(
      streamResponse([
        {
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        },
      ]),
      "responses",
      { timeoutMs: 1000 },
    );
    expect(result.status).to.equal("incomplete");
  });
});
