import type { ItemResearchRecord } from "../../../domain/types";
import { createEmptyRecord } from "../../../core/records";
import { ResearchRepository } from "../../../storage/repository";

export async function resolveSavedItems(
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
