export type FieldType =
  | "text"
  | "longText"
  | "select"
  | "multiSelect"
  | "number"
  | "date"
  | "checkbox"
  | "rating"
  | "url";

/** A semantic colour token, rather than an arbitrary CSS value. */
export type ViewColor =
  | "none"
  | "blue"
  | "green"
  | "yellow"
  | "orange"
  | "red"
  | "purple"
  | "gray";

export type CitationStyle = "zotero" | "gbt7714" | "apa7" | "nature" | "ieee";
export type FigureKind = "figure" | "table" | "formula";

export interface FieldExtractionDefinition {
  enabled: boolean;
  instruction: string;
  outputLanguage: string;
  templateVersion: number;
}

export interface FieldDefinition {
  id: string;
  name: string;
  description: string;
  type: FieldType;
  options: string[];
  extraction: FieldExtractionDefinition;
  /** Archived fields keep their values and can be restored later. */
  archived?: boolean;
}

export interface FieldAudit {
  executor:
    | "codex"
    | "external-agent"
    | "manual"
    | "import"
    | "legacy-provider";
  executorVersion: string;
  inputType: "mineru-markdown" | "pdf-fulltext" | "manual" | "import";
  inputHash: string;
  generatedAt: string;
  templateVersion: number;
}

export interface ResearchValue {
  value: unknown;
  locked: boolean;
  source: "agent" | "manual" | "import" | "ai";
  updatedAt: string;
  audit?: FieldAudit;
}

export interface ItemResearchRecord {
  schemaVersion: 1;
  libraryID: number;
  itemKey: string;
  revision: number;
  fields: Record<string, ResearchValue>;
  updatedAt: string;
}

/**
 * Plugin-owned data associated with one Zotero item. The object is stored in
 * the local plugin data file so it never enters Zotero's cloud sync queue or
 * exposes implementation metadata in Extra.
 */
export interface ItemInternalState {
  schemaVersion: 1;
  libraryID: number;
  itemKey: string;
  record?: ItemResearchRecord;
  figures: FigureArtifact[];
  artifacts: ManagedArtifact[];
  primaryPdfAttachmentKey?: string;
  updatedAt: string;
}

export interface ViewLayout {
  columnOrder: string[];
  columnWidths: Record<string, number>;
  rowHeight: number;
  rowHeights: Record<string, number>;
  cardWidth: number;
  cardDensity: "compact" | "comfortable";
  /** Columns displayed by this view. Missing values are migrated to all columns. */
  visibleColumnIDs: string[];
  /** Per-view aliases. These never change the underlying Zotero field. */
  columnLabels: Record<string, string>;
  cellColors: Record<string, ViewColor>;
  rowColors: Record<string, ViewColor>;
  /** CSL bibliography style used by the combined basic-information column. */
  citationStyle: CitationStyle;
  pinnedColumnIDs: string[];
  /** Optional per-view override; absent means use the local global settings. */
  figureKinds?: FigureKind[];
}

export interface SavedView {
  id: string;
  name: string;
  mode: "table";
  visibleFieldIDs: string[];
  /** Kept on the view as well as layout for easy future migrations. */
  visibleColumnIDs?: string[];
  /** Optional per-view override; absent means use the local global settings. */
  figureKinds?: FigureKind[];
  sortBy?: { fieldID: string; direction: "asc" | "desc" };
  groupBy?: string;
  filterText: string;
  layout: ViewLayout;
  createdAt: string;
  updatedAt: string;
}

export interface ComparisonDefinition {
  id: string;
  name: string;
  itemKeys: string[];
  fieldIDs: string[];
  synthesisPrompt: string;
  synthesis?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ComparisonRow {
  itemKey: string;
  title: string;
  creators: string;
  year: string;
  values: Record<string, unknown>;
}

export interface ComparisonSnapshot {
  id: string;
  name: string;
  fieldIDs: string[];
  rows: ComparisonRow[];
  synthesis: string;
  createdAt: string;
  exportAttachmentIDs: number[];
}

export interface WorkspaceState {
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
  fields: FieldDefinition[];
  views: SavedView[];
  comparisons: ComparisonDefinition[];
  snapshots: ComparisonSnapshot[];
  updatedAt: string;
}

export interface FigureArtifact {
  id: string;
  parentItemKey: string;
  attachmentKey: string;
  sourcePdfAttachmentKey?: string;
  kind: "figure" | "table";
  caption: string;
  pageIndex: number;
  rect?: { x: number; y: number; width: number; height: number };
  sha256: string;
}

export type ArtifactRole =
  | "mineru-original"
  | "translation"
  | "figure"
  | "table";

/**
 * Plugin-owned attachment metadata. It lives in the parent item's local
 * record so implementation IDs never leak into Zotero's user-facing Extra or
 * tag databases.
 */
export interface ManagedArtifact {
  attachmentKey: string;
  role: ArtifactRole | "snapshot";
  sha256?: string;
  runID?: string;
  figureID?: string;
  snapshotID?: string;
  format?: "md" | "html" | "csv";
  history?: boolean;
}

export interface ArtifactImport {
  role: ArtifactRole;
  path: string;
  sha256: string;
  title: string;
  figure?: {
    id: string;
    caption: string;
    pageIndex: number;
    rect?: { x: number; y: number; width: number; height: number };
    sourcePdfAttachmentKey?: string;
  };
}

export interface ArtifactImportRequest {
  libraryID: number;
  parentItemKey: string;
  workflowRunID: string;
  artifacts: ArtifactImport[];
}

export interface SourceText {
  type: "mineru-markdown" | "pdf-fulltext";
  text: string;
  hash: string;
  attachmentID: number;
  /** The selected primary PDF path, when a local file is available. */
  pdfPath?: string;
  /** Optional local figure/page images supplied by a parser or Agent. */
  images?: string[];
}

/**
 * Input delivered to an external Agent. Paths are local-only and are never
 * persisted in research records or sent to Zotero sync.
 */
export interface AgentDocumentInput {
  pdfPath?: string;
  text?: string;
  images?: string[];
  sourceType?: "mineru-markdown" | "pdf-fulltext" | "pdf-direct";
}
