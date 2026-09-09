import {
  snapshotToCSV,
  snapshotToHTML,
  snapshotToMarkdown,
} from "../core/exporters";
import type { ComparisonSnapshot, FieldDefinition } from "../domain/types";
import { setCurrentArtifact } from "./artifactMetadata";
import { sha256Text } from "./contentSource";
import type { ResearchRepository } from "../storage/repository";
import { getResearchRepository } from "../storage/repositoryScope";
import { createManagedAttachment } from "./artifactStorage";

export type SnapshotExportRepository = Pick<
  ResearchRepository,
  "loadArtifacts" | "saveArtifacts"
>;

export async function exportSnapshotAttachments(
  workspaceItem: Zotero.Item,
  snapshot: ComparisonSnapshot,
  fields: FieldDefinition[],
  repository: SnapshotExportRepository = getResearchRepository(),
  createAttachment = createManagedAttachment,
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
      const managed = await createAttachment(
        workspaceItem,
        path,
        `${snapshot.name}.${file.extension}`,
        {
          role: "snapshot",
          snapshotID: snapshot.id,
          format: file.extension as "md" | "html" | "csv",
        },
      );
      artifacts = setCurrentArtifact(
        artifacts,
        {
          attachmentKey: managed.attachment.key,
          role: "snapshot",
          sha256: managed.sha256 || (await sha256Text(file.content)),
          relativePath: managed.relativePath,
          snapshotID: snapshot.id,
          format: file.extension as "md" | "html" | "csv",
        },
        (entry) =>
          entry.role === "snapshot" &&
          entry.snapshotID === snapshot.id &&
          entry.format === file.extension,
      );
      attachmentIDs.push(managed.attachment.id);
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
