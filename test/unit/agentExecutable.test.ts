import { expect } from "chai";
import {
  agentExecutableCandidates,
  CodexAgentBridge,
  resolveAgentExecutable,
} from "../../src/services/externalAgent";

const globals = globalThis as any;
const joinPOSIX = (...parts: string[]) => parts.join("/");
const joinWindows = (...parts: string[]) => parts.join("\\");

describe("Agent CLI executable discovery", function () {
  let previous: Record<string, unknown>;

  beforeEach(function () {
    previous = Object.fromEntries(
      ["Services", "IOUtils", "PathUtils", "ChromeUtils"].map((key) => [
        key,
        globals[key],
      ]),
    );
  });

  afterEach(function () {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globals[key];
      else globals[key] = value;
    }
  });

  function setPlatform(platform: string, env: Record<string, string>): void {
    globals.Services = {
      appinfo: { OS: platform },
      env: { get: (key: string) => env[key] },
    };
  }

  it("covers Windows native npm packages and per-user CLI installs", function () {
    const home = "C:\\Users\\reader";
    const appData = "C:\\Users\\reader\\AppData\\Roaming";
    const codex = agentExecutableCandidates(
      "codex",
      "WINNT",
      home,
      appData,
      joinWindows,
    );
    expect(codex).to.include("C:\\Users\\reader\\.local\\bin\\codex.exe");
    expect(codex.some((path) => path.includes("codex-win32-x64"))).to.equal(
      true,
    );
    expect(codex.some((path) => path.includes("codex-win32-arm64"))).to.equal(
      true,
    );
    expect(
      agentExecutableCandidates("claude", "WINNT", home, appData, joinWindows),
    ).to.deep.equal(["C:\\Users\\reader\\.local\\bin\\claude.exe"]);
  });

  it("covers standard macOS and Linux install locations", function () {
    expect(
      agentExecutableCandidates(
        "claude",
        "Darwin",
        "/Users/reader",
        undefined,
        joinPOSIX,
      ),
    ).to.deep.equal([
      "/Users/reader/.local/bin/claude",
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude",
    ]);
    expect(
      agentExecutableCandidates(
        "codex",
        "Linux",
        "/home/reader",
        undefined,
        joinPOSIX,
      ),
    ).to.deep.equal([
      "/home/reader/.local/bin/codex",
      "/usr/local/bin/codex",
      "/usr/bin/codex",
    ]);
  });

  it("uses an explicit absolute path without PATH or fallback lookup", async function () {
    globals.IOUtils = { exists: async () => true };
    let searches = 0;
    const resolved = await resolveAgentExecutable(
      " /opt/custom/claude ",
      "claude",
      "Claude Code",
      {
        pathSearch: async () => {
          searches += 1;
          throw new Error("must not search");
        },
      } as any,
    );
    expect(resolved).to.equal("/opt/custom/claude");
    expect(searches).to.equal(0);
  });

  it("rejects a missing explicit path instead of launching another CLI", async function () {
    globals.IOUtils = { exists: async () => false };
    let failure: unknown;
    try {
      await resolveAgentExecutable("/missing/claude", "claude", "Claude Code", {
        pathSearch: async () => "/wrong/claude",
      } as any);
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).to.include(
      "Claude Code 可执行文件不存在：/missing/claude",
    );
  });

  it("searches the platform command before common install locations", async function () {
    setPlatform("Linux", { HOME: "/home/reader" });
    const searched: string[] = [];
    const resolved = await resolveAgentExecutable(
      undefined,
      "claude",
      "Claude Code",
      {
        pathSearch: async (command: string) => {
          searched.push(command);
          return "/usr/local/bin/claude";
        },
      } as any,
    );
    expect(resolved).to.equal("/usr/local/bin/claude");
    expect(searched).to.deep.equal(["claude"]);
  });

  it("falls back to a platform-specific common location", async function () {
    setPlatform("Darwin", { HOME: "/Users/reader" });
    globals.PathUtils = { join: joinPOSIX };
    globals.IOUtils = {
      exists: async (path: string) => path === "/opt/homebrew/bin/codex",
    };
    const resolved = await resolveAgentExecutable("", "codex", "Codex CLI", {
      pathSearch: async () => Promise.reject(new Error("not on PATH")),
    } as any);
    expect(resolved).to.equal("/opt/homebrew/bin/codex");
  });

  it("passes Codex's configured path to its availability probe", async function () {
    globals.IOUtils = { exists: async () => true };
    const commands: string[] = [];
    const subprocess = {
      pathSearch: async () => {
        throw new Error("manual path must take priority");
      },
      call: async (options: { command: string }) => {
        commands.push(options.command);
        const chunks = ["codex-cli 1.0.0", ""];
        return {
          stdout: { readString: async () => chunks.shift() || "" },
          stderr: { readString: async () => "" },
          wait: async () => ({ exitCode: 0 }),
        };
      },
    };
    globals.ChromeUtils = {
      importESModule: () => ({ Subprocess: subprocess }),
    };
    const bridge = new CodexAgentBridge({
      executable: "/opt/custom/codex",
      timeoutMs: 1000,
    });
    const result = await bridge.probe();
    expect(result.executable).to.equal("/opt/custom/codex");
    expect(commands).to.deep.equal(["/opt/custom/codex"]);
  });
});
