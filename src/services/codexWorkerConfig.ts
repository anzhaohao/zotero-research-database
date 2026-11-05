import { parse, stringify } from "smol-toml";
import { resolveConfiguredPath } from "./codexModels";

// Preserve model routing and authentication, but do not start a user's MCP,
// hooks, plugins, project instructions or background integrations for a paper.
const ROUTING_KEYS = [
  "model",
  "model_provider",
  "model_providers",
  "model_catalog_json",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "model_context_window",
  "model_auto_compact_token_limit",
  "service_tier",
  "openai_base_url",
  "chatgpt_base_url",
  "preferred_auth_method",
  "forced_login_method",
  "forced_chatgpt_workspace_id",
  "cli_auth_credentials_store",
  "disable_response_storage",
  "oss_provider",
] as const;

export function buildCodexWorkerConfig(
  text: string,
  sourceHome: string,
  resolvePath = resolveConfiguredPath,
): string {
  let original: Record<string, unknown>;
  try {
    original = parse(text);
  } catch {
    // TOML parse diagnostics can quote credentials from the offending line.
    throw new Error(
      "Codex config.toml 格式无效，未启动文献任务；请先修复原配置",
    );
  }
  const select = (source: Record<string, unknown>): Record<string, unknown> => {
    const output: Record<string, unknown> = {};
    for (const key of ROUTING_KEYS) {
      if (Object.hasOwn(source, key)) output[key] = source[key];
    }
    if (output.model_providers && typeof output.model_providers === "object") {
      output.model_providers = Object.fromEntries(
        Object.entries(output.model_providers).map(([name, provider]) => {
          if (
            !provider ||
            typeof provider !== "object" ||
            Array.isArray(provider)
          )
            throw new Error("Codex 供应商配置格式无效，未启动文献任务");
          return [
            name,
            { ...provider, request_max_retries: 0, stream_max_retries: 0 },
          ];
        }),
      );
    }
    if (typeof output.model_catalog_json === "string") {
      output.model_catalog_json = resolvePath(
        sourceHome,
        output.model_catalog_json,
      );
    }
    return output;
  };
  const output = select(original);
  if (typeof original.profile === "string") output.profile = original.profile;
  if (original.profiles && typeof original.profiles === "object") {
    output.profiles = Object.fromEntries(
      Object.entries(original.profiles).map(([name, profile]) => {
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
          throw new Error("Codex profile 配置格式无效，未启动文献任务");
        }
        return [name, select(profile as Record<string, unknown>)];
      }),
    );
  }
  return stringify(output);
}
