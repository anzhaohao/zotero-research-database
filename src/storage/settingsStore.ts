import {
  DATA_ROOT_SETTINGS,
  dataRootPath,
  hasConfiguredDataRoot,
  initializeDataRoot,
  readJsonWithRecovery,
  writeJsonAtomic,
} from "./dataRoot";

export interface PortableSettingsPayload {
  schemaVersion: 1;
  values: Record<string, unknown>;
  updatedAt: string;
}

// Credentials and the data-root pointer are deliberately excluded. Absolute
// executable paths remain portable settings because they describe the user's
// chosen toolchain; the UI can overwrite them after moving to another machine.
export const PORTABLE_SETTING_KEYS = [
  "defaultRowHeight",
  "defaultView",
  "hideMinerUArtifactsInNativeList",
  "motionEnabled",
  "density",
  "cornerStrength",
  "shadowStrength",
  "defaultExportScope",
  "viewTogglePosition",
  "zoteroFigureEnabled",
  "zoteroFigureShowFigures",
  "zoteroFigureShowTables",
  "zoteroFigureShowFormulas",
  "mineruFigureFallback",
  "figureImageQuality",
  "agentKind",
  "agentExecutable",
  "agentArgs",
  "agentEndpoint",
  "agentModel",
  "agentTimeoutMs",
  "mineruMode",
  "mineruExecutable",
  "mineruArgs",
  "mineruDesktopOutputDirectory",
  "mineruOfficialEndpoint",
  "mineruOfficialTokenEnvironment",
  "mineruSelfHostedEndpoint",
  "mineruSelfHostedAutoStart",
  "mineruSelfHostedProjectDirectory",
  "mineruDockerExecutable",
  "mineruDockerDesktopExecutable",
  "mineruBackend",
  "mineruMethod",
  "mineruModelVersion",
  "mineruLanguage",
  "mineruEnableFormula",
  "mineruEnableTable",
  "mineruTimeoutMs",
] as const;

type RuntimeIO = {
  exists(path: string): Promise<boolean>;
};

let values: Record<string, unknown> | undefined;
let writeQueue: Promise<void> = Promise.resolve();
let initialization: Promise<void> | undefined;
let initializationError: unknown;
const portableKeys = new Set<string>(PORTABLE_SETTING_KEYS);

function runtimeIO(): RuntimeIO | undefined {
  try {
    if (typeof IOUtils !== "undefined") return IOUtils as RuntimeIO;
  } catch {
    // Zotero may expose IOUtils as a lexical global instead of a property.
  }
  return (globalThis as { IOUtils?: RuntimeIO }).IOUtils;
}

function readZoteroValue(key: string): unknown {
  try {
    return Zotero.Prefs.get(
      `extensions.zotero.zoteroResearchDatabase.${key}`,
      true,
    );
  } catch {
    return undefined;
  }
}

function currentPrefs(): Record<string, unknown> {
  return portableValues(
    Object.fromEntries(
      PORTABLE_SETTING_KEYS.map((key) => [key, readZoteroValue(key)]),
    ),
  );
}

function portableValues(
  source: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        portableKeys.has(key) &&
        (typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))),
    ),
  );
}

export function getPortableSetting(key: string): unknown {
  return portableKeys.has(key) ? values?.[key] : undefined;
}

export function isPortableSettingsReady(): boolean {
  return values !== undefined;
}

export async function initializePortableSettings(): Promise<void> {
  if (!hasConfiguredDataRoot()) return;
  if (!initialization) initialization = initializePortableSettingsOnce();
  const attempt = initialization;
  try {
    await attempt;
    if (initialization === attempt) initializationError = undefined;
  } catch (error) {
    if (initialization === attempt) {
      initialization = undefined;
      initializationError = error;
      values = undefined;
    }
    throw error;
  }
}

async function initializePortableSettingsOnce(): Promise<void> {
  await initializeDataRoot();
  const path = dataRootPath(DATA_ROOT_SETTINGS);
  const io = runtimeIO();
  if (!io?.exists) throw new Error("当前 Zotero 不支持读取研究数据库设置");
  if ((await io.exists(path)) || (await io.exists(`${path}.bak`))) {
    const payload = await readJsonWithRecovery<PortableSettingsPayload>(path);
    if (
      !payload ||
      payload.schemaVersion !== 1 ||
      !payload.values ||
      typeof payload.values !== "object" ||
      Array.isArray(payload.values)
    )
      throw new Error("研究数据库设置格式无效；未覆盖原文件");
    values = { ...currentPrefs(), ...portableValues(payload.values) };
    applyToZotero(values);
    return;
  }
  values = currentPrefs();
  await persistPortableSettings();
}

export function setPortableSetting(key: string, value: unknown): void {
  if (!values || !portableKeys.has(key)) return;
  values[key] = value;
  void persistPortableSettings().catch((error: unknown) => {
    // Keep writeQueue rejected so an explicit save can report the failure.
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  });
}

export async function flushPortableSettings(): Promise<void> {
  await initialization;
  if (initializationError) throw initializationError;
  await writeQueue;
}

function applyToZotero(next: Record<string, unknown>): void {
  for (const key of PORTABLE_SETTING_KEYS) {
    if (!(key in next)) continue;
    try {
      Zotero.Prefs.set(
        `extensions.zotero.zoteroResearchDatabase.${key}`,
        next[key] as string | number | boolean,
        true,
      );
    } catch {
      // A test or shutdown runtime may not expose preferences.
    }
  }
}

async function persistPortableSettings(): Promise<void> {
  if (!values || !hasConfiguredDataRoot()) return;
  const payload: PortableSettingsPayload = {
    schemaVersion: 1,
    values: portableValues(values),
    updatedAt: new Date().toISOString(),
  };
  const path = dataRootPath(DATA_ROOT_SETTINGS);
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(() => writeJsonAtomic(path, payload));
  await writeQueue;
}

export function resetPortableSettingsScope(): void {
  values = undefined;
  writeQueue = Promise.resolve();
  initialization = undefined;
  initializationError = undefined;
}
