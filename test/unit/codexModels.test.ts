import { expect } from "chai";
import {
  parseCodexCatalog,
  parseCodexConfigRouting,
  resolveCatalogModelId,
  resolveConfiguredPath,
} from "../../src/services/codexModels";

describe("local Codex model catalog", function () {
  it("reads the root routing keys of a Codex config", function () {
    const routing = parseCodexConfigRouting(
      [
        'model_provider = "aimai1"',
        'model = "aimami_relay_f0611e18c2::gpt-6-astra"',
        'model_reasoning_effort = "ultra"',
        'model_catalog_json = "C:\\\\Users\\\\x\\\\.codex\\\\catalog.json"',
        "",
        "[projects.'d:\\\\demo']",
        'model = "\\\\must-not-win"',
      ].join("\n"),
    );
    expect(routing.provider).to.equal("aimai1");
    expect(routing.model).to.equal("aimami_relay_f0611e18c2::gpt-6-astra");
    expect(routing.catalogPath).to.equal("C:\\Users\\x\\.codex\\catalog.json");
  });

  it("maps catalog entries to model options", function () {
    const models = parseCodexCatalog(
      JSON.stringify({
        models: [
          { slug: "gpt-6-astra", display_name: "GPT-6-Astra" },
          { slug: "relay::k3-256k", display_name: "601lab / k3-256k" },
          { slug: "relay::k3-256k", display_name: "duplicate" },
          { slug: "" },
          "junk",
        ],
      }),
    );
    expect(models).to.deep.equal([
      { value: "gpt-6-astra", label: "GPT-6-Astra" },
      { value: "relay::k3-256k", label: "601lab / k3-256k" },
    ]);
    expect(parseCodexCatalog("not json")).to.deep.equal([]);
  });

  it("repairs a bare model name with the provider qualified id", function () {
    const models = parseCodexCatalog(
      JSON.stringify({
        models: [
          { slug: "gpt-5.5" },
          { slug: "relay_a::k3-256k", display_name: "k3" },
          { slug: "relay_b::k3-256k", display_name: "k3 twin" },
          { slug: "relay_a::qwen", display_name: "qwen" },
        ],
      }),
    );
    expect(resolveCatalogModelId("gpt-5.5", models)).to.equal("gpt-5.5");
    expect(resolveCatalogModelId("qwen", models)).to.equal("relay_a::qwen");
    expect(resolveCatalogModelId("k3-256k", models)).to.equal(undefined);
    expect(resolveCatalogModelId("missing", models)).to.equal(undefined);
    expect(resolveCatalogModelId("", models)).to.equal(undefined);
  });

  it("keeps an absolute catalog path instead of re-joining it", function () {
    // PathUtils.join throws NS_ERROR_FILE_UNRECOGNIZED_PATH for absolute parts.
    const globalScope = globalThis as unknown as { PathUtils?: unknown };
    const original = globalScope.PathUtils;
    globalScope.PathUtils = {
      join: (parent: string, child: string) =>
        parent.replace(/[\\/]+$/, "") + "\\" + child.replace(/^[\\/]+/, ""),
    };
    try {
      expect(
        resolveConfiguredPath("C:\\home", "C:\\relay\\catalog.json"),
      ).to.equal("C:\\relay\\catalog.json");
      expect(resolveConfiguredPath("C:\\home", "relay/catalog.json")).to.equal(
        "C:\\home\\relay/catalog.json",
      );
      expect(resolveConfiguredPath("C:\\home", "")).to.equal("");
    } finally {
      globalScope.PathUtils = original;
    }
  });
});
