import type { AgentProfile } from "../services/externalAgent";

const AGENT_LABELS: Record<AgentProfile["kind"], string> = {
  "codex-cli": "Codex CLI",
  "claude-code": "Claude Code",
  "hana-agent": "Hana Agent",
  ollama: "Ollama",
  "openai-compatible": "OpenAI 兼容 API",
  "custom-json-process": "自定义程序",
};

function redactDiagnostic(value: string, apiKey?: string): string {
  let result = value;
  const secret = apiKey?.trim();
  if (secret) result = result.split(secret).join("[已隐藏]");
  return result
    .replace(/\b(Bearer\s+)[^\s,;"']+/gi, "$1[已隐藏]")
    .replace(
      /\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization|token|secret)\b(\s*[:=]\s*)(["']?)[^\s,;"'}]+/gi,
      (_match, key: string, separator: string, quote: string) =>
        key + separator + quote + "[已隐藏]",
    );
}

function errorDiagnostic(error: unknown): string {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  const candidate = error as {
    message?: unknown;
    cause?: unknown;
  };
  let message: string;
  try {
    message = String(candidate.message || error);
  } catch {
    message = "无法读取错误详情";
  }
  let cause: string;
  try {
    cause =
      candidate.cause && candidate.cause !== error
        ? errorDiagnostic(candidate.cause)
        : "";
  } catch {
    cause = "无法读取底层错误";
  }
  return cause ? message + "\n底层原因：" + cause : message;
}

export function formatAgentError(
  title: string,
  error: unknown,
  profile?: AgentProfile,
): string {
  const context = profile
    ? [
        "助手：" + (AGENT_LABELS[profile.kind] || profile.kind),
        "模型：" + (profile.model || "自动选择"),
        "思考强度：" + (profile.reasoningEffort || "默认"),
        "",
      ]
    : [];
  const diagnostic = redactDiagnostic(
    errorDiagnostic(error),
    profile?.apiKey,
  ).trim();
  const bounded =
    diagnostic.length > 5000
      ? diagnostic.slice(0, 2400) +
        "\n……诊断过长，中间部分已省略……\n" +
        diagnostic.slice(-2400)
      : diagnostic;
  return [title, "", ...context, "错误详情：" + (bounded || "未知错误")].join(
    "\n",
  );
}

export function showAgentError(
  win: Pick<Window, "alert">,
  title: string,
  error: unknown,
  profile?: AgentProfile,
): void {
  win.alert(formatAgentError(title, error, profile));
}
