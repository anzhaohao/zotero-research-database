import type { SavedAgentProvider } from "./agentSettings";
import { parseModelConcurrency } from "./agentConcurrency";
import { getPref, setPref } from "../utils/prefs";

export interface LocalHarness extends SavedAgentProvider {
  modelArgs?: string[];
}

export function readLocalHarnesses(): LocalHarness[] {
  let entries: unknown;
  try {
    entries = JSON.parse(String(getPref("localHarnesses") || "[]"));
  } catch {
    throw new Error("本机助手配置已损坏，未覆盖原配置");
  }
  if (!Array.isArray(entries)) throw new Error("本机助手配置必须是列表");
  const ids = new Set<string>();
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object")
      throw new Error("本机助手配置无效");
    const saved = entry as LocalHarness;
    if (!saved.id || ids.has(saved.id))
      throw new Error("本机助手 ID 缺失或重复");
    ids.add(saved.id);
    return {
      ...localHarnessProvider({
        ...saved,
        args: JSON.stringify(saved.args || []),
        executable: saved.executable || "",
        previous: saved,
      }),
      modelArgs: parseLocalHarnessArgs(JSON.stringify(saved.modelArgs || [])),
    };
  });
}

export function saveLocalHarness(harness: LocalHarness): void {
  const entries = readLocalHarnesses();
  setPref(
    "localHarnesses",
    JSON.stringify(
      entries.some((entry) => entry.id === harness.id)
        ? entries.map((entry) => (entry.id === harness.id ? harness : entry))
        : [...entries, harness],
    ),
  );
}

export function assistantKey(profile: {
  assistantID?: string;
  kind: string;
}): string {
  return profile.assistantID || profile.kind;
}

export type LocalHarnessKind =
  "codex-cli" | "claude-code" | "custom-prompt-cli" | "custom-json-process";

export const LOCAL_HARNESS_KINDS: readonly LocalHarnessKind[] = [
  "codex-cli",
  "claude-code",
  "custom-prompt-cli",
  "custom-json-process",
];

export function localHarnessProvider(input: {
  id: string;
  name: string;
  kind: string;
  executable: string;
  args: string;
  previous?: SavedAgentProvider;
}): SavedAgentProvider {
  const name = input.name.trim();
  if (!name) throw new Error("请填写本机 CLI 名称");
  if (!LOCAL_HARNESS_KINDS.includes(input.kind as LocalHarnessKind))
    throw new Error("请选择本机 CLI 的调用方式");
  const executable = input.executable.trim();
  if (!executable && !["codex-cli", "claude-code"].includes(input.kind))
    throw new Error("其他本机 CLI 需要填写程序路径或命令名");
  const previous =
    input.previous?.kind === input.kind ? input.previous : undefined;
  return {
    id: input.id,
    name,
    kind: input.kind as LocalHarnessKind,
    executable: executable || undefined,
    args: ["codex-cli", "claude-code"].includes(input.kind)
      ? []
      : parseLocalHarnessArgs(input.args),
    model: previous?.model,
    reasoningEffort: previous?.reasoningEffort,
    modelConcurrency: parseModelConcurrency(previous?.modelConcurrency),
    timeoutMs: previous?.timeoutMs || 900_000,
  };
}

function parseLocalHarnessArgs(value: string): string[] {
  let args: unknown;
  try {
    args = JSON.parse(value || "[]");
  } catch {
    throw new Error('启动参数必须是 JSON 字符串数组，例如 ["--print"]');
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new Error("启动参数必须是 JSON 字符串数组");
  return args;
}

/** Literal arguments only: never parse a shell command or expand environment variables. */
export function localPromptInvocation(
  args: readonly string[],
  prompt: string,
  schema: Record<string, unknown>,
  model = "",
  effort = "",
) {
  const instruction = [
    prompt,
    "只输出符合以下 JSON Schema 的 JSON 对象，不要添加解释：",
    JSON.stringify(schema),
  ].join("\n");
  const replacements: Record<string, string> = {
    "{prompt}": instruction,
    "{schema}": JSON.stringify(schema),
    "{model}": model,
    "{effort}": effort,
  };
  const arguments_ = args.map((arg) =>
    arg.replace(
      /\{(?:prompt|schema|model|effort)\}/g,
      (key) => replacements[key],
    ),
  );
  return {
    arguments: arguments_,
    stdin: args.some((arg) => arg.includes("{prompt}")) ? "" : instruction,
  };
}
