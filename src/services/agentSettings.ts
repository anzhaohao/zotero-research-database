import { getPref, setPref } from "../utils/prefs";
import {
  createAgentBridge,
  type AgentAdapterKind,
  type AgentBridge,
  type AgentProfile,
} from "./externalAgent";

const supportedKinds = new Set<AgentAdapterKind>([
  "codex-cli",
  "claude-code",
  "hana-agent",
  "ollama",
  "custom-json-process",
]);
const AGENT_SETTINGS_VERSION = 1;
const LEGACY_CODEX_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_TIMEOUT_MS = 900_000;

export interface AgentSettingsInput {
  kind: unknown;
  executable: unknown;
  args: unknown;
  endpoint: unknown;
  model: unknown;
  timeoutMs: unknown;
}

export const AGENT_PRESETS: Record<
  "claude-code" | "hana-agent",
  Pick<AgentProfile, "executable" | "endpoint">
> = {
  "claude-code": {
    executable: "C:\\Users\\anzhaofeng\\.local\\bin\\claude.exe",
  },
  "hana-agent": {
    executable: "E:\\software\\Hanako\\HanaAgent.exe",
    endpoint: "C:\\Users\\anzhaofeng\\.hanako\\server-info.json",
  },
};

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
  const preset =
    kind === "claude-code" || kind === "hana-agent"
      ? AGENT_PRESETS[kind]
      : undefined;
  const rawExecutable = String(input.executable || "").trim();
  const rawEndpoint = String(input.endpoint || "").trim();
  return {
    kind,
    executable:
      (preset && (!rawExecutable || rawExecutable === "codex")
        ? preset.executable
        : rawExecutable) || undefined,
    args,
    endpoint:
      (kind === "hana-agent" &&
      (!rawEndpoint || rawEndpoint === "http://127.0.0.1:11434")
        ? preset?.endpoint
        : rawEndpoint) || undefined,
    model: String(input.model || "").trim() || undefined,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : 900_000,
  };
}

export function readAgentProfile(): AgentProfile {
  return parseAgentProfile({
    kind: getPref("agentKind"),
    executable: getPref("agentExecutable"),
    args: getPref("agentArgs"),
    endpoint: getPref("agentEndpoint"),
    model: getPref("agentModel"),
    timeoutMs: getPref("agentTimeoutMs"),
  });
}

/** Upgrade local-only Agent defaults without touching synced workspace data. */
export function migrateAgentPreferences(): void {
  const version = Number(getPref("agentSettingsVersion") || 0);
  if (version >= AGENT_SETTINGS_VERSION) return;
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
  setPref("agentModel", profile.model || "");
  setPref("agentTimeoutMs", profile.timeoutMs);
}
