interface TextPipe {
  readString(): Promise<string>;
}

/** Gecko readString() returns one chunk, not the complete subprocess output. */
export function captureSubprocessOutput(
  pipe?: TextPipe,
  limit = 2_000_000,
): { readonly text: string; done: Promise<string> } {
  let text = "";
  const done = (async () => {
    if (!pipe) return text;
    try {
      for (;;) {
        const chunk = await pipe.readString();
        if (!chunk) break;
        // Keep draining after the retention limit so a noisy child cannot
        // block on its full pipe while its parent waits for process exit.
        text = (text + chunk).slice(-Math.max(1, limit));
      }
    } catch (error) {
      text = (text + "\n子进程输出读取失败：" + String(error)).slice(
        -Math.max(1, limit),
      );
    }
    return text;
  })();
  return {
    get text() {
      return text;
    },
    done,
  };
}
