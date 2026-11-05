export const MAX_AGENT_CONCURRENCY = 8;

export interface ModelConcurrencyProfile {
  kind: string;
  model?: string;
  modelConcurrency?: Record<string, number>;
}

export function agentModelKey(profile: ModelConcurrencyProfile): string {
  return JSON.stringify([profile.kind, profile.model?.trim() || ""]);
}

export function parseAgentConcurrency(value: unknown): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim())
  )
    throw new Error(`模型并发数必须是 1—${MAX_AGENT_CONCURRENCY} 的整数`);
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_AGENT_CONCURRENCY)
    throw new Error(`模型并发数必须是 1—${MAX_AGENT_CONCURRENCY} 的整数`);
  return count;
}

export function parseModelConcurrency(value: unknown): Record<string, number> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value || "{}");
    } catch {
      throw new Error("模型并发配置损坏，未覆盖原设置");
    }
  }
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("模型并发配置必须是按模型保存的对象");
  return Object.fromEntries(
    Object.entries(value).map(([key, count]) => [
      key,
      parseAgentConcurrency(count),
    ]),
  );
}

export function agentConcurrency(profile: ModelConcurrencyProfile): number {
  const key = agentModelKey(profile);
  return profile.modelConcurrency &&
    Object.hasOwn(profile.modelConcurrency, key)
    ? parseAgentConcurrency(profile.modelConcurrency[key])
    : profile.kind === "openai-compatible"
      ? 3
      : 1;
}
