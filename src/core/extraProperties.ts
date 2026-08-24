import {
  ARTIFACT_EXTRA_KEY,
  FIGURE_EXTRA_KEY,
  PRIMARY_PDF_EXTRA_KEY,
  RECORD_EXTRA_META_KEY,
  RECORD_EXTRA_PROPERTY_PREFIX,
  WORKSPACE_EXTRA_KEY,
  WORKSPACE_MARKER,
} from "../domain/defaults";
import type {
  FigureArtifact,
  ItemResearchRecord,
  ManagedArtifact,
  ResearchValue,
  WorkspaceState,
} from "../domain/types";
import { parseRecordPayload, parseWorkspacePayload } from "./codec";

interface ManagedLine {
  index: number;
  key: string;
  value: string;
}

interface RecordMeta {
  schemaVersion: 1;
  libraryID: number;
  itemKey: string;
  revision: number;
  updatedAt: string;
}

function splitKeyValue(line: string): { key: string; value: string } | null {
  const separator = line.indexOf(":");
  if (separator < 0) return null;
  const key = line.slice(0, separator).trim();
  if (!key) return null;
  return { key, value: line.slice(separator + 1).trim() };
}

function managedLines(extra: string, predicate: (key: string) => boolean) {
  const matches: ManagedLine[] = [];
  extra.split(/\r?\n/).forEach((line, index) => {
    const parsed = splitKeyValue(line);
    if (parsed && predicate(parsed.key)) {
      matches.push({ index, ...parsed });
    }
  });
  return matches;
}

function assertUnique(lines: ManagedLine[], keyName: string): void {
  if (lines.length > 1) {
    throw new Error(`Extra 中存在重复的插件属性：${keyName}`);
  }
}

function parseJSON(value: string, key: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Extra 属性 ${key} 不是有效 JSON`, { cause: error });
  }
}

function appendManagedLines(
  extra: string,
  remove: (key: string) => boolean,
  additions: string[],
): string {
  const kept = extra.split(/\r?\n/).filter((line) => {
    const parsed = splitKeyValue(line);
    return !parsed || !remove(parsed.key);
  });
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  if (kept.length && additions.length) kept.push("");
  kept.push(...additions);
  return kept.join("\n");
}

function recordKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase();
  return (
    normalized === RECORD_EXTRA_META_KEY.toLocaleLowerCase() ||
    normalized.startsWith(RECORD_EXTRA_PROPERTY_PREFIX.toLocaleLowerCase())
  );
}

function itemManagedKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase();
  return (
    recordKey(key) ||
    normalized === FIGURE_EXTRA_KEY.toLocaleLowerCase() ||
    normalized === ARTIFACT_EXTRA_KEY.toLocaleLowerCase() ||
    normalized === PRIMARY_PDF_EXTRA_KEY.toLocaleLowerCase()
  );
}

/** True when an item still contains data written by pre-0.3.21 versions. */
export function hasManagedItemExtra(extra: string): boolean {
  return managedLines(extra, itemManagedKey).length > 0;
}

/**
 * Remove only plugin-owned item metadata. Unrelated Zotero/user/plugin Extra
 * lines keep their order, spelling and line-ending style.
 */
export function stripManagedItemExtra(extra: string): string {
  return stripLines(extra, (line) => {
    const parsed = splitKeyValue(line);
    return Boolean(parsed && itemManagedKey(parsed.key));
  });
}

export function hasManagedWorkspaceExtra(extra: string): boolean {
  return extra.split(/\r?\n/).some((line) => {
    const parsed = splitKeyValue(line);
    return (
      line.trim().toLocaleLowerCase() ===
        WORKSPACE_MARKER.toLocaleLowerCase() ||
      parsed?.key.toLocaleLowerCase() ===
        WORKSPACE_EXTRA_KEY.toLocaleLowerCase()
    );
  });
}

/** Remove the old workspace marker/payload while preserving unrelated Extra. */
export function stripManagedWorkspaceExtra(extra: string): string {
  return stripLines(extra, (line) => {
    if (
      line.trim().toLocaleLowerCase() === WORKSPACE_MARKER.toLocaleLowerCase()
    )
      return true;
    const parsed = splitKeyValue(line);
    return (
      parsed?.key.toLocaleLowerCase() ===
      WORKSPACE_EXTRA_KEY.toLocaleLowerCase()
    );
  });
}

function stripLines(extra: string, remove: (line: string) => boolean): string {
  const eol = extra.includes("\r\n") ? "\r\n" : "\n";
  const kept = extra.split(/\r?\n/).filter((line) => !remove(line));
  // Managed blocks were separated with one blank line. Avoid leaving a blank
  // tail in the visible Extra field without rewriting unrelated content.
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join(eol);
}

export function parseRecordExtra(
  extra: string,
): ItemResearchRecord | undefined {
  const metaLines = managedLines(
    extra,
    (key) =>
      key.toLocaleLowerCase() === RECORD_EXTRA_META_KEY.toLocaleLowerCase(),
  );
  assertUnique(metaLines, RECORD_EXTRA_META_KEY);
  if (!metaLines.length) return undefined;

  const meta = parseJSON(metaLines[0].value, metaLines[0].key) as RecordMeta;
  const fields: Record<string, ResearchValue> = {};
  const seen = new Set<string>();
  for (const line of managedLines(extra, (key) =>
    key
      .toLocaleLowerCase()
      .startsWith(RECORD_EXTRA_PROPERTY_PREFIX.toLocaleLowerCase()),
  )) {
    const fieldID = line.key.slice(RECORD_EXTRA_PROPERTY_PREFIX.length);
    const normalized = fieldID.toLocaleLowerCase();
    if (!fieldID || seen.has(normalized)) {
      throw new Error(`Extra 中存在重复或无效的研究属性：${line.key}`);
    }
    seen.add(normalized);
    fields[fieldID] = parseJSON(line.value, line.key) as ResearchValue;
  }
  return parseRecordPayload({ ...meta, fields });
}

export function writeRecordExtra(
  extra: string,
  record: ItemResearchRecord,
): string {
  // Parse first so malformed or duplicate managed lines can never be silently
  // overwritten. Unrelated Extra lines remain byte-for-byte identical.
  if (managedLines(extra, recordKey).length) parseRecordExtra(extra);
  const meta: RecordMeta = {
    schemaVersion: record.schemaVersion,
    libraryID: record.libraryID,
    itemKey: record.itemKey,
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
  const additions = [
    `${RECORD_EXTRA_META_KEY}: ${JSON.stringify(meta)}`,
    ...Object.entries(record.fields).map(
      ([fieldID, value]) =>
        `${RECORD_EXTRA_PROPERTY_PREFIX}${fieldID}: ${JSON.stringify(value)}`,
    ),
  ];
  return appendManagedLines(extra, recordKey, additions);
}

export function parseWorkspaceExtra(extra: string): WorkspaceState | undefined {
  const lines = managedLines(
    extra,
    (key) =>
      key.toLocaleLowerCase() === WORKSPACE_EXTRA_KEY.toLocaleLowerCase(),
  );
  assertUnique(lines, WORKSPACE_EXTRA_KEY);
  if (!lines.length) return undefined;
  return parseWorkspacePayload(parseJSON(lines[0].value, lines[0].key));
}

export function writeWorkspaceExtra(
  extra: string,
  state: WorkspaceState,
): string {
  if (
    managedLines(
      extra,
      (key) =>
        key.toLocaleLowerCase() === WORKSPACE_EXTRA_KEY.toLocaleLowerCase(),
    ).length
  ) {
    parseWorkspaceExtra(extra);
  }
  const hasMarker = extra
    .split(/\r?\n/)
    .some(
      (line) =>
        line.trim().toLocaleLowerCase() ===
        WORKSPACE_MARKER.toLocaleLowerCase(),
    );
  const base = hasMarker
    ? extra
    : [extra.trimEnd(), WORKSPACE_MARKER].filter(Boolean).join("\n");
  return appendManagedLines(
    base,
    (key) =>
      key.toLocaleLowerCase() === WORKSPACE_EXTRA_KEY.toLocaleLowerCase(),
    [`${WORKSPACE_EXTRA_KEY}: ${JSON.stringify(state)}`],
  );
}

interface FigureManifestPayload {
  schemaVersion: 1;
  figures: FigureArtifact[];
  updatedAt: string;
}

interface ArtifactManifestPayload {
  schemaVersion: 1;
  artifacts: ManagedArtifact[];
  updatedAt: string;
}

export function parseArtifactExtra(extra: string): ManagedArtifact[] {
  const lines = managedLines(
    extra,
    (key) => key.toLocaleLowerCase() === ARTIFACT_EXTRA_KEY.toLocaleLowerCase(),
  );
  assertUnique(lines, ARTIFACT_EXTRA_KEY);
  if (!lines.length) return [];
  const payload = parseJSON(
    lines[0].value,
    lines[0].key,
  ) as Partial<ArtifactManifestPayload>;
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.artifacts)) {
    throw new Error(`Extra 属性 ${ARTIFACT_EXTRA_KEY} 不是有效附件产物清单`);
  }
  return payload.artifacts.map(validateManagedArtifact);
}

export function writeArtifactExtra(
  extra: string,
  artifacts: ManagedArtifact[],
): string {
  const hasManaged = managedLines(
    extra,
    (key) => key.toLocaleLowerCase() === ARTIFACT_EXTRA_KEY.toLocaleLowerCase(),
  ).length;
  if (hasManaged) parseArtifactExtra(extra);
  const payload: ArtifactManifestPayload = {
    schemaVersion: 1,
    artifacts: artifacts.map(validateManagedArtifact),
    updatedAt: new Date().toISOString(),
  };
  return appendManagedLines(
    extra,
    (key) => key.toLocaleLowerCase() === ARTIFACT_EXTRA_KEY.toLocaleLowerCase(),
    [`${ARTIFACT_EXTRA_KEY}: ${JSON.stringify(payload)}`],
  );
}

export function parseFigureExtra(extra: string): FigureArtifact[] {
  const lines = managedLines(
    extra,
    (key) => key.toLocaleLowerCase() === FIGURE_EXTRA_KEY.toLocaleLowerCase(),
  );
  assertUnique(lines, FIGURE_EXTRA_KEY);
  if (!lines.length) return [];
  const payload = parseJSON(
    lines[0].value,
    lines[0].key,
  ) as Partial<FigureManifestPayload>;
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.figures))
    throw new Error(`Extra 属性 ${FIGURE_EXTRA_KEY} 不是有效图表清单`);
  return payload.figures.map((figure) => validateFigureArtifact(figure));
}

export function writeFigureExtra(
  extra: string,
  figures: FigureArtifact[],
): string {
  const hasManaged = managedLines(
    extra,
    (key) => key.toLocaleLowerCase() === FIGURE_EXTRA_KEY.toLocaleLowerCase(),
  ).length;
  if (hasManaged) parseFigureExtra(extra);
  const payload: FigureManifestPayload = {
    schemaVersion: 1,
    figures: figures.map(validateFigureArtifact),
    updatedAt: new Date().toISOString(),
  };
  return appendManagedLines(
    extra,
    (key) => key.toLocaleLowerCase() === FIGURE_EXTRA_KEY.toLocaleLowerCase(),
    [`${FIGURE_EXTRA_KEY}: ${JSON.stringify(payload)}`],
  );
}

export function parsePrimaryPdfExtra(extra: string): string | undefined {
  const lines = managedLines(
    extra,
    (key) =>
      key.toLocaleLowerCase() === PRIMARY_PDF_EXTRA_KEY.toLocaleLowerCase(),
  );
  assertUnique(lines, PRIMARY_PDF_EXTRA_KEY);
  if (!lines.length) return undefined;
  const key = lines[0].value.trim();
  if (!/^[A-Z0-9]{8}$/i.test(key)) {
    throw new Error(`Extra 属性 ${PRIMARY_PDF_EXTRA_KEY} 不是有效附件键`);
  }
  return key;
}

export function writePrimaryPdfExtra(
  extra: string,
  attachmentKey?: string,
): string {
  if (
    managedLines(
      extra,
      (key) =>
        key.toLocaleLowerCase() === PRIMARY_PDF_EXTRA_KEY.toLocaleLowerCase(),
    ).length
  ) {
    parsePrimaryPdfExtra(extra);
  }
  const additions = attachmentKey
    ? [`${PRIMARY_PDF_EXTRA_KEY}: ${attachmentKey.toUpperCase()}`]
    : [];
  if (attachmentKey && !/^[A-Z0-9]{8}$/i.test(attachmentKey)) {
    throw new Error("主 PDF 附件键无效");
  }
  return appendManagedLines(
    extra,
    (key) =>
      key.toLocaleLowerCase() === PRIMARY_PDF_EXTRA_KEY.toLocaleLowerCase(),
    additions,
  );
}

function validateFigureArtifact(value: unknown): FigureArtifact {
  const figure = value as Partial<FigureArtifact>;
  const rect = figure.rect;
  if (
    !figure ||
    typeof figure.id !== "string" ||
    !figure.id ||
    typeof figure.parentItemKey !== "string" ||
    typeof figure.attachmentKey !== "string" ||
    !["figure", "table"].includes(String(figure.kind)) ||
    typeof figure.caption !== "string" ||
    !Number.isInteger(figure.pageIndex) ||
    Number(figure.pageIndex) < 0 ||
    !/^[a-f0-9]{64}$/i.test(String(figure.sha256)) ||
    (rect &&
      ([rect.x, rect.y, rect.width, rect.height].some(
        (entry) => typeof entry !== "number" || !Number.isFinite(entry),
      ) ||
        rect.width <= 0 ||
        rect.height <= 0))
  ) {
    throw new Error(`Extra 属性 ${FIGURE_EXTRA_KEY} 包含无效图表记录`);
  }
  return {
    id: figure.id,
    parentItemKey: figure.parentItemKey,
    attachmentKey: figure.attachmentKey,
    sourcePdfAttachmentKey: figure.sourcePdfAttachmentKey,
    kind: figure.kind as FigureArtifact["kind"],
    caption: figure.caption,
    pageIndex: Number(figure.pageIndex),
    rect: rect
      ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      : undefined,
    sha256: String(figure.sha256).toLowerCase(),
  };
}

function validateManagedArtifact(value: unknown): ManagedArtifact {
  const artifact = value as Partial<ManagedArtifact>;
  const validRoles = [
    "mineru-original",
    "translation",
    "figure",
    "table",
    "snapshot",
  ];
  if (
    !artifact ||
    typeof artifact.attachmentKey !== "string" ||
    !/^[A-Z0-9]{8}$/i.test(artifact.attachmentKey) ||
    !validRoles.includes(String(artifact.role)) ||
    (artifact.sha256 !== undefined &&
      !/^[a-f0-9]{64}$/i.test(artifact.sha256)) ||
    (artifact.runID !== undefined && typeof artifact.runID !== "string") ||
    (artifact.figureID !== undefined &&
      typeof artifact.figureID !== "string") ||
    (artifact.snapshotID !== undefined &&
      typeof artifact.snapshotID !== "string") ||
    (artifact.format !== undefined &&
      !["md", "html", "csv"].includes(artifact.format)) ||
    (artifact.history !== undefined && typeof artifact.history !== "boolean")
  ) {
    throw new Error(`Extra 属性 ${ARTIFACT_EXTRA_KEY} 包含无效附件产物记录`);
  }
  return {
    attachmentKey: artifact.attachmentKey.toUpperCase(),
    role: artifact.role as ManagedArtifact["role"],
    sha256: artifact.sha256?.toLowerCase(),
    runID: artifact.runID,
    figureID: artifact.figureID,
    snapshotID: artifact.snapshotID,
    format: artifact.format,
    ...(artifact.history ? { history: true } : {}),
  };
}
