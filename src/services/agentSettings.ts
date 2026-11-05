import { getPref, setPref } from "../utils/prefs";
import { parseModelConcurrency } from "./agentConcurrency";
import {
  createAgentBridge,
  AGENT_REASONING_EFFORTS,
  type AgentAdapterKind,
  type AgentBridge,
  type AgentApiProtocol,
  type AgentProfile,
  type AgentReasoningEffort,
} from "./externalAgent";

const supportedKinds = new Set<AgentAdapterKind>([
  "codex-cli",
  "claude-code",
  "ollama",
  "openai-compatible",
  "custom-json-process",
]);
const AGENT_SETTINGS_VERSION = 2;
const LEGACY_CODEX_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_TIMEOUT_MS = 900_000;
const AGENT_PROVIDERS_PREF = "agentProviders";
const ACTIVE_AGENT_PROVIDER_PREF = "agentProviderID";

export interface SavedAgentProvider extends AgentProfile {
  id: string;
  name: string;
}

export interface AgentModelOption {
  value: string;
  label: string;
}

/** Stable suggestions only; the input remains editable for newer/custom models. */
export const AGENT_MODEL_PRESETS: Partial<
  Record<AgentAdapterKind, readonly AgentModelOption[]>
> = {
  "codex-cli": [
    { value: "", label: "自动选择（由 Codex 决定）" },
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "qwen3.8-27b", label: "Qwen 3.8 27B（中转/自定义）" },
  ],
  "claude-code": [
    { value: "", label: "自动选择（由 Claude 决定）" },
    { value: "fable", label: "Claude Fable 5" },
    { value: "claude-opus-4-1", label: "Claude Opus 4.1" },
    { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  ollama: [],
  "openai-compatible": [],
  "custom-json-process": [],
};

export function getAgentModelPresets(
  kind: AgentAdapterKind,
): readonly AgentModelOption[] {
  return AGENT_MODEL_PRESETS[kind] || [];
}

export interface AgentSettingsInput {
  kind: unknown;
  executable: unknown;
  args: unknown;
  endpoint: unknown;
  apiKey?: unknown;
  model: unknown;
  reasoningEffort?: unknown;
  apiProtocol?: unknown;
  modelConcurrency?: unknown;
  timeoutMs: unknown;
}

export function parseAgentProfile(input: AgentSettingsInput): AgentProfile {
  const rawKind = String(input.kind || "codex-cli") as AgentAdapterKind;
  const kind = supportedKinds.has(rawKind) ? rawKind : "codex-cli";
  let args: string[] = [];
  const rawArgs = String(input.args || "").trim();
  if (rawArgs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch (error) {
      throw new Error('Agent 参数必须是 JSON 字符串数组，例如 ["--flag"]', {
        cause: error,
      });
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((entry) => typeof entry !== "string")
    )
      throw new Error('Agent 参数必须是 JSON 字符串数组，例如 ["--flag"]');
    args = parsed;
  }
  const timeoutMs = Number(input.timeoutMs);
  const rawExecutable = String(input.executable || "").trim();
  const rawEndpoint = String(input.endpoint || "").trim();
  const apiKey = String(input.apiKey || "").trim();
  const rawReasoningEffort = String(input.reasoningEffort || "").trim();
  const reasoningEffort = (
    AGENT_REASONING_EFFORTS as readonly string[]
  ).includes(rawReasoningEffort)
    ? (rawReasoningEffort as AgentReasoningEffort)
    : undefined;
  const rawProtocol = String(input.apiProtocol || "").trim();
  const modelConcurrency = parseModelConcurrency(input.modelConcurrency);
  const apiProtocol: AgentApiProtocol | undefined =
    rawProtocol === "responses" || rawProtocol === "chat-completions"
      ? rawProtocol
      : undefined;
  return {
    kind,
    // Older releases used "codex" as the default value. Treat it as automatic
    // discovery so those installations also gain the common-location fallback.
    executable:
      (kind === "codex-cli" && rawExecutable === "codex"
        ? undefined
        : rawExecutable) || undefined,
    args,
    endpoint: rawEndpoint || undefined,
    ...(apiKey ? { apiKey } : {}),
    model: String(input.model || "").trim() || undefined,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(apiProtocol ? { apiProtocol } : {}),
    ...(Object.keys(modelConcurrency).length ? { modelConcurrency } : {}),
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : 900_000,
  };
}

function readLegacyAgentProfile(): AgentProfile {
  return parseAgentProfile({
    kind: getPref("agentKind"),
    executable: getPref("agentExecutable"),
    args: getPref("agentArgs"),
    endpoint: getPref("agentEndpoint"),
    apiKey: getPref("agentApiKey"),
    model: getPref("agentModel"),
    reasoningEffort: getPref("agentReasoningEffort"),
    apiProtocol: getPref("agentProtocol"),
    modelConcurrency: getPref("agentModelConcurrency"),
    timeoutMs: getPref("agentTimeoutMs"),
  });
}

function providerFromUnknown(value: unknown): SavedAgentProvider | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const profile = parseAgentProfile({
    kind: entry.kind,
    executable: entry.executable,
    args: JSON.stringify(entry.args || []),
    endpoint: entry.endpoint,
    apiKey: entry.apiKey,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
    apiProtocol: entry.apiProtocol,
    modelConcurrency: entry.modelConcurrency,
    timeoutMs: entry.timeoutMs,
  });
  const id = String(entry.id || "").trim();
  const name = String(entry.name || "").trim();
  if (!id || !name) return undefined;
  return { id, name, ...profile };
}

export function readAgentProviders(): SavedAgentProvider[] {
  const raw = String(getPref(AGENT_PROVIDERS_PREF) || "").trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        "供应商配置已损坏，未用旧设置覆盖；请检查本机 agentProviders 偏好设置",
        { cause: error },
      );
    }
    if (!Array.isArray(parsed) || !parsed.length)
      throw new Error("供应商配置无效：至少需要一个供应商");
    const providers = parsed.map(providerFromUnknown);
    if (providers.some((provider) => !provider))
      throw new Error("供应商配置无效：存在缺少 ID 或名称的条目");
    const valid = providers as SavedAgentProvider[];
    if (new Set(valid.map((provider) => provider.id)).size !== valid.length)
      throw new Error("供应商配置无效：供应商 ID 重复");
    return valid;
  }
  return [{ id: "default", name: "默认供应商", ...readLegacyAgentProfile() }];
}

export function activeAgentProviderID(): string {
  const providers = readAgentProviders();
  const saved = String(getPref(ACTIVE_AGENT_PROVIDER_PREF) || "").trim();
  return providers.some((provider) => provider.id === saved)
    ? saved
    : providers[0].id;
}

export function readActiveAgentProvider(): SavedAgentProvider {
  const providers = readAgentProviders();
  return (
    providers.find((provider) => provider.id === activeAgentProviderID()) ||
    providers[0]
  );
}

export function readAgentProfile(): AgentProfile {
  return readActiveAgentProvider();
}

/** Upgrade local-only Agent defaults without touching synced workspace data. */
export function migrateAgentPreferences(): void {
  const version = Number(getPref("agentSettingsVersion") || 0);
  if (version >= AGENT_SETTINGS_VERSION) return;
  if (String(getPref("agentKind") || "") === "hana-agent")
    setPref("agentKind", "codex-cli");
  if (
    String(getPref("agentKind") || "codex-cli") === "codex-cli" &&
    Number(getPref("agentTimeoutMs")) === LEGACY_CODEX_TIMEOUT_MS
  ) {
    setPref("agentTimeoutMs", DEFAULT_CODEX_TIMEOUT_MS);
  }
  setPref("agentSettingsVersion", AGENT_SETTINGS_VERSION);
}

export function createAgentBridgeFromPrefs(): AgentBridge {
  return createAgentBridge(readAgentProfile());
}

export function saveAgentProfile(profile: AgentProfile): void {
  setPref("agentKind", profile.kind);
  setPref("agentExecutable", profile.executable || "");
  setPref("agentArgs", JSON.stringify(profile.args || []));
  setPref("agentEndpoint", profile.endpoint || "");
  setPref("agentApiKey", profile.apiKey || "");
  setPref("agentModel", profile.model || "");
  setPref("agentReasoningEffort", profile.reasoningEffort || "");
  setPref("agentProtocol", profile.apiProtocol || "chat-completions");
  setPref(
    "agentModelConcurrency",
    JSON.stringify(profile.modelConcurrency || {}),
  );
  setPref("agentTimeoutMs", profile.timeoutMs);
}

export function saveAgentProviders(providers: SavedAgentProvider[]): void {
  if (!providers.length) throw new Error("至少需要保留一个供应商");
  const normalized = providers.map((provider) => {
    const parsed = providerFromUnknown(provider);
    if (!parsed) throw new Error("供应商 ID 和名称不能为空");
    return parsed;
  });
  if (
    new Set(normalized.map((provider) => provider.id)).size !==
    normalized.length
  )
    throw new Error("供应商 ID 不能重复");
  setPref(AGENT_PROVIDERS_PREF, JSON.stringify(normalized));
}

export function saveActiveAgentProvider(
  provider: SavedAgentProvider,
  providers = readAgentProviders(),
): void {
  const next = providers.some((entry) => entry.id === provider.id)
    ? providers.map((entry) => (entry.id === provider.id ? provider : entry))
    : [...providers, provider];
  saveAgentProviders(next);
  setPref(ACTIVE_AGENT_PROVIDER_PREF, provider.id);
  saveAgentProfile(provider);
}

export function switchAgentProvider(providerID: string): SavedAgentProvider {
  const providers = readAgentProviders();
  const provider = providers.find((entry) => entry.id === providerID);
  if (!provider) throw new Error("找不到所选供应商");
  setPref(ACTIVE_AGENT_PROVIDER_PREF, provider.id);
  saveAgentProfile(provider);
  return provider;
}

export function deleteAgentProvider(providerID: string): SavedAgentProvider {
  const providers = readAgentProviders();
  if (providers.length <= 1) throw new Error("至少需要保留一个供应商");
  const next = providers.filter((provider) => provider.id !== providerID);
  if (next.length === providers.length) throw new Error("找不到所选供应商");
  const previousActiveID = activeAgentProviderID();
  saveAgentProviders(next);
  const nextActive =
    providerID === previousActiveID
      ? next[0]
      : next.find((provider) => provider.id === previousActiveID) || next[0];
  setPref(ACTIVE_AGENT_PROVIDER_PREF, nextActive.id);
  saveAgentProfile(nextActive);
  return nextActive;
}
