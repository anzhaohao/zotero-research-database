import { expect } from "chai";
import { parse } from "smol-toml";
import { buildCodexWorkerConfig } from "../../src/services/codexWorkerConfig";

describe("isolated Codex worker configuration", function () {
  it("preserves provider authentication while excluding unrelated tools and instructions", function () {
    const text = [
      'model = "selected-model"',
      'model_provider = "router"',
      'developer_instructions = "global unrelated instructions"',
      "[model_providers.router]",
      'name = "Router"',
      'base_url = "http://127.0.0.1:1234/v1"',
      'env_key = "CUSTOM_KEY"',
      "[mcp_servers.officecli]",
      'command = "officecli"',
      "[plugins]",
      "enabled = true",
      "[hooks]",
      "enabled = true",
    ].join("\n");
    const result = parse(buildCodexWorkerConfig(text, "/home/reader"));
    expect(result.model).to.equal("selected-model");
    expect(result.model_providers).to.deep.equal({
      router: {
        name: "Router",
        base_url: "http://127.0.0.1:1234/v1",
        env_key: "CUSTOM_KEY",
        request_max_retries: 0,
        stream_max_retries: 0,
      },
    });
    expect(result).not.to.have.any.keys(
      "mcp_servers",
      "plugins",
      "hooks",
      "developer_instructions",
    );
  });

  it("retains quoted provider headers and resolves catalog paths before changing home", function () {
    const text = [
      'model_provider = "custom.with.dots"',
      'model_catalog_json = "models/catalog.json"',
      '[model_providers."custom.with.dots"]',
      'name = "Custom"',
      '[model_providers."custom.with.dots".http_headers]',
      '"X-Custom-Auth" = "private-auth-value"',
    ].join("\n");
    const result = parse(
      buildCodexWorkerConfig(
        text,
        "/original",
        (root, value) => root + "/" + value,
      ),
    );
    expect(result.model_catalog_json).to.equal("/original/models/catalog.json");
    expect(
      (result.model_providers as any)["custom.with.dots"].http_headers[
        "X-Custom-Auth"
      ],
    ).to.equal("private-auth-value");
  });

  it("preserves the selected profile routing but excludes profile-level tool settings", function () {
    const text = [
      'profile = "research"',
      "[profiles.research]",
      'model = "profile-model"',
      'model_provider = "router"',
      'developer_instructions = "unrelated"',
      "[profiles.research.mcp_servers.tools]",
      'command = "tool"',
    ].join("\n");
    const result = parse(buildCodexWorkerConfig(text, "/home/reader"));
    expect(result.profile).to.equal("research");
    expect(result.profiles).to.deep.equal({
      research: { model: "profile-model", model_provider: "router" },
    });
  });

  it("rejects invalid TOML without echoing the secret-bearing input line", function () {
    expect(() =>
      buildCodexWorkerConfig('auth = "private-auth-value', "/original"),
    )
      .to.throw("config.toml 格式无效")
      .with.property("message")
      .that.does.not.include("private-auth-value");
  });

  it("bounds retries in the disposable configuration while preserving source routing", function () {
    const source = [
      'model_provider = "router"',
      "[model_providers.router]",
      'name = "Router"',
      'base_url = "http://127.0.0.1:1234/v1"',
      "request_max_retries = 4",
      "stream_max_retries = 5",
    ].join("\n");
    const original = parse(source);
    const result = parse(buildCodexWorkerConfig(source, "/original"));
    expect((result.model_providers as any).router).to.include({
      request_max_retries: 0,
      stream_max_retries: 0,
      base_url: "http://127.0.0.1:1234/v1",
    });
    expect(parse(source)).to.deep.equal(original);
  });
});
