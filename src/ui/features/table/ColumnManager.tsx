import React, { useEffect, useMemo, useRef, useState } from "react";
import { normalizeViewLayout } from "../../../domain/defaults";
import type { FieldDefinition, ViewLayout } from "../../../domain/types";
import { reorderColumnLayout } from "../../../core/viewLayout";
import { buildColumnDefinitions, type ColumnDefinition } from "./tableColumns";
import { COLUMN_DRAG_START_DISTANCE } from "./tableConstants";
import { Modal } from "../shared/ui";

export function ColumnManager({
  fields,
  initialColumnID,
  layout,
  onSave,
  onClose,
  onOpenFieldSettings,
}: {
  fields: FieldDefinition[];
  initialColumnID?: string;
  layout: ViewLayout;
  onSave: (layout: ViewLayout) => void;
  onClose: () => void;
  /** Open the global field-definition settings page, when the host provides it. */
  onOpenFieldSettings?: () => void;
}) {
  const all = useMemo(() => buildColumnDefinitions(fields), [fields]);
  const [draftLayout, setDraftLayout] = useState(() =>
    normalizeViewLayout(layout),
  );
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
  return (
    <Modal title="当前视图列布局" onClose={onClose} wide>
      <div className="zrdb-manager-header">
        <p className="zrdb-dialog-hint">
          管理当前视图的显示列、顺序、表头别名和固定列。按住每行的六点拖柄可调整顺序。
        </p>
        {onOpenFieldSettings && (
          <button type="button" onClick={onOpenFieldSettings}>
            打开字段设置
          </button>
        )}
      </div>
      <div className="zrdb-column-manager">
        {ordered.map((column) => {
          const visible = draftLayout.visibleColumnIDs.includes(column.id);
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
                onPointerDown={(event) => beginManagerDrag(event, column.id)}
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
                  onChange={(event) => setVisible(column, event.target.checked)}
                />
                显示
              </label>
              <strong>{column.label}</strong>
              <input
                value={draftLayout.columnLabels[column.id] || ""}
                placeholder="当前视图表头别名"
                aria-label={`“${column.label}”当前视图表头别名`}
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
                固定列
              </label>
              {draftLayout.columnLabels[column.id] && (
                <button
                  type="button"
                  className="zrdb-manager-reset-label"
                  title="恢复默认表头"
                  aria-label={`恢复“${column.label}”默认表头`}
                  onClick={() => patchAlias(column, column.label)}
                >
                  恢复名称
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="zrdb-dialog-actions">
        <button onClick={onClose}>取消</button>
        <button
          className="primary"
          onClick={() => {
            onSave(draftLayout);
            onClose();
          }}
        >
          保存列布局
        </button>
      </div>
    </Modal>
  );
}
