import {
  snapshotToCSV,
  snapshotToHTML,
  snapshotToMarkdown,
} from "../core/exporters";
import type { ComparisonSnapshot, FieldDefinition } from "../domain/types";
import { setCurrentArtifact } from "./artifactMetadata";
import { sha256Text } from "./contentSource";
import { ResearchRepository } from "../storage/repository";

const repository = new ResearchRepository();

export async function exportSnapshotAttachments(
  workspaceItem: Zotero.Item,
  snapshot: ComparisonSnapshot,
  fields: FieldDefinition[],
): Promise<number[]> {
  const safeName = sanitize(snapshot.name);
  const directory = PathUtils.join(
    PathUtils.tempDir,
    `zrdb-${snapshot.id}-${Date.now()}`,
  );
  await IOUtils.makeDirectory(directory, { ignoreExisting: true });
  const files = [
    { extension: "md", content: snapshotToMarkdown(snapshot, fields) },
    { extension: "html", content: snapshotToHTML(snapshot, fields) },
    { extension: "csv", content: `\uFEFF${snapshotToCSV(snapshot, fields)}` },
  ];
  const attachmentIDs: number[] = [];
  let artifacts = await repository.loadArtifacts(workspaceItem);
  try {
    for (const file of files) {
      const path = PathUtils.join(directory, `${safeName}.${file.extension}`);
      await IOUtils.writeUTF8(path, file.content);
      const attachment = await Zotero.Attachments.importFromFile({
        file: path,
        parentItemID: workspaceItem.id,
        title: `${snapshot.name}.${file.extension}`,
      } as any);
      artifacts = setCurrentArtifact(
        artifacts,
        {
          attachmentKey: attachment.key,
          role: "snapshot",
          sha256: await sha256Text(file.content),
          snapshotID: snapshot.id,
          format: file.extension as "md" | "html" | "csv",
        },
        (entry) =>
          entry.role === "snapshot" &&
          entry.snapshotID === snapshot.id &&
          entry.format === file.extension,
      );
      attachmentIDs.push(attachment.id);
    }
    await repository.saveArtifacts(workspaceItem, artifacts);
  } finally {
    await IOUtils.remove(directory, { recursive: true, ignoreAbsent: true });
  }
  return attachmentIDs;
}

function sanitize(name: string): string {
  const forbidden = '<>:"/\\|?*';
  const value = [...name]
    .map((character) =>
      forbidden.includes(character) || character.charCodeAt(0) <= 0x1f
        ? "_"
        : character,
    )
    .join("")
    .trim();
  return value.slice(0, 100) || "论文比较";
}
