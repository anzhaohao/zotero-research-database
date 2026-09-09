import React, { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { TRANSLATED_TITLE_FIELD_ID } from "../../../domain/defaults";
import type {
  FieldDefinition,
  ItemResearchRecord,
  ViewColor,
  ViewLayout,
} from "../../../domain/types";
import {
  edgeAutoScrollDirection,
  pinnedLeftOffset,
  reorderColumnLayout,
} from "../../../core/viewLayout";
import { type EditableNativeField } from "../../../storage/repository";
import { type ExtractionProgress } from "../../../services/extraction";
import { resolvePrimaryPdf } from "../../../services/primaryPdf";
import { copyPlainText } from "../../../services/clipboard";
import { TableFlatRowsCache, type TableFlatRow } from "./tableRows";
import { nativeColumns, type ColumnDefinition } from "./tableColumns";
import { type FigureRecord } from "../figures/figureRecords";
import { type EditingCell } from "./tableTypes";
import { type ColorTarget, colorValue, ColorMenu } from "./ColorMenu";
import { useColumns } from "./useColumns";
import {
  COLUMN_RESIZE_END_GUTTER,
  COLUMN_DRAG_EDGE_SIZE,
  COLUMN_DRAG_SCROLL_STEP,
  COLUMN_DRAG_START_DISTANCE,
  COLUMN_DRAG_HOLD_MS,
} from "./tableConstants";
import { year, displayValue, nativeValue } from "../shared/display";
import { UIIcon, ResearchTextValue, IconButton } from "../shared/ui";
import { PdfPreview } from "../pdf/PdfPreview";
import { FigureGallery } from "../figures/FigureGallery";
import { InlineCellEditor, TitleCell, BasicInfoCell } from "./TableCells";
import { CellAgentStatus } from "../agent/ProgressBar";

export function TableView(props: {
  items: Zotero.Item[];
  fields: FieldDefinition[];
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
  const flatRowsCacheRef = useRef(new TableFlatRowsCache<Zotero.Item>());
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
  const columns = useColumns(props.fields, shownLayout);
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
  const flatRows = useMemo<TableFlatRow<Zotero.Item>[]>(
    () =>
      flatRowsCacheRef.current.get(
        props.items,
        props.groupBy,
        (item, groupBy) =>
          groupBy === "year"
            ? year(item)
            : displayValue(props.records.get(item.key)?.fields[groupBy]?.value),
      ),
    [props.groupBy, props.items, props.records],
  );
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
                props.onManageColumns(column.id);
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
                title="管理此列"
                aria-label={`管理“${column.label}”列`}
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
