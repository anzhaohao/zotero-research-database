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
export const TRANSLATED_TITLE_FIELD_ID = "translated-title";

export const LEGACY_BUILTIN_FIELD_PROMPTS: Record<string, string> = {
  "research-question": "论文试图回答的核心问题是什么？",
  "research-significance": "为什么需要开展这项研究？",
  "research-value": "这项工作对领域或实际应用的价值是什么？",
  "research-outcomes": "论文取得了哪些主要成果？",
};

export const STRUCTURED_BUILTIN_FIELD_PROMPTS: Record<string, string> = {
  "research-question":
    "提炼论文的核心研究问题。严格输出三个编号段落并各自换行：\n1. 研究对象：研究聚焦什么对象或现象。\n2. 关键矛盾：现有认识、方法或应用存在哪个缺口。\n3. 核心问题：论文最终试图回答什么。\n每段简洁明确，不得合并；论文证据缺失或未明确时写“未明确”，不得编造。",
  "research-significance":
    "说明开展这项研究的意义。严格输出三个编号段落并各自换行：\n1. 研究背景：该问题处于什么背景。\n2. 研究必要性：为什么现在需要解决。\n3. 领域影响：解决后对相关领域有何意义。\n每段简洁明确，不得合并；论文证据缺失或未明确时写“未明确”，不得编造。",
  "research-value":
    "概括论文的研究价值。严格输出三个编号段落并各自换行：\n1. 理论价值：带来什么认识或解释。\n2. 方法价值：提供什么方法、工具或实验能力。\n3. 应用价值：可能支持什么实际应用。\n每段简洁明确，不得合并；论文证据缺失或未明确时写“未明确”，不得编造。",
  "research-outcomes":
    "概括论文的主要成果。严格输出三个编号段落并各自换行：\n1. 方法成果：建立或改进了什么方法。\n2. 结果成果：获得了哪些关键结果。\n3. 结论成果：论文据此得出什么核心结论。\n每段简洁明确，不得合并；论文证据缺失或未明确时写“未明确”，不得编造。",
};

export const BUILTIN_FIELD_PROMPTS: Record<string, string> = {
  "research-question":
    "先用一句直白的话说明论文最终要回答什么，再按理解需要补充研究对象和现有认识或方法的具体缺口。不要把研究背景、方法步骤或结果清单当作研究问题。论文未明确或证据不足时写“未明确”，不得编造。",
  "research-significance":
    "先说明这个问题为什么值得解决，再依据原文区分科学意义与工程、实验或应用价值；没有的方面不硬凑。需要时补充已有工作的基础与限制，但不重复详细研究方案。论文未明确或证据不足时写“未明确”，不得编造。",
  "research-value":
    "先说明这项工作实际推进了什么，再按原文说明它对认识、方法、实验能力或应用的贡献；只写有依据的方面，不要求逐项齐全。区分论文已经展示的价值与合理推断的潜在价值。论文未明确或证据不足时写“未明确”，不得编造。",
  "research-outcomes":
    "先概括论文最重要的发现或结果，再区分直接观察或计算、作者解释及其证据支持程度。保留支撑核心结论的关键结果和条件，不把作者主张写成已证实事实。论文未明确或证据不足时写“未明确”，不得编造。",
};

const LEGACY_READING_FIELD_SUFFIX =
  "这是数据库速览，不是精读笔记，六栏合计约350～500字。请把快速扫读体验放在首位，由你根据本栏内容自主决定最清晰的排版：内容单一时可写连贯短段；包含两个及以上独立要点时，优先使用简短中文加粗标签（如 **机制：**）、单换行、分段或列表建立视觉层次，不要把它们挤成一个长段。结果与证据中的多个定量结果或 Fig. 证据、局限与迁移中的不同类别内容，都应按语义拆分呈现。六栏无需同构，不固定行数、段落数、标签数量或句式，也不要求每栏都使用列表；具体形式和数量由内容决定。避免用多个分号串联不同层次，优先删减次要背景、仪器和过程细节。严格避免跨字段重复：论文定位不展开详细指标，核心逻辑只保留因果链，研究实施不堆砌参数与缩写，决定性定量结果和图号证据集中放在结果与证据。数字与单位之间保留空格，图号写成 Fig. 2 或 Fig. 3a–c。只依据论文原文，确实没有相关信息时写“原文未明确说明”，不得编造。字段保存受限 Markdown 原文；不要使用 Markdown 标题、表格、代码块、原始 HTML、链接、图片或 LaTeX 公式。引用图片证据时只写原文图号并说明作用，不输出图片路径或 Base64。不要输出总标题、开场白或末尾总结。";

const legacyReadingPrompt = (task: string) =>
  `${task}\n\n${LEGACY_READING_FIELD_SUFFIX}`;

export const LEGACY_READING_FIELD_PROMPTS: Record<string, string> = {
  "paper-positioning": legacyReadingPrompt(
    "概括这项工作的类型（如理论、方法、实验、综述）、研究对象，以及最核心的贡献或主张。贡献必须是论文实际新增或推进的内容，不把研究背景、结果清单或作者自评当作贡献。",
  ),
  "research-background": legacyReadingPrompt(
    "说明论文针对的具体问题、为什么值得研究、已有工作提供了什么基础，以及仍留下什么限制或缺口。不要泛写领域重要性，也不要与“论文定位”重复。",
  ),
  "core-logic": legacyReadingPrompt(
    "用一条清晰的因果链概括“问题→思路→实施→证据→结论”，说明连接各环节的关键原理、假设或推理。重点解释论文为什么这样做、各环节怎样衔接，不展开公式推导，不与其他字段重复。",
  ),
  "research-implementation": legacyReadingPrompt(
    "概括论文如何通过理论推导、实验、仿真、数据或案例验证主张；只写关键步骤及关键装置、材料、模型或数据的作用，不逐项罗列参数。综述或纯理论论文按实际组织方式说明，不硬套实验流程。",
  ),
  "results-evidence": legacyReadingPrompt(
    "区分直接观察或计算结果、作者解释及其证据支持程度，概括最关键的结果及其支持的结论；保留少数决定性定量结果和比较对象。优先引用最能支撑结论的原图号（如 Fig. 2、Fig. 3a），说明它展示什么、支撑什么，不只罗列图号。",
  ),
  "limitations-transfer": legacyReadingPrompt(
    "说明结论的适用条件、可能失效的条件、证据或方法限制及实际代价，再指出可迁移到后续研究的具体内容。区分论文明确承认的局限与基于原文的推断；后者用“可进一步”或“可借鉴”标明，不为批评而挑错。",
  ),
};

export const READING_FIELD_PROMPTS: Record<string, string> = {
  "paper-positioning":
    "先用一句直白的话回答“这篇论文本质上做了什么”，指出工作性质和研究对象。工作性质可以是提出方法、解释原理或机制、发现现象、设计装置、验证理论、整合已有方案等，按原文判断，不强行分类。随后按理解需要补充最核心的新贡献或新主张，以及论文最终回答的问题；辅助工作不写成核心贡献，作者自评不等于贡献。",
  "research-background":
    "先回答论文为什么值得做，再说明具体问题及其实际的科学、工程或实验价值。只解释理解核心问题所必需的前置概念及其关系；陌生概念可用直白语言、具体例子或比喻建立直觉，随后回到严格定义，并说明比喻在哪里不再成立。说明前人已经做到哪里、现有限制在哪个环节，以及本文真正新增或改进的内容与沿用的已有方法。不要泛写领域重要性，也不要在没有外部检索材料时补写论文发表后的进展。",
  "core-logic":
    "先用一句简单直白的话说明作者为什么认为这条路线走得通，再梳理论证链“研究问题→核心思路→研究实施→证据→结论”，重点解释各环节为什么能连接。展开决定主张能否成立的原理、建模假设、近似或设计选择；关键公式若承担推理作用，先解释它表达的关系和关键推导步骤。研究对象与实际观测、计算或输出的量不同时，说明二者对应的条件，以及指标可能遗漏的信息或产生多解的原因。结论适用范围写清楚，但不重复实施步骤和结果清单。",
  "research-implementation":
    "先概括作者怎样完成论证或验证，再按论文实际结构说明关键推导、计算、观测、实验、仿真或数据流程。每一步都要说明它在方案中的作用；需要时解释为什么采用当前设计，而不是更简单的替代方案。关键装置、材料、模型、数据、参数、对照和控制变量若影响理解或可靠性就必须保留，否则不逐项罗列。指出最可能影响结果可靠性的环节。理论类关注假设、近似和推导；实验类关注装置作用、校准、对照和误差；测量类关注观测量到目标量的模型与不确定度；仿真类关注方程、条件、收敛性和实验核对；AI 类关注数据来源、标签、数据划分、泄漏、基线和失败案例。只选与当前论文及其疑点有关的分支。",
  "results-evidence":
    "先用一句话说明最重要的结果支持了什么，再按“直接观察或计算到什么→作者如何解释→证据支持到哪一步”组织关键证据。保留决定性数值、比较对象、实验条件和伴随代价，并引用对应图号、表号或公式号；引用图表时说明应该比较什么、出现了什么趋势或差异，以及它在论证中的作用，不只罗列编号。比较是否公平、异常与误差、替代解释及排除它们的对照或独立证据，只在影响结论判断时展开。明确区分论文直接证明、基于证据的合理推断和仍属猜想的内容，不把作者主张写成已证实事实。",
  "limitations-transfer":
    "先说明结论能用到哪里、不能用到哪里，再解释可能失效的条件、证据或方法限制，以及精度、速度、范围、成本、复杂度或通用性上的实际代价；没有的方面不硬凑。更换材料、装置、参数范围、数据分布或实验环境时，区分仍可能成立的结论与需要重新验证的部分。随后指出对后续研究最值得借鉴的原理、研究思路、装置设计、测量方式或分析方法；有原文依据时给出最小复现或验证步骤及缺失条件。论文已经展示的应用与基于证据设想的潜在应用必须分开，后者明确标为推断，不为批评而挑错。",
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
      templateVersion: id === TRANSLATED_TITLE_FIELD_ID ? 1 : 3,
    },
  }));
}

export function createDefaultLayout(): ViewLayout {
  return {
    columnOrder: ["pdfPreview", "title", "basicInfo", "figureGallery"],
    columnWidths: {
      // Leave enough room for a legible preview; the user can still resize
      // this column per saved view to control the rendered thumbnail size.
      pdfPreview: 162,
      title: 338,
      basicInfo: 374,
      figureGallery: 440,
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
