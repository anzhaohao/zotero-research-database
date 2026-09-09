import type { FieldDefinition, ViewLayout, WorkspaceState } from "./types";

export const WORKSPACE_MARKER = "ZRDB Workspace: 1";
export const WORKSPACE_NOTE_MARKER = "zotero-research-database-workspace:v1";
export const RECORD_NOTE_MARKER = "zotero-research-database-record:v1";
export const RECORD_EXTRA_META_KEY = "ZRDB.Record";
export const RECORD_EXTRA_PROPERTY_PREFIX = "ZRDB.Property.";
export const WORKSPACE_EXTRA_KEY = "ZRDB.Workspace";
export const FIGURE_EXTRA_KEY = "ZRDB.Figures";
export const ARTIFACT_EXTRA_KEY = "ZRDB.Artifacts";
export const PRIMARY_PDF_EXTRA_KEY = "ZRDB.PrimaryPDF";
export const SYNCED_SETTING_PREFIX = "zoteroResearchDatabase";
export const WORKSPACE_SYNCED_SETTING = `${SYNCED_SETTING_PREFIX}.workspace.v1`;
export const API_ENDPOINT = "/zotero-research-db/v1/artifacts/import";
export const API_TOKEN_PREF = "artifactImportToken";
export const TRANSLATED_TITLE_FIELD_ID = "translated-title";

export const LEGACY_BUILTIN_FIELD_PROMPTS: Record<string, string> = {
  "research-question": "论文试图回答的核心问题是什么？",
  "research-significance": "为什么需要开展这项研究？",
  "research-value": "这项工作对领域或实际应用的价值是什么？",
  "research-outcomes": "论文取得了哪些主要成果？",
};

export const BUILTIN_FIELD_PROMPTS: Record<string, string> = {
  "research-question":
    "提炼论文的核心研究问题。严格输出三个编号段落并各自换行：\n1. 研究对象：研究聚焦什么对象或现象。\n2. 关键矛盾：现有认识、方法或应用存在哪个缺口。\n3. 核心问题：论文最终试图回答什么。\n每段简洁明确，不得合并；论文证据缺失或未明确时写“未明确”，不得编造。",
  "research-significance":
    "说明开展这项研究的意义。严格输出三个编号段落并各自换行：\n1. 研究背景：该问题处于什么背景。\n2. 研究必要性：为什么现在需要解决。\n3. 领域影响：解决后对相关领域有何意义。\n每段简洁明确，不得合并；论文证据缺失或未明确时写“未明确”，不得编造。",
  "research-value":
    "概括论文的研究价值。严格输出三个编号段落并各自换行：\n1. 理论价值：带来什么认识或解释。\n2. 方法价值：提供什么方法、工具或实验能力。\n3. 应用价值：可能支持什么实际应用。\n每段简洁明确，不得合并；论文证据缺失或未明确时写“未明确”，不得编造。",
  "research-outcomes":
    "概括论文的主要成果。严格输出三个编号段落并各自换行：\n1. 方法成果：建立或改进了什么方法。\n2. 结果成果：获得了哪些关键结果。\n3. 结论成果：论文据此得出什么核心结论。\n每段简洁明确，不得合并；论文证据缺失或未明确时写“未明确”，不得编造。",
};

export function itemSyncedSetting(itemKey: string): string {
  if (!/^[A-Z0-9]{8}$/i.test(itemKey)) throw new Error("无效的 Zotero 条目键");
  return `${SYNCED_SETTING_PREFIX}.item.${itemKey.toUpperCase()}.v1`;
}

const now = () => new Date().toISOString();

export function createID(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createDefaultFields(): FieldDefinition[] {
  return [
    [
      "research-question",
      "研究问题",
      BUILTIN_FIELD_PROMPTS["research-question"],
    ],
    [
      "research-significance",
      "研究意义",
      BUILTIN_FIELD_PROMPTS["research-significance"],
    ],
    ["research-value", "研究价值", BUILTIN_FIELD_PROMPTS["research-value"]],
    [
      "research-outcomes",
      "主要成果",
      BUILTIN_FIELD_PROMPTS["research-outcomes"],
    ],
    [
      TRANSLATED_TITLE_FIELD_ID,
      "中文标题",
      "将外文论文原标题准确翻译成简洁、规范的中文标题；中文论文保持为空。",
    ],
  ].map(([id, name, prompt]) => ({
    id,
    name,
    description: prompt,
    type: "longText" as const,
    options: [],
    extraction: {
      enabled: true,
      instruction: prompt,
      templateVersion: id === TRANSLATED_TITLE_FIELD_ID ? 1 : 2,
    },
  }));
}

export function createDefaultLayout(): ViewLayout {
  return {
    columnOrder: [
      "pdfPreview",
      "title",
      "basicInfo",
      "figureGallery",
      "creators",
      "year",
      "date",
      "DOI",
      "url",
      "tags",
    ],
    columnWidths: {
      // Leave enough room for a legible preview; the user can still resize
      // this column per saved view to control the rendered thumbnail size.
      pdfPreview: 162,
      title: 338,
      basicInfo: 374,
      figureGallery: 440,
      creators: 180,
      year: 90,
      date: 130,
      DOI: 190,
      url: 240,
      tags: 180,
    },
    rowHeight: 270,
    rowHeights: {},
    cardWidth: 300,
    cardDensity: "comfortable",
    visibleColumnIDs: [
      "pdfPreview",
      "title",
      "basicInfo",
      "figureGallery",
      "url",
      "tags",
      "research-question",
      "research-significance",
      "research-value",
      "research-outcomes",
    ],
    columnLabels: {},
    cellColors: {},
    rowColors: {},
    citationStyle: "zotero",
    pinnedColumnIDs: [],
  };
}

/** Fill fields introduced by 0.3 without discarding user layout settings. */
export function normalizeViewLayout(value?: Partial<ViewLayout>): ViewLayout {
  const defaults = createDefaultLayout();
  const raw = value || {};
  return {
    ...defaults,
    ...raw,
    columnOrder: raw.columnOrder?.length
      ? [...raw.columnOrder]
      : defaults.columnOrder,
    columnWidths: { ...defaults.columnWidths, ...(raw.columnWidths || {}) },
    rowHeights: { ...(raw.rowHeights || {}) },
    rowHeight:
      typeof raw.rowHeight === "number" && raw.rowHeight >= 32
        ? raw.rowHeight
        : defaults.rowHeight,
    visibleColumnIDs: raw.visibleColumnIDs
      ? [...raw.visibleColumnIDs]
      : defaults.visibleColumnIDs,
    columnLabels: { ...defaults.columnLabels, ...(raw.columnLabels || {}) },
    cellColors: { ...defaults.cellColors, ...(raw.cellColors || {}) },
    rowColors: { ...defaults.rowColors, ...(raw.rowColors || {}) },
    citationStyle: ["zotero", "gbt7714", "apa7", "nature", "ieee"].includes(
      String(raw.citationStyle),
    )
      ? (raw.citationStyle as ViewLayout["citationStyle"])
      : defaults.citationStyle,
    pinnedColumnIDs: raw.pinnedColumnIDs
      ? [...raw.pinnedColumnIDs]
      : defaults.pinnedColumnIDs,
  };
}

export function createDefaultWorkspace(): WorkspaceState {
  return {
    schemaVersion: 14,
    fields: createDefaultFields(),
    views: [],
    comparisons: [],
    snapshots: [],
    updatedAt: now(),
  };
}
