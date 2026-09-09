import { useTableExport } from "./features/export/useTableExport";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  TRANSLATED_TITLE_FIELD_ID,
  createID,
  createDefaultLayout,
  normalizeViewLayout,
} from "../domain/defaults";
import type {
  FieldDefinition,
  FigureKind,
  ItemResearchRecord,
  SavedView,
  WorkspaceState,
} from "../domain/types";
import {
  createEmptyRecord,
  setFieldLock,
  setManualValue,
} from "../core/records";
import { togglePinnedColumnIDs } from "../core/viewLayout";
import {
  ResearchRepository,
  type EditableNativeField,
} from "../storage/repository";
import {
  ExternalAgentExtractionService,
  type ExtractionProgress,
} from "../services/extraction";
import {
  translateTitleWithAgent,
  translateTitleWithFallback,
  translateTitleWithPDFTranslate,
} from "../services/titleTranslation";
import { createAgentBridgeFromPrefs } from "../services/agentSettings";
import { openZoteroFigureParserUI } from "../services/zoteroFigure";
import { getPref } from "../utils/prefs";
import { type EditingCell } from "./features/table/tableTypes";
import {
  prefersReducedMotion,
  UIIcon,
  ToolbarMenu,
  MenuButton,
} from "./features/shared/ui";
import {
  nativeValue,
  creators,
  year,
  displayValue,
  sortValue,
  itemField,
} from "./features/shared/display";
import { useResearchData } from "./features/table/useResearchData";
import { useColumns } from "./features/table/useColumns";
import { ProgressBar } from "./features/agent/ProgressBar";
import { TableView } from "./features/table/TableView";
import { ColumnManager } from "./features/table/ColumnManager";
import { AgentBridgeManager } from "./features/agent/AgentBridgeManager";
import { RowHeightManager } from "./features/table/RowHeightManager";
import { ComparisonManager } from "./features/export/ComparisonManager";
import { SavedManager } from "./features/export/SavedManager";
import { resolveSavedItems } from "./features/export/savedItems";
import { openResearchPreferences } from "./preferencesNavigation";

export type DatabaseViewMode = "table";

interface Props {
  mode: DatabaseViewMode;
  items: Zotero.Item[];
  repository: ResearchRepository;
  zoteroWindow: _ZoteroTypes.MainWindow;
  onSelect: (items: Zotero.Item[]) => Promise<void>;
  onModeChange: (mode: "default" | DatabaseViewMode) => void;
}

export function ResearchDatabaseApp(props: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState("");
  const [groupBy, setGroupBy] = useState("");
  const [sortBy, setSortBy] = useState("title");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [activeViewID, setActiveViewID] = useState(`builtin-${props.mode}`);
  const [columnDialog, setColumnDialog] = useState<string>();
  const [agentDialog, setAgentDialog] = useState(false);
  const [agentDialogTab, setAgentDialogTab] = useState<"mineru" | "pdf">(
    "mineru",
  );
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
  const [workspace, setWorkspace] = useState<WorkspaceState>();
  const { records, setRecords, figures, reloadRecords } = useResearchData({
    items: props.items,
    repository: props.repository,
    workspace,
    activeViewID,
    mode: props.mode,
    onWorkspaceChanged: setWorkspace,
  });
  const [, setItemRevision] = useState(0);

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
    layout.visibleColumnIDs = [
      ...layout.visibleColumnIDs,
      ...(workspace?.fields || [])
        .filter((field) => !field.archived)
        .map((field) => field.id),
    ];
    const configuredHeight = Number(getPref("defaultRowHeight"));
    if (configuredHeight >= 32) layout.rowHeight = configuredHeight;
  }
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
    ],
  );

  const effectiveFigureKinds: FigureKind[] =
    currentView?.figureKinds ||
    ([
      ...(getPref("zoteroFigureShowFigures") !== false ? ["figure"] : []),
      ...(getPref("zoteroFigureShowTables") !== false ? ["table"] : []),
      ...(getPref("zoteroFigureShowFormulas") !== false ? ["formula"] : []),
    ] as FigureKind[]);
  const hasFigureKindOverride = Boolean(currentView?.figureKinds);
  const toggleViewFigureKind = async (kind: FigureKind) => {
    const next = effectiveFigureKinds.includes(kind)
      ? effectiveFigureKinds.filter((entry) => entry !== kind)
      : [...effectiveFigureKinds, kind];
    await patchCurrentView({
      figureKinds: next,
    });
  };
  const clearViewFigureKinds = async () => {
    await patchCurrentView({ figureKinds: undefined });
  };

  const resetCurrentViewLayout = async () => {
    await patchCurrentView({
      layout: createDefaultLayout(),
      figureKinds: undefined,
    });
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
      filterText,
      groupBy: groupBy || undefined,
      sortBy: { fieldID: sortBy, direction: sortDirection },
      layout,
      ...(currentView?.figureKinds
        ? { figureKinds: [...currentView.figureKinds] }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    await saveWorkspace({ ...workspace, views: [...workspace.views, view] });
    setActiveViewID(view.id);
  }, [
    filterText,
    groupBy,
    currentView?.figureKinds,
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
      const service = new ExternalAgentExtractionService(
        props.repository,
        currentAgent,
      );
      extractionRef.current = service;
      try {
        await service.run(targets, workspace, (entry) => {
          setProgress((current) => new Map(current).set(entry.itemKey, entry));
        });
        await reloadRecords(workspace, false, true);
        props.zoteroWindow.setTimeout(() => {
          setProgress(
            (current) =>
              new Map(
                [...current].filter(([, entry]) => entry.state === "failed"),
              ),
          );
        }, 1400);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        props.zoteroWindow.alert(`提取任务失败：${message}`);
      } finally {
        setExtracting(false);
        extractionRef.current = undefined;
      }
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

  const currentColumns = useColumns(workspace?.fields || [], layout);
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

  const openFieldSettings = useCallback(() => {
    setColumnDialog(undefined);
    void openResearchPreferences("fields").catch((error) =>
      props.zoteroWindow.alert(
        `无法打开插件字段设置：${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }, [props.zoteroWindow]);

  const exportTable = useTableExport({
    currentViewName: currentView?.name,
    exportColumns,
    filteredItems,
    layout,
    items: props.items,
    zoteroWindow: props.zoteroWindow,
    records,
    selected,
  });

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
              label="字段与工具"
              open={openToolbarMenu === "fields"}
              onToggle={() =>
                setOpenToolbarMenu((current) =>
                  current === "fields" ? undefined : "fields",
                )
              }
            >
              <h3>当前视图</h3>
              <MenuButton
                icon="columns"
                label="列布局"
                detail={`${workspace.fields.filter((field) => !field.archived).length} 个字段`}
                onClick={() => setColumnDialog("__all")}
              />
              <details className="zrdb-menu-submenu">
                <summary>
                  <UIIcon name="lock" />
                  <span>固定列</span>
                  <small>
                    {layout.pinnedColumnIDs.length
                      ? `${layout.pinnedColumnIDs.length} 列`
                      : "未设置"}
                  </small>
                </summary>
                <div className="zrdb-menu-submenu-body">
                  <div className="zrdb-menu-choice-group" role="group">
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
                      const checked = layout.pinnedColumnIDs.includes(
                        column.id,
                      );
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
                </div>
              </details>
              <details className="zrdb-menu-submenu">
                <summary>
                  <UIIcon name="table" />
                  <span>图表显示</span>
                  <small>
                    {hasFigureKindOverride ? "当前视图" : "跟随设置"}
                  </small>
                </summary>
                <div className="zrdb-menu-submenu-body">
                  <div className="zrdb-menu-choice-group" role="group">
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
                    {hasFigureKindOverride && (
                      <button
                        type="button"
                        className="zrdb-menu-choice"
                        onClick={() => void clearViewFigureKinds()}
                      >
                        <i aria-hidden="true" />
                        恢复跟随全局设置
                      </button>
                    )}
                  </div>
                </div>
              </details>
              <details className="zrdb-menu-submenu">
                <summary>
                  <UIIcon name="spark" />
                  <span>处理工具</span>
                  <small>{selected.size} 篇已选</small>
                </summary>
                <div className="zrdb-menu-submenu-body">
                  <MenuButton
                    icon="refresh"
                    label="刷新论文图表"
                    detail="读取 Zotero Figure / MinerU"
                    onClick={() => void reloadRecords(workspace, true)}
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
                  <MenuButton
                    icon="mineru"
                    label="MinerU 转换"
                    detail={
                      selected.size ? `${selected.size} 篇` : "需先选择文献"
                    }
                    disabled={selected.size === 0}
                    onClick={() => {
                      setAgentDialogTab("mineru");
                      setAgentDialog(true);
                    }}
                  />
                  <MenuButton
                    icon="open"
                    label="管理主 PDF"
                    detail={
                      selected.size ? `${selected.size} 篇` : "需先选择文献"
                    }
                    disabled={selected.size === 0}
                    onClick={() => {
                      setAgentDialogTab("pdf");
                      setAgentDialog(true);
                    }}
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
                </div>
              </details>
              <div className="zrdb-menu-separator" />
              <MenuButton
                icon="fields"
                label="插件设置"
                detail="字段 · Agent · MinerU"
                onClick={() => {
                  setOpenToolbarMenu(undefined);
                  void openResearchPreferences("general").catch((error) =>
                    props.zoteroWindow.alert(
                      `无法打开插件设置：${error instanceof Error ? error.message : String(error)}`,
                    ),
                  );
                }}
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
                icon="refresh"
                label="恢复当前视图默认布局"
                detail="不影响字段值"
                onClick={() => void resetCurrentViewLayout()}
              />
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
          onSave={(nextLayout) => {
            const now = new Date().toISOString();
            const viewID = currentView?.id || builtinViewID;
            const existing = workspace.views.find((view) => view.id === viewID);
            const nextView: SavedView = {
              id: viewID,
              name: "默认表格",
              mode: props.mode,
              createdAt: now,
              ...existing,
              layout: nextLayout,
              filterText,
              groupBy: groupBy || undefined,
              sortBy: { fieldID: sortBy, direction: sortDirection },
              updatedAt: now,
            };
            void saveWorkspace({
              ...workspace,
              views: [
                ...workspace.views.filter((view) => view.id !== viewID),
                nextView,
              ],
            });
          }}
          onOpenFieldSettings={openFieldSettings}
          onClose={() => setColumnDialog(undefined)}
        />
      )}
      {agentDialog && (
        <AgentBridgeManager
          repository={props.repository}
          initialTab={agentDialogTab}
          items={props.items.filter((item) => selected.has(item.key))}
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
          createAgent={createAgentBridgeFromPrefs}
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
                      filterText,
                      groupBy: groupBy || undefined,
                      sortBy: { fieldID: sortBy, direction: sortDirection },
                      layout,
                      figureKinds: currentView?.figureKinds,
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
