export interface AgentResponseProgress {
  receivedCharacters: number;
  phase: "thinking" | "writing";
}

/** Decode both OpenAI SSE protocols without depending on browser DOM objects. */
export async function readAgentAPIResponse(
  response: Response,
  protocol: "responses" | "chat-completions",
  options: {
    timeoutMs: number;
    apiKey?: string;
    signal?: AbortSignal;
    abort?: () => void;
    onProgress?: (progress: AgentResponseProgress) => void;
  },
): Promise<any> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error("AI 请求已取消，未写入研究属性"));
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(
      () => {
        reject(new Error("AI 响应读取超时，未写入研究属性"));
        options.abort?.();
      },
      Math.max(1, options.timeoutMs),
    );
  });
  const consume = async () => {
    const contentType = response.headers?.get("content-type") || "";
    if (!/text\/event-stream/i.test(contentType)) return response.json();
    if (!response.body?.getReader)
      throw new Error("当前环境无法读取 AI 流式响应");
    const streamReader =
      response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    reader = streamReader;
    const decoder = new TextDecoder();
    let pending = "";
    let text = "";
    let received = 0;
    let result: any;
    let terminal = false;
    let finishReason = "";
    const event = (block: string) => {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) return;
      if (data.trim() === "[DONE]") {
        if (protocol === "chat-completions") terminal = true;
        return;
      }
      let value: any;
      try {
        value = JSON.parse(data);
      } catch {
        throw new Error("AI 流式事件不是有效 JSON，未写入研究属性");
      }
      if (value.type === "error" || value.error)
        throw new Error(
          String(value.error?.message || value.message || "AI 流式生成失败"),
        );
      if (protocol === "responses") {
        if (value.type === "response.output_text.delta")
          text += String(value.delta || "");
        if (
          [
            "response.completed",
            "response.failed",
            "response.incomplete",
          ].includes(value.type)
        ) {
          if (!value.response || typeof value.response !== "object")
            throw new Error("AI 流式响应缺少最终结果，未写入研究属性");
          result = value.response;
          if (value.type === "response.failed")
            result = { ...result, status: "failed" };
          if (value.type === "response.incomplete")
            result = { ...result, status: "incomplete" };
          terminal = true;
        }
      } else {
        const choice = value.choices?.find((entry: any) => !entry.index);
        text += String(choice?.delta?.content || "");
        if (choice?.delta?.refusal)
          throw new Error("AI 拒绝生成：" + choice.delta.refusal);
        if (choice?.finish_reason) finishReason = String(choice.finish_reason);
      }
      options.onProgress?.({
        receivedCharacters: text.length,
        phase: text ? "writing" : "thinking",
      });
    };
    while (!terminal) {
      const chunk = await streamReader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      received += chunk.value?.byteLength || 0;
      if (received > 4_000_000)
        throw new Error("AI 响应超过大小限制，未写入研究属性");
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        event(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
        if (terminal) break;
      }
      if (chunk.done) {
        if (pending.trim() && !terminal) event(pending);
        break;
      }
    }
    if (!terminal) throw new Error("AI 响应流提前中断，未写入研究属性；请重试");
    if (protocol === "responses") return result;
    if (finishReason && finishReason !== "stop")
      throw new Error("AI 未完整生成（" + finishReason + "），未写入研究属性");
    return { choices: [{ message: { content: text } }] };
  };
  try {
    return await Promise.race([consume(), stopped]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.apiKey && message.includes(options.apiKey))
      // A raw cause would re-expose the gateway's echoed credential.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(message.split(options.apiKey).join("[REDACTED]"));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
    if (reader) {
      void reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        /* A timed-out read may still be pending. */
      }
    }
  }
}
