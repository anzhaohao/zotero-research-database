import { createID } from "../domain/defaults";
import type {
  ComparisonSnapshot,
  FieldDefinition,
  ItemResearchRecord,
} from "../domain/types";
import type { AgentBridge } from "./externalAgent";

export function createComparisonSnapshot(
  name: string,
  items: Zotero.Item[],
  records: Map<string, ItemResearchRecord>,
  fieldIDs: string[],
  synthesis = "",
): ComparisonSnapshot {
  return {
    id: createID("snapshot"),
    name,
    fieldIDs,
    rows: items.map((item) => ({
      itemKey: item.key,
      title: String(item.getField("title") || "未命名文献"),
      creators: item
        .getCreators()
        .map((creator) => (creator as any).name || creator.lastName || "")
        .filter(Boolean)
        .join("、"),
      year: String(item.getField("year") || item.getField("date") || ""),
      values: Object.fromEntries(
        fieldIDs.map((fieldID) => [
          fieldID,
          records.get(item.key)?.fields[fieldID]?.value ?? "",
        ]),
      ),
    })),
    synthesis,
    createdAt: new Date().toISOString(),
    exportAttachmentIDs: [],
  };
}

export async function synthesizeComparison(
  snapshot: ComparisonSnapshot,
  definitions: FieldDefinition[],
  agent: AgentBridge,
  customPrompt = "",
): Promise<string> {
  return (await agent.synthesizeComparison(snapshot, definitions, customPrompt))
    .value;
}
