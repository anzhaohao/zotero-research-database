/**
 * Read the models that the locally installed Codex CLI can actually use.
 *
 * Codex resolves model ids through `model_catalog_json` in `$CODEX_HOME/config.toml`.
 * Relay providers expose ids such as `relay::model-name`, so a bare `model-name`
 * is rejected by the provider. Offering the catalog instead of a hand-written
 * list keeps the plugin model picker aligned with the user's own Codex setup.
 */

export interface CodexCatalogModel {
  value: string;
  label: string;
}

export interface CodexModelCatalog {
  models: CodexCatalogModel[];
  defaultModel?: string;
  provider?: string;
  sourcePath?: string;
}

export interface CodexConfigRouting {
  model?: string;
  provider?: string;
  catalogPath?: string;
}

function parseTomlString(raw: string): string | undefined {
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
  if (!match) return undefined;
  return match[1].replace(
    /\\(u[0-9a-fA-F]{4}|.)/g,
    (_whole, escape: string) => {
      if (escape.startsWith("u"))
        return String.fromCharCode(parseInt(escape.slice(1), 16));
      switch (escape) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "\\":
          return "\\";
        case '"':
          return '"';
        default:
          return escape;
      }
    },
  );
}

/** Parse the root-level routing keys of a Codex `config.toml`. */
export function parseCodexConfigRouting(text: string): CodexConfigRouting {
  const routing: CodexConfigRouting = {};
  let inRootSection = true;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\[\[?.+\]\]?$/.test(line)) {
      inRootSection = false;
      continue;
    }
    if (!inRootSection) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const value = parseTomlString(match[2].trim());
    if (value === undefined) continue;
    if (match[1] === "model") routing.model = value;
    else if (match[1] === "model_provider") routing.provider = value;
    else if (match[1] === "model_catalog_json") routing.catalogPath = value;
  }
  return routing;
}

/** Read model ids and display names out of a Codex model catalog file. */
export function parseCodexCatalog(text: string): CodexCatalogModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    return [];
  }
  const rows = (parsed as { models?: unknown } | undefined)?.models;
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const models: CodexCatalogModel[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const value = String(entry.slug ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const label = String(entry.display_name ?? "").trim() || value;
    models.push({ value, label });
  }
  return models;
}

/**
 * Map a saved model name onto a catalog id.
 *
 * An exact catalog id wins. Otherwise a unique `relay::name` suffix match is
 * accepted, which repairs settings such as `k3-256k` that were stored without
 * the provider prefix the local relay requires.
 */
export function resolveCatalogModelId(
  saved: string | undefined,
  models: readonly CodexCatalogModel[],
): string | undefined {
  const value = String(saved ?? "").trim();
  if (!value) return undefined;
  if (models.some((model) => model.value === value)) return value;
  const matches = models.filter((model) => model.value.endsWith(`::${value}`));
  return matches.length === 1 ? matches[0].value : undefined;
}

export function resolveCodexHome(): string | undefined {
  const configured = Services.env.get("CODEX_HOME")?.trim();
  if (configured) return configured;
  const profile = Services.env.get("USERPROFILE") || Services.env.get("HOME");
  return profile ? PathUtils.join(profile, ".codex") : undefined;
}

/** `PathUtils.join` rejects absolute segments, so only join relative paths. */
export function resolveConfiguredPath(
  home: string,
  configured: string | undefined,
): string {
  const value = String(configured ?? "").trim();
  if (!value) return "";
  if (
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    value.startsWith("/")
  )
    return value;
  return PathUtils.join(home, value);
}

/** Read the local Codex catalog. Missing files simply yield an empty list. */
export async function readLocalCodexModelCatalog(): Promise<CodexModelCatalog> {
  const home = resolveCodexHome();
  if (!home) return { models: [] };
  const configPath = PathUtils.join(home, "config.toml");
  if (!(await IOUtils.exists(configPath))) return { models: [] };
  let routing: CodexConfigRouting;
  try {
    routing = parseCodexConfigRouting(
      String(await Zotero.File.getContentsAsync(configPath, "utf-8")),
    );
  } catch {
    return { models: [] };
  }
  const catalog: CodexModelCatalog = { models: [] };
  if (routing.model) catalog.defaultModel = routing.model;
  if (routing.provider) catalog.provider = routing.provider;
  const catalogPath = resolveConfiguredPath(home, routing.catalogPath);
  if (!catalogPath || !(await IOUtils.exists(catalogPath))) {
    if (catalog.defaultModel)
      catalog.models = [
        { value: catalog.defaultModel, label: catalog.defaultModel },
      ];
    return catalog;
  }
  try {
    catalog.models = parseCodexCatalog(
      String(await Zotero.File.getContentsAsync(catalogPath, "utf-8")),
    );
    catalog.sourcePath = catalogPath;
  } catch {
    // Keep the routing default when the catalog file cannot be read.
  }
  return catalog;
}
