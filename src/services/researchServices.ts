import type { ComparisonSnapshot, FieldDefinition } from "../domain/types";
import { getResearchRepository } from "../storage/repositoryScope";
import {
  resolvePrimaryPdf,
  setPrimaryPdf,
  type PrimaryPdfRepository,
} from "./primaryPdf";
import {
  resolveSourceText,
  type ContentSourceRepository,
} from "./contentSource";
import {
  migrateLegacyInternalTags,
  type ArtifactMetadataRepository,
} from "./artifactMetadata";
import {
  createManagedAttachment,
  migrateStoredArtifacts,
  scanBrokenArtifactLinks,
  type ArtifactStorageRepository,
} from "./artifactStorage";
import {
  importArtifacts,
  registerArtifactEndpoint,
  type ArtifactImportRepository,
} from "./artifactEndpoint";
import {
  exportSnapshotAttachments,
  type SnapshotExportRepository,
} from "./snapshotExport";
import type { ArtifactImportRequest } from "../domain/types";

export type ResearchServiceRepository = PrimaryPdfRepository &
  ContentSourceRepository &
  ArtifactMetadataRepository &
  ArtifactStorageRepository &
  ArtifactImportRepository &
  SnapshotExportRepository;

/**
 * Explicit composition for a window, workflow, or isolated test. Every nested
 * operation receives the same repository and attachment writer. Production
 * callers without overrides share the loaded plugin's repository scope.
 */
export function createResearchServices(
  repository: ResearchServiceRepository = getResearchRepository(),
  dependencies: { createAttachment?: typeof createManagedAttachment } = {},
) {
  const createAttachment =
    dependencies.createAttachment || createManagedAttachment;
  return {
    repository,
    resolvePrimaryPdf: (item: Zotero.Item, attachments?: Zotero.Item[]) =>
      resolvePrimaryPdf(item, attachments, repository),
    setPrimaryPdf: (item: Zotero.Item, attachmentKey?: string) =>
      setPrimaryPdf(item, attachmentKey, repository),
    resolveSourceText: (item: Zotero.Item) =>
      resolveSourceText(item, repository),
    migrateLegacyInternalTags: () => migrateLegacyInternalTags(repository),
    migrateStoredArtifacts: () =>
      migrateStoredArtifacts(repository, createAttachment),
    scanBrokenArtifactLinks: (root?: string) =>
      scanBrokenArtifactLinks(root, repository),
    importArtifacts: (request: ArtifactImportRequest) =>
      importArtifacts(request, repository, createAttachment),
    registerArtifactEndpoint: () =>
      registerArtifactEndpoint(repository, createAttachment),
    exportSnapshotAttachments: (
      item: Zotero.Item,
      snapshot: ComparisonSnapshot,
      fields: FieldDefinition[],
    ) =>
      exportSnapshotAttachments(
        item,
        snapshot,
        fields,
        repository,
        createAttachment,
      ),
  };
}
