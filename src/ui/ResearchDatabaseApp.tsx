import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { config } from "../../package.json";
import { useVirtualizer } from "@tanstack/react-virtual";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  TRANSLATED_TITLE_FIELD_ID,
  createID,
  normalizeViewLayout,
} from "../domain/defaults";
import type {
  ComparisonDefinition,
  ComparisonSnapshot,
  FieldDefinition,
  FieldType,
  FigureArtifact,
  FigureKind,
  ItemResearchRecord,
  SavedView,
  ViewColor,
  ViewLayout,
  WorkspaceState,
} from "../domain/types";
import {
  createEmptyRecord,
  setFieldLock,
  setManualValue,
} from "../core/records";
import { researchDisplayBlocks } from "../core/researchText";
import {
  edgeAutoScrollDirection,
  partitionPinnedIDs,
  pinnedLeftOffset,
  reorderColumnLayout,
  togglePinnedColumnIDs,
} from "../core/viewLayout";
import {
  ResearchRepository,
  type EditableNativeField,
} from "../storage/repository";
import { onLocalResearchDataChanged } from "../storage/localData";
import {
  ExternalAgentExtractionService,
  type ExtractionProgress,
} from "../services/extraction";
import {
  translateTitleWithAgent,
  translateTitleWithFallback,
  translateTitleWithPDFTranslate,
} from "../services/titleTranslation";
import {
  createComparisonSnapshot,
  synthesizeComparison,
} from "../services/comparison";
import { exportSnapshotAttachments } from "../services/snapshotExport";
import {
  createAgentBridge,
  type AgentBridge,
  type AgentProfile,
} from "../services/externalAgent";
import {
  AGENT_PRESETS,
  createAgentBridgeFromPrefs,
  parseAgentProfile,
  readAgentProfile,
  saveAgentProfile,
} from "../services/agentSettings";
import {
  MinerUConversionService,
  type MinerUProgress,
  type MinerUProfile,
  parseMinerUProfile,
  readMinerUProfile,
  saveMinerUProfile,
} from "../services/mineru";
import {
  listPdfAttachments,
  pdfAttachmentLabel,
  resolvePrimaryPdf,
  setPrimaryPdf,
  type PrimaryPdfResolution,
} from "../services/primaryPdf";
import {
  getPdfPageCount,
  getPdfRegionThumbnail,
  getPdfThumbnail,
  mineruFigureRenderPlan,
} from "../services/pdfThumbnail";
import {
  invalidateZoteroFigureCache,
  listZoteroFigures,
  openZoteroFigureParserUI,
  openZoteroFigureImage,
  openZoteroFigureSource,
  readZoteroFigureImage,
  zoteroFigureImageSignature,
  type ZoteroFigureKind,
  type ZoteroFigureRecord,
} from "../services/zoteroFigure";
import {
  downloadBlob,
  printTableHTML,
  tableToCSV,
  tableToHTML,
  tableToXLSX,
  type TableExportColumn,
  type TableExportRow,
} from "../services/tableExport";
import {
  ensureArtifactImportToken,
  rotateArtifactImportToken,
} from "../services/artifactEndpoint";
import { getPref, setPref } from "../utils/prefs";
import { copyPlainText } from "../services/clipboard";

export type DatabaseViewMode = "table";

gsap.registerPlugin(useGSAP);

const COLUMN_DRAG_HOLD_MS = 260;
const COLUMN_DRAG_START_DISTANCE = 5;
const COLUMN_DRAG_EDGE_SIZE = 48;
const COLUMN_DRAG_SCROLL_STEP = 16;
const COLUMN_RESIZE_END_GUTTER = 18;
const MIN_ROW_HEIGHT = 200;
const MAX_ROW_HEIGHT = 360;
const ROW_HEIGHT_STEP = 5;
const ROW_HEIGHT_PRESETS = [
  { value: 220, label: "紧凑" },
  { value: 240, label: "标准" },
  { value: 270, label: "舒适" },
  { value: 300, label: "宽松" },
  { value: 340, label: "展开" },
] as const;

interface Props {
  mode: DatabaseViewMode;
  items: Zotero.Item[];
  repository: ResearchRepository;
  zoteroWindow: _ZoteroTypes.MainWindow;
  onSelect: (items: Zotero.Item[]) => Promise<void>;
  onModeChange: (mode: "default" | DatabaseViewMode) => void;
}

interface ColumnDefinition {
  id: string;
  label: string;
  field?: FieldDefinition;
  nativeField?: EditableNativeField;
  kind?: "pdfPreview" | "basicInfo" | "figureGallery";
}

interface EditingCell {
  item: Zotero.Item;
  column: ColumnDefinition;
}

const nativeColumns: ColumnDefinition[] = [
  { id: "pdfPreview", label: "预览", kind: "pdfPreview" },
  { id: "title", label: "标题", nativeField: "title" },
  { id: "basicInfo", label: "基础信息", kind: "basicInfo" },
  { id: "figureGallery", label: "论文图表", kind: "figureGallery" },
  { id: "creators", label: "作者" },
  { id: "year", label: "年份" },
  { id: "date", label: "日期", nativeField: "date" },
  { id: "DOI", label: "DOI", nativeField: "DOI" },
  { id: "url", label: "URL", nativeField: "url" },
  { id: "tags", label: "标签", nativeField: "tags" },
];

type FigureRecord = FigureArtifact | ZoteroFigureRecord;

function isZoteroFigureRecord(
  value: FigureRecord,
): value is ZoteroFigureRecord {
  return (value as ZoteroFigureRecord).provider === "zotero-figure";
}

function figureImageSignature(value: FigureRecord): string {
  return isZoteroFigureRecord(value)
    ? zoteroFigureImageSignature(value)
    : `${value.attachmentKey}:${value.sha256}`;
}

const fieldTypes: Array<{ value: FieldType; label: string }> = [
  { value: "text", label: "短文本" },
  { value: "longText", label: "长文本" },
  { value: "select", label: "单选" },
  { value: "multiSelect", label: "多选" },
  { value: "number", label: "数值" },
  { value: "date", label: "日期" },
  { value: "checkbox", label: "勾选" },
  { value: "rating", label: "评分" },
  { value: "url", label: "URL" },
];

function creators(item: Zotero.Item): string {
  return item
    .getCreators()
    .map((creator) => (creator as any).name || creator.lastName || "")
    .filter(Boolean)
    .join("、");
}

function year(item: Zotero.Item): string {
  return String(item.getField("year") || item.getField("date") || "").slice(
    0,
    4,
  );
}

function itemField(item: Zotero.Item, field: string): string {
  try {
    return String(item.getField(field as any) || "");
  } catch {
    return "";
  }
}

function journalBadges(item: Zotero.Item): string[] {
  const values = item
    .getTags()
    .map((tag) => tag.tag.trim())
    .filter((tag) =>
      /(?:^|\b)(?:SCI|SSCI|EI|CSCD|CSSCI|JCR|Q[1-4])(?:\b|$)|北大核心|北核|核心库|中科院|分区/i.test(
        tag,
      ),
    );
  const extra = itemField(item, "extra");
  for (const line of extra.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:期刊分区|分区|journal\s*(?:zone|partition)|index(?:ed)?)[：:]\s*(.+)$/i,
    );
    if (match) values.push(...match[1].split(/[，,;；|]/));
  }
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].slice(0, 6);
}

function translatedTitle(
  item: Zotero.Item,
  record: ItemResearchRecord | undefined,
): string {
  const title = itemField(item, "title");
  if (/\p{Script=Han}/u.test(title)) return "";
  return displayValue(record?.fields[TRANSLATED_TITLE_FIELD_ID]?.value).trim();
}

function basicInfoText(item: Zotero.Item): string {
  const institution =
    itemField(item, "university") ||
    itemField(item, "institution") ||
    itemField(item, "publisher") ||
    "未记录";
  const journal =
    itemField(item, "publicationTitle") ||
    itemField(item, "proceedingsTitle") ||
    itemField(item, "bookTitle") ||
    "未记录";
  const doi = itemField(item, "DOI") || "未记录";
  const badges = journalBadges(item);
  return [
    `作者：${creators(item) || "未记录"}`,
    `年份：${year(item) || "未记录"}`,
    `期刊：${journal}`,
    `机构：${institution}`,
    `DOI：${doi}`,
    badges.length ? `期刊分区：${badges.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function ResearchTextValue({
  value,
  fieldName,
}: {
  value: unknown;
  fieldName: string;
}) {
  const blocks = researchDisplayBlocks(value, fieldName);
  if (!blocks.length) return <span className="zrdb-empty-value">—</span>;
  return (
    <div className="zrdb-research-text">
      {blocks.map((block, index) => (
        <div
          className={`zrdb-research-block is-${block.kind}`}
          key={`${block.kind}-${index}`}
        >
          {block.kind === "bullet" && (
            <span className="zrdb-research-marker">{block.marker}</span>
          )}
          <span>
            {block.label && <strong>{block.label}</strong>}
            {block.label && "："}
            {block.text}
          </span>
        </div>
      ))}
    </div>
  );
}

function prefersReducedMotion(element: Element | null): boolean {
  if (getPref("motionEnabled") === false) return true;
  const view = element?.ownerDocument?.defaultView;
  const query = view?.matchMedia?.("(prefers-reduced-motion: reduce)");
  return query?.matches === true;
}

function nativeValue(item: Zotero.Item, id: string): string {
  if (id === "title") return String(item.getField("title") || "未命名文献");
  if (id === "creators") return creators(item);
  if (id === "year") return year(item);
  if (id === "basicInfo") {
    return basicInfoText(item);
  }
  if (id === "tags")
    return item
      .getTags()
      .map((tag) => tag.tag)
      .join("，");
  if (["date", "DOI", "url"].includes(id))
    return String(item.getField(id as any) || "");
  return "";
}

export function ResearchDatabaseApp(props: Props) {
  const [workspace, setWorkspace] = useState<WorkspaceState>();
  const [records, setRecords] = useState<Map<string, ItemResearchRecord>>(
    new Map(),
  );
  const [figures, setFigures] = useState<Map<string, FigureRecord[]>>(
    new Map(),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState("");
  const [groupBy, setGroupBy] = useState("");
  const [sortBy, setSortBy] = useState("title");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [activeViewID, setActiveViewID] = useState(`builtin-${props.mode}`);
  const [columnDialog, setColumnDialog] = useState<string>();
  const [agentDialog, setAgentDialog] = useState(false);
  const [agentDialogTab, setAgentDialogTab] = useState<
    "agent" | "mineru" | "pdf"
  >("mineru");
  const [rowHeightDialog, setRowHeightDialog] = useState(false);
  const [savedDialog, setSavedDialog] = useState(false);
  const [openToolbarMenu, setOpenToolbarMenu] = useState<
    "arrange" | "fields" | "views" | undefined
  >();
  const [exportScope, setExportScope] = useState<
    "filtered" | "selected" | "all"
  >("filtered");
  const [comparisonDialog, setComparisonDialog] = useState(false);
  const [comparisonDefinitionID, setComparisonDefinitionID] = useState<
    string | undefined
  >();
  const [comparisonItems, setComparisonItems] = useState<Zotero.Item[]>();
  const [editing, setEditing] = useState<EditingCell>();
  const [progress, setProgress] = useState<Map<string, ExtractionProgress>>(
    new Map(),
  );
  const [extracting, setExtracting] = useState(false);
  const extractionRef = useRef<{ cancel(): void } | undefined>(undefined);
  const appliedViewRef = useRef("");
  const appRef = useRef<HTMLDivElement>(null);
  const rangeSignature = props.items.map((item) => item.key).join("|");
  const rangeItems = useMemo(() => props.items, [rangeSignature]);
  const currentRangeSignatureRef = useRef(rangeSignature);
  currentRangeSignatureRef.current = rangeSignature;
  const reloadEpochRef = useRef(0);
  const [, setItemRevision] = useState(0);
  const [hideMinerUArtifacts, setHideMinerUArtifacts] = useState(
    getPref("hideMinerUArtifactsInNativeList") !== false,
  );
  const [agent, setAgent] = useState<AgentBridge>(() =>
    createAgentBridgeFromPrefs(),
  );

  useGSAP(
    () => {
      const canvas = appRef.current?.querySelector(".zrdb-view-canvas");
      if (!canvas || prefersReducedMotion(canvas)) return;
      gsap.fromTo(
        canvas,
        { autoAlpha: 0, y: 4 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.16,
          ease: "power1.out",
          clearProps: "transform,opacity,visibility",
        },
      );
    },
    {
      scope: appRef,
      dependencies: [props.mode, Boolean(workspace)],
      revertOnUpdate: true,
    },
  );

  const reloadRecords = useCallback(
    async (_state: WorkspaceState, refreshFigures = false) => {
      const requestEpoch = ++reloadEpochRef.current;
      const requestRange = rangeSignature;
      const requestItems = rangeItems;
      if (refreshFigures)
        for (const libraryID of new Set(
          requestItems.map((item) => item.libraryID),
        ))
          invalidateZoteroFigureCache(libraryID);
      const entries = await Promise.all(
        requestItems.map(
          async (item) =>
            [
              item.key,
              (await props.repository.loadRecord(item)) ||
                createEmptyRecord(item.libraryID, item.key),
            ] as const,
        ),
      );
      if (
        requestEpoch !== reloadEpochRef.current ||
        requestRange !== currentRangeSignatureRef.current
      ) {
        return;
      }
      setRecords(new Map(entries));
      const activeFigureView =
        _state.views.find((view) => view.id === activeViewID) ||
        _state.views.find((view) => view.id === `builtin-${props.mode}`);
      const figureKindOverride =
        activeFigureView?.figureKinds || activeFigureView?.layout?.figureKinds;
      const figureEntries = await Promise.all(
        requestItems.map(async (item) => {
          try {
            const allowedKinds = new Set<ZoteroFigureKind>();
            if (figureKindOverride) {
              for (const kind of figureKindOverride) allowedKinds.add(kind);
            } else {
              if (getPref("zoteroFigureShowFigures") !== false)
                allowedKinds.add("figure");
              if (getPref("zoteroFigureShowTables") !== false)
                allowedKinds.add("table");
              if (getPref("zoteroFigureShowFormulas") !== false)
                allowedKinds.add("formula");
            }
            if (getPref("zoteroFigureEnabled") !== false) {
              let native: ZoteroFigureRecord[] = [];
              try {
                native = await listZoteroFigures(item, allowedKinds);
              } catch (error) {
                Zotero.logError(
                  error instanceof Error ? error : new Error(String(error)),
                );
              }
              if (native.length) return [item.key, native] as const;
            }
            if (getPref("mineruFigureFallback") === false)
              return [item.key, [] as FigureRecord[]] as const;
            return [
              item.key,
              (await props.repository.loadFigures(item)).filter((figure) =>
                allowedKinds.has(figure.kind),
              ),
            ] as const;
          } catch (error) {
            Zotero.logError(
              error instanceof Error ? error : new Error(String(error)),
            );
            return [item.key, [] as FigureRecord[]] as const;
          }
        }),
      );
      if (
        requestEpoch !== reloadEpochRef.current ||
        requestRange !== currentRangeSignatureRef.current
      ) {
        return;
      }
      setFigures(new Map(figureEntries));
    },
    [activeViewID, props.mode, props.repository, rangeItems, rangeSignature],
  );

  useEffect(() => {
    let alive = true;
    void props.repository.loadWorkspace().then((state) => {
      if (alive) setWorkspace(state);
    });
    return () => {
      alive = false;
    };
  }, [props.repository]);

  useEffect(() => {
    if (!workspace) return;
    void reloadRecords(workspace);
  }, [reloadRecords, workspace]);

  useEffect(() => {
    if (!workspace) return;
    const keys = [
      "zoteroFigureEnabled",
      "zoteroFigureShowFigures",
      "zoteroFigureShowTables",
      "zoteroFigureShowFormulas",
      "mineruFigureFallback",
      "figureImageQuality",
    ];
    const observerIDs = keys.map((key) =>
      Zotero.Prefs.registerObserver(
        `${config.prefsPrefix}.${key}`,
        () => void reloadRecords(workspace, true),
        true,
      ),
    );
    return () => {
      for (const observerID of observerIDs)
        Zotero.Prefs.unregisterObserver(observerID);
    };
  }, [reloadRecords, workspace]);

  // Local research records are deliberately not part of Zotero's item data.
  // Re-read them here instead of relying on a parent React render, which can
  // preserve this component instance when the visible Zotero range is stable.
  useEffect(() => {
    if (!workspace) return;
    return onLocalResearchDataChanged(() => {
      void reloadRecords(workspace);
    });
  }, [reloadRecords, workspace]);

  useEffect(() => {
    const visible = new Set(props.items.map((item) => item.key));
    setSelected(
      (current) => new Set([...current].filter((key) => visible.has(key))),
    );
  }, [props.items]);

  useEffect(() => {
    if (!openToolbarMenu) return;
    const doc = props.zoteroWindow.document;
    const close = (event: Event) => {
      const target = event.target as Element | null;
      if (!target?.closest?.(".zrdb-toolbar-menu"))
        setOpenToolbarMenu(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenToolbarMenu(undefined);
    };
    doc.addEventListener("pointerdown", close);
    doc.addEventListener("keydown", escape);
    return () => {
      doc.removeEventListener("pointerdown", close);
      doc.removeEventListener("keydown", escape);
    };
  }, [openToolbarMenu, props.zoteroWindow.document]);

  const builtinViewID = `builtin-${props.mode}`;
  const currentView =
    workspace?.views.find(
      (view) => view.id === activeViewID && view.mode === props.mode,
    ) || workspace?.views.find((view) => view.id === builtinViewID);
  const layout = normalizeViewLayout(currentView?.layout);
  if (!currentView) {
    const configuredHeight = Number(getPref("defaultRowHeight"));
    if (configuredHeight >= 32) layout.rowHeight = configuredHeight;
  }
  const visibleFieldIDs = currentView?.visibleFieldIDs?.length
    ? currentView.visibleFieldIDs
    : (workspace?.fields || [])
        .filter((field) => !(field as any).archived)
        .map((field) => field.id);

  useEffect(() => {
    if (!workspace) return;
    const candidate =
      workspace.views.find(
        (view) => view.id === activeViewID && view.mode === props.mode,
      ) || workspace.views.find((view) => view.id === builtinViewID);
    const candidateID = candidate?.id || builtinViewID;
    if (activeViewID !== candidateID) setActiveViewID(candidateID);
    const signature = `${props.mode}:${candidateID}`;
    if (appliedViewRef.current === signature) return;
    setFilterText(candidate?.filterText || "");
    setGroupBy(candidate?.groupBy || "");
    setSortBy(candidate?.sortBy?.fieldID || "title");
    setSortDirection(candidate?.sortBy?.direction || "asc");
    appliedViewRef.current = signature;
  }, [activeViewID, builtinViewID, props.mode, workspace]);

  const saveWorkspace = useCallback(
    async (next: WorkspaceState) => {
      setWorkspace(next);
      await props.repository.saveWorkspace(next);
    },
    [props.repository],
  );

  const patchCurrentView = useCallback(
    async (patch: Partial<SavedView>) => {
      if (!workspace) return;
      const now = new Date().toISOString();
      const viewID = currentView?.id || builtinViewID;
      const existing = workspace.views.find((view) => view.id === viewID);
      const view: SavedView = {
        id: viewID,
        name: "默认表格",
        mode: props.mode,
        visibleFieldIDs,
        visibleColumnIDs: existing?.visibleColumnIDs ?? layout.visibleColumnIDs,
        layout,
        createdAt: now,
        ...existing,
        filterText,
        groupBy: groupBy || undefined,
        sortBy: { fieldID: sortBy, direction: sortDirection },
        ...patch,
        updatedAt: now,
      };
      await saveWorkspace({
        ...workspace,
        views: [
          ...workspace.views.filter((entry) => entry.id !== view.id),
          view,
        ],
      });
    },
    [
      builtinViewID,
      currentView?.id,
      filterText,
      groupBy,
      props.mode,
      saveWorkspace,
      sortBy,
      sortDirection,
      workspace,
      layout,
      visibleFieldIDs,
    ],
  );

  const effectiveFigureKinds: FigureKind[] =
    currentView?.figureKinds ||
    currentView?.layout?.figureKinds ||
    ([
      ...(getPref("zoteroFigureShowFigures") !== false ? ["figure"] : []),
      ...(getPref("zoteroFigureShowTables") !== false ? ["table"] : []),
      ...(getPref("zoteroFigureShowFormulas") !== false ? ["formula"] : []),
    ] as FigureKind[]);
  const hasFigureKindOverride = Boolean(
    currentView?.figureKinds || currentView?.layout?.figureKinds,
  );
  const toggleViewFigureKind = async (kind: FigureKind) => {
    const next = effectiveFigureKinds.includes(kind)
      ? effectiveFigureKinds.filter((entry) => entry !== kind)
      : [...effectiveFigureKinds, kind];
    await patchCurrentView({
      figureKinds: next,
      layout: { ...layout, figureKinds: next },
    });
  };
  const clearViewFigureKinds = async () => {
    const nextLayout = { ...layout };
    delete nextLayout.figureKinds;
    await patchCurrentView({ figureKinds: undefined, layout: nextLayout });
  };

  const openSavedView = useCallback(
    (view: SavedView) => {
      if (view.mode !== "table") return;
      setActiveViewID(view.id);
      setFilterText(view.filterText || "");
      setGroupBy(view.groupBy || "");
      setSortBy(view.sortBy?.fieldID || "title");
      setSortDirection(view.sortBy?.direction || "asc");
      props.onModeChange(view.mode);
      setSavedDialog(false);
    },
    [props],
  );

  const saveCurrentAsNewView = useCallback(async () => {
    if (!workspace) return;
    const suggested = "新表格视图";
    const name = (globalThis as any).prompt?.("视图名称", suggested)?.trim();
    if (!name) return;
    const now = new Date().toISOString();
    const view: SavedView = {
      id: createID("view"),
      name,
      mode: props.mode,
      visibleFieldIDs: workspace.fields.map((field) => field.id),
      visibleColumnIDs: layout.visibleColumnIDs,
      filterText,
      groupBy: groupBy || undefined,
      sortBy: { fieldID: sortBy, direction: sortDirection },
      layout,
      createdAt: now,
      updatedAt: now,
    };
    await saveWorkspace({ ...workspace, views: [...workspace.views, view] });
    setActiveViewID(view.id);
  }, [
    filterText,
    groupBy,
    layout,
    props.mode,
    saveWorkspace,
    sortBy,
    sortDirection,
    workspace,
  ]);

  const filteredItems = useMemo(() => {
    if (!workspace) return [];
    const query = filterText.trim().toLocaleLowerCase();
    const items = props.items.filter((item) => {
      if (!query) return true;
      const record = records.get(item.key);
      return [
        nativeValue(item, "title"),
        creators(item),
        year(item),
        ...workspace.fields.map((field) =>
          displayValue(record?.fields[field.id]?.value),
        ),
      ].some((value) => value.toLocaleLowerCase().includes(query));
    });
    return items.sort((a, b) => {
      const aValue = sortValue(a, sortBy, records);
      const bValue = sortValue(b, sortBy, records);
      return (
        aValue.localeCompare(bValue, "zh-CN", { numeric: true }) *
        (sortDirection === "asc" ? 1 : -1)
      );
    });
  }, [filterText, props.items, records, sortBy, sortDirection, workspace]);

  const selectItem = useCallback(
    async (item: Zotero.Item, event: React.MouseEvent) => {
      const next = new Set(event.ctrlKey || event.metaKey ? selected : []);
      if (next.has(item.key)) next.delete(item.key);
      else next.add(item.key);
      setSelected(next);
      await props.onSelect(props.items.filter((entry) => next.has(entry.key)));
    },
    [props, selected],
  );

  const saveManualValue = useCallback(
    async (item: Zotero.Item, field: FieldDefinition, value: unknown) => {
      if (!workspace) return;
      const current =
        records.get(item.key) || createEmptyRecord(item.libraryID, item.key);
      const next = setManualValue(current, field.id, value);
      await props.repository.saveRecord(item, next, workspace.fields);
      setRecords((all) => new Map(all).set(item.key, next));
      setEditing(undefined);
    },
    [props.repository, records, workspace],
  );

  const saveNativeValue = useCallback(
    async (item: Zotero.Item, field: EditableNativeField, value: string) => {
      await props.repository.saveNativeField(item, field, value);
      setItemRevision((revision) => revision + 1);
      setEditing(undefined);
    },
    [props.repository],
  );

  const toggleLock = useCallback(
    async (item: Zotero.Item, field: FieldDefinition) => {
      if (!workspace) return;
      const current = records.get(item.key);
      if (!current?.fields[field.id]) return;
      const next = setFieldLock(
        current,
        field.id,
        !current.fields[field.id].locked,
      );
      await props.repository.saveRecord(item, next, workspace.fields);
      setRecords((all) => new Map(all).set(item.key, next));
    },
    [props.repository, records, workspace],
  );

  const runExtraction = useCallback(
    async (scope: "selected" | "unprocessed" | "all" | "failed") => {
      if (!workspace || extracting) return;
      let targets = filteredItems;
      if (scope === "selected") {
        targets = filteredItems.filter((item) => selected.has(item.key));
      } else if (scope === "unprocessed") {
        targets = filteredItems.filter((item) =>
          workspace.fields.some(
            (field) =>
              field.extraction.enabled &&
              !displayValue(records.get(item.key)?.fields[field.id]?.value),
          ),
        );
      } else if (scope === "failed") {
        targets = filteredItems.filter(
          (item) => progress.get(item.key)?.state === "failed",
        );
      }
      if (!targets.length) {
        props.zoteroWindow.alert("没有符合条件的文献");
        return;
      }
      setExtracting(true);
      setProgress(new Map());
      const currentAgent = createAgentBridgeFromPrefs();
      setAgent(currentAgent);
      const service = new ExternalAgentExtractionService(
        props.repository,
        currentAgent,
      );
      extractionRef.current = service;
      await service.run(targets, workspace, (entry) => {
        setProgress((current) => new Map(current).set(entry.itemKey, entry));
      });
      await reloadRecords(workspace);
      setExtracting(false);
      props.zoteroWindow.setTimeout(() => {
        setProgress(
          (current) =>
            new Map(
              [...current].filter(([, entry]) => entry.state === "failed"),
            ),
        );
      }, 1400);
    },
    [
      extracting,
      filteredItems,
      props.repository,
      props.zoteroWindow,
      records,
      reloadRecords,
      selected,
      progress,
      workspace,
    ],
  );

  const translateTitle = useCallback(
    async (item: Zotero.Item) => {
      if (!workspace || extracting) return;
      const rawTitle = itemField(item, "title");
      if (/\p{Script=Han}/u.test(rawTitle)) return;
      const currentRecord =
        records.get(item.key) || createEmptyRecord(item.libraryID, item.key);
      const titleField = workspace.fields.find(
        (field) => field.id === TRANSLATED_TITLE_FIELD_ID,
      );
      if (!titleField) throw new Error("研究数据库缺少中文标题字段");
      setExtracting(true);
      setProgress(new Map());
      try {
        let savedRecord: ItemResearchRecord | undefined;
        const translation = await translateTitleWithFallback({
          record: currentRecord,
          translatePrimary: async () => ({
            value: await translateTitleWithPDFTranslate(rawTitle, item.id),
            audit: {
              executor: "legacy-provider",
              executorVersion: "Translate for Zotero 2.4.6",
              inputType: "manual",
              inputHash: "",
              generatedAt: new Date().toISOString(),
              templateVersion: titleField.extraction.templateVersion,
            },
          }),
          translateFallback: async () => {
            const currentAgent = createAgentBridgeFromPrefs();
            setAgent(currentAgent);
            extractionRef.current = currentAgent;
            setProgress(
              new Map([
                [
                  item.key,
                  {
                    itemKey: item.key,
                    fieldIDs: [TRANSLATED_TITLE_FIELD_ID],
                    state: "running",
                    message: "Translate for Zotero 不可用，正在调用外部 Agent",
                  },
                ],
              ]),
            );
            return translateTitleWithAgent(rawTitle, titleField, currentAgent);
          },
          persist: async ({ value, audit }) => {
            savedRecord = await props.repository.saveTranslatedTitle(
              item,
              value,
              audit,
              currentRecord,
            );
          },
        });
        const persistedRecord = savedRecord;
        if (!translation || !persistedRecord) return;
        setRecords((all) => new Map(all).set(item.key, persistedRecord));
        setProgress(
          new Map([
            [
              item.key,
              {
                itemKey: item.key,
                fieldIDs: [TRANSLATED_TITLE_FIELD_ID],
                state: "success",
                message: "中文标题翻译完成",
              },
            ],
          ]),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setProgress(
          new Map([
            [
              item.key,
              {
                itemKey: item.key,
                fieldIDs: [TRANSLATED_TITLE_FIELD_ID],
                state: "failed",
                message: `中文标题翻译失败：${detail}`,
              },
            ],
          ]),
        );
        Zotero.logError(error instanceof Error ? error : new Error(detail));
      } finally {
        setExtracting(false);
      }
    },
    [extracting, props.repository, records, workspace],
  );

  const currentColumns = useColumns(
    workspace?.fields || [],
    layout,
    visibleFieldIDs,
  );
  const exportColumns = currentColumns.filter(
    (column) => column.kind !== "pdfPreview",
  );

  const pinColumn = useCallback(
    (columnID: string) => {
      const sharedOrder = [
        ...new Set([
          ...layout.columnOrder,
          ...currentColumns.map((column) => column.id),
        ]),
      ];
      void patchCurrentView({
        layout: {
          ...layout,
          pinnedColumnIDs: togglePinnedColumnIDs(
            sharedOrder,
            layout.pinnedColumnIDs,
            columnID,
          ),
        },
      });
    },
    [currentColumns, layout, patchCurrentView],
  );

  const toggleMinerUArtifactVisibility = useCallback(() => {
    const next = !hideMinerUArtifacts;
    setHideMinerUArtifacts(next);
    setPref("hideMinerUArtifactsInNativeList", next);
  }, [hideMinerUArtifacts]);

  const exportTable = useCallback(
    async (
      format: "csv" | "xlsx" | "html" | "pdf",
      scope: "filtered" | "selected" | "all",
    ) => {
      const items =
        scope === "selected"
          ? props.items.filter((item) => selected.has(item.key))
          : scope === "all"
            ? props.items
            : filteredItems;
      if (!items.length) {
        props.zoteroWindow.alert("没有可导出的文献");
        return;
      }
      const columns: TableExportColumn[] = exportColumns.map(
        ({ id, label }) => ({ id, label }),
      );
      const rows: TableExportRow[] = items.map((item) => ({
        key: item.key,
        values: Object.fromEntries(
          exportColumns.map((column) => [
            column.id,
            column.field
              ? displayValue(
                  records.get(item.key)?.fields[column.field.id]?.value,
                )
              : nativeValue(item, column.id),
          ]),
        ),
        color: layout.rowColors[item.key],
        cellColors: Object.fromEntries(
          exportColumns.map((column) => [
            column.id,
            layout.cellColors[`${item.key}:${column.id}`],
          ]),
        ),
      }));
      const filename = `zotero-research-database-${new Date().toISOString().slice(0, 10)}`;
      if (format === "csv")
        downloadBlob(
          new Blob(["\ufeff", tableToCSV(columns, rows)], {
            type: "text/csv;charset=utf-8",
          }),
          `${filename}.csv`,
          props.zoteroWindow.document,
        );
      else if (format === "html")
        downloadBlob(
          new Blob(
            [tableToHTML(columns, rows, currentView?.name || "研究数据库")],
            { type: "text/html;charset=utf-8" },
          ),
          `${filename}.html`,
          props.zoteroWindow.document,
        );
      else if (format === "xlsx")
        downloadBlob(
          await tableToXLSX(columns, rows),
          `${filename}.xlsx`,
          props.zoteroWindow.document,
        );
      else
        printTableHTML(
          tableToHTML(columns, rows, currentView?.name || "研究数据库"),
          props.zoteroWindow as unknown as Window,
        );
    },
    [
      currentView?.name,
      exportColumns,
      filteredItems,
      layout,
      props.items,
      props.zoteroWindow,
      records,
      selected,
    ],
  );

  if (!workspace) {
    return <div className="zrdb-loading">正在加载研究数据库……</div>;
  }

  const selectedItems =
    comparisonItems || props.items.filter((item) => selected.has(item.key));
  const density = String(getPref("density") || "comfortable");
  const cornerStrength = String(getPref("cornerStrength") || "medium");
  const shadowStrength = String(getPref("shadowStrength") || "subtle");

  return (
    <div
      className={`zrdb-app density-${density}`}
      data-corners={cornerStrength}
      data-shadow={shadowStrength}
      data-theme="zotero"
      ref={appRef}
    >
      <header className="zrdb-actionbar">
        <div className="zrdb-titlebar">
          <div className="zrdb-context-strip" aria-label="当前数据库状态">
            <span className="zrdb-database-mark" aria-hidden="true">
              <UIIcon name="table" />
            </span>
            <div className="zrdb-database-title">
              <strong>{currentView?.name || "论文精读数据库"}</strong>
              <small>当前范围 · {filteredItems.length} 篇</small>
            </div>
            <span className="zrdb-source-status">
              <i aria-hidden="true" /> Zotero 已载入
            </span>
          </div>
          <span className="zrdb-toolbar-spacer" />
          <div className="zrdb-functionbar" aria-label="数据库功能区">
            <label className="zrdb-search-wrap">
              <UIIcon name="search" />
              <input
                className="zrdb-search"
                value={filterText}
                onChange={(event) => setFilterText(event.target.value)}
                placeholder="筛选当前文献和研究字段"
              />
            </label>

            <ToolbarMenu
              icon="arrange"
              label="排列：排序、分组与升降序"
              open={openToolbarMenu === "arrange"}
              onToggle={() =>
                setOpenToolbarMenu((current) =>
                  current === "arrange" ? undefined : "arrange",
                )
              }
            >
              <h3>排列</h3>
              <label className="zrdb-menu-select">
                <span>排序字段</span>
                <select
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value)}
                >
                  <option value="title">文献标题</option>
                  <option value="year">年份</option>
                  {workspace.fields
                    .filter((field) => !field.archived)
                    .map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                </select>
              </label>
              <MenuButton
                icon="direction"
                label={sortDirection === "asc" ? "升序" : "降序"}
                detail="点击切换"
                onClick={() =>
                  setSortDirection((value) =>
                    value === "asc" ? "desc" : "asc",
                  )
                }
              />
              <div className="zrdb-menu-separator" />
              <label className="zrdb-menu-select">
                <span>分组字段</span>
                <select
                  value={groupBy}
                  onChange={(event) => setGroupBy(event.target.value)}
                >
                  <option value="">不分组</option>
                  <option value="year">年份</option>
                  {workspace.fields
                    .filter((field) => !field.archived)
                    .map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name}
                      </option>
                    ))}
                </select>
              </label>
              <div className="zrdb-menu-separator" />
              <MenuButton
                icon="rowHeight"
                label="统一调整行高"
                detail={`${Math.round(layout.rowHeight)} px`}
                onClick={() => {
                  setOpenToolbarMenu(undefined);
                  setRowHeightDialog(true);
                }}
              />
            </ToolbarMenu>

            <ToolbarMenu
              icon="fields"
              label="字段、列与外部工具"
              open={openToolbarMenu === "fields"}
              onToggle={() =>
                setOpenToolbarMenu((current) =>
                  current === "fields" ? undefined : "fields",
                )
              }
            >
              <h3>字段与工具</h3>
              <MenuButton
                icon="columns"
                label="字段与列管理"
                detail={`${workspace.fields.filter((field) => !field.archived).length} 个字段 · 列布局`}
                onClick={() => setColumnDialog("__all")}
              />
              <div className="zrdb-menu-choice-group" role="group">
                <span>临时固定列</span>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={false}
                  className="zrdb-menu-choice"
                  onClick={() => pinColumn("")}
                  disabled={!layout.pinnedColumnIDs.length}
                >
                  <i aria-hidden="true" />
                  清除全部固定
                </button>
                {currentColumns.map((column) => {
                  const checked = layout.pinnedColumnIDs.includes(column.id);
                  return (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      className="zrdb-menu-choice"
                      key={column.id}
                      onClick={() => pinColumn(column.id)}
                    >
                      <i aria-hidden="true" />
                      {column.label}
                    </button>
                  );
                })}
              </div>
              <div className="zrdb-menu-separator" />
              <MenuButton
                icon="agent"
                label="Agent、MinerU 与主 PDF"
                detail="外部工具"
                onClick={() => {
                  setAgent(createAgentBridgeFromPrefs());
                  setAgentDialogTab("agent");
                  setAgentDialog(true);
                }}
              />
              <MenuButton
                icon="mineru"
                label="MinerU 转换"
                detail={`${selected.size} 篇`}
                onClick={() => {
                  setAgent(createAgentBridgeFromPrefs());
                  setAgentDialogTab("mineru");
                  setAgentDialog(true);
                }}
              />
              <MenuButton
                icon="refresh"
                label="刷新论文图表"
                detail="读取 Zotero Figure / MinerU"
                onClick={() => void reloadRecords(workspace, true)}
              />
              <MenuButton
                icon="open"
                label="打开 Zotero Figure 解析入口"
                detail="可用时打开插件界面"
                onClick={() => {
                  void openZoteroFigureParserUI()
                    .then((opened) => {
                      if (!opened)
                        props.zoteroWindow.alert(
                          "当前 Zotero Figure 版本未公开解析入口；请在 PDF 阅读器中使用 Zotero Figure 解析。",
                        );
                    })
                    .catch(() =>
                      props.zoteroWindow.alert(
                        "无法打开 Zotero Figure；请在 PDF 阅读器中使用 Zotero Figure 解析。",
                      ),
                    );
                }}
              />
              <div className="zrdb-menu-choice-group" role="group">
                <span>
                  当前视图图表类型
                  {!hasFigureKindOverride ? " · 跟随设置" : ""}
                </span>
                {(
                  [
                    ["figure", "图"],
                    ["table", "表"],
                    ["formula", "公式"],
                  ] as Array<[FigureKind, string]>
                ).map(([kind, label]) => (
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={effectiveFigureKinds.includes(kind)}
                    className="zrdb-menu-choice"
                    key={kind}
                    onClick={() => void toggleViewFigureKind(kind)}
                  >
                    <i aria-hidden="true" />
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  className="zrdb-menu-choice"
                  disabled={!hasFigureKindOverride}
                  onClick={() => void clearViewFigureKinds()}
                >
                  恢复跟随全局设置
                </button>
              </div>
              <MenuButton
                icon="mineru"
                label={
                  hideMinerUArtifacts
                    ? "默认列表显示 MinerU 产物"
                    : "默认列表隐藏 MinerU 产物"
                }
                detail="仅本机显示"
                onClick={toggleMinerUArtifactVisibility}
              />
              <MenuButton
                icon="spark"
                label="填充选中文献"
                detail={`${selected.size} 篇`}
                disabled={extracting || selected.size === 0}
                onClick={() => void runExtraction("selected")}
              />
              <MenuButton
                icon="spark"
                label="填充当前视图未处理文献"
                disabled={extracting}
                onClick={() => void runExtraction("unprocessed")}
              />
              <MenuButton
                icon={extracting ? "close" : "refresh"}
                label={extracting ? "取消当前任务" : "重试失败项"}
                disabled={
                  !extracting &&
                  ![...progress.values()].some(
                    (entry) => entry.state === "failed",
                  )
                }
                onClick={() =>
                  extracting
                    ? extractionRef.current?.cancel()
                    : void runExtraction("failed")
                }
              />
            </ToolbarMenu>

            <ToolbarMenu
              icon="views"
              label="视图与导出"
              open={openToolbarMenu === "views"}
              onToggle={() =>
                setOpenToolbarMenu((current) =>
                  current === "views" ? undefined : "views",
                )
              }
            >
              <h3>视图与导出</h3>
              <MenuButton
                icon="save"
                label="保存为新视图"
                onClick={() => void saveCurrentAsNewView()}
              />
              <MenuButton
                icon="folder"
                label="打开已保存内容"
                detail={`${workspace.views.filter((view) => view.mode === "table").length + workspace.comparisons.length + workspace.snapshots.length} 个`}
                onClick={() => setSavedDialog(true)}
              />
              {currentView && !currentView.id.startsWith("builtin-") && (
                <MenuButton
                  icon="refresh"
                  label={`更新“${currentView.name}”`}
                  onClick={() => void patchCurrentView({})}
                />
              )}
              <MenuButton
                icon="compare"
                label="比较选中文献"
                detail={`${selected.size} 篇`}
                disabled={selected.size < 2}
                onClick={() => {
                  setComparisonDefinitionID(undefined);
                  setComparisonItems(undefined);
                  setComparisonDialog(true);
                }}
              />
              <div className="zrdb-menu-separator" />
              <label className="zrdb-menu-select">
                <span>导出范围</span>
                <select
                  value={exportScope}
                  onChange={(event) =>
                    setExportScope(
                      event.target.value as "filtered" | "selected" | "all",
                    )
                  }
                >
                  <option value="filtered">当前筛选结果</option>
                  <option value="selected">当前选中文献</option>
                  <option value="all">当前视图全部文献</option>
                </select>
              </label>
              <div className="zrdb-menu-separator" />
              <MenuButton
                icon="sheet"
                label="导出 Excel"
                detail="保留背景色"
                onClick={() => void exportTable("xlsx", exportScope)}
              />
              <MenuButton
                icon="csv"
                label="导出 CSV"
                onClick={() => void exportTable("csv", exportScope)}
              />
              <MenuButton
                icon="html"
                label="导出 HTML"
                onClick={() => void exportTable("html", exportScope)}
              />
              <MenuButton
                icon="print"
                label="打印 / 导出 PDF"
                onClick={() => void exportTable("pdf", exportScope)}
              />
            </ToolbarMenu>
          </div>
        </div>
      </header>

      {(extracting || progress.size > 0) && (
        <ProgressBar
          progress={progress}
          total={progress.size || selectedItems.length}
        />
      )}

      <div className="zrdb-view-canvas" data-mode={props.mode}>
        <TableView
          items={filteredItems}
          fields={workspace.fields}
          visibleFieldIDs={visibleFieldIDs}
          records={records}
          figures={figures}
          selected={selected}
          groupBy={groupBy}
          layout={layout}
          editing={editing}
          progress={progress}
          onLayout={(next) => void patchCurrentView({ layout: next })}
          onSelect={selectItem}
          onBeginEdit={(item, column) => setEditing({ item, column })}
          onSaveCustom={saveManualValue}
          onSaveNative={saveNativeValue}
          onCancelEdit={() => setEditing(undefined)}
          onToggleLock={toggleLock}
          onManageColumns={(columnID) => setColumnDialog(columnID)}
          onTranslateTitle={translateTitle}
        />
      </div>
      {columnDialog && (
        <ColumnManager
          fields={workspace.fields}
          initialColumnID={columnDialog === "__all" ? undefined : columnDialog}
          layout={layout}
          visibleFieldIDs={visibleFieldIDs}
          onSave={(nextLayout, nextVisibleFieldIDs, nextFields) => {
            const now = new Date().toISOString();
            const viewID = currentView?.id || builtinViewID;
            const existing = workspace.views.find((view) => view.id === viewID);
            const nextView: SavedView = {
              id: viewID,
              name: "默认表格",
              mode: props.mode,
              createdAt: now,
              ...existing,
              visibleFieldIDs: nextVisibleFieldIDs,
              visibleColumnIDs: nextLayout.visibleColumnIDs,
              layout: nextLayout,
              filterText,
              groupBy: groupBy || undefined,
              sortBy: { fieldID: sortBy, direction: sortDirection },
              updatedAt: now,
            };
            void saveWorkspace({
              ...workspace,
              fields: nextFields,
              views: [
                ...workspace.views.filter((view) => view.id !== viewID),
                nextView,
              ],
            });
          }}
          onClose={() => setColumnDialog(undefined)}
        />
      )}
      {agentDialog && (
        <AgentBridgeManager
          agent={agent}
          initialTab={agentDialogTab}
          items={props.items.filter((item) => selected.has(item.key))}
          onAgentChange={setAgent}
          onArtifactsImported={() => reloadRecords(workspace)}
          onClose={() => setAgentDialog(false)}
        />
      )}
      {rowHeightDialog && (
        <RowHeightManager
          rowHeight={layout.rowHeight}
          onApply={(rowHeight) => {
            setRowHeightDialog(false);
            void patchCurrentView({
              layout: { ...layout, rowHeight, rowHeights: {} },
            });
          }}
          onClose={() => setRowHeightDialog(false)}
        />
      )}
      {comparisonDialog && (
        <ComparisonManager
          items={selectedItems}
          records={records}
          workspace={workspace}
          repository={props.repository}
          agent={agent}
          definition={workspace.comparisons.find(
            (entry) => entry.id === comparisonDefinitionID,
          )}
          onSave={saveWorkspace}
          onClose={() => {
            setComparisonDialog(false);
            setComparisonDefinitionID(undefined);
            setComparisonItems(undefined);
          }}
        />
      )}
      {savedDialog && (
        <SavedManager
          workspace={workspace}
          repository={props.repository}
          records={records}
          onSave={saveWorkspace}
          onOpenComparison={(comparison) =>
            void (async () => {
              try {
                const resolved = await resolveSavedItems(
                  comparison.itemKeys,
                  props.repository,
                  records,
                );
                setRecords(
                  (current) => new Map([...current, ...resolved.records]),
                );
                setComparisonItems(resolved.items);
                const next = new Set(comparison.itemKeys);
                setSelected(next);
                setSavedDialog(false);
                setComparisonDefinitionID(comparison.id);
                setComparisonDialog(true);
                await props.onSelect(resolved.items);
              } catch (error) {
                props.zoteroWindow.alert(
                  error instanceof Error ? error.message : String(error),
                );
              }
            })()
          }
          onOpenView={openSavedView}
          onUpdateView={(view) =>
            saveWorkspace({
              ...workspace,
              views: workspace.views.map((entry) =>
                entry.id === view.id
                  ? {
                      ...entry,
                      mode: props.mode,
                      visibleFieldIDs: workspace.fields.map(
                        (field) => field.id,
                      ),
                      filterText,
                      groupBy: groupBy || undefined,
                      sortBy: { fieldID: sortBy, direction: sortDirection },
                      layout,
                      updatedAt: new Date().toISOString(),
                    }
                  : entry,
              ),
            })
          }
          onClose={() => setSavedDialog(false)}
        />
      )}
    </div>
  );
}

function sortValue(
  item: Zotero.Item,
  fieldID: string,
  records: Map<string, ItemResearchRecord>,
): string {
  if (["title", "creators", "year"].includes(fieldID))
    return nativeValue(item, fieldID);
  return displayValue(records.get(item.key)?.fields[fieldID]?.value);
}

async function resolveSavedItems(
  itemKeys: string[],
  repository: ResearchRepository,
  knownRecords: Map<string, ItemResearchRecord>,
): Promise<{
  items: Zotero.Item[];
  records: Map<string, ItemResearchRecord>;
}> {
  const resolved = await Promise.all(
    itemKeys.map((key) =>
      Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, key),
    ),
  );
  const items = resolved.filter(
    (item): item is Zotero.Item => item !== false && item.isRegularItem(),
  );
  if (items.length !== itemKeys.length) {
    throw new Error("已保存比较中的部分 Zotero 论文已不存在或不在个人库");
  }
  const entries = await Promise.all(
    items.map(
      async (item) =>
        [
          item.key,
          knownRecords.get(item.key) ||
            (await repository.loadRecord(item)) ||
            createEmptyRecord(item.libraryID, item.key),
        ] as const,
    ),
  );
  return { items, records: new Map(entries) };
}

type IconName =
  | "agent"
  | "arrange"
  | "check"
  | "chevron"
  | "close"
  | "color"
  | "columns"
  | "compare"
  | "copy"
  | "csv"
  | "direction"
  | "edit"
  | "field"
  | "fields"
  | "folder"
  | "html"
  | "list"
  | "lock"
  | "mineru"
  | "open"
  | "print"
  | "refresh"
  | "rowColor"
  | "rowHeight"
  | "save"
  | "search"
  | "sheet"
  | "spark"
  | "table"
  | "unlock"
  | "views";

function UIIcon({ name }: { name: IconName }) {
  let paths: React.ReactNode;
  switch (name) {
    case "list":
      paths = (
        <>
          <path d="M7 5h9M7 10h9M7 15h9" />
          <path d="M4 5h.01M4 10h.01M4 15h.01" strokeWidth="2.4" />
        </>
      );
      break;
    case "table":
      paths = (
        <>
          <rect x="3" y="3" width="14" height="14" rx="2" />
          <path d="M3 8h14M8 3v14M13 3v14" />
        </>
      );
      break;
    case "search":
      paths = (
        <>
          <circle cx="8.5" cy="8.5" r="4.5" />
          <path d="m12 12 4 4" />
        </>
      );
      break;
    case "arrange":
      paths = (
        <>
          <path d="M4 5h8M4 10h11M4 15h5" />
          <path d="m13 13 2 2 2-2M15 15V9" />
        </>
      );
      break;
    case "fields":
      paths = (
        <>
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <path d="M8 4v12M3 9h14" />
        </>
      );
      break;
    case "views":
      paths = (
        <>
          <path d="M4 3h9l3 3v11H4z" />
          <path d="M12 3v4h4M7 11h6M7 14h4" />
        </>
      );
      break;
    case "direction":
      paths = <path d="m6 4-2 2 2 2M4 6h9M14 16l2-2-2-2M16 14H7" />;
      break;
    case "field":
      paths = (
        <>
          <rect x="3" y="3" width="14" height="14" rx="2" />
          <path d="M7 7h6M7 10h6M7 13h3" />
        </>
      );
      break;
    case "columns":
      paths = (
        <>
          <rect x="3" y="4" width="14" height="12" rx="2" />
          <path d="M8 4v12M13 4v12" />
        </>
      );
      break;
    case "agent":
      paths = (
        <>
          <rect x="4" y="6" width="12" height="10" rx="3" />
          <path d="M10 3v3M7.5 11h.01M12.5 11h.01M7 16v2M13 16v2" />
        </>
      );
      break;
    case "mineru":
      paths = (
        <>
          <path d="M5 3h7l3 3v11H5z" />
          <path d="M12 3v4h4M8 10h4M8 13h4" />
        </>
      );
      break;
    case "spark":
      paths = (
        <path d="m10 2 1.2 4.3L15 8l-3.8 1.7L10 14l-1.2-4.3L5 8l3.8-1.7zM15.5 13l.6 2.1L18 16l-1.9.9-.6 2.1-.6-2.1L13 16l1.9-.9z" />
      );
      break;
    case "close":
      paths = <path d="m5 5 10 10M15 5 5 15" />;
      break;
    case "refresh":
      paths = <path d="M16 7a6 6 0 1 0 .3 5M16 3v4h-4" />;
      break;
    case "save":
      paths = (
        <>
          <path d="M4 3h10l3 3v11H4z" />
          <path d="M7 3v5h7V3M7 17v-5h6v5" />
        </>
      );
      break;
    case "folder":
      paths = <path d="M3 6h6l2-2h6v12H3z" />;
      break;
    case "compare":
      paths = <path d="M7 4H4v12h3M13 4h3v12h-3M8 7h4M8 13h4M10 5v10" />;
      break;
    case "sheet":
      paths = (
        <>
          <rect x="3" y="3" width="14" height="14" rx="2" />
          <path d="M3 8h14M8 3v14M3 13h14" />
        </>
      );
      break;
    case "csv":
      paths = <path d="M5 3h7l3 3v11H5zM11 3v4h4M7 11h6M7 14h6" />;
      break;
    case "html":
      paths = <path d="m7 6-4 4 4 4M13 6l4 4-4 4M11 4 9 16" />;
      break;
    case "print":
      paths = (
        <>
          <path d="M6 7V3h8v4M6 14H4V8h12v6h-2" />
          <path d="M6 11h8v6H6z" />
        </>
      );
      break;
    case "edit":
      paths = <path d="m4 14-.5 3 3-.5L15 8 12 5zM11 6l3 3" />;
      break;
    case "check":
      paths = <path d="m4 10 4 4 8-9" />;
      break;
    case "chevron":
      paths = <path d="m5 8 5 5 5-5" />;
      break;
    case "copy":
      paths = (
        <>
          <rect x="7" y="7" width="10" height="10" rx="2" />
          <path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
        </>
      );
      break;
    case "color":
      paths = (
        <path d="M10 3c3 3.4 5 5.7 5 8a5 5 0 0 1-10 0c0-2.3 2-4.6 5-8zM7 14h6" />
      );
      break;
    case "rowColor":
      paths = <path d="M3 5h14M3 10h14M3 15h14M5 3v14M15 3v14" />;
      break;
    case "rowHeight":
      paths = (
        <>
          <path d="M4 4h12M4 16h12M10 7v6" />
          <path d="m7.5 9.5 2.5-2.5 2.5 2.5M7.5 10.5 10 13l2.5-2.5" />
        </>
      );
      break;
    case "open":
      paths = <path d="M11 4h5v5M16 4l-7 7M14 11v5H4V6h5" />;
      break;
    case "lock":
      paths = <path d="M5 9h10v8H5zM7 9V6a3 3 0 0 1 6 0v3" />;
      break;
    case "unlock":
      paths = <path d="M5 9h10v8H5zM8 9V6a3 3 0 0 1 5-2" />;
      break;
  }
  return (
    <svg className="zrdb-ui-icon" viewBox="0 0 20 20" aria-hidden="true">
      {paths}
    </svg>
  );
}

function IconButton({
  icon,
  label,
  active = false,
  disabled = false,
  className = "",
  onClick,
}: {
  icon: IconName;
  label: string;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`zrdb-icon-button ${active ? "is-active" : ""} ${className}`}
      data-tooltip={label}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <UIIcon name={icon} />
    </button>
  );
}

function MenuButton({
  icon,
  label,
  detail,
  disabled = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="zrdb-menu-item"
      disabled={disabled}
      onClick={onClick}
    >
      <UIIcon name={icon} />
      <span>{label}</span>
      {detail && <small>{detail}</small>}
    </button>
  );
}

function ToolbarMenu({
  icon,
  label,
  open,
  onToggle,
  children,
}: {
  icon: IconName;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const menu = rootRef.current?.querySelector(".zrdb-menu-popover");
      if (!open || !menu || prefersReducedMotion(menu)) return;
      gsap.fromTo(
        menu,
        { autoAlpha: 0, y: -3, scale: 0.985 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.14,
          ease: "power1.out",
          clearProps: "transform,opacity,visibility",
        },
      );
    },
    { scope: rootRef, dependencies: [open], revertOnUpdate: true },
  );
  return (
    <div className={`zrdb-toolbar-menu ${open ? "is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="zrdb-menu-trigger zrdb-icon-button"
        data-tooltip={label}
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={onToggle}
      >
        <UIIcon name={icon} />
      </button>
      {open && (
        <div className="zrdb-menu-popover" role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

function ProgressBar({
  progress,
  total,
}: {
  progress: Map<string, ExtractionProgress>;
  total: number;
}) {
  const done = [...progress.values()].filter((entry) =>
    ["success", "failed", "cancelled"].includes(entry.state),
  ).length;
  const failed = [...progress.values()].filter(
    (entry) => entry.state === "failed",
  );
  const failureSummary = failed
    .map((entry) => `${entry.itemKey}：${entry.message}`)
    .join("\n");
  return (
    <div className="zrdb-progress" title={failureSummary || undefined}>
      <div
        style={{ width: `${Math.min(100, total ? (done / total) * 100 : 0)}%` }}
      />
      <span>
        {done}/{total}
        {failed.length ? `，失败 ${failed.length}` : ""}
      </span>
    </div>
  );
}

function useColumns(
  fields: FieldDefinition[],
  layout: ViewLayout,
  visibleFieldIDs: string[],
): ColumnDefinition[] {
  return useMemo(() => {
    const all: ColumnDefinition[] = [
      ...nativeColumns,
      ...fields
        .filter(
          (field) =>
            !(field as any).archived && field.id !== TRANSLATED_TITLE_FIELD_ID,
        )
        .map((field) => ({ id: field.id, label: field.name, field })),
    ];
    const order = [...layout.columnOrder, ...all.map((column) => column.id)];
    const visible = new Set(layout.visibleColumnIDs || []);
    const showsBasicInfo = visible.size === 0 || visible.has("basicInfo");
    const combinedMetadata = new Set(["creators", "year", "date", "DOI"]);
    const ordered = [...new Set(order)]
      .map((id) => all.find((column) => column.id === id))
      .filter((column): column is ColumnDefinition => {
        if (!column) return false;
        if (showsBasicInfo && combinedMetadata.has(column.id)) return false;
        return column.field
          ? visibleFieldIDs.includes(column.id)
          : visible.size === 0 || visible.has(column.id);
      })
      .map((column) => ({
        ...column,
        label: layout.columnLabels[column.id] || column.label,
      }));
    const byID = new Map(ordered.map((column) => [column.id, column]));
    return partitionPinnedIDs(
      ordered.map((column) => column.id),
      layout.pinnedColumnIDs,
    ).map((id) => byID.get(id)!);
  }, [fields, layout, visibleFieldIDs]);
}

function colorValue(color: string | undefined): string | undefined {
  if (!color || color === "none") return undefined;
  return `var(--zrdb-color-${color})`;
}

function TitleCell({
  item,
  record,
  translating,
  failureReason,
  onTranslate,
}: {
  item: Zotero.Item;
  record: ItemResearchRecord | undefined;
  translating: boolean;
  failureReason?: string;
  onTranslate: () => void;
}) {
  const translation = translatedTitle(item, record);
  const foreignTitle = !/\p{Script=Han}/u.test(itemField(item, "title"));
  const locked = record?.fields[TRANSLATED_TITLE_FIELD_ID]?.locked === true;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (copyTimer.current !== undefined)
        (globalThis as any).clearTimeout(copyTimer.current);
    },
    [],
  );
  return (
    <div className="zrdb-paper-title">
      <div className="zrdb-paper-title-heading">
        <strong>{nativeValue(item, "title")}</strong>
        <button
          type="button"
          className="zrdb-original-title-copy"
          aria-label={
            copyState === "copied"
              ? "原标题已复制"
              : copyState === "failed"
                ? "原标题复制失败"
                : "复制原标题"
          }
          title={
            copyState === "copied"
              ? "原标题已复制"
              : copyState === "failed"
                ? "原标题复制失败"
                : "复制原标题"
          }
          data-copy-state={copyState}
          onClick={(event) => {
            event.stopPropagation();
            const view = event.currentTarget.ownerDocument?.defaultView;
            void copyPlainText(
              itemField(item, "title") || "未命名文献",
              event.currentTarget.ownerDocument,
            ).then((copied) => {
              setCopyState(copied ? "copied" : "failed");
              if (!view) return;
              if (copyTimer.current !== undefined)
                view.clearTimeout(copyTimer.current);
              copyTimer.current = view.setTimeout(
                () => setCopyState("idle"),
                1200,
              );
            });
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <UIIcon name={copyState === "copied" ? "check" : "copy"} />
        </button>
      </div>
      {translation && <span>{translation}</span>}
      {foreignTitle && !translation && (
        <button
          type="button"
          className="zrdb-title-translate"
          disabled={translating || locked}
          title={
            locked
              ? "中文标题已锁定"
              : failureReason
                ? `上次翻译失败：${failureReason}；点击重试`
                : "优先使用 Translate for Zotero，失败后自动调用当前 Agent"
          }
          onClick={(event) => {
            event.stopPropagation();
            onTranslate();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {translating
            ? "正在翻译…"
            : locked
              ? "中文标题已锁定"
              : failureReason
                ? "重试翻译"
                : "翻译成中文"}
        </button>
      )}
      {failureReason && (
        <small className="zrdb-title-translation-error" title={failureReason}>
          {failureReason}
        </small>
      )}
    </div>
  );
}

function BasicInfoCell({ item }: { item: Zotero.Item }) {
  const institution =
    itemField(item, "university") ||
    itemField(item, "institution") ||
    itemField(item, "publisher") ||
    "未记录";
  const journal =
    itemField(item, "publicationTitle") ||
    itemField(item, "proceedingsTitle") ||
    itemField(item, "bookTitle") ||
    "未记录";
  const doi = itemField(item, "DOI") || "未记录";
  const rows = [
    ["作者", creators(item) || "未记录"],
    ["年份", year(item) || "未记录"],
    ["期刊", journal],
    ["机构", institution],
    ["DOI", doi],
  ];
  return (
    <div className="zrdb-basic-info">
      {rows.map(([label, value]) => (
        <div className="zrdb-basic-row" key={label}>
          <b>{label}</b>
          <span>{value}</span>
        </div>
      ))}
      {journalBadges(item).length > 0 && (
        <div className="zrdb-journal-badges">
          {journalBadges(item).map((badge, index) => (
            <span key={badge} data-tone={index % 3}>
              {badge}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PdfPreview({
  item,
  thumbnailWidth,
}: {
  item: Zotero.Item;
  thumbnailWidth: number;
}) {
  const [pageCount, setPageCount] = useState<number>();
  const [visiblePages, setVisiblePages] = useState(3);
  useEffect(() => {
    let alive = true;
    setPageCount(undefined);
    setVisiblePages(3);
    void getPdfPageCount(item).then((next) => {
      if (alive) setPageCount(next);
    });
    return () => {
      alive = false;
    };
  }, [item]);
  const renderedPageCount = Math.min(Math.max(pageCount || 1, 1), visiblePages);
  const pages = Array.from(
    { length: renderedPageCount },
    (_, index) => index + 1,
  );
  return (
    <div
      className="zrdb-pdf-thumbnail-stack"
      aria-label={pageCount ? `PDF 缩略图，共 ${pageCount} 页` : "PDF 缩略图"}
      style={
        {
          "--zrdb-pdf-thumbnail-width": `${thumbnailWidth}px`,
        } as React.CSSProperties
      }
      onScroll={(event) => {
        const target = event.currentTarget;
        if (
          pageCount &&
          visiblePages < pageCount &&
          target.scrollTop + target.clientHeight >= target.scrollHeight - 24
        ) {
          setVisiblePages((current) => Math.min(pageCount, current + 2));
        }
      }}
    >
      {pages.map((page) => (
        <PdfThumbnailPage
          item={item}
          page={page}
          thumbnailWidth={thumbnailWidth}
          key={page}
        />
      ))}
      {pageCount && visiblePages < pageCount && (
        <span className="zrdb-pdf-thumbnail-more">继续向下滚动加载</span>
      )}
    </div>
  );
}

function PdfThumbnailPage({
  item,
  page,
  thumbnailWidth,
}: {
  item: Zotero.Item;
  page: number;
  thumbnailWidth: number;
}) {
  const [result, setResult] =
    useState<Awaited<ReturnType<typeof getPdfThumbnail>>>();
  useEffect(() => {
    let alive = true;
    void getPdfThumbnail(item, thumbnailWidth, page).then((next) => {
      if (alive) setResult(next);
    });
    return () => {
      alive = false;
    };
  }, [item, page, thumbnailWidth]);
  if (!result?.dataUrl) {
    return (
      <span className="zrdb-pdf-placeholder">
        {result?.reason === "unreadable" ? "PDF 不可读" : "PDF"}
      </span>
    );
  }
  return (
    <span className="zrdb-pdf-thumb-page">
      <img
        className="zrdb-pdf-thumb"
        src={result.dataUrl}
        alt={`PDF 第 ${page} 页`}
      />
      <small>{page}</small>
    </span>
  );
}

function FigureGallery({
  item,
  figures,
}: {
  item: Zotero.Item;
  figures: FigureRecord[];
}) {
  if (!figures.length)
    return <span className="zrdb-figures-empty">尚未提取</span>;
  return (
    <div className="zrdb-figure-gallery">
      {figures.map((figure) => (
        <FigureThumbnail
          key={`${figure.id}:${figureImageSignature(figure)}`}
          item={item}
          figure={figure}
        />
      ))}
    </div>
  );
}

function FigureThumbnail({
  item,
  figure,
}: {
  item: Zotero.Item;
  figure: FigureRecord;
}) {
  const [dataUrl, setDataUrl] = useState<string>();
  const [imagePath, setImagePath] = useState<string>();
  const [missing, setMissing] = useState(false);
  const clickTimer = useRef<number | undefined>(undefined);
  const imageSignature = figureImageSignature(figure);
  useEffect(() => {
    let alive = true;
    setDataUrl(undefined);
    setImagePath(undefined);
    setMissing(false);
    void (async () => {
      try {
        if (isZoteroFigureRecord(figure)) {
          const image = await readZoteroFigureImage(figure);
          if (!alive) return;
          if (!image.dataUrl) {
            setMissing(true);
            return;
          }
          setDataUrl(image.dataUrl);
          setImagePath(image.path);
          return;
        }
        const renderPlan = mineruFigureRenderPlan(
          Boolean(figure.rect),
          String(getPref("figureImageQuality") || "high"),
        );
        if (figure.rect && renderPlan.previewWidth) {
          const rendered = await getPdfRegionThumbnail(
            item,
            figure.pageIndex,
            figure.rect,
            renderPlan.previewWidth,
          );
          if (!alive) return;
          if (rendered.dataUrl) {
            setDataUrl(rendered.dataUrl);
            setImagePath(rendered.path);
            return;
          }
        }
        const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
          item.libraryID,
          figure.attachmentKey,
        );
        if (!alive) return;
        if (!attachment) {
          setMissing(true);
          return;
        }
        const path = await attachment.getFilePathAsync();
        if (!alive) return;
        if (!path) {
          setMissing(true);
          return;
        }
        // Zotero 9.0.6 implements this as async even though the published
        // zotero-types declaration still says it returns a string.
        const generated = await Promise.resolve(
          Zotero.File.generateDataURI(
            path,
            imageContentType(
              path,
              String((attachment as any).attachmentContentType || ""),
            ),
          ) as unknown as string | Promise<string>,
        );
        if (!alive) return;
        if (
          typeof generated !== "string" ||
          !generated.startsWith("data:image/")
        ) {
          setMissing(true);
          return;
        }
        setDataUrl(generated);
      } catch {
        if (alive) setMissing(true);
      }
    })();
    return () => {
      alive = false;
      if (clickTimer.current !== undefined)
        (globalThis as any).clearTimeout(clickTimer.current);
    };
  }, [imageSignature, item.libraryID]);

  const openImage = async () => {
    if (isZoteroFigureRecord(figure)) {
      await openZoteroFigureImage(figure);
      return;
    }
    const renderPlan = mineruFigureRenderPlan(
      Boolean(figure.rect),
      String(getPref("figureImageQuality") || "high"),
    );
    if (figure.rect && renderPlan.openWidth) {
      const full = await getPdfRegionThumbnail(
        item,
        figure.pageIndex,
        figure.rect,
        renderPlan.openWidth,
      );
      if (full.path && (await IOUtils.exists(full.path)))
        await Zotero.launchFile(full.path);
      return;
    }
    if (imagePath && (await IOUtils.exists(imagePath))) {
      await Zotero.launchFile(imagePath);
      return;
    }
    const attachment = await Zotero.Items.getByLibraryAndKeyAsync(
      item.libraryID,
      figure.attachmentKey,
    );
    if (!attachment) return;
    const path = await attachment.getFilePathAsync();
    if (path) await Zotero.launchFile(path);
  };

  const openPdf = async () => {
    if (isZoteroFigureRecord(figure)) {
      await openZoteroFigureSource(figure, item);
      return;
    }
    let pdf = figure.sourcePdfAttachmentKey
      ? await Zotero.Items.getByLibraryAndKeyAsync(
          item.libraryID,
          figure.sourcePdfAttachmentKey,
        )
      : false;
    if (!pdf) pdf = (await resolvePrimaryPdf(item))?.attachment || false;
    if (!pdf) return;
    const location = figure.rect
      ? {
          position: {
            pageIndex: figure.pageIndex,
            rects: [
              [
                figure.rect.x,
                figure.rect.y,
                figure.rect.x + figure.rect.width,
                figure.rect.y + figure.rect.height,
              ],
            ],
          },
        }
      : { pageIndex: figure.pageIndex };
    if ((Zotero.Reader as any)?.open)
      await (Zotero.Reader as any).open(pdf.id, location);
    else await (Zotero.FileHandlers as any).open(pdf, { location });
  };

  return (
    <button
      type="button"
      className="zrdb-figure-thumb"
      title={`${figure.kind === "figure" ? "图" : figure.kind === "table" ? "表" : "公式"} · 第 ${figure.pageIndex + 1} 页\n${figure.caption}`}
      onClick={(event) => {
        event.stopPropagation();
        const view = event.currentTarget.ownerDocument?.defaultView;
        if (!view) return;
        if (clickTimer.current !== undefined)
          view.clearTimeout(clickTimer.current);
        clickTimer.current = view.setTimeout(() => {
          clickTimer.current = undefined;
          void openImage();
        }, 220);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        const view = event.currentTarget.ownerDocument?.defaultView;
        if (view && clickTimer.current !== undefined)
          view.clearTimeout(clickTimer.current);
        clickTimer.current = undefined;
        void openPdf();
      }}
    >
      <span className="zrdb-figure-image-frame">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt={figure.caption || figure.id}
            loading="lazy"
            onError={() => {
              setDataUrl(undefined);
              setMissing(true);
            }}
          />
        ) : (
          <span>{missing ? "图片无法读取" : "正在加载图片"}</span>
        )}
        {isZoteroFigureRecord(figure) &&
          figure.kind === "formula" &&
          figure.latex && (
            <span className="zrdb-formula-latex" aria-label="公式 LaTeX">
              {figure.latex}
            </span>
          )}
      </span>
      <span className="zrdb-figure-caption">
        <small>
          {figure.kind === "figure"
            ? "图"
            : figure.kind === "table"
              ? "表"
              : "公式"}{" "}
          {figure.pageIndex + 1}
        </small>
        {figure.caption && <span>{figure.caption}</span>}
      </span>
    </button>
  );
}

function imageContentType(path: string, stored: string): string {
  if (stored.startsWith("image/")) return stored;
  const extension = path.split(".").pop()?.toLocaleLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "tif" || extension === "tiff") return "image/tiff";
  if (extension === "bmp") return "image/bmp";
  return "image/png";
}

interface ColorTarget {
  kind: "cell" | "row";
  itemKey: string;
  columnID?: string;
  left: number;
  top: number;
}

const colorChoices: Array<{ value: ViewColor; label: string }> = [
  { value: "none", label: "清除" },
  { value: "gray", label: "灰" },
  { value: "blue", label: "蓝" },
  { value: "green", label: "绿" },
  { value: "yellow", label: "黄" },
  { value: "orange", label: "橙" },
  { value: "red", label: "红" },
  { value: "purple", label: "紫" },
];

function ColorMenu({
  target,
  onChoose,
  onClose,
}: {
  target: ColorTarget;
  onChoose: (color: ViewColor) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="zrdb-color-menu"
      style={{ left: target.left, top: target.top }}
      role="menu"
      onMouseDown={(event) => event.stopPropagation()}
    >
      {colorChoices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          title={choice.label}
          aria-label={choice.label}
          className={`zrdb-color-swatch color-${choice.value}`}
          onClick={() => onChoose(choice.value)}
        >
          {choice.value === "none" ? "×" : ""}
        </button>
      ))}
      <button type="button" className="zrdb-color-close" onClick={onClose}>
        完成
      </button>
    </div>
  );
}

function CellAgentStatus({ progress }: { progress: ExtractionProgress }) {
  const label =
    progress.state === "running"
      ? progress.message
      : progress.state === "success"
        ? "AI 提取完成"
        : progress.state === "failed"
          ? `AI 提取失败：${progress.message}`
          : "AI 提取已取消";
  return (
    <span
      className={`zrdb-cell-agent-status is-${progress.state}`}
      data-agent-state={progress.state}
      role={progress.state === "failed" ? "alert" : "status"}
      aria-label={label}
      title={label}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        {progress.state === "running" ? (
          <>
            <circle className="zrdb-agent-ring-track" cx="10" cy="10" r="7" />
            <circle className="zrdb-agent-ring-value" cx="10" cy="10" r="7" />
          </>
        ) : (
          <circle className="zrdb-agent-ring-outline" cx="10" cy="10" r="7" />
        )}
        {progress.state === "success" && <path d="m6.7 10 2.1 2.1 4.6-4.5" />}
        {progress.state === "failed" && (
          <>
            <path d="M10 6.2v4.9" />
            <path d="M10 13.8h.01" strokeWidth="2.1" />
          </>
        )}
        {progress.state === "cancelled" && <path d="M6.8 10h6.4" />}
      </svg>
    </span>
  );
}

type FlatRow =
  | { type: "group"; label: string }
  | { type: "item"; item: Zotero.Item };

function TableView(props: {
  items: Zotero.Item[];
  fields: FieldDefinition[];
  visibleFieldIDs: string[];
  records: Map<string, ItemResearchRecord>;
  figures: Map<string, FigureRecord[]>;
  selected: Set<string>;
  groupBy: string;
  layout: ViewLayout;
  editing?: EditingCell;
  progress: Map<string, ExtractionProgress>;
  onLayout: (layout: ViewLayout) => void;
  onSelect: (item: Zotero.Item, event: React.MouseEvent) => Promise<void>;
  onBeginEdit: (item: Zotero.Item, column: ColumnDefinition) => void;
  onSaveCustom: (
    item: Zotero.Item,
    field: FieldDefinition,
    value: unknown,
  ) => Promise<void>;
  onSaveNative: (
    item: Zotero.Item,
    field: EditableNativeField,
    value: string,
  ) => Promise<void>;
  onCancelEdit: () => void;
  onToggleLock: (item: Zotero.Item, field: FieldDefinition) => Promise<void>;
  onManageColumns: (columnID: string) => void;
  onTranslateTitle: (item: Zotero.Item) => Promise<void>;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef(props.layout);
  const draftRef = useRef<ViewLayout | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);
  const [draftLayout, setDraftLayout] = useState<ViewLayout | undefined>(
    undefined,
  );
  const [colorTarget, setColorTarget] = useState<ColorTarget>();
  const [selectedColumnID, setSelectedColumnID] = useState<string>();
  const [activeCell, setActiveCell] = useState<{
    itemKey: string;
    columnID: string;
  }>();
  const [draggingColumnID, setDraggingColumnID] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{
    columnID: string;
    after: boolean;
  }>();
  const dropTargetRef = useRef<{
    columnID: string;
    after: boolean;
  }>(undefined);
  const dragCleanupRef = useRef<(() => void) | undefined>(undefined);
  const shownLayout = draftLayout || props.layout;
  const columns = useColumns(props.fields, shownLayout, props.visibleFieldIDs);
  const columnWidth = (columnID: string) =>
    shownLayout.columnWidths[columnID] || (columnID === "title" ? 320 : 180);
  const tableWidth = columns.reduce(
    (total, column) => total + columnWidth(column.id),
    0,
  );
  const tableCanvasWidth = tableWidth + COLUMN_RESIZE_END_GUTTER;
  useEffect(() => {
    layoutRef.current = props.layout;
    if (!draftRef.current) setDraftLayout(undefined);
  }, [props.layout]);
  const flatRows = useMemo<FlatRow[]>(() => {
    if (!props.groupBy)
      return props.items.map((item) => ({ type: "item", item }));
    const groups = new Map<string, Zotero.Item[]>();
    for (const item of props.items) {
      const label =
        props.groupBy === "year"
          ? year(item) || "未设置"
          : displayValue(
              props.records.get(item.key)?.fields[props.groupBy]?.value,
            ) || "未设置";
      groups.set(label, [...(groups.get(label) || []), item]);
    }
    return [...groups.entries()].flatMap(([label, items]) => [
      { type: "group" as const, label: `${label}（${items.length}）` },
      ...items.map((item) => ({ type: "item" as const, item })),
    ]);
  }, [props.groupBy, props.items, props.records]);
  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const row = flatRows[index];
      if (!row || row.type === "group") return 34;
      return shownLayout.rowHeights[row.item.key] || shownLayout.rowHeight;
    },
    overscan: 8,
  });
  const storedRowHeightSignature = JSON.stringify(props.layout.rowHeights);
  useEffect(() => {
    virtualizer.measure();
  }, [props.layout.rowHeight, storedRowHeightSignature, virtualizer]);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    [],
  );

  const resizeColumn = (event: React.PointerEvent, columnID: string) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic test events do not create an active browser pointer.
    }
    const startX = event.clientX;
    const startWidth = columnWidth(columnID);
    const win = event.currentTarget.ownerDocument?.defaultView;
    if (!win) return;
    const move = (next: PointerEvent) => {
      const base = draftRef.current || layoutRef.current;
      draftRef.current = {
        ...base,
        columnWidths: {
          ...base.columnWidths,
          [columnID]: Math.max(80, startWidth + next.clientX - startX),
        },
      };
      if (rafRef.current !== undefined) return;
      rafRef.current = win.requestAnimationFrame(() => {
        rafRef.current = undefined;
        if (draftRef.current) setDraftLayout(draftRef.current);
      });
    };
    const up = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", up);
      if (rafRef.current !== undefined) {
        win.cancelAnimationFrame(rafRef.current);
        rafRef.current = undefined;
      }
      const finalLayout = draftRef.current;
      draftRef.current = undefined;
      if (finalLayout) setDraftLayout(finalLayout);
      if (finalLayout) props.onLayout(finalLayout);
    };
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up);
    win.addEventListener("pointercancel", up);
  };

  const reorder = (from: string, to: string, after: boolean) => {
    if (!from || from === to) return;
    const allIDs = [
      ...new Set([
        ...shownLayout.columnOrder,
        ...nativeColumns.map((column) => column.id),
        ...props.fields.map((field) => field.id),
      ]),
    ];
    const targetPinned = shownLayout.pinnedColumnIDs.includes(to);
    const next = reorderColumnLayout(
      allIDs,
      shownLayout.pinnedColumnIDs,
      from,
      to,
      after,
      targetPinned,
    );
    props.onLayout({
      ...shownLayout,
      ...next,
    });
  };

  const beginColumnDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    columnID: string,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragCleanupRef.current?.();

    const grip = event.currentTarget;
    try {
      grip.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events used by the Zotero test runner are not capturable.
    }
    const doc = event.currentTarget.ownerDocument!;
    const win = doc.defaultView;
    if (!win) return;
    const pointerID = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let armed = false;
    let finished = false;
    let frame: number | undefined;
    let scrollDirection: -1 | 0 | 1 = 0;
    let lastPoint: { x: number; y: number } | undefined;

    const stopAutoScroll = () => {
      scrollDirection = 0;
      if (frame !== undefined) {
        win.cancelAnimationFrame(frame);
        frame = undefined;
      }
    };

    const updateDropTarget = (clientX: number, clientY: number) => {
      const pointedTarget = doc.elementFromPoint(clientX, clientY);
      const header = pointedTarget?.closest?.(
        ".zrdb-header-cell",
      ) as HTMLElement | null;
      const targetID = header?.dataset.columnId;
      if (!header || !targetID || targetID === columnID) {
        dropTargetRef.current = undefined;
        setDropTarget(undefined);
        return;
      }
      const rect = header.getBoundingClientRect();
      const target = {
        columnID: targetID,
        after: clientX > rect.left + rect.width / 2,
      };
      dropTargetRef.current = target;
      setDropTarget(target);
    };

    const updateAutoScroll = (clientX: number) => {
      const scroll = parentRef.current;
      const rect = scroll?.getBoundingClientRect();
      scrollDirection =
        scroll && rect
          ? edgeAutoScrollDirection(
              clientX,
              rect.left,
              rect.right,
              COLUMN_DRAG_EDGE_SIZE,
            )
          : 0;
      if (!scrollDirection || frame !== undefined) return;
      const step = () => {
        const target = parentRef.current;
        if (!target || !scrollDirection) {
          frame = undefined;
          return;
        }
        const previous = target.scrollLeft;
        target.scrollLeft += scrollDirection * COLUMN_DRAG_SCROLL_STEP;
        if (lastPoint) updateDropTarget(lastPoint.x, lastPoint.y);
        if (target.scrollLeft === previous) {
          stopAutoScroll();
          return;
        }
        frame = win.requestAnimationFrame(step);
      };
      frame = win.requestAnimationFrame(step);
    };

    const arm = () => {
      if (armed || finished) return;
      armed = true;
      setDraggingColumnID(columnID);
    };

    const clearListeners = () => {
      if (finished) return;
      finished = true;
      win.clearTimeout(holdTimer);
      stopAutoScroll();
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", finish);
      win.removeEventListener("pointercancel", cancel);
      try {
        if (grip.hasPointerCapture?.(pointerID))
          grip.releasePointerCapture(pointerID);
      } catch {
        // Pointer capture may already be released by Zotero/XUL.
      }
      dragCleanupRef.current = undefined;
    };

    const clearVisuals = () => {
      dropTargetRef.current = undefined;
      setDraggingColumnID(undefined);
      setDropTarget(undefined);
    };

    function cancel(next?: PointerEvent) {
      if (next && next.pointerId !== pointerID) return;
      clearListeners();
      clearVisuals();
    }

    function move(next: PointerEvent) {
      if (next.pointerId !== pointerID) return;
      lastPoint = { x: next.clientX, y: next.clientY };
      if (!armed) {
        if (
          Math.hypot(next.clientX - startX, next.clientY - startY) <
          COLUMN_DRAG_START_DISTANCE
        )
          return;
        arm();
      }
      next.preventDefault();
      updateAutoScroll(next.clientX);
      const directTarget = next.target as Element | null;
      const directHeader = directTarget?.closest?.(
        ".zrdb-header-cell",
      ) as HTMLElement | null;
      if (
        directHeader?.dataset.columnId &&
        directHeader.dataset.columnId !== columnID
      ) {
        const rect = directHeader.getBoundingClientRect();
        const target = {
          columnID: directHeader.dataset.columnId,
          after: next.clientX > rect.left + rect.width / 2,
        };
        dropTargetRef.current = target;
        setDropTarget(target);
      } else {
        updateDropTarget(next.clientX, next.clientY);
      }
    }

    function finish(next: PointerEvent) {
      if (next.pointerId !== pointerID) return;
      const target = dropTargetRef.current;
      clearListeners();
      clearVisuals();
      if (armed && target) reorder(columnID, target.columnID, target.after);
    }

    const holdTimer = win.setTimeout(() => {
      arm();
    }, COLUMN_DRAG_HOLD_MS);
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", finish);
    win.addEventListener("pointercancel", cancel);
    dragCleanupRef.current = cancel;
  };

  const copyValue = async (
    value: string,
    event: React.MouseEvent,
  ): Promise<boolean> => {
    event.stopPropagation();
    return copyPlainText(value, event.currentTarget.ownerDocument);
  };

  const openPdf = (item: Zotero.Item) => {
    void resolvePrimaryPdf(item).then((resolution) => {
      const target = resolution?.attachment || item;
      const zotero = globalThis as any;
      if (zotero.Zotero?.FileHandlers?.open)
        void zotero.Zotero.FileHandlers.open(target);
      else if (zotero.Zotero?.launchFile) void zotero.Zotero.launchFile(target);
    });
  };

  const renameColumn = (column: ColumnDefinition) => {
    const prompt = (globalThis as any).prompt;
    const next = prompt?.("修改当前视图表头（留空恢复默认）", column.label);
    if (next === undefined || next === null) return;
    const labels = { ...shownLayout.columnLabels };
    if (String(next).trim()) labels[column.id] = String(next).trim();
    else delete labels[column.id];
    props.onLayout({ ...shownLayout, columnLabels: labels });
  };

  const pinnedLeft = (columnID: string): number | undefined => {
    return pinnedLeftOffset(
      columnID,
      columns.map((column) => column.id),
      shownLayout.pinnedColumnIDs,
      Object.fromEntries(
        columns.map((column) => [column.id, columnWidth(column.id)]),
      ),
    );
  };

  const openColorMenu = (
    event: React.MouseEvent,
    target: Omit<ColorTarget, "left" | "top">,
  ) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const view = event.currentTarget.ownerDocument?.defaultView;
    setColorTarget({
      ...target,
      left: Math.min(rect.left, (view?.innerWidth || 900) - 230),
      top: rect.bottom + 4,
    });
  };

  const applyColor = (color: ViewColor) => {
    if (!colorTarget) return;
    if (colorTarget.kind === "row") {
      const rowColors = { ...shownLayout.rowColors };
      if (color === "none") delete rowColors[colorTarget.itemKey];
      else rowColors[colorTarget.itemKey] = color;
      props.onLayout({ ...shownLayout, rowColors });
    } else if (colorTarget.columnID) {
      const key = `${colorTarget.itemKey}:${colorTarget.columnID}`;
      const cellColors = { ...shownLayout.cellColors };
      if (color === "none") delete cellColors[key];
      else cellColors[key] = color;
      props.onLayout({ ...shownLayout, cellColors });
    }
    setColorTarget(undefined);
  };

  return (
    <div className="zrdb-table-shell">
      <div className="zrdb-table-scroll" ref={parentRef}>
        <div className="zrdb-table-header" style={{ width: tableCanvasWidth }}>
          {columns.map((column) => (
            <div
              key={column.id}
              data-column-id={column.id}
              className={`zrdb-table-cell zrdb-header-cell ${shownLayout.pinnedColumnIDs.includes(column.id) ? "is-pinned" : ""} ${selectedColumnID === column.id ? "is-column-selected" : ""} ${draggingColumnID === column.id ? "is-dragging" : ""} ${dropTarget?.columnID === column.id ? (dropTarget.after ? "is-drop-after" : "is-drop-before") : ""}`}
              style={{
                width: columnWidth(column.id),
                left: pinnedLeft(column.id),
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                renameColumn(column);
              }}
            >
              <button
                className="zrdb-column-grip"
                type="button"
                draggable={false}
                aria-label={`按住六点拖动“${column.label}”列`}
                title="按住六点拖动列"
                onPointerDown={(event) => beginColumnDrag(event, column.id)}
                onClick={(event) => event.stopPropagation()}
              >
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </button>
              <span>{column.label}</span>
              {shownLayout.pinnedColumnIDs.includes(column.id) && (
                <small className="zrdb-pin-mark">固定</small>
              )}
              <button
                className="zrdb-column-menu"
                type="button"
                title="列设置"
                aria-label="列设置"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onManageColumns(column.id);
                }}
              >
                <UIIcon name="columns" />
              </button>
              <span
                className="zrdb-column-resizer"
                onPointerDown={(event) => resizeColumn(event, column.id)}
              />
            </div>
          ))}
        </div>
        <div
          className="zrdb-table-body"
          style={{
            height: virtualizer.getTotalSize(),
            width: tableCanvasWidth,
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const entry = flatRows[virtualRow.index];
            if (entry.type === "group") {
              return (
                <div
                  key={`group-${entry.label}`}
                  className="zrdb-group-row"
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    height: virtualRow.size,
                  }}
                >
                  {entry.label}
                </div>
              );
            }
            const item = entry.item;
            const rowHeight =
              shownLayout.rowHeights[item.key] || shownLayout.rowHeight;
            return (
              <div
                key={item.key}
                className={`zrdb-table-row ${virtualRow.index === flatRows.length - 1 ? "is-last-row" : ""} ${props.selected.has(item.key) ? "is-selected" : ""}`}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                  height: rowHeight,
                  background: colorValue(shownLayout.rowColors[item.key]),
                }}
                onClick={(event) => void props.onSelect(item, event)}
                onDoubleClick={(event) => {
                  const target = event.target as Element | null;
                  if (
                    target?.closest?.(
                      "button,input,textarea,select,a,[contenteditable='true']",
                    )
                  ) {
                    return;
                  }
                  event.preventDefault();
                  openPdf(item);
                }}
              >
                {columns.map((column) => {
                  const stored = column.field
                    ? props.records.get(item.key)?.fields[column.field.id]
                    : undefined;
                  const isEditing =
                    props.editing?.item.key === item.key &&
                    props.editing.column.id === column.id;
                  const editable = Boolean(column.field || column.nativeField);
                  const agentProgress = column.field
                    ? props.progress.get(item.key)
                    : undefined;
                  const visibleAgentProgress = agentProgress?.fieldIDs.includes(
                    column.field?.id || "",
                  )
                    ? agentProgress
                    : undefined;
                  const isActive =
                    activeCell?.itemKey === item.key &&
                    activeCell.columnID === column.id;
                  return (
                    <div
                      key={column.id}
                      className={`zrdb-table-cell ${editable ? "is-editable" : ""} ${isEditing ? "is-editing" : ""} ${isActive ? "is-active" : ""} ${visibleAgentProgress ? "has-agent-status" : ""} ${selectedColumnID === column.id ? "is-column-selected" : ""} ${shownLayout.pinnedColumnIDs.includes(column.id) ? "is-pinned" : ""}`}
                      style={{
                        width: columnWidth(column.id),
                        background: colorValue(
                          shownLayout.cellColors[`${item.key}:${column.id}`],
                        ),
                        left: pinnedLeft(column.id),
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedColumnID(column.id);
                        setActiveCell({
                          itemKey: item.key,
                          columnID: column.id,
                        });
                        void props.onSelect(item, event);
                      }}
                      title="双击打开主 PDF"
                    >
                      {column.kind === "pdfPreview" ? (
                        <PdfPreview
                          item={item}
                          thumbnailWidth={Math.max(
                            96,
                            Math.min(260, columnWidth(column.id) - 14),
                          )}
                        />
                      ) : column.kind === "figureGallery" ? (
                        <FigureGallery
                          item={item}
                          figures={props.figures.get(item.key) || []}
                        />
                      ) : isEditing ? (
                        <InlineCellEditor
                          field={column.field}
                          nativeField={column.nativeField}
                          value={
                            column.field
                              ? stored?.value
                              : nativeValue(item, column.id)
                          }
                          onSave={(value) =>
                            column.field
                              ? props.onSaveCustom(item, column.field, value)
                              : props.onSaveNative(
                                  item,
                                  column.nativeField!,
                                  String(value ?? ""),
                                )
                          }
                          onCancel={props.onCancelEdit}
                        />
                      ) : column.id === "title" ? (
                        <TitleCell
                          item={item}
                          record={props.records.get(item.key)}
                          translating={Boolean(
                            props.progress.get(item.key)?.state === "running" &&
                            props.progress
                              .get(item.key)
                              ?.fieldIDs.includes(TRANSLATED_TITLE_FIELD_ID),
                          )}
                          failureReason={
                            props.progress.get(item.key)?.state === "failed" &&
                            props.progress
                              .get(item.key)
                              ?.fieldIDs.includes(TRANSLATED_TITLE_FIELD_ID)
                              ? props.progress.get(item.key)?.message
                              : undefined
                          }
                          onTranslate={() => void props.onTranslateTitle(item)}
                        />
                      ) : column.kind === "basicInfo" ? (
                        <BasicInfoCell item={item} />
                      ) : column.field?.type === "longText" ? (
                        <ResearchTextValue
                          value={stored?.value}
                          fieldName={column.field.name}
                        />
                      ) : (
                        <span>
                          {column.field
                            ? displayValue(stored?.value)
                            : nativeValue(item, column.id)}
                        </span>
                      )}
                      {visibleAgentProgress && (
                        <CellAgentStatus progress={visibleAgentProgress} />
                      )}
                      {isActive && !isEditing && (
                        <span className="zrdb-cell-actions">
                          {column.kind === "pdfPreview" && (
                            <IconButton
                              icon="open"
                              label="打开 PDF"
                              active
                              onClick={(event) => {
                                event.stopPropagation();
                                openPdf(item);
                              }}
                            />
                          )}
                          {editable && (
                            <IconButton
                              icon="edit"
                              label="编辑"
                              active
                              onClick={(event) => {
                                event.stopPropagation();
                                props.onBeginEdit(item, column);
                              }}
                            />
                          )}
                          {![
                            "pdfPreview",
                            "figureGallery",
                            "basicInfo",
                          ].includes(column.kind || "") && (
                            <IconButton
                              icon="copy"
                              label="复制内容"
                              onClick={(event) =>
                                void copyValue(
                                  column.field
                                    ? displayValue(stored?.value)
                                    : nativeValue(item, column.id),
                                  event,
                                )
                              }
                            />
                          )}
                          <IconButton
                            icon="color"
                            label="设置单元格背景色"
                            onClick={(event) =>
                              openColorMenu(event, {
                                kind: "cell",
                                itemKey: item.key,
                                columnID: column.id,
                              })
                            }
                          />
                          <IconButton
                            icon="rowColor"
                            label="设置整行背景色"
                            onClick={(event) =>
                              openColorMenu(event, {
                                kind: "row",
                                itemKey: item.key,
                              })
                            }
                          />
                          {column.field && stored && (
                            <IconButton
                              icon={stored.locked ? "lock" : "unlock"}
                              label={stored.locked ? "解锁字段" : "锁定字段"}
                              onClick={(event) => {
                                event.stopPropagation();
                                void props.onToggleLock(item, column.field!);
                              }}
                            />
                          )}
                        </span>
                      )}
                    </div>
                  );
                })}
                <span
                  className="zrdb-row-resizer"
                  role="separator"
                  aria-label="拖动调整行高"
                  aria-orientation="horizontal"
                  title="拖动调整行高"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    try {
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                    } catch {
                      // Synthetic test events do not create an active pointer.
                    }
                    const startY = event.clientY;
                    const startHeight = rowHeight;
                    const win = event.currentTarget.ownerDocument?.defaultView;
                    if (!win) return;
                    const move = (next: PointerEvent) => {
                      const base = draftRef.current || layoutRef.current;
                      const nextHeight = Math.max(
                        32,
                        startHeight + next.clientY - startY,
                      );
                      draftRef.current = {
                        ...base,
                        rowHeights: {
                          ...base.rowHeights,
                          [item.key]: nextHeight,
                        },
                      };
                      virtualizer.resizeItem(virtualRow.index, nextHeight);
                      if (rafRef.current !== undefined) return;
                      rafRef.current = win.requestAnimationFrame(() => {
                        rafRef.current = undefined;
                        if (draftRef.current) setDraftLayout(draftRef.current);
                      });
                    };
                    const up = () => {
                      win.removeEventListener("pointermove", move);
                      win.removeEventListener("pointerup", up);
                      win.removeEventListener("pointercancel", up);
                      if (rafRef.current !== undefined) {
                        win.cancelAnimationFrame(rafRef.current);
                        rafRef.current = undefined;
                      }
                      const finalLayout = draftRef.current;
                      draftRef.current = undefined;
                      if (finalLayout) setDraftLayout(finalLayout);
                      if (finalLayout) props.onLayout(finalLayout);
                    };
                    win.addEventListener("pointermove", move);
                    win.addEventListener("pointerup", up);
                    win.addEventListener("pointercancel", up);
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
      {colorTarget && (
        <ColorMenu
          target={colorTarget}
          onChoose={applyColor}
          onClose={() => setColorTarget(undefined)}
        />
      )}
    </div>
  );
}

function InlineCellEditor({
  field,
  nativeField,
  value,
  onSave,
  onCancel,
}: {
  field?: FieldDefinition;
  nativeField?: EditableNativeField;
  value: unknown;
  onSave: (value: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(displayValue(value));
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >(null);

  useEffect(() => {
    const editor = editorRef.current;
    editor?.focus();
    if (editor && "select" in editor)
      (editor as HTMLInputElement | HTMLTextAreaElement).select();
  }, []);

  const parsedValue = useCallback((): unknown => {
    const currentDraft = editorRef.current
      ? field?.type === "checkbox"
        ? String((editorRef.current as HTMLInputElement).checked)
        : editorRef.current.value
      : draft;
    if (!field) return currentDraft;
    if (field.type === "number" || field.type === "rating") {
      return currentDraft.trim() ? Number(currentDraft) : null;
    }
    if (field.type === "checkbox") return currentDraft === "true";
    if (field.type === "multiSelect") {
      return currentDraft
        .split(/[，,]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    return currentDraft;
  }, [draft, field]);

  const commit = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(parsedValue());
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      setSaving(false);
    }
  }, [onSave, parsedValue, saving]);

  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    const multiline = field?.type === "longText";
    if (
      event.key === "Enter" &&
      (!multiline || event.ctrlKey || event.metaKey) &&
      !event.shiftKey
    ) {
      event.preventDefault();
      void commit();
    }
  };

  let editor: React.ReactNode;
  if (field?.type === "checkbox") {
    editor = (
      <input
        ref={editorRef as React.RefObject<HTMLInputElement>}
        className="zrdb-inline-checkbox"
        type="checkbox"
        autoFocus
        checked={draft === "true"}
        onClick={stop}
        onChange={(event) => {
          event.stopPropagation();
          setDraft(String(event.target.checked));
        }}
        onKeyDown={onKeyDown}
      />
    );
  } else if (field?.type === "select") {
    editor = (
      <select
        ref={editorRef as React.RefObject<HTMLSelectElement>}
        className="zrdb-inline-editor"
        autoFocus
        value={draft}
        onClick={stop}
        onChange={(event) => {
          event.stopPropagation();
          setDraft(event.target.value);
        }}
        onKeyDown={onKeyDown}
      >
        <option value="" />
        {field.options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    );
  } else if (field?.type === "longText") {
    editor = (
      <textarea
        ref={editorRef as React.RefObject<HTMLTextAreaElement>}
        className="zrdb-inline-editor multiline"
        rows={3}
        value={draft}
        onClick={stop}
        onDoubleClick={stop}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
    );
  } else {
    editor = (
      <input
        ref={editorRef as React.RefObject<HTMLInputElement>}
        className="zrdb-inline-editor"
        type={
          field?.type === "number" || field?.type === "rating"
            ? "number"
            : field?.type === "date" || nativeField === "date"
              ? "text"
              : field?.type === "url" || nativeField === "url"
                ? "url"
                : "text"
        }
        value={draft}
        disabled={saving}
        onClick={stop}
        onDoubleClick={stop}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
    );
  }

  return (
    <span
      className="zrdb-inline-editor-shell"
      onClick={stop}
      onDoubleClick={stop}
    >
      {editor}
      <span className="zrdb-edit-actions">
        <button
          type="button"
          className="zrdb-icon-button primary"
          disabled={saving}
          data-tooltip={saving ? "保存中" : "完成编辑"}
          aria-label={saving ? "保存中" : "完成编辑"}
          title={saving ? "保存中" : "完成编辑"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void commit()}
        >
          <UIIcon name="check" />
        </button>
        <button
          type="button"
          className="zrdb-icon-button"
          disabled={saving}
          data-tooltip="取消编辑"
          aria-label="取消编辑"
          title="取消编辑"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          <UIIcon name="close" />
        </button>
      </span>
    </span>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLElement>(null);
  useGSAP(
    () => {
      const backdrop = backdropRef.current;
      const modal = modalRef.current;
      if (!backdrop || !modal || prefersReducedMotion(backdrop)) return;
      gsap.fromTo(
        backdrop,
        { autoAlpha: 0 },
        { autoAlpha: 1, duration: 0.12, ease: "none" },
      );
      gsap.fromTo(
        modal,
        { autoAlpha: 0, y: 4, scale: 0.99 },
        {
          autoAlpha: 1,
          y: 0,
          scale: 1,
          duration: 0.17,
          ease: "power1.out",
          clearProps: "transform,opacity,visibility",
        },
      );
    },
    { scope: backdropRef },
  );
  return (
    <div
      ref={backdropRef}
      className="zrdb-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={modalRef}
        className={`zrdb-modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button onClick={onClose}>×</button>
        </header>
        <div className="zrdb-modal-body">{children}</div>
      </section>
    </div>
  );
}

function RowHeightManager({
  rowHeight,
  onApply,
  onClose,
}: {
  rowHeight: number;
  onApply: (rowHeight: number) => void;
  onClose: () => void;
}) {
  const [draftRowHeight, setDraftRowHeight] = useState(() =>
    Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, Math.round(rowHeight))),
  );
  const progress =
    ((draftRowHeight - MIN_ROW_HEIGHT) / (MAX_ROW_HEIGHT - MIN_ROW_HEIGHT)) *
    100;

  return (
    <Modal title="统一调整行高" onClose={onClose}>
      <form
        className="zrdb-row-height-manager"
        onSubmit={(event) => {
          event.preventDefault();
          onApply(draftRowHeight);
        }}
      >
        <div className="zrdb-row-height-readout">
          <span>当前高度</span>
          <output htmlFor="zrdb-row-height-slider">
            {draftRowHeight}
            <small> px</small>
          </output>
        </div>
        <div
          className="zrdb-row-height-track"
          style={
            {
              "--zrdb-row-height-progress": `${progress}%`,
            } as React.CSSProperties
          }
        >
          <input
            id="zrdb-row-height-slider"
            className="zrdb-row-height-slider"
            type="range"
            min={MIN_ROW_HEIGHT}
            max={MAX_ROW_HEIGHT}
            step={ROW_HEIGHT_STEP}
            value={draftRowHeight}
            aria-label="统一行高"
            aria-valuetext={`${draftRowHeight} 像素`}
            aria-describedby="zrdb-row-height-note"
            onChange={(event) =>
              setDraftRowHeight(Number.parseInt(event.target.value, 10))
            }
          />
          <div
            className="zrdb-row-height-nodes"
            role="group"
            aria-label="预设行高"
          >
            {ROW_HEIGHT_PRESETS.map((preset) => {
              const position =
                ((preset.value - MIN_ROW_HEIGHT) /
                  (MAX_ROW_HEIGHT - MIN_ROW_HEIGHT)) *
                100;
              return (
                <button
                  key={preset.value}
                  className="zrdb-row-height-node"
                  type="button"
                  aria-label={`${preset.value} ${preset.label}`}
                  aria-pressed={draftRowHeight === preset.value}
                  style={
                    {
                      "--zrdb-row-height-node-position": `${position}%`,
                    } as React.CSSProperties
                  }
                  onClick={() => setDraftRowHeight(preset.value)}
                >
                  <span
                    className="zrdb-row-height-node-dot"
                    aria-hidden="true"
                  />
                  <span>{preset.value}</span>
                  <small>{preset.label}</small>
                </button>
              );
            })}
          </div>
        </div>
        <p id="zrdb-row-height-note" className="zrdb-row-height-note">
          应用后会清除当前视图的逐篇行高，所有文献行使用同一高度。
        </p>
        <div className="zrdb-dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" type="submit">
            统一全部行
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ColumnManager({
  fields,
  initialColumnID,
  layout,
  visibleFieldIDs,
  onSave,
  onClose,
}: {
  fields: FieldDefinition[];
  initialColumnID?: string;
  layout: ViewLayout;
  visibleFieldIDs: string[];
  onSave: (
    layout: ViewLayout,
    visibleFieldIDs: string[],
    fields: FieldDefinition[],
  ) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"layout" | "fields">("layout");
  const [draftDefinitions, setDraftDefinitions] = useState(fields);
  const all = useMemo<ColumnDefinition[]>(
    () => [
      ...nativeColumns,
      ...draftDefinitions
        .filter(
          (field) => !field.archived && field.id !== TRANSLATED_TITLE_FIELD_ID,
        )
        .map((field) => ({ id: field.id, label: field.name, field })),
    ],
    [draftDefinitions],
  );
  const [draftLayout, setDraftLayout] = useState(() => ({
    ...normalizeViewLayout(layout),
    visibleColumnIDs: [
      ...new Set([...layout.visibleColumnIDs, ...visibleFieldIDs]),
    ],
  }));
  const [draftFields, setDraftFields] = useState([...visibleFieldIDs]);
  const [draggingColumnID, setDraggingColumnID] = useState<string>();
  const [dropTarget, setDropTarget] = useState<{
    columnID: string;
    after: boolean;
  }>();
  const dragCleanupRef = useRef<(() => void) | undefined>(undefined);
  const dropTargetRef = useRef<
    { columnID: string; after: boolean } | undefined
  >(undefined);
  useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    [],
  );
  const ordered = useMemo(() => {
    const ids = [...draftLayout.columnOrder, ...all.map((column) => column.id)];
    return [...new Set(ids)]
      .map((id) => all.find((column) => column.id === id))
      .filter((column): column is ColumnDefinition => Boolean(column));
  }, [all, draftLayout.columnOrder]);
  const patchAlias = (column: ColumnDefinition, value: string) => {
    const labels = { ...draftLayout.columnLabels };
    const trimmed = value.trim();
    if (trimmed && trimmed !== column.label) labels[column.id] = value;
    else delete labels[column.id];
    setDraftLayout({ ...draftLayout, columnLabels: labels });
  };
  const setVisible = (column: ColumnDefinition, visible: boolean) => {
    const ids = new Set(draftLayout.visibleColumnIDs);
    if (visible) ids.add(column.id);
    else ids.delete(column.id);
    setDraftLayout({ ...draftLayout, visibleColumnIDs: [...ids] });
    if (column.field)
      setDraftFields((current) =>
        visible
          ? [...new Set([...current, column.id])]
          : current.filter((id) => id !== column.id),
      );
  };
  const reorderDraft = (from: string, to: string, after: boolean) => {
    if (!from || from === to) return;
    setDraftLayout((current) => {
      const columnOrder = [
        ...new Set([...current.columnOrder, ...all.map((column) => column.id)]),
      ];
      const next = reorderColumnLayout(
        columnOrder,
        current.pinnedColumnIDs,
        from,
        to,
        after,
        current.pinnedColumnIDs.includes(to),
      );
      return { ...current, ...next };
    });
  };
  const beginManagerDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    columnID: string,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragCleanupRef.current?.();

    const grip = event.currentTarget;
    try {
      grip.setPointerCapture?.(event.pointerId);
    } catch {
      // Test-runner pointer events cannot always be captured.
    }
    const doc = grip.ownerDocument;
    if (!doc) return;
    const ownerDocument: Document = doc;
    const win = ownerDocument.defaultView;
    if (!win) return;
    const pointerID = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    let finished = false;

    const clear = () => {
      if (finished) return;
      finished = true;
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", finish);
      win.removeEventListener("pointercancel", cancel);
      try {
        if (grip.hasPointerCapture?.(pointerID))
          grip.releasePointerCapture(pointerID);
      } catch {
        // Pointer capture may have been released by the host document.
      }
      dragCleanupRef.current = undefined;
    };
    const clearVisuals = () => {
      dropTargetRef.current = undefined;
      setDraggingColumnID(undefined);
      setDropTarget(undefined);
    };
    function cancel(next?: PointerEvent) {
      if (next && next.pointerId !== pointerID) return;
      clear();
      clearVisuals();
    }
    function rowAt(next: PointerEvent): HTMLElement | null {
      const direct = next.target as Element | null;
      return (ownerDocument
        .elementFromPoint(next.clientX, next.clientY)
        ?.closest?.("[data-column-manager-id]") ||
        direct?.closest?.("[data-column-manager-id]")) as HTMLElement | null;
    }
    function move(next: PointerEvent) {
      if (next.pointerId !== pointerID) return;
      if (!started) {
        if (
          Math.hypot(next.clientX - startX, next.clientY - startY) <
          COLUMN_DRAG_START_DISTANCE
        )
          return;
        started = true;
        setDraggingColumnID(columnID);
      }
      next.preventDefault();
      const row = rowAt(next);
      const targetID = row?.dataset.columnManagerId;
      if (!row || !targetID || targetID === columnID) {
        dropTargetRef.current = undefined;
        setDropTarget(undefined);
        return;
      }
      const rect = row.getBoundingClientRect();
      const target = {
        columnID: targetID,
        after: next.clientY > rect.top + rect.height / 2,
      };
      dropTargetRef.current = target;
      setDropTarget(target);
    }
    function finish(next: PointerEvent) {
      if (next.pointerId !== pointerID) return;
      const target = dropTargetRef.current;
      clear();
      clearVisuals();
      if (started && target)
        reorderDraft(columnID, target.columnID, target.after);
    }
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", finish);
    win.addEventListener("pointercancel", cancel);
    dragCleanupRef.current = cancel;
  };
  const patchField = (id: string, value: Partial<FieldDefinition>) =>
    setDraftDefinitions((allFields) =>
      allFields.map((field) =>
        field.id === id ? { ...field, ...value } : field,
      ),
    );
  return (
    <Modal title="字段与列管理" onClose={onClose} wide>
      <div
        className="zrdb-manager-tabs"
        role="tablist"
        aria-label="字段与列管理"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "layout"}
          className={tab === "layout" ? "is-active" : ""}
          onClick={() => setTab("layout")}
        >
          列布局
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "fields"}
          className={tab === "fields" ? "is-active" : ""}
          onClick={() => setTab("fields")}
        >
          自定义字段
        </button>
      </div>
      {tab === "layout" ? (
        <>
          <p className="zrdb-dialog-hint">
            勾选决定当前视图显示的原生列和自定义列。按住每行的六点拖柄可调整顺序；不修改
            Zotero 元数据、字段名称或论文数据。
          </p>
          <div className="zrdb-column-manager">
            {ordered.map((column) => {
              const visible = column.field
                ? draftFields.includes(column.id)
                : draftLayout.visibleColumnIDs.includes(column.id);
              return (
                <div
                  key={column.id}
                  data-column-manager-id={column.id}
                  className={`zrdb-column-manager-row ${column.id === initialColumnID ? "is-focus" : ""} ${draggingColumnID === column.id ? "is-dragging" : ""} ${dropTarget?.columnID === column.id ? (dropTarget.after ? "is-drop-after" : "is-drop-before") : ""}`}
                >
                  <button
                    type="button"
                    className="zrdb-column-manager-grip"
                    aria-label={`按住六点拖动“${column.label}”列`}
                    title="按住六点拖动列"
                    onPointerDown={(event) =>
                      beginManagerDrag(event, column.id)
                    }
                    onClick={(event) => event.stopPropagation()}
                  >
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={(event) =>
                        setVisible(column, event.target.checked)
                      }
                    />
                    显示
                  </label>
                  <strong>{column.label}</strong>
                  <input
                    value={draftLayout.columnLabels[column.id] || ""}
                    placeholder="当前视图表头别名"
                    onChange={(event) => patchAlias(column, event.target.value)}
                  />
                  <label>
                    <input
                      type="checkbox"
                      checked={draftLayout.pinnedColumnIDs.includes(column.id)}
                      onChange={(event) => {
                        const pinned = new Set(draftLayout.pinnedColumnIDs);
                        if (event.target.checked) pinned.add(column.id);
                        else pinned.delete(column.id);
                        setDraftLayout({
                          ...draftLayout,
                          pinnedColumnIDs: ordered
                            .map((entry) => entry.id)
                            .filter((id) => pinned.has(id)),
                        });
                      }}
                    />
                    临时固定
                  </label>
                  <button
                    type="button"
                    className="zrdb-manager-reset-label"
                    title="恢复默认表头"
                    aria-label={`恢复“${column.label}”默认表头`}
                    onClick={() => patchAlias(column, column.label)}
                  >
                    恢复名称
                  </button>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <p className="zrdb-dialog-hint">
            字段值以稳定字段 ID
            保存；改名不会丢失历史值，归档不会删除已有论文数据。
          </p>
          <div className="zrdb-field-list">
            {draftDefinitions.map((field) => (
              <div
                className={`zrdb-field-editor ${field.archived ? "is-archived" : ""}`}
                key={field.id}
              >
                <input
                  value={field.name}
                  disabled={field.archived}
                  onChange={(event) =>
                    patchField(field.id, { name: event.target.value })
                  }
                  placeholder="字段名"
                />
                <select
                  value={field.type}
                  disabled={field.archived}
                  onChange={(event) =>
                    patchField(field.id, {
                      type: event.target.value as FieldType,
                    })
                  }
                >
                  {fieldTypes.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                <input
                  value={field.description}
                  disabled={field.archived}
                  onChange={(event) =>
                    patchField(field.id, { description: event.target.value })
                  }
                  placeholder="说明"
                />
                <label>
                  <input
                    type="checkbox"
                    checked={field.extraction.enabled}
                    disabled={field.archived}
                    onChange={(event) =>
                      patchField(field.id, {
                        extraction: {
                          ...field.extraction,
                          enabled: event.target.checked,
                        },
                      })
                    }
                  />{" "}
                  允许外部 Agent 填充
                </label>
                {field.extraction.enabled && (
                  <>
                    <textarea
                      value={field.extraction.instruction}
                      onChange={(event) =>
                        patchField(field.id, {
                          extraction: {
                            ...field.extraction,
                            instruction: event.target.value,
                            templateVersion:
                              field.extraction.templateVersion + 1,
                          },
                        })
                      }
                      placeholder="给外部 Agent 的提取说明"
                    />
                    <input
                      value={field.extraction.outputLanguage}
                      onChange={(event) =>
                        patchField(field.id, {
                          extraction: {
                            ...field.extraction,
                            outputLanguage: event.target.value,
                          },
                        })
                      }
                      placeholder="输出语言"
                    />
                  </>
                )}
                {["select", "multiSelect"].includes(field.type) && (
                  <input
                    value={field.options.join("，")}
                    onChange={(event) =>
                      patchField(field.id, {
                        options: event.target.value
                          .split(/[，,]/)
                          .map((entry) => entry.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="选项，用逗号分隔"
                  />
                )}
                <button
                  className={field.archived ? "" : "danger"}
                  onClick={() =>
                    patchField(field.id, { archived: !field.archived })
                  }
                >
                  {field.archived ? "恢复" : "归档"}
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() =>
              setDraftDefinitions((allFields) => [
                ...allFields,
                {
                  id: createID("field"),
                  name: "新字段",
                  description: "",
                  type: "text",
                  options: [],
                  extraction: {
                    enabled: false,
                    instruction: "",
                    outputLanguage: "中文",
                    templateVersion: 1,
                  },
                },
              ])
            }
          >
            ＋ 添加字段
          </button>
        </>
      )}
      <div className="zrdb-dialog-actions">
        <button onClick={onClose}>取消</button>
        <button
          className="primary"
          onClick={() => {
            onSave(draftLayout, draftFields, draftDefinitions);
            onClose();
          }}
        >
          保存字段与列设置
        </button>
      </div>
    </Modal>
  );
}

function AgentBridgeManager({
  agent,
  initialTab,
  items,
  onAgentChange,
  onArtifactsImported,
  onClose,
}: {
  agent: AgentBridge;
  initialTab: "agent" | "mineru" | "pdf";
  items: Zotero.Item[];
  onAgentChange: (agent: AgentBridge) => void;
  onArtifactsImported: () => Promise<void>;
  onClose: () => void;
}) {
  const initialAgent = readAgentProfile();
  const initialMinerU = readMinerUProfile();
  const [agentDraft, setAgentDraft] = useState({
    kind: initialAgent.kind,
    executable: initialAgent.executable || "",
    args: JSON.stringify(initialAgent.args || []),
    endpoint: initialAgent.endpoint || "",
    model: initialAgent.model || "",
    timeoutMs: String(initialAgent.timeoutMs),
  });
  const [mineruDraft, setMineruDraft] = useState({
    mode: initialMinerU.mode,
    executable: initialMinerU.executable,
    args: JSON.stringify(initialMinerU.args),
    desktopOutputDirectory: initialMinerU.desktopOutputDirectory,
    officialEndpoint: initialMinerU.officialEndpoint,
    officialTokenEnvironment: initialMinerU.officialTokenEnvironment,
    selfHostedEndpoint: initialMinerU.selfHostedEndpoint,
    selfHostedAutoStart: initialMinerU.selfHostedAutoStart,
    selfHostedProjectDirectory: initialMinerU.selfHostedProjectDirectory,
    dockerExecutable: initialMinerU.dockerExecutable,
    dockerDesktopExecutable: initialMinerU.dockerDesktopExecutable,
    backend: initialMinerU.backend,
    method: initialMinerU.method,
    modelVersion: initialMinerU.modelVersion,
    language: initialMinerU.language,
    enableFormula: initialMinerU.enableFormula,
    enableTable: initialMinerU.enableTable,
    timeoutMs: String(initialMinerU.timeoutMs),
  });
  const [status, setStatus] = useState(
    `当前 Agent：${agentLabel(agent.kind)}。配置只保存在本机。`,
  );
  const [token, setToken] = useState(ensureArtifactImportToken());
  const [pdfRows, setPdfRows] = useState<
    Array<{
      item: Zotero.Item;
      attachments: Zotero.Item[];
      explicitKey: string;
      automaticLabel: string;
    }>
  >([]);
  const [mineruProgress, setMineruProgress] = useState<
    Map<string, MinerUProgress>
  >(new Map());
  const [mineruRunning, setMineruRunning] = useState(false);
  const [toolTab, setToolTab] = useState<"agent" | "mineru" | "pdf">(
    initialTab,
  );
  const mineruServiceRef = useRef<MinerUConversionService | undefined>(
    undefined,
  );

  const reloadPdfRows = useCallback(async () => {
    const rows = await Promise.all(
      items.map(async (item) => {
        const attachments = await listPdfAttachments(item);
        const resolution = await resolvePrimaryPdf(item, attachments);
        return {
          item,
          attachments,
          explicitKey:
            resolution?.source === "explicit" ? resolution.attachment.key : "",
          automaticLabel: resolution
            ? `${pdfAttachmentLabel(resolution.attachment)}（${primaryPdfSourceLabel(resolution.source)}）`
            : "没有 PDF",
        };
      }),
    );
    setPdfRows(rows);
  }, [items]);

  useEffect(() => {
    void reloadPdfRows();
  }, [reloadPdfRows]);

  const currentAgentProfile = (): AgentProfile =>
    parseAgentProfile({
      kind: agentDraft.kind,
      executable: agentDraft.executable,
      args: agentDraft.args,
      endpoint: agentDraft.endpoint,
      model: agentDraft.model,
      timeoutMs: agentDraft.timeoutMs,
    });

  const currentMinerUProfile = (): MinerUProfile =>
    parseMinerUProfile({
      mode: mineruDraft.mode,
      executable: mineruDraft.executable,
      args: mineruDraft.args,
      desktopOutputDirectory: mineruDraft.desktopOutputDirectory,
      officialEndpoint: mineruDraft.officialEndpoint,
      officialTokenEnvironment: mineruDraft.officialTokenEnvironment,
      selfHostedEndpoint: mineruDraft.selfHostedEndpoint,
      selfHostedAutoStart: mineruDraft.selfHostedAutoStart,
      selfHostedProjectDirectory: mineruDraft.selfHostedProjectDirectory,
      dockerExecutable: mineruDraft.dockerExecutable,
      dockerDesktopExecutable: mineruDraft.dockerDesktopExecutable,
      backend: mineruDraft.backend,
      method: mineruDraft.method,
      modelVersion: mineruDraft.modelVersion,
      language: mineruDraft.language,
      enableFormula: mineruDraft.enableFormula,
      enableTable: mineruDraft.enableTable,
      timeoutMs: mineruDraft.timeoutMs,
    });

  const saveAgent = (): AgentBridge | undefined => {
    try {
      const profile = currentAgentProfile();
      saveAgentProfile(profile);
      const nextAgent = createAgentBridge(profile);
      onAgentChange(nextAgent);
      setStatus(`已保存并切换到 ${agentLabel(profile.kind)}`);
      return nextAgent;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const saveMinerU = (): MinerUProfile | undefined => {
    try {
      const profile = currentMinerUProfile();
      saveMinerUProfile(profile);
      setStatus(`已保存 MinerU：${mineruModeLabel(profile.mode)}`);
      return profile;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  };

  const runMinerU = async (targets: Zotero.Item[]): Promise<void> => {
    if (!targets.length || mineruRunning) return;
    // A tools modal can remain mounted while the user changes and saves MinerU
    // preferences elsewhere. Each conversion must therefore construct a new
    // service from the currently persisted profile, rather than allowing this
    // modal's initial React draft to overwrite newer settings. Draft edits stay
    // intact and take effect only after the explicit “保存配置” action.
    let profile: MinerUProfile;
    try {
      profile = readMinerUProfile();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return;
    }
    const service = new MinerUConversionService(profile);
    mineruServiceRef.current = service;
    setMineruRunning(true);
    setMineruProgress(new Map());
    setStatus(
      `正在使用已保存的 ${mineruModeLabel(profile.mode)} 配置转换 ${targets.length} 篇论文……`,
    );
    try {
      await service.run(targets, (entry) =>
        setMineruProgress((current) => {
          const next = new Map(current);
          next.set(entry.itemKey, entry);
          return next;
        }),
      );
      await onArtifactsImported();
      setStatus("MinerU 队列已结束；Markdown 与图表已刷新到对应条目");
    } finally {
      setMineruRunning(false);
      mineruServiceRef.current = undefined;
    }
  };

  return (
    <Modal title="Agent、MinerU 与主 PDF" onClose={onClose} wide>
      <nav className="zrdb-tool-tabs" aria-label="外部工具配置">
        {(
          [
            ["agent", "Agent"],
            ["mineru", "MinerU 转换"],
            ["pdf", `主 PDF · ${items.length}`],
          ] as const
        ).map(([id, label]) => (
          <button
            type="button"
            className={toolTab === id ? "is-active" : ""}
            aria-pressed={toolTab === id}
            key={id}
            onClick={() => setToolTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="zrdb-external-tools-grid">
        {toolTab === "agent" && (
          <section className="zrdb-tool-section">
            <header>
              <div>
                <strong>Agent</strong>
                <small>切换和配置现有提取器，不增加工具栏按钮</small>
              </div>
            </header>
            <label className="zrdb-form-field">
              <span>适配器</span>
              <select
                value={agentDraft.kind}
                onChange={(event) => {
                  const kind = event.target.value as AgentProfile["kind"];
                  const preset =
                    kind === "claude-code" || kind === "hana-agent"
                      ? AGENT_PRESETS[kind]
                      : undefined;
                  setAgentDraft((current) => ({
                    ...current,
                    kind,
                    executable: preset?.executable || "",
                    endpoint: preset?.endpoint || "",
                    args: kind === "custom-json-process" ? current.args : "[]",
                  }));
                }}
              >
                <option value="codex-cli">Codex CLI</option>
                <option value="claude-code">Claude Code（本机预设）</option>
                <option value="hana-agent">HanaAgent（本机预设）</option>
                <option value="ollama">Ollama（本机）</option>
                <option value="custom-json-process">自定义 JSON Agent</option>
              </select>
            </label>
            {["claude-code", "hana-agent", "custom-json-process"].includes(
              agentDraft.kind,
            ) && (
              <>
                <label className="zrdb-form-field">
                  <span>可执行文件</span>
                  <input
                    value={agentDraft.executable}
                    onChange={(event) =>
                      setAgentDraft((current) => ({
                        ...current,
                        executable: event.target.value,
                      }))
                    }
                    placeholder="C:\\tools\\paper-agent.exe"
                  />
                </label>
                {agentDraft.kind === "custom-json-process" && (
                  <label className="zrdb-form-field">
                    <span>参数（JSON 数组）</span>
                    <input
                      value={agentDraft.args}
                      onChange={(event) =>
                        setAgentDraft((current) => ({
                          ...current,
                          args: event.target.value,
                        }))
                      }
                      placeholder='["--mode","zotero"]'
                    />
                  </label>
                )}
              </>
            )}
            {agentDraft.kind === "hana-agent" && (
              <label className="zrdb-form-field">
                <span>server-info.json</span>
                <input
                  value={agentDraft.endpoint}
                  onChange={(event) =>
                    setAgentDraft((current) => ({
                      ...current,
                      endpoint: event.target.value,
                    }))
                  }
                />
              </label>
            )}
            {agentDraft.kind === "ollama" && (
              <label className="zrdb-form-field">
                <span>Ollama 地址</span>
                <input
                  value={agentDraft.endpoint}
                  onChange={(event) =>
                    setAgentDraft((current) => ({
                      ...current,
                      endpoint: event.target.value,
                    }))
                  }
                  placeholder="http://127.0.0.1:11434"
                />
              </label>
            )}
            {!["custom-json-process", "hana-agent"].includes(
              agentDraft.kind,
            ) && (
              <label className="zrdb-form-field">
                <span>模型</span>
                <input
                  value={agentDraft.model}
                  onChange={(event) =>
                    setAgentDraft((current) => ({
                      ...current,
                      model: event.target.value,
                    }))
                  }
                  placeholder={
                    ["codex-cli", "claude-code"].includes(agentDraft.kind)
                      ? "留空沿用当前 Agent 默认"
                      : "qwen3"
                  }
                />
              </label>
            )}
            <label className="zrdb-form-field">
              <span>超时（毫秒）</span>
              <input
                type="number"
                min={1000}
                value={agentDraft.timeoutMs}
                onChange={(event) =>
                  setAgentDraft((current) => ({
                    ...current,
                    timeoutMs: event.target.value,
                  }))
                }
              />
            </label>
            <div className="zrdb-inline-actions">
              <button onClick={saveAgent}>保存并切换</button>
              <button
                onClick={() =>
                  void (async () => {
                    const bridge = saveAgent();
                    if (!bridge) return;
                    try {
                      setStatus("正在检测外部 Agent……");
                      const result = await bridge.probe();
                      setStatus(
                        `已连接：${result.version}\n${result.executable}`,
                      );
                    } catch (error) {
                      setStatus(
                        error instanceof Error ? error.message : String(error),
                      );
                    }
                  })()
                }
              >
                连接测试
              </button>
              <button
                onClick={() =>
                  void (async () => {
                    const bridge = saveAgent();
                    if (!bridge) return;
                    try {
                      setStatus("正在测试结构化 JSON……");
                      await bridge.testStructuredOutput();
                      setStatus("结构化 JSON 测试通过");
                    } catch (error) {
                      setStatus(
                        error instanceof Error ? error.message : String(error),
                      );
                    }
                  })()
                }
              >
                JSON 测试
              </button>
            </div>
            <small>{agentModeHelp(agentDraft.kind)}</small>
          </section>
        )}

        {toolTab === "mineru" && (
          <section className="zrdb-tool-section">
            <header>
              <div>
                <strong>MinerU</strong>
                <small>
                  转换当前选中的 {items.length} 篇论文并导入各自条目
                </small>
              </div>
            </header>
            <label className="zrdb-form-field">
              <span>运行方式</span>
              <select
                value={mineruDraft.mode}
                onChange={(event) =>
                  setMineruDraft((current) => ({
                    ...current,
                    mode: event.target.value as MinerUProfile["mode"],
                  }))
                }
              >
                <option value="local-client">MinerU Desktop（本机）</option>
                <option value="official-api">MinerU 网页 API</option>
                <option value="self-hosted">Docker / 本地 API</option>
              </select>
            </label>
            {mineruDraft.mode === "local-client" && (
              <>
                <p className="zrdb-tool-capability" data-tone="notice">
                  {
                    "插件会把主 PDF 投递到 Desktop，并持续监听结果目录。请在客户端点击“立即解析”；完成后，Markdown 与论文图表会自动回传到对应 Zotero 条目。"
                  }
                </p>
                <label className="zrdb-form-field">
                  <span>可执行文件</span>
                  <input
                    value={mineruDraft.executable}
                    onChange={(event) =>
                      setMineruDraft((current) => ({
                        ...current,
                        executable: event.target.value,
                      }))
                    }
                    placeholder="E:\software\MinerU\MinerU.exe"
                  />
                </label>
                <label className="zrdb-form-field">
                  <span>Desktop 结果目录</span>
                  <input
                    value={mineruDraft.desktopOutputDirectory}
                    onChange={(event) =>
                      setMineruDraft((current) => ({
                        ...current,
                        desktopOutputDirectory: event.target.value,
                      }))
                    }
                    placeholder="留空时自动读取 %USERPROFILE%\MinerU\config.json"
                  />
                </label>
              </>
            )}
            {mineruDraft.mode === "official-api" && (
              <>
                <label className="zrdb-form-field">
                  <span>网页 API</span>
                  <input
                    value={mineruDraft.officialEndpoint}
                    onChange={(event) =>
                      setMineruDraft((current) => ({
                        ...current,
                        officialEndpoint: event.target.value,
                      }))
                    }
                    placeholder="暂未配置；填写官方 HTTPS API 地址"
                  />
                </label>
                <label className="zrdb-form-field">
                  <span>Token 环境变量</span>
                  <input
                    value={mineruDraft.officialTokenEnvironment}
                    onChange={(event) =>
                      setMineruDraft((current) => ({
                        ...current,
                        officialTokenEnvironment: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="zrdb-form-field">
                  <span>网页模型</span>
                  <select
                    value={mineruDraft.modelVersion}
                    onChange={(event) =>
                      setMineruDraft((current) => ({
                        ...current,
                        modelVersion: event.target
                          .value as MinerUProfile["modelVersion"],
                      }))
                    }
                  >
                    <option value="vlm">VLM</option>
                    <option value="pipeline">Pipeline</option>
                  </select>
                </label>
              </>
            )}
            {mineruDraft.mode === "self-hosted" && (
              <>
                <p className="zrdb-tool-capability" data-tone="success">
                  推荐模式。转换完成后自动导入 MinerU Markdown，并把
                  content_list.json 中的图片、图表与表格放入“论文图表”列。
                </p>
                <label className="zrdb-form-field">
                  <span>本地部署地址</span>
                  <input
                    value={mineruDraft.selfHostedEndpoint}
                    onChange={(event) =>
                      setMineruDraft((current) => ({
                        ...current,
                        selfHostedEndpoint: event.target.value,
                      }))
                    }
                    placeholder="http://127.0.0.1:8000"
                  />
                </label>
                <label className="zrdb-tool-check">
                  <input
                    type="checkbox"
                    checked={mineruDraft.selfHostedAutoStart}
                    onChange={(event) =>
                      setMineruDraft((current) => ({
                        ...current,
                        selfHostedAutoStart: event.target.checked,
                      }))
                    }
                  />
                  服务未运行时自动启动 Docker Desktop 与 MinerU API
                </label>
                {mineruDraft.selfHostedAutoStart && (
                  <>
                    <label className="zrdb-form-field">
                      <span>Docker 项目目录</span>
                      <input
                        value={mineruDraft.selfHostedProjectDirectory}
                        onChange={(event) =>
                          setMineruDraft((current) => ({
                            ...current,
                            selfHostedProjectDirectory: event.target.value,
                          }))
                        }
                        placeholder="E:\software\DockerProject\MinerU"
                      />
                    </label>
                    <label className="zrdb-form-field">
                      <span>Docker CLI</span>
                      <input
                        value={mineruDraft.dockerExecutable}
                        onChange={(event) =>
                          setMineruDraft((current) => ({
                            ...current,
                            dockerExecutable: event.target.value,
                          }))
                        }
                        placeholder="E:\software\docker\resources\bin\docker.exe"
                      />
                    </label>
                    <label className="zrdb-form-field">
                      <span>Docker Desktop</span>
                      <input
                        value={mineruDraft.dockerDesktopExecutable}
                        onChange={(event) =>
                          setMineruDraft((current) => ({
                            ...current,
                            dockerDesktopExecutable: event.target.value,
                          }))
                        }
                        placeholder="E:\software\docker\Docker Desktop.exe"
                      />
                    </label>
                  </>
                )}
              </>
            )}
            {mineruDraft.mode === "self-hosted" && (
              <label className="zrdb-form-field">
                <span>解析后端</span>
                <input
                  value={mineruDraft.backend}
                  onChange={(event) =>
                    setMineruDraft((current) => ({
                      ...current,
                      backend: event.target.value,
                    }))
                  }
                  placeholder="pipeline"
                />
              </label>
            )}
            {mineruDraft.mode !== "local-client" && (
              <>
                <div className="zrdb-tool-inline-grid">
                  <label className="zrdb-form-field">
                    <span>解析方式</span>
                    <select
                      value={mineruDraft.method}
                      onChange={(event) =>
                        setMineruDraft((current) => ({
                          ...current,
                          method: event.target.value as MinerUProfile["method"],
                        }))
                      }
                    >
                      <option value="auto">自动</option>
                      <option value="txt">文本</option>
                      <option value="ocr">OCR</option>
                    </select>
                  </label>
                  <label className="zrdb-form-field">
                    <span>语言</span>
                    <input
                      value={mineruDraft.language}
                      onChange={(event) =>
                        setMineruDraft((current) => ({
                          ...current,
                          language: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                <div className="zrdb-field-checks compact">
                  <label>
                    <input
                      type="checkbox"
                      checked={mineruDraft.enableFormula}
                      onChange={(event) =>
                        setMineruDraft((current) => ({
                          ...current,
                          enableFormula: event.target.checked,
                        }))
                      }
                    />
                    公式
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={mineruDraft.enableTable}
                      onChange={(event) =>
                        setMineruDraft((current) => ({
                          ...current,
                          enableTable: event.target.checked,
                        }))
                      }
                    />
                    表格
                  </label>
                </div>
              </>
            )}
            <div className="zrdb-inline-actions">
              <button onClick={saveMinerU}>保存配置</button>
              <button
                onClick={() =>
                  void (async () => {
                    const profile = saveMinerU();
                    if (!profile) return;
                    try {
                      setStatus("正在检测 MinerU……");
                      setStatus(
                        await new MinerUConversionService(profile).probe(),
                      );
                    } catch (error) {
                      setStatus(
                        error instanceof Error ? error.message : String(error),
                      );
                    }
                  })()
                }
              >
                连接测试
              </button>
              <button
                className="primary"
                disabled={!items.length || mineruRunning}
                onClick={() => void runMinerU(items)}
              >
                批量转换选中 {items.length} 篇
              </button>
            </div>
            {mineruRunning && (
              <button
                className="zrdb-link-action"
                onClick={() => mineruServiceRef.current?.cancel()}
              >
                取消当前队列
              </button>
            )}
            {!!mineruProgress.size && (
              <div className="zrdb-tool-progress-list">
                {[...mineruProgress.values()].map((entry) => (
                  <div key={entry.itemKey} data-state={entry.state}>
                    <span>
                      {entry.state === "running"
                        ? "◌"
                        : entry.state === "success"
                          ? "✓"
                          : "!"}
                    </span>
                    <p>
                      {items
                        .find((item) => item.key === entry.itemKey)
                        ?.getField("title") || entry.itemKey}
                    </p>
                    <small>{entry.message}</small>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {toolTab === "pdf" && (
        <section className="zrdb-tool-section zrdb-primary-pdf-section">
          <header>
            <div>
              <strong>主 PDF</strong>
              <small>MinerU、PDF 首页预览和全文回退都使用同一附件</small>
            </div>
          </header>
          {!items.length && (
            <p className="zrdb-status">请先在表格中选中文献。</p>
          )}
          {pdfRows.map((row) => (
            <div className="zrdb-primary-pdf-row" key={row.item.key}>
              <span>{String(row.item.getField("title") || row.item.key)}</span>
              <select
                value={row.explicitKey}
                disabled={!row.attachments.length}
                onChange={(event) =>
                  void (async () => {
                    try {
                      await setPrimaryPdf(
                        row.item,
                        event.target.value || undefined,
                      );
                      await reloadPdfRows();
                      setStatus(
                        "主 PDF 已保存到条目 Extra；原始 PDF 数据没有修改",
                      );
                    } catch (error) {
                      setStatus(
                        error instanceof Error ? error.message : String(error),
                      );
                    }
                  })()
                }
              >
                <option value="">自动：{row.automaticLabel}</option>
                {row.attachments.map((attachment) => (
                  <option value={attachment.key} key={attachment.key}>
                    {pdfAttachmentLabel(attachment)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!row.attachments.length || mineruRunning}
                onClick={() => {
                  setToolTab("mineru");
                  void runMinerU([row.item]);
                }}
              >
                转换此篇
              </button>
            </div>
          ))}
        </section>
      )}

      <details className="zrdb-tool-details">
        <summary>精读工作流本地接口</summary>
        <div className="zrdb-token">
          <strong>本地令牌</strong>
          <code>{token}</code>
          <button
            onClick={() => {
              (Zotero.Utilities.Internal as any).copyTextToClipboard(token);
              setStatus("令牌已复制");
            }}
          >
            复制
          </button>
          <button onClick={() => setToken(rotateArtifactImportToken())}>
            轮换
          </button>
        </div>
      </details>
      <p className="zrdb-status">{status}</p>
      <div className="zrdb-dialog-actions">
        <button className="primary" onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}

function agentLabel(kind: AgentProfile["kind"]): string {
  if (kind === "claude-code") return "Claude Code";
  if (kind === "hana-agent") return "HanaAgent";
  if (kind === "ollama") return "Ollama";
  if (kind === "custom-json-process") return "自定义 JSON Agent";
  return "Codex CLI";
}

function agentModeHelp(kind: AgentProfile["kind"]): string {
  if (kind === "claude-code")
    return "优先读取任务期只读目录中的主 PDF；仅允许 Read、Glob、Grep，无法读取时自动回退 Zotero 全文或 MinerU Markdown。";
  if (kind === "hana-agent")
    return "通过本机 server-info 建立临时会话；优先把主 PDF 路径交给 Hana 的识图/OCR 能力，失败时自动回退文本。令牌只驻留内存。";
  if (kind === "ollama")
    return "调用本机 Ollama 的结构化输出接口；主 PDF 路径不会交给模型进程，优先使用 Zotero 全文或 MinerU Markdown。";
  if (kind === "custom-json-process")
    return "直接启动自定义进程，不经过 Shell；stdin JSON 包含 pdfPath、可选 text/images、字段和 Schema，stdout 必须返回 JSON。";
  return "使用 Codex CLI 的只读沙箱和任务期 PDF 目录；无法直读时自动回退 Zotero 全文或 MinerU Markdown。";
}

function mineruModeLabel(mode: MinerUProfile["mode"]): string {
  if (mode === "official-api") return "MinerU 网页 API";
  if (mode === "self-hosted") return "Docker / 本地 API";
  return "MinerU Desktop";
}

function primaryPdfSourceLabel(source: PrimaryPdfResolution["source"]): string {
  if (source === "explicit") return "已指定";
  if (source === "named-pdf") return "标题为 PDF";
  if (source === "best-attachment") return "Zotero 默认附件";
  return "首个 PDF";
}

function ComparisonManager({
  items,
  records,
  workspace,
  repository,
  agent,
  definition,
  onSave,
  onClose,
}: {
  items: Zotero.Item[];
  records: Map<string, ItemResearchRecord>;
  workspace: WorkspaceState;
  repository: ResearchRepository;
  agent: AgentBridge;
  definition?: ComparisonDefinition;
  onSave: (workspace: WorkspaceState) => Promise<void>;
  onClose: () => void;
}) {
  const [fieldIDs, setFieldIDs] = useState(
    definition?.fieldIDs || workspace.fields.map((field) => field.id),
  );
  const [name, setName] = useState(
    definition?.name || `论文比较 ${new Date().toLocaleDateString()}`,
  );
  const [synthesis, setSynthesis] = useState(definition?.synthesis || "");
  const [synthesisPrompt, setSynthesisPrompt] = useState(
    definition?.synthesisPrompt || "",
  );
  const [status, setStatus] = useState("");
  const snapshot = useMemo(
    () => createComparisonSnapshot(name, items, records, fieldIDs, synthesis),
    [fieldIDs, items, name, records, synthesis],
  );
  return (
    <Modal title="自定义论文比较" onClose={onClose} wide>
      <input
        className="zrdb-comparison-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <div className="zrdb-field-checks">
        {workspace.fields.map((field) => (
          <label key={field.id}>
            <input
              type="checkbox"
              checked={fieldIDs.includes(field.id)}
              onChange={(event) =>
                setFieldIDs((all) =>
                  event.target.checked
                    ? [...all, field.id]
                    : all.filter((id) => id !== field.id),
                )
              }
            />
            {field.name}
          </label>
        ))}
      </div>
      <div className="zrdb-comparison-scroll">
        <table>
          <thead>
            <tr>
              <th>论文</th>
              {workspace.fields
                .filter((field) => fieldIDs.includes(field.id))
                .map((field) => (
                  <th key={field.id}>{field.name}</th>
                ))}
            </tr>
          </thead>
          <tbody>
            {snapshot.rows.map((row) => (
              <tr key={row.itemKey}>
                <td>{row.title}</td>
                {fieldIDs.map((fieldID) => (
                  <td key={fieldID}>{displayValue(row.values[fieldID])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="zrdb-form-field">
        <span>比较说明</span>
        <textarea
          rows={3}
          value={synthesisPrompt}
          onChange={(event) => setSynthesisPrompt(event.target.value)}
          placeholder="默认比较共同点、差异、研究空白和可借鉴方向"
        />
      </label>
      <label className="zrdb-form-field">
        <span>综合结论</span>
        <textarea
          rows={8}
          value={synthesis}
          onChange={(event) => setSynthesis(event.target.value)}
        />
      </label>
      <div className="zrdb-inline-actions">
        <button
          onClick={() =>
            void (async () => {
              try {
                setStatus("正在调用 Codex 生成综合结论……");
                setSynthesis(
                  await synthesizeComparison(
                    snapshot,
                    workspace.fields,
                    agent,
                    synthesisPrompt,
                  ),
                );
                setStatus("综合完成");
              } catch (error) {
                setStatus(
                  error instanceof Error ? error.message : String(error),
                );
              }
            })()
          }
        >
          调用 Codex 综合
        </button>
        <button
          onClick={() =>
            void (() => {
              const now = new Date().toISOString();
              const next: ComparisonDefinition = {
                id: definition?.id || createID("comparison"),
                name,
                itemKeys: items.map((item) => item.key),
                fieldIDs,
                synthesisPrompt,
                synthesis,
                createdAt: definition?.createdAt || now,
                updatedAt: now,
              };
              return onSave({
                ...workspace,
                comparisons: definition
                  ? workspace.comparisons.map((entry) =>
                      entry.id === definition.id ? next : entry,
                    )
                  : [...workspace.comparisons, next],
              });
            })().then(() =>
              setStatus(definition ? "动态比较已更新" : "动态比较已保存"),
            )
          }
        >
          {definition ? "更新动态比较" : "保存动态比较"}
        </button>
        <button
          onClick={() =>
            void onSave({
              ...workspace,
              snapshots: [...workspace.snapshots, snapshot],
            }).then(() => setStatus("固定快照已保存"))
          }
        >
          保存固定快照
        </button>
        <button
          onClick={() =>
            void (async () => {
              const ids = await exportSnapshotAttachments(
                await repository.getWorkspaceItem(),
                snapshot,
                workspace.fields,
              );
              const saved = { ...snapshot, exportAttachmentIDs: ids };
              await onSave({
                ...workspace,
                snapshots: [...workspace.snapshots, saved],
              });
              setStatus("Markdown、HTML、CSV 已保存到工作区条目");
            })()
          }
        >
          保存快照并导出
        </button>
      </div>
      {status && <p className="zrdb-status">{status}</p>}
    </Modal>
  );
}

function SavedManager({
  workspace,
  repository,
  records,
  onSave,
  onOpenComparison,
  onOpenView,
  onUpdateView,
  onClose,
}: {
  workspace: WorkspaceState;
  repository: ResearchRepository;
  records: Map<string, ItemResearchRecord>;
  onSave: (workspace: WorkspaceState) => Promise<void>;
  onOpenComparison: (comparison: ComparisonDefinition) => void;
  onOpenView: (view: SavedView) => void;
  onUpdateView: (view: SavedView) => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"views" | "comparisons" | "snapshots">(
    "views",
  );
  const [openedSnapshot, setOpenedSnapshot] = useState<ComparisonSnapshot>();
  const rename = (value: string) =>
    (globalThis as any).prompt?.("输入新名称", value) || value;
  return (
    <Modal title="已保存" onClose={onClose} wide>
      <div className="zrdb-tabs">
        <button
          className={tab === "views" ? "active" : ""}
          onClick={() => setTab("views")}
        >
          视图
        </button>
        <button
          className={tab === "comparisons" ? "active" : ""}
          onClick={() => setTab("comparisons")}
        >
          动态比较
        </button>
        <button
          className={tab === "snapshots" ? "active" : ""}
          onClick={() => setTab("snapshots")}
        >
          固定快照
        </button>
      </div>
      <div className="zrdb-saved-list">
        {tab === "views" &&
          workspace.views
            .filter((view) => view.mode === "table")
            .map((view) => (
              <div key={view.id}>
                <strong>{view.name}</strong>
                <span>表格</span>
                <button
                  onClick={() => {
                    onOpenView(view);
                  }}
                >
                  打开
                </button>
                <button
                  onClick={() =>
                    void onSave({
                      ...workspace,
                      views: workspace.views.map((entry) =>
                        entry.id === view.id
                          ? {
                              ...entry,
                              name: rename(entry.name),
                              updatedAt: new Date().toISOString(),
                            }
                          : entry,
                      ),
                    })
                  }
                >
                  重命名
                </button>
                <button onClick={() => void onUpdateView(view)}>更新</button>
                <button
                  onClick={() => {
                    const now = new Date().toISOString();
                    void onSave({
                      ...workspace,
                      views: [
                        ...workspace.views,
                        {
                          ...view,
                          id: createID("view"),
                          name: `${view.name} 副本`,
                          createdAt: now,
                          updatedAt: now,
                        },
                      ],
                    });
                  }}
                >
                  复制
                </button>
                <button
                  className="danger"
                  disabled={view.id.startsWith("builtin-")}
                  onClick={() =>
                    void onSave({
                      ...workspace,
                      views: workspace.views.filter(
                        (entry) => entry.id !== view.id,
                      ),
                    })
                  }
                >
                  删除
                </button>
              </div>
            ))}
        {tab === "comparisons" &&
          workspace.comparisons.map((comparison) => (
            <div key={comparison.id}>
              <strong>{comparison.name}</strong>
              <span>{comparison.itemKeys.length} 篇</span>
              <button onClick={() => onOpenComparison(comparison)}>打开</button>
              <button
                onClick={() =>
                  void onSave({
                    ...workspace,
                    comparisons: workspace.comparisons.map((entry) =>
                      entry.id === comparison.id
                        ? {
                            ...entry,
                            name: rename(entry.name),
                            updatedAt: new Date().toISOString(),
                          }
                        : entry,
                    ),
                  })
                }
              >
                重命名
              </button>
              <button
                onClick={() =>
                  void onSave({
                    ...workspace,
                    comparisons: [
                      ...workspace.comparisons,
                      {
                        ...comparison,
                        id: createID("comparison"),
                        name: `${comparison.name} 副本`,
                      },
                    ],
                  })
                }
              >
                复制
              </button>
              <button
                onClick={() =>
                  void (async () => {
                    const resolved = await resolveSavedItems(
                      comparison.itemKeys,
                      repository,
                      records,
                    );
                    const snapshot = createComparisonSnapshot(
                      comparison.name,
                      resolved.items,
                      resolved.records,
                      comparison.fieldIDs,
                      comparison.synthesis || "",
                    );
                    await exportSnapshotAttachments(
                      await repository.getWorkspaceItem(),
                      snapshot,
                      workspace.fields,
                    );
                  })()
                }
              >
                导出最新
              </button>
              <button
                className="danger"
                onClick={() =>
                  void onSave({
                    ...workspace,
                    comparisons: workspace.comparisons.filter(
                      (entry) => entry.id !== comparison.id,
                    ),
                  })
                }
              >
                删除
              </button>
            </div>
          ))}
        {tab === "snapshots" &&
          workspace.snapshots.map((snapshot) => (
            <div key={snapshot.id}>
              <strong>{snapshot.name}</strong>
              <span>{new Date(snapshot.createdAt).toLocaleString()}</span>
              <button onClick={() => setOpenedSnapshot(snapshot)}>打开</button>
              <button
                onClick={() => {
                  const name = rename(snapshot.name);
                  void onSave({
                    ...workspace,
                    snapshots: workspace.snapshots.map((entry) =>
                      entry.id === snapshot.id ? { ...entry, name } : entry,
                    ),
                  });
                  setOpenedSnapshot((current) =>
                    current?.id === snapshot.id
                      ? { ...current, name }
                      : current,
                  );
                }}
              >
                重命名
              </button>
              <button
                onClick={() => {
                  const copy = {
                    ...snapshot,
                    id: createID("snapshot"),
                    name: `${snapshot.name} 副本`,
                    createdAt: new Date().toISOString(),
                    exportAttachmentIDs: [],
                  };
                  void onSave({
                    ...workspace,
                    snapshots: [...workspace.snapshots, copy],
                  });
                }}
              >
                复制
              </button>
              <button
                onClick={() =>
                  void (async () => {
                    const resolved = await resolveSavedItems(
                      snapshot.rows.map((row) => row.itemKey),
                      repository,
                      records,
                    );
                    const refreshed = {
                      ...createComparisonSnapshot(
                        snapshot.name,
                        resolved.items,
                        resolved.records,
                        snapshot.fieldIDs,
                        snapshot.synthesis,
                      ),
                      id: snapshot.id,
                    };
                    await onSave({
                      ...workspace,
                      snapshots: workspace.snapshots.map((entry) =>
                        entry.id === snapshot.id ? refreshed : entry,
                      ),
                    });
                    setOpenedSnapshot(refreshed);
                  })()
                }
              >
                更新
              </button>
              <button
                onClick={() =>
                  void (async () => {
                    const ids = await exportSnapshotAttachments(
                      await repository.getWorkspaceItem(),
                      snapshot,
                      workspace.fields,
                    );
                    await onSave({
                      ...workspace,
                      snapshots: workspace.snapshots.map((entry) =>
                        entry.id === snapshot.id
                          ? {
                              ...entry,
                              exportAttachmentIDs: [
                                ...entry.exportAttachmentIDs,
                                ...ids,
                              ],
                            }
                          : entry,
                      ),
                    });
                  })()
                }
              >
                再次导出
              </button>
              <button
                className="danger"
                onClick={() =>
                  void onSave({
                    ...workspace,
                    snapshots: workspace.snapshots.filter(
                      (entry) => entry.id !== snapshot.id,
                    ),
                  })
                }
              >
                删除
              </button>
            </div>
          ))}
      </div>
      {openedSnapshot && (
        <div className="zrdb-comparison-scroll">
          <h3>{openedSnapshot.name}</h3>
          <table>
            <thead>
              <tr>
                <th>论文</th>
                {workspace.fields
                  .filter((field) => openedSnapshot.fieldIDs.includes(field.id))
                  .map((field) => (
                    <th key={field.id}>{field.name}</th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {openedSnapshot.rows.map((row) => (
                <tr key={row.itemKey}>
                  <td>{row.title}</td>
                  {openedSnapshot.fieldIDs.map((fieldID) => (
                    <td key={fieldID}>{displayValue(row.values[fieldID])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <h4>综合结论</h4>
          <p>{openedSnapshot.synthesis || "尚未生成"}</p>
        </div>
      )}
    </Modal>
  );
}
