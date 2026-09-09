import { useMemo, useState } from "react";
import { createID } from "../../../domain/defaults";
import type {
  ComparisonDefinition,
  ItemResearchRecord,
  WorkspaceState,
} from "../../../domain/types";
import { ResearchRepository } from "../../../storage/repository";
import {
  createComparisonSnapshot,
  synthesizeComparison,
} from "../../../services/comparison";
import { exportSnapshotAttachments } from "../../../services/snapshotExport";
import { type AgentBridge } from "../../../services/externalAgent";
import { Modal } from "../shared/ui";
import { displayValue } from "../shared/display";

export function ComparisonManager({
  items,
  records,
  workspace,
  repository,
  createAgent,
  definition,
  onSave,
  onClose,
}: {
  items: Zotero.Item[];
  records: Map<string, ItemResearchRecord>;
  workspace: WorkspaceState;
  repository: ResearchRepository;
  createAgent: () => AgentBridge;
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
                setStatus("正在调用 Agent 生成综合结论……");
                setSynthesis(
                  await synthesizeComparison(
                    snapshot,
                    workspace.fields,
                    createAgent(),
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
          调用 Agent 综合
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
                repository,
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
