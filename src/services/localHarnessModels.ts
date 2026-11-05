import {
  getSubprocess,
  prepareIsolatedCodexHome,
  resolveAgentExecutable,
  waitForProcess,
  type AgentProfile,
} from "./externalAgent";
import { captureSubprocessOutput } from "./subprocessOutput";

export function parseHarnessModels(value: unknown): string[] {
  const record = value as Record<string, unknown> | undefined;
  const rows = Array.isArray(value) ? value : record?.data || record?.models;
  if (!Array.isArray(rows))
    throw new Error("模型查询未返回模型数组（data / models）");
  return [
    ...new Set(
      rows
        .map((row) =>
          typeof row === "string"
            ? row
            : String(row?.id || row?.slug || row?.model || ""),
        )
        .filter(Boolean),
    ),
  ];
}

export async function detectLocalHarness(
  kind: "codex-cli" | "claude-code",
): Promise<string> {
  return resolveAgentExecutable(
    undefined,
    kind === "codex-cli" ? "codex" : "claude",
    kind === "codex-cli" ? "Codex CLI" : "Claude Code",
    getSubprocess(),
  );
}

async function codexModels(profile: AgentProfile): Promise<string[]> {
  const directory = PathUtils.join(
    PathUtils.tempDir,
    "zrdb-models-" + Date.now() + "-" + Math.random().toString(36).slice(2),
  );
  let process:
    Awaited<ReturnType<ReturnType<typeof getSubprocess>["call"]>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await prepareIsolatedCodexHome(directory);
    process = await getSubprocess().call({
      command: await resolveAgentExecutable(
        profile.executable,
        "codex",
        "Codex CLI",
        getSubprocess(),
      ),
      arguments: ["app-server"],
      environment: { CODEX_HOME: directory },
      environmentAppend: true,
      workdir: directory,
      stderr: "pipe",
    });
    const stderr = captureSubprocessOutput(process.stderr);
    const child = process;
    await child.stdin.write(
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "zrdb", version: "1" },
          capabilities: { experimentalApi: true },
        },
      }) + "\n",
    );
    let buffer = "";
    let initialized = false;
    const models: string[] = [];
    const read = (async () => {
      for (;;) {
        const chunk = await child.stdout.readString();
        if (!chunk)
          throw new Error(
            "Codex 模型查询提前结束：" + stderr.text.slice(-1500),
          );
        buffer += chunk;
        if (buffer.length > 4_000_000)
          throw new Error("Codex 模型列表超过读取上限");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message: any;
          try {
            message = JSON.parse(line);
          } catch {
            continue;
          }
          if (message.error)
            throw new Error(
              "Codex 模型查询失败：" +
                String(message.error.message || "未知错误"),
            );
          if (message.id === 1 && !initialized) {
            initialized = true;
            await child.stdin.write(
              JSON.stringify({ method: "initialized" }) +
                "\n" +
                JSON.stringify({
                  id: 2,
                  method: "model/list",
                  params: { limit: 100 },
                }) +
                "\n",
            );
          } else if (message.id === 2) {
            models.push(...parseHarnessModels(message.result));
            const cursor = message.result?.nextCursor;
            if (!cursor) return [...new Set(models)];
            await child.stdin.write(
              JSON.stringify({
                id: 2,
                method: "model/list",
                params: { limit: 100, cursor },
              }) + "\n",
            );
          }
        }
      }
    })();
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Codex 上游模型查询超时（30 秒）")),
          30_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (process) await process.kill(800).catch(() => undefined);
    await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
  }
}

async function claudeModels(): Promise<string[]> {
  const home = Services.env.get("USERPROFILE") || Services.env.get("HOME");
  let env: Record<string, string> = {};
  const configDir =
    Services.env.get("CLAUDE_CONFIG_DIR") ||
    (home ? PathUtils.join(home, ".claude") : "");
  if (configDir) {
    const path = PathUtils.join(configDir, "settings.json");
    if (await IOUtils.exists(path))
      env =
        JSON.parse(String(await Zotero.File.getContentsAsync(path, "utf-8")))
          .env || {};
  }
  const variable = (key: string) =>
    String(env[key] || Services.env.get(key) || "");
  const base = variable("ANTHROPIC_BASE_URL") || "https://api.anthropic.com";
  const key = variable("ANTHROPIC_API_KEY") || variable("ANTHROPIC_AUTH_TOKEN");
  if (!key)
    throw new Error(
      "Claude Code 登录未提供可用于模型枚举的 API 凭据；可手动填写模型，或为自定义助手配置模型查询命令",
    );
  const endpoint = base.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/models";
  return fetchModels(endpoint, {
    "x-api-key": key,
    Authorization: "Bearer " + key,
    "anthropic-version": "2023-06-01",
  });
}

async function fetchModels(
  endpoint: string,
  headers: Record<string, string>,
): Promise<string[]> {
  const win = Zotero.getMainWindow();
  const controller = new win.AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await win.fetch(endpoint, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error("上游模型查询失败（HTTP " + response.status + "）");
    return parseHarnessModels(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

export async function listLocalHarnessModels(
  profile: AgentProfile,
  args?: string[],
): Promise<string[]> {
  if (profile.kind === "codex-cli") return codexModels(profile);
  if (profile.kind === "claude-code") return claudeModels();
  if (!args?.length)
    throw new Error(
      "该 CLI 没有通用模型枚举接口，请在“编辑当前 CLI”中填写模型查询参数，或手动填写模型 ID",
    );
  const process = await getSubprocess().call({
    command:
      profile.executable?.includes("/") || profile.executable?.includes("\\")
        ? profile.executable!
        : await getSubprocess().pathSearch(profile.executable!),
    arguments: args,
    environmentAppend: true,
    stderr: "pipe",
  });
  const output = captureSubprocessOutput(process.stdout);
  const errors = captureSubprocessOutput(process.stderr);
  try {
    await process.stdin.close();
    const result = await waitForProcess(
      process,
      30_000,
      "CLI 模型查询超时（30 秒）",
    );
    if (result.exitCode !== 0)
      throw new Error("CLI 模型查询失败：" + (await errors.done).slice(-1500));
    return parseHarnessModels(JSON.parse(await output.done));
  } finally {
    await process.kill(800).catch(() => undefined);
  }
}
