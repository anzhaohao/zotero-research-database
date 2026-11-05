import { assert } from "chai";
import {
  CodexAgentBridge,
  type AgentProfile,
} from "../../src/services/externalAgent";
import { buildCodexWorkerConfig } from "../../src/services/codexWorkerConfig";
import { resolveCodexHome } from "../../src/services/codexModels";
import { captureSubprocessOutput } from "../../src/services/subprocessOutput";
import { waitForProcess } from "../../src/services/externalAgent";

describe("live saved Codex CLI in Zotero", function () {
  it("loads the isolated provider configuration without starting unrelated MCP services", async function () {
    this.timeout(25_000);
    if (
      !Zotero.Prefs.get(
        "extensions.zotero-research-database.test.liveCodexEnabled",
        true,
      )
    )
      this.skip();
    const home = resolveCodexHome();
    assert.isString(home);
    const config = buildCodexWorkerConfig(
      String(
        await Zotero.File.getContentsAsync(
          PathUtils.join(home!, "config.toml"),
          "utf-8",
        ),
      ),
      home!,
    );
    const directory = PathUtils.join(
      PathUtils.tempDir,
      "zrdb-native-cli-config-" + Date.now(),
    );
    await IOUtils.makeDirectory(directory);
    try {
      await IOUtils.writeUTF8(PathUtils.join(directory, "config.toml"), config);
      const { executable } = await new CodexAgentBridge().probe();
      const subprocess = (
        ChromeUtils.importESModule(
          "resource://gre/modules/Subprocess.sys.mjs",
        ) as any
      ).Subprocess;
      const process = await subprocess.call({
        command: executable,
        arguments: [
          "--disable",
          "apps",
          "--disable",
          "plugins",
          "mcp",
          "list",
          "--json",
        ],
        environment: { CODEX_HOME: directory },
        environmentAppend: true,
        stderr: "pipe",
      });
      const stdout = captureSubprocessOutput(process.stdout);
      const stderr = captureSubprocessOutput(process.stderr);
      const result = await waitForProcess(process, 10_000, "CLI 配置验证超时");
      assert.equal(result.exitCode, 0, stderr.text);
      const services = JSON.parse(await stdout.done);
      assert.isArray(services);
      assert.isEmpty(
        services.filter((service: any) => service.enabled !== false),
      );
    } finally {
      await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
    }
  });

  it("checks the saved CLI model using the production isolated worker", async function () {
    this.timeout(110_000);
    if (
      !Zotero.Prefs.get(
        "extensions.zotero-research-database.test.liveCodexEnabled",
        true,
      )
    )
      this.skip();
    const fixturePath = String(
      Zotero.Prefs.get(
        "extensions.zotero-research-database.test.liveAgentFixture",
        true,
      ) || "",
    );
    if (!fixturePath) this.skip();
    const fixture = JSON.parse(await IOUtils.readUTF8(fixturePath));
    const prefs = new Map<string, unknown>();
    for (const raw of (await IOUtils.readUTF8(fixture.prefsPath)).split(
      String.fromCharCode(10),
    )) {
      const line = raw.trim();
      if (!line.startsWith("user_pref(") || !line.endsWith(");")) continue;
      try {
        const [key, value] = JSON.parse("[" + line.slice(10, -2) + "]");
        prefs.set(key, value);
      } catch {
        /* Ignore non-preference lines. */
      }
    }
    const providers = JSON.parse(
      String(
        prefs.get("extensions.zotero.zoteroResearchDatabase.agentProviders"),
      ),
    ) as AgentProfile[];
    const profile = providers.find((p) => p.kind === "codex-cli");
    assert.exists(profile);
    const bridge = new CodexAgentBridge({ ...profile!, timeoutMs: 75_000 });
    const started = Date.now();
    const report: Record<string, unknown> = {
      model: profile!.model,
      effort: profile!.reasoningEffort,
    };
    try {
      report.probe = await bridge.probe();
      await bridge.testStructuredOutput();
      report.success = true;
    } catch (error) {
      report.success = false;
      report.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      report.totalMs = Date.now() - started;
      await IOUtils.writeUTF8(
        fixture.reportPath.slice(0, -5) + "-codex.json",
        JSON.stringify(report, null, 2),
      );
    }
  });
});
