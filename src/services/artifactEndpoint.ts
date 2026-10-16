import { API_ENDPOINT, API_TOKEN_PREF } from "../domain/defaults";
import type {
  ArtifactImport,
  ArtifactImportRequest,
  FigureArtifact,
  ManagedArtifact,
} from "../domain/types";
import { getPref, setPref } from "../utils/prefs";
import { resolvePrimaryPdf } from "./primaryPdf";
import { setCurrentArtifact } from "./artifactMetadata";
import type { ResearchRepository } from "../storage/repository";
import { getResearchRepository } from "../storage/repositoryScope";
import {
  createManagedAttachment,
  createManagedAttachmentUnlocked,
  rollbackManagedAttachments,
  withArtifactStorageItemLock,
} from "./artifactStorage";

export type ArtifactImportRepository = Pick<
  ResearchRepository,
  | "loadArtifacts"
  | "loadFigures"
  | "saveManifests"
  | "loadPrimaryPdfKey"
  | "savePrimaryPdfKey"
>;

export function ensureArtifactImportToken(): string {
  const current = String(getPref(API_TOKEN_PREF) || "");
  if (current) return current;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  setPref(API_TOKEN_PREF, token);
  return token;
}

export function rotateArtifactImportToken(): string {
  setPref(API_TOKEN_PREF, "");
  return ensureArtifactImportToken();
}

export function registerArtifactEndpoint(
  repository: ArtifactImportRepository = getResearchRepository(),
  createAttachment = createManagedAttachment,
): void {
  ensureArtifactImportToken();
  Zotero.Server.Endpoints[API_ENDPOINT] = class {
    supportedMethods = ["POST"];
    supportedDataTypes = ["application/json"];
    allowRequestsFromUnsafeWebContent = false;

    async init({
      headers,
      data,
    }: {
      headers: Record<string, string>;
      data: unknown;
    }) {
      const requestToken = Object.entries(headers || {}).find(
        ([name]) => name.toLowerCase() === "x-zrdb-token",
      )?.[1];
      if (requestToken !== ensureArtifactImportToken()) {
        return [
          401,
          "application/json",
          JSON.stringify({ error: "unauthorized" }),
        ];
      }
      try {
        const result = await importArtifacts(
          validateRequest(data),
          repository,
          createAttachment,
        );
        return [200, "application/json", JSON.stringify(result)];
      } catch (error) {
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
        return [
          400,
          "application/json",
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        ];
      }
    }
  };
}

export function unregisterArtifactEndpoint(): void {
  delete Zotero.Server.Endpoints[API_ENDPOINT];
}

export async function importArtifacts(
  request: ArtifactImportRequest,
  repository: ArtifactImportRepository = getResearchRepository(),
  createAttachment = createManagedAttachment,
): Promise<object> {
  if (request.libraryID !== Zotero.Libraries.userLibraryID) {
    throw new Error("第一版只接受个人库产物");
  }
  const parent = await Zotero.Items.getByLibraryAndKeyAsync(
    request.libraryID,
    request.parentItemKey,
  );
  if (parent === false || !parent.isRegularItem()) {
    throw new Error("找不到对应的 Zotero 父条目");
  }
  return withArtifactStorageItemLock(parent.key, async () => {
    const originalArtifacts = await repository.loadArtifacts(parent);
    const originalFigures = await repository.loadFigures(parent);
    const originalChildren = await Zotero.Items.getAsync(
      parent.getAttachments(),
    );
    const originalKeys = new Set(originalChildren.map((child) => child.key));
    const results = [];
    const transactionCreateAttachment =
      createAttachment === createManagedAttachment
        ? createManagedAttachmentUnlocked
        : createAttachment;
    try {
      for (const artifact of request.artifacts) {
        results.push(
          await importOne(
            parent,
            request.workflowRunID,
            artifact,
            repository,
            transactionCreateAttachment,
          ),
        );
      }
      return { ok: true, parentItemKey: parent.key, artifacts: results };
    } catch (error) {
      // Restore repository metadata and remove only attachments created by this
      // request. Existing user attachments are never touched.
      await repository.saveManifests(
        parent,
        originalArtifacts,
        originalFigures,
      );
      const currentChildren = await Zotero.Items.getAsync(
        parent.getAttachments(),
      );
      const created = currentChildren.filter(
        (child) => !originalKeys.has(child.key),
      );
      await rollbackManagedAttachments(
        parent.key,
        created.map((child) => child.key),
        undefined,
        true,
      ).catch(() => undefined);
      for (const child of created) {
        await child.eraseTx().catch(() => undefined);
      }
      throw error;
    }
  });
}

async function importOne(
  parent: Zotero.Item,
  runID: string,
  artifact: ArtifactImport,
  repository: ArtifactImportRepository,
  createAttachment: typeof createManagedAttachment,
): Promise<object> {
  const isFigure = artifact.role === "figure" || artifact.role === "table";
  if (!isFigure && !artifact.path.toLowerCase().endsWith(".md"))
    throw new Error("MinerU 原文和中译产物必须是 Markdown 文件");
  if (isFigure && !/\.(png|jpe?g|webp|gif|tiff?|bmp)$/i.test(artifact.path))
    throw new Error("图表产物必须是受支持的图片文件");
  const actualHash = await sha256File(artifact.path);
  if (actualHash !== artifact.sha256.toLowerCase()) {
    throw new Error(`产物哈希不匹配：${artifact.title}`);
  }
  const children = await Zotero.Items.getAsync(parent.getAttachments());
  const currentArtifacts = await repository.loadArtifacts(parent);
  if (isFigure) {
    const metadata = artifact.figure!;
    const figures = await repository.loadFigures(parent);
    const duplicateMetadata = currentArtifacts.find(
      (entry) =>
        entry.figureID === metadata.id &&
        entry.sha256 === actualHash &&
        entry.role === artifact.role,
    );
    // Figure manifests from 0.3.18 remain a valid fallback while the tag
    // migration is pending or when a synced manifest arrives first.
    const legacyFigure = figures.find(
      (entry) => entry.id === metadata.id && entry.sha256 === actualHash,
    );
    const duplicateKey =
      duplicateMetadata?.attachmentKey || legacyFigure?.attachmentKey;
    const duplicate = children.find((child) => child.key === duplicateKey);
    if (duplicate) {
      const managed = figureManagedArtifact(
        duplicate,
        runID,
        artifact,
        actualHash,
      );
      const nextArtifacts = setCurrentArtifact(
        currentArtifacts,
        managed,
        (entry) => entry.figureID === metadata.id,
      );
      const figure = await createFigureArtifact(
        parent,
        duplicate,
        artifact,
        actualHash,
        children,
        repository,
      );
      await saveParentManifests({
        parent,
        artifacts: nextArtifacts,
        repository,
        figures: replaceFigure(figures, figure),
      });
      return {
        role: artifact.role,
        figureID: metadata.id,
        attachmentID: duplicate.id,
        status: "unchanged",
      };
    }
    const imported = await createAttachment(
      parent,
      artifact.path,
      artifact.title,
      {
        role: artifact.role,
        runID,
        figureID: metadata.id,
      },
    );
    const managed = figureManagedArtifact(
      imported.attachment,
      runID,
      artifact,
      imported.sha256,
      imported.relativePath,
    );
    const nextArtifacts = setCurrentArtifact(
      currentArtifacts,
      managed,
      (entry) => entry.figureID === metadata.id,
    );
    const figure = await createFigureArtifact(
      parent,
      imported.attachment,
      artifact,
      imported.sha256,
      children,
      repository,
    );
    await saveParentManifests({
      parent,
      artifacts: nextArtifacts,
      repository,
      figures: replaceFigure(figures, figure),
    });
    return {
      role: artifact.role,
      figureID: metadata.id,
      attachmentID: imported.attachment.id,
      status: "imported",
    };
  }
  const duplicateMetadata = currentArtifacts.find(
    (entry) => entry.role === artifact.role && entry.sha256 === actualHash,
  );
  const duplicate = children.find(
    (child) => child.key === duplicateMetadata?.attachmentKey,
  );
  if (duplicate) {
    const managed: ManagedArtifact = {
      attachmentKey: duplicate.key,
      role: artifact.role,
      sha256: actualHash,
      relativePath: duplicateMetadata?.relativePath,
      runID,
    };
    await saveParentManifests({
      parent,
      artifacts: setCurrentArtifact(
        currentArtifacts,
        managed,
        (entry) => entry.role === artifact.role,
      ),
      repository,
    });
    return {
      role: artifact.role,
      attachmentID: duplicate.id,
      status: "unchanged",
    };
  }
  const imported = await createAttachment(
    parent,
    artifact.path,
    artifact.title,
    { role: artifact.role, runID },
  );
  const managed: ManagedArtifact = {
    attachmentKey: imported.attachment.key,
    role: artifact.role,
    sha256: imported.sha256,
    relativePath: imported.relativePath,
    runID,
  };
  await saveParentManifests({
    parent,
    artifacts: setCurrentArtifact(
      currentArtifacts,
      managed,
      (entry) => entry.role === artifact.role,
    ),
    repository,
  });
  return {
    role: artifact.role,
    attachmentID: imported.attachment.id,
    status: "imported",
  };
}

function figureManagedArtifact(
  attachment: Zotero.Item,
  runID: string,
  artifact: ArtifactImport,
  actualHash: string,
  relativePath?: string,
): ManagedArtifact {
  return {
    attachmentKey: attachment.key,
    role: artifact.role,
    sha256: actualHash,
    relativePath,
    runID,
    figureID: artifact.figure!.id,
  };
}

async function createFigureArtifact(
  parent: Zotero.Item,
  attachment: Zotero.Item,
  artifact: ArtifactImport,
  actualHash: string,
  children: Zotero.Item[],
  repository: ArtifactImportRepository,
): Promise<FigureArtifact> {
  const metadata = artifact.figure!;
  const pdf = metadata.sourcePdfAttachmentKey
    ? children.find((child) => child.key === metadata.sourcePdfAttachmentKey)
    : (await resolvePrimaryPdf(parent, children, repository))?.attachment;
  return {
    id: metadata.id,
    parentItemKey: parent.key,
    attachmentKey: attachment.key,
    sourcePdfAttachmentKey: pdf?.key || metadata.sourcePdfAttachmentKey,
    kind: artifact.role as FigureArtifact["kind"],
    caption: metadata.caption,
    pageIndex: metadata.pageIndex,
    rect: metadata.rect,
    sha256: actualHash,
  };
}

function replaceFigure(
  figures: FigureArtifact[],
  figure: FigureArtifact,
): FigureArtifact[] {
  return [...figures.filter((entry) => entry.id !== figure.id), figure];
}

async function saveParentManifests(options: {
  parent: Zotero.Item;
  artifacts: ManagedArtifact[];
  repository: ArtifactImportRepository;
  figures?: FigureArtifact[];
}): Promise<void> {
  await options.repository.saveManifests(
    options.parent,
    options.artifacts,
    options.figures,
  );
}

export function validateRequest(data: unknown): ArtifactImportRequest {
  const value = data as Partial<ArtifactImportRequest>;
  if (
    !value ||
    typeof value.libraryID !== "number" ||
    typeof value.parentItemKey !== "string" ||
    typeof value.workflowRunID !== "string" ||
    !Array.isArray(value.artifacts) ||
    !value.artifacts.length
  ) {
    throw new Error("无效的 ArtifactImportRequest");
  }
  for (const artifact of value.artifacts) {
    if (
      !artifact ||
      !["mineru-original", "translation", "figure", "table"].includes(
        artifact.role,
      ) ||
      typeof artifact.path !== "string" ||
      !/^[a-f0-9]{64}$/i.test(artifact.sha256) ||
      typeof artifact.title !== "string"
    ) {
      throw new Error("无效的 artifacts 字段");
    }
    if (
      ["figure", "table"].includes(artifact.role) &&
      (!artifact.figure ||
        typeof artifact.figure.id !== "string" ||
        !artifact.figure.id ||
        typeof artifact.figure.caption !== "string" ||
        (artifact.figure.sourcePdfAttachmentKey !== undefined &&
          typeof artifact.figure.sourcePdfAttachmentKey !== "string") ||
        !Number.isInteger(artifact.figure.pageIndex) ||
        artifact.figure.pageIndex < 0 ||
        (artifact.figure.rect &&
          ([
            artifact.figure.rect.x,
            artifact.figure.rect.y,
            artifact.figure.rect.width,
            artifact.figure.rect.height,
          ].some(
            (entry) => typeof entry !== "number" || !Number.isFinite(entry),
          ) ||
            artifact.figure.rect.width <= 0 ||
            artifact.figure.rect.height <= 0)))
    ) {
      throw new Error("图表产物缺少有效的 ID、页码或区域坐标");
    }
  }
  return value as ArtifactImportRequest;
}

async function sha256File(path: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await IOUtils.read(path);
  } catch {
    throw new Error(`无法读取产物文件：${path}`);
  }
  // @types/node 26 typed Uint8Array as Uint8Array<ArrayBufferLike>; IOUtils
  // always returns a plain ArrayBuffer view, so narrow it before hashing.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
