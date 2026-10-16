import JSZip from "jszip";
import { version } from "../../package.json";
import { API_TOKEN_PREF } from "../domain/defaults";
import type {
  ComparisonDefinition,
  ComparisonSnapshot,
  FigureArtifact,
  ItemInternalState,
  ItemResearchRecord,
  WorkspaceState,
} from "../domain/types";
import {
  getLocalPayloadSnapshot,
  replaceLocalPayload,
} from "../storage/localData";
import { getPref, setPref } from "../utils/prefs";

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_DATA_FILE = "research-data-v1.json";
export const BACKUP_PREFS_FILE = "prefs.json";
export const BACKUP_MAPPING_FILE = "mapping.json";
export const BACKUP_MANIFEST_FILE = "manifest.json";
export const BACKUP_FILE_NAMES = [
  BACKUP_DATA_FILE,
  BACKUP_PREFS_FILE,
  BACKUP_MAPPING_FILE,
  BACKUP_MANIFEST_FILE,
] as const;

/**
 * The artifact import token is a machine-local credential. It is never
 * exported and never restored; the current machine keeps its own value.
 */
const EXCLUDED_PREF_KEYS = new Set<string>([API_TOKEN_PREF]);

export const EXPORTED_PREF_KEYS = [
  "enable",
  "lastViewMode",
  "defaultRowHeight",
  "defaultView",
  "hideMinerUArtifactsInNativeList",
  "motionEnabled",
  "density",
  "cornerStrength",
  "shadowStrength",
  "defaultExportScope",
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
  "agentSettingsVersion",
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
  "mineruTier",
  "mineruMethod",
  "mineruModelVersion",
  "mineruLanguage",
  "mineruEnableFormula",
  "mineruEnableTable",
  "mineruTimeoutMs",
  "mineruSettingsVersion",
] as const;

export type ExportedPrefKey = (typeof EXPORTED_PREF_KEYS)[number];

export interface BackupMappingEntry {
  libraryID: number;
  itemKey: string;
  doi?: string;
  title?: string;
}

export interface BackupMapping {
  schemaVersion: 1;
  entries: BackupMappingEntry[];
}

export interface BackupManifest {
  formatVersion: number;
  addonVersion: string;
  generatedAt: string;
  schemaVersion: number;
  files: Record<string, string>;
}

export type BackupMatchMethod = "itemKey" | "doi" | "title";

export interface MatchedImportRecord {
  record: BackupMappingEntry;
  method: BackupMatchMethod;
  target: { libraryID: number; itemKey: string };
}

export interface AmbiguousImportRecord {
  record: BackupMappingEntry;
  reason: string;
  candidates: Array<{ libraryID: number; itemKey: string; label?: string }>;
}

export interface MatchReport {
  matched: MatchedImportRecord[];
  ambiguous: AmbiguousImportRecord[];
  conflicts: AmbiguousImportRecord[];
  unmatched: BackupMappingEntry[];
}

export interface BackupImportReport {
  matchedCount: number;
  skipped: BackupMappingEntry[];
  ambiguous: AmbiguousImportRecord[];
  conflicts: AmbiguousImportRecord[];
  appliedPrefs: string[];
  credentialNote: string;
}

/**
 * One bibliographic entry in the target library, already reduced to the
 * fields matching needs. The add-on builds this list from Zotero.Items;
 * tests build it directly.
 */
export interface ImportCandidate {
  libraryID: number;
  itemKey: string;
  doi?: string;
  title?: string;
}

/** Live Zotero item shape used when enumerating the current library. */
export interface ZoteroItemLike {
  libraryID: number;
  key: string;
  isRegularItem(): boolean;
  getField(name: string): unknown;
}

export function normalizeDOI(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  if (!text) return undefined;
  text = text.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  text = text.replace(/^doi:\s*/i, "");
  text = text.trim();
  if (!text) return undefined;
  return text.toLowerCase();
}

export function normalizeTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  return text ? text.toLowerCase() : undefined;
}

function candidateLabel(candidate: ImportCandidate): string {
  const title = typeof candidate.title === "string" ? candidate.title : "";
  return title ? `${title} [${candidate.itemKey}]` : `[${candidate.itemKey}]`;
}

/**
 * Match backup records against the current library. The priority is strictly
 * itemKey -> DOI -> title; a level with multiple candidates reports ambiguity
 * and never falls through to a weaker level. A target already claimed by an
 * earlier matched record reports a conflict instead of being reused.
 */
export function matchBackupRecords(
  mapping: BackupMapping,
  candidates: ImportCandidate[],
): MatchReport {
  const report: MatchReport = {
    matched: [],
    ambiguous: [],
    conflicts: [],
    unmatched: [],
  };
  const claimed = new Map<string, BackupMappingEntry>();
  const entries = Array.isArray(mapping?.entries) ? mapping.entries : [];

  for (const record of entries) {
    const target = resolveRecord(record, candidates, report);
    if (!target) continue;
    const claimID = `${target.libraryID}:${target.itemKey.toUpperCase()}`;
    const previous = claimed.get(claimID);
    if (previous) {
      report.conflicts.push({
        record,
        reason: `目标条目已被备份记录 ${previous.itemKey} 占用，拒绝重复使用`,
        candidates: [
          {
            libraryID: target.libraryID,
            itemKey: target.itemKey,
            label: candidateLabel(target),
          },
        ],
      });
      continue;
    }
    claimed.set(claimID, record);
    report.matched.push({
      record,
      method: target.method!,
      target: { libraryID: target.libraryID, itemKey: target.itemKey },
    });
  }
  return report;
}

function resolveRecord(
  record: BackupMappingEntry,
  candidates: ImportCandidate[],
  report: MatchReport,
): (ImportCandidate & { method?: BackupMatchMethod }) | undefined {
  const key = typeof record.itemKey === "string" ? record.itemKey : "";
  if (key) {
    const byKey = candidates.filter(
      (candidate) => candidate.itemKey.toUpperCase() === key.toUpperCase(),
    );
    if (byKey.length > 1) {
      report.ambiguous.push({
        record,
        reason: "itemKey 匹配到多个当前条目",
        candidates: byKey.map((candidate) => ({
          libraryID: candidate.libraryID,
          itemKey: candidate.itemKey,
          label: candidateLabel(candidate),
        })),
      });
      return undefined;
    }
    if (byKey.length === 1) return { ...byKey[0], method: "itemKey" };
  }

  const doi = normalizeDOI(record.doi);
  if (doi) {
    const byDOI = candidates.filter(
      (candidate) => normalizeDOI(candidate.doi) === doi,
    );
    if (byDOI.length > 1) {
      report.ambiguous.push({
        record,
        reason: "DOI 匹配到多个当前条目",
        candidates: byDOI.map((candidate) => ({
          libraryID: candidate.libraryID,
          itemKey: candidate.itemKey,
          label: candidateLabel(candidate),
        })),
      });
      return undefined;
    }
    if (byDOI.length === 1) return { ...byDOI[0], method: "doi" };
  }

  const title = normalizeTitle(record.title);
  if (title) {
    const byTitle = candidates.filter(
      (candidate) => normalizeTitle(candidate.title) === title,
    );
    if (byTitle.length > 1) {
      report.ambiguous.push({
        record,
        reason: "标题匹配到多个当前条目",
        candidates: byTitle.map((candidate) => ({
          libraryID: candidate.libraryID,
          itemKey: candidate.itemKey,
          label: candidateLabel(candidate),
        })),
      });
      return undefined;
    }
    if (byTitle.length === 1) return { ...byTitle[0], method: "title" };
  }

  report.unmatched.push(record);
  return undefined;
}

function mapKey(
  value: string | undefined,
  remap: Map<string, { libraryID: number; itemKey: string }>,
): string | undefined {
  if (value === undefined) return undefined;
  return remap.get(value.toUpperCase())?.itemKey ?? value;
}

function remapRecord(
  record: ItemResearchRecord,
  target: { libraryID: number; itemKey: string },
): ItemResearchRecord {
  return { ...record, libraryID: target.libraryID, itemKey: target.itemKey };
}

function remapFigure(
  figure: FigureArtifact,
  remap: Map<string, { libraryID: number; itemKey: string }>,
): FigureArtifact {
  return {
    ...figure,
    parentItemKey: mapKey(figure.parentItemKey, remap)!,
  };
}

function remapComparison(
  comparison: ComparisonDefinition,
  remap: Map<string, { libraryID: number; itemKey: string }>,
): ComparisonDefinition {
  return {
    ...comparison,
    itemKeys: comparison.itemKeys.map((key) => mapKey(key, remap)!),
  };
}

function remapSnapshot(
  snapshot: ComparisonSnapshot,
  remap: Map<string, { libraryID: number; itemKey: string }>,
): ComparisonSnapshot {
  return {
    ...snapshot,
    rows: snapshot.rows.map((row) => ({
      ...row,
      itemKey: mapKey(row.itemKey, remap)!,
    })),
  };
}

/**
 * Rewrite every item-level and workspace-level key reference in a local
 * payload. Keys that have no matched target (ambiguous, conflicted or
 * unmatched records) keep their original value so they can be matched again
 * after the user fixes the library.
 */
export function remapLocalPayload(
  payload: unknown,
  matched: MatchedImportRecord[],
): unknown {
  const raw = JSON.parse(JSON.stringify(payload)) as {
    schemaVersion?: unknown;
    workspaceLibraryID?: number;
    workspace?: WorkspaceState;
    items?: Record<string, ItemInternalState>;
  };
  const remap = new Map<string, { libraryID: number; itemKey: string }>();
  const byOldID = new Map<string, { libraryID: number; itemKey: string }>();
  for (const entry of matched) {
    remap.set(entry.record.itemKey.toUpperCase(), entry.target);
    byOldID.set(
      `${entry.record.libraryID}:${entry.record.itemKey.toUpperCase()}`,
      entry.target,
    );
  }

  const items: Record<string, ItemInternalState> = {};
  for (const [oldID, state] of Object.entries(raw.items ?? {})) {
    const target = byOldID.get(oldID.toUpperCase());
    const next: ItemInternalState = target
      ? {
          ...state,
          libraryID: target.libraryID,
          itemKey: target.itemKey,
          ...(state.record
            ? { record: remapRecord(state.record, target) }
            : {}),
          figures: state.figures.map((figure) => remapFigure(figure, remap)),
        }
      : {
          ...state,
          figures: state.figures.map((figure) => remapFigure(figure, remap)),
        };
    const nextID = target ? `${target.libraryID}:${target.itemKey}` : oldID;
    if (items[nextID] !== undefined)
      throw new Error(`重映射后条目标识冲突：${nextID}`);
    items[nextID] = next;
  }

  const result: typeof raw = { ...raw, items };
  if (raw.workspace) {
    const targetLibraryID = matched[0]?.target.libraryID;
    result.workspace = {
      ...raw.workspace,
      comparisons: raw.workspace.comparisons.map((comparison) =>
        remapComparison(comparison, remap),
      ),
      snapshots: raw.workspace.snapshots.map((snapshot) =>
        remapSnapshot(snapshot, remap),
      ),
    };
    if (raw.workspaceLibraryID !== undefined && targetLibraryID !== undefined)
      result.workspaceLibraryID = targetLibraryID;
  }
  return result;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function readExportedPrefs(): Record<string, unknown> {
  const prefs: Record<string, unknown> = {};
  for (const key of EXPORTED_PREF_KEYS) {
    if (EXCLUDED_PREF_KEYS.has(key)) continue;
    prefs[key] = getPref(key);
  }
  return prefs;
}

function mappingFromPayload(payload: {
  items: Record<string, ItemInternalState>;
}): BackupMapping {
  const entries = Object.values(payload.items)
    .map((state) => {
      const item = Zotero.Items.getByLibraryAndKey(
        state.libraryID,
        state.itemKey,
      ) as Zotero.Item | false;
      const doi =
        item && typeof item.getField === "function"
          ? String(item.getField("DOI") || "").trim()
          : "";
      const title =
        item && typeof item.getField === "function"
          ? String(item.getField("title") || "").trim()
          : "";
      return {
        libraryID: state.libraryID,
        itemKey: state.itemKey,
        ...(doi ? { doi } : {}),
        ...(title ? { title } : {}),
      };
    })
    .sort((a, b) => a.itemKey.localeCompare(b.itemKey));
  return { schemaVersion: 1, entries };
}

/** Build the backup ZIP in memory; callers decide where to write it. */
export async function createBackupZip(): Promise<Uint8Array> {
  const payload = await getLocalPayloadSnapshot();
  const dataContent = JSON.stringify(payload, null, 2);
  const prefsContent = JSON.stringify(readExportedPrefs(), null, 2);
  const mappingContent = JSON.stringify(mappingFromPayload(payload), null, 2);
  const files: Record<string, string> = {
    [BACKUP_DATA_FILE]: await sha256Hex(dataContent),
    [BACKUP_PREFS_FILE]: await sha256Hex(prefsContent),
    [BACKUP_MAPPING_FILE]: await sha256Hex(mappingContent),
  };
  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    addonVersion: version,
    generatedAt: new Date().toISOString(),
    schemaVersion: payload.schemaVersion,
    files,
  };
  const zip = new JSZip();
  zip.file(BACKUP_DATA_FILE, dataContent);
  zip.file(BACKUP_PREFS_FILE, prefsContent);
  zip.file(BACKUP_MAPPING_FILE, mappingContent);
  zip.file(BACKUP_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

async function readZipEntry(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) throw new Error(`备份文件缺少 ${name}`);
  return entry.async("string");
}

function parseJSON(content: string, name: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`备份文件 ${name} 不是有效的 JSON`, { cause: error });
  }
}

export function parseBackupMapping(value: unknown): BackupMapping {
  const raw = value as Partial<BackupMapping>;
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.entries))
    throw new Error("备份 mapping.json 格式无效");
  const entries = raw.entries.map((entry) => {
    const rawEntry = entry as Partial<BackupMappingEntry>;
    if (
      !rawEntry ||
      !Number.isInteger(rawEntry.libraryID) ||
      typeof rawEntry.itemKey !== "string" ||
      !/^[A-Z0-9]{8}$/i.test(rawEntry.itemKey)
    )
      throw new Error("备份 mapping.json 存在无效的条目记录");
    return {
      libraryID: Number(rawEntry.libraryID),
      itemKey: rawEntry.itemKey.toUpperCase(),
      ...(typeof rawEntry.doi === "string" && rawEntry.doi.trim()
        ? { doi: rawEntry.doi }
        : {}),
      ...(typeof rawEntry.title === "string" && rawEntry.title.trim()
        ? { title: rawEntry.title }
        : {}),
    };
  });
  return { schemaVersion: 1, entries };
}

interface ParsedBackupArchive {
  data: unknown;
  dataSchemaVersion: number;
  prefs: Record<string, unknown>;
  mapping: BackupMapping;
}

/** Read and fully validate a backup ZIP without applying anything. */
export async function parseBackupArchive(
  bytes: Uint8Array,
): Promise<ParsedBackupArchive> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new Error("备份文件不是有效的 ZIP 压缩包", { cause: error });
  }
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const unexpected = names.filter(
    (name) => !(BACKUP_FILE_NAMES as readonly string[]).includes(name),
  );
  if (unexpected.length)
    throw new Error(`备份文件包含不允许的内容：${unexpected.join("、")}`);
  for (const name of BACKUP_FILE_NAMES) {
    if (!names.includes(name)) throw new Error(`备份文件缺少 ${name}`);
  }

  const manifest = parseJSON(
    await readZipEntry(zip, BACKUP_MANIFEST_FILE),
    BACKUP_MANIFEST_FILE,
  ) as Partial<BackupManifest>;
  if (
    !manifest ||
    manifest.formatVersion !== BACKUP_FORMAT_VERSION ||
    typeof manifest.schemaVersion !== "number" ||
    !manifest.files ||
    typeof manifest.files !== "object"
  )
    throw new Error("备份 manifest.json 无效或格式版本不受支持");
  if (manifest.schemaVersion !== 1)
    throw new Error(
      `备份数据 schemaVersion ${manifest.schemaVersion} 不受支持，未导入`,
    );
  const requiredFiles = [
    BACKUP_DATA_FILE,
    BACKUP_PREFS_FILE,
    BACKUP_MAPPING_FILE,
  ];
  const expectedFiles = Object.keys(manifest.files).sort();
  const requiredSorted = [...requiredFiles].sort();
  if (
    expectedFiles.length !== requiredSorted.length ||
    expectedFiles.some((name, index) => name !== requiredSorted[index])
  )
    throw new Error("备份 manifest.json 的文件清单无效");

  const contents: Record<string, string> = {};
  for (const name of requiredFiles)
    contents[name] = await readZipEntry(zip, name);
  for (const name of requiredFiles) {
    const checksum = manifest.files[name];
    if (typeof checksum !== "string" || !/^[a-f0-9]{64}$/i.test(checksum))
      throw new Error(`备份 manifest.json 中 ${name} 的校验和无效`);
    const actual = await sha256Hex(contents[name]);
    if (actual !== checksum.toLowerCase())
      throw new Error(`备份文件 ${name} 校验和不匹配，可能已损坏`);
  }

  const data = parseJSON(contents[BACKUP_DATA_FILE], BACKUP_DATA_FILE);
  const dataSchemaVersion = (data as { schemaVersion?: unknown })
    ?.schemaVersion;
  if (dataSchemaVersion !== 1)
    throw new Error("备份 research-data-v1.json 的 schemaVersion 不受支持");
  const prefsValue = parseJSON(contents[BACKUP_PREFS_FILE], BACKUP_PREFS_FILE);
  if (
    !prefsValue ||
    typeof prefsValue !== "object" ||
    Array.isArray(prefsValue)
  )
    throw new Error("备份 prefs.json 格式无效");
  const prefs = prefsValue as Record<string, unknown>;
  if (API_TOKEN_PREF in prefs)
    throw new Error("备份 prefs.json 包含敏感凭据，拒绝导入");
  const mapping = parseBackupMapping(
    parseJSON(contents[BACKUP_MAPPING_FILE], BACKUP_MAPPING_FILE),
  );
  return { data, dataSchemaVersion: 1, prefs, mapping };
}

/** Enumerate regular items of the current personal library for matching. */
export async function enumerateCurrentItems(): Promise<ImportCandidate[]> {
  const all = await Zotero.Items.getAll(
    Zotero.Libraries.userLibraryID,
    true,
    false,
  );
  return all
    .filter((item) => item.isRegularItem())
    .map((item) => {
      const doi = String(item.getField("DOI") || "").trim();
      const title = String(item.getField("title") || "").trim();
      return {
        libraryID: item.libraryID,
        itemKey: item.key,
        ...(doi ? { doi } : {}),
        ...(title ? { title } : {}),
      };
    });
}

/**
 * Import a backup ZIP. The order is fixed: read and validate everything,
 * enumerate and match, back up the current local data, then apply the
 * remapped payload atomically. A payload without any valid match is never
 * written over current data.
 */
export async function importBackupZip(
  bytes: Uint8Array,
  options: { candidates?: ImportCandidate[] } = {},
): Promise<BackupImportReport> {
  const archive = await parseBackupArchive(bytes);
  const candidates = options.candidates ?? (await enumerateCurrentItems());
  const report = matchBackupRecords(archive.mapping, candidates);

  const hasData =
    Object.keys(((archive.data as { items?: object })?.items ?? {}) as object)
      .length > 0;
  if (hasData && report.matched.length === 0)
    throw new Error("备份中没有条目能唯一匹配当前文献库，未覆盖当前数据");

  const remapped = remapLocalPayload(archive.data, report.matched);
  // Parses and validates the payload, backs up the current file as .bak and
  // restores the in-memory state when persistence fails.
  await replaceLocalPayload(remapped, { backupCurrent: true });

  const appliedPrefs: string[] = [];
  for (const key of EXPORTED_PREF_KEYS) {
    if (!(key in archive.prefs)) continue;
    setPref(key, archive.prefs[key] as never);
    appliedPrefs.push(key);
  }

  const skipped = archive.mapping.entries.filter(
    (record) =>
      !report.matched.some(
        (entry) =>
          entry.record.libraryID === record.libraryID &&
          entry.record.itemKey === record.itemKey,
      ) &&
      !report.ambiguous.some((entry) => entry.record === record) &&
      !report.conflicts.some((entry) => entry.record === record),
  );
  return {
    matchedCount: report.matched.length,
    skipped,
    ambiguous: report.ambiguous,
    conflicts: report.conflicts,
    appliedPrefs,
    credentialNote:
      " artifactImportToken 属于敏感凭据，不会从备份恢复；已保留当前机器的值。",
  };
}

export function formatImportReport(report: BackupImportReport): string {
  const parts = [`已导入 ${report.matchedCount} 条研究数据`];
  if (report.skipped.length)
    parts.push(`${report.skipped.length} 条未匹配被跳过`);
  if (report.ambiguous.length)
    parts.push(`${report.ambiguous.length} 条存在歧义未导入`);
  if (report.conflicts.length)
    parts.push(`${report.conflicts.length} 条目标冲突未导入`);
  parts.push(`已应用 ${report.appliedPrefs.length} 项设置`);
  parts.push(report.credentialNote.trim());
  return parts.join("；");
}

/** Default suggested file name for the export dialog. */
export function suggestedBackupFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `zrdb-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}` +
    `${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`
  );
}
