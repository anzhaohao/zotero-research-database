import { useState } from "react";
import { createID } from "../../../domain/defaults";
import type {
  ComparisonDefinition,
  ComparisonSnapshot,
  ItemResearchRecord,
  SavedView,
  WorkspaceState,
} from "../../../domain/types";
import { ResearchRepository } from "../../../storage/repository";
import { createComparisonSnapshot } from "../../../services/comparison";
import { exportSnapshotAttachments } from "../../../services/snapshotExport";
import { Modal } from "../shared/ui";
import { resolveSavedItems } from "./savedItems";
import { displayValue } from "../shared/display";

export function SavedManager({
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
                      repository,
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
                      repository,
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
