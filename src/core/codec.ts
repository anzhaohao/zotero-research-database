import { z } from "zod";
import {
  BUILTIN_FIELD_PROMPTS,
  LEGACY_BUILTIN_FIELD_PROMPTS,
  RECORD_NOTE_MARKER,
  TRANSLATED_TITLE_FIELD_ID,
  WORKSPACE_NOTE_MARKER,
  createDefaultFields,
  createDefaultLayout,
} from "../domain/defaults";
import type {
  FieldDefinition,
  FigureKind,
  ItemResearchRecord,
  WorkspaceState,
} from "../domain/types";

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  libraryID: z.number(),
  itemKey: z.string().min(1),
  revision: z.number().int().nonnegative(),
  fields: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
});

const workspaceSchema = z.object({
  schemaVersion: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(8),
    z.literal(9),
    z.literal(10),
    z.literal(11),
    z.literal(12),
    z.literal(13),
    z.literal(14),
  ]),
  fields: z.array(z.unknown()),
  // Accepted only so version 0.1 workspaces can be migrated without touching
  // any paper records. Provider settings are deliberately not written back.
  providerProfiles: z.array(z.unknown()).optional(),
  views: z.array(z.unknown()),
  comparisons: z.array(z.unknown()),
  snapshots: z.array(z.unknown()),
  updatedAt: z.string(),
});

function escapeHTML(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function unescapeHTML(value: string): string {
  return value
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function valueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function extractPayload(note: string, marker: string): unknown {
  if (!note.includes(marker)) throw new Error(`Missing note marker: ${marker}`);
  const match = note.match(
    /<pre[^>]*data-zrdb-payload=["']1["'][^>]*>([\s\S]*?)<\/pre>/i,
  );
  if (!match) throw new Error("Missing structured note payload");
  return JSON.parse(unescapeHTML(match[1].trim()));
}

export function buildRecordNote(
  record: ItemResearchRecord,
  definitions: FieldDefinition[],
): string {
  const rows = definitions
    .map((field) => {
      const stored = record.fields[field.id];
      return `<tr><th>${escapeHTML(field.name)}</th><td>${escapeHTML(
        valueText(stored?.value),
      )}</td><td>${stored?.locked ? "已锁定" : ""}</td></tr>`;
    })
    .join("");
  const payload = escapeHTML(JSON.stringify(record));
  return `<!--${RECORD_NOTE_MARKER}--><h1>研究数据库</h1><p>由 Zotero Research Database 插件维护，请在数据库视图中编辑。</p><table><tbody>${rows}</tbody></table><pre data-zrdb-payload="1" style="display:none">${payload}</pre>`;
}

export function parseRecordPayload(payload: unknown): ItemResearchRecord {
  return recordSchema.parse(payload) as ItemResearchRecord;
}

export function parseRecordNote(note: string): ItemResearchRecord {
  return parseRecordPayload(extractPayload(note, RECORD_NOTE_MARKER));
}

export function buildWorkspaceNote(state: WorkspaceState): string {
  const payload = escapeHTML(JSON.stringify(state));
  return `<!--${WORKSPACE_NOTE_MARKER}--><h1>Zotero Research Database 配置</h1><p>字段方案、视图、比较和快照由插件管理。</p><pre data-zrdb-payload="1" style="display:none">${payload}</pre>`;
}

export function parseWorkspacePayload(payload: unknown): WorkspaceState {
  const parsed = workspaceSchema.parse(payload);
  const fields = parsed.fields.map(normalizeFieldDefinition);
  if (parsed.schemaVersion === 10) migrateUntouchedBuiltinPrompts(fields);
  if (!fields.some((field) => field.id === TRANSLATED_TITLE_FIELD_ID)) {
    fields.push(
      createDefaultFields().find(
        (field) => field.id === TRANSLATED_TITLE_FIELD_ID,
      )!,
    );
  }
  return {
    schemaVersion: 14,
    fields,
    // 0.2 views did not have display-column metadata. Upgrade only old
    // workspaces so current data keeps its exact shape for a lossless round
    // trip, while old workspaces receive the new defaults.
    views: parsed.views.map((view) => {
      const current = normalizeView(view, parsed.schemaVersion, fields);
      const normalizedCurrent = {
        ...current,
        // 0.3.15 removed the card renderer. Retain its name and layout while
        // exposing it as a table view.
        mode: "table" as const,
      };
      if (current.id !== "builtin-table") return normalizedCurrent;
      // Upgrade only untouched built-in defaults. Saved views and every
      // manually resized column remain byte-for-byte unchanged.
      if (
        parsed.schemaVersion === 9 &&
        current.layout?.columnWidths?.figureGallery === 280
      ) {
        return {
          ...normalizedCurrent,
          layout: {
            ...current.layout,
            columnWidths: {
              ...current.layout.columnWidths,
              figureGallery: createDefaultLayout().columnWidths.figureGallery,
            },
          },
        };
      }
      if (
        parsed.schemaVersion === 11 &&
        current.layout?.columnWidths?.pdfPreview === 126
      ) {
        return {
          ...normalizedCurrent,
          layout: {
            ...current.layout,
            columnWidths: {
              ...current.layout.columnWidths,
              pdfPreview: createDefaultLayout().columnWidths.pdfPreview,
            },
          },
        };
      }
      return normalizedCurrent;
    }),
    comparisons: parsed.comparisons as WorkspaceState["comparisons"],
    snapshots: parsed.snapshots as WorkspaceState["snapshots"],
    updatedAt: parsed.updatedAt,
  };
}

function normalizeView(
  value: unknown,
  sourceVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14,
  fields: readonly FieldDefinition[],
): WorkspaceState["views"][number] {
  const raw = (value || {}) as Record<string, any>;
  const defaults = createDefaultLayout();
  const rawLayout = (raw.layout || {}) as Record<string, any>;
  const rawOrder = Array.isArray(rawLayout.columnOrder)
    ? rawLayout.columnOrder.map(String)
    : defaults.columnOrder;
  const rawLayoutVisible = Array.isArray(rawLayout.visibleColumnIDs)
    ? rawLayout.visibleColumnIDs.map(String)
    : undefined;
  const rawViewVisible = Array.isArray(raw.visibleColumnIDs)
    ? raw.visibleColumnIDs.map(String)
    : undefined;
  const legacyFieldIDs = Array.isArray(raw.visibleFieldIDs)
    ? raw.visibleFieldIDs.map(String)
    : undefined;
  const fieldIDs = new Set(fields.map((field) => field.id));
  const defaultFieldIDs = fields
    .filter(
      (field) => !field.archived && field.id !== TRANSLATED_TITLE_FIELD_ID,
    )
    .map((field) => field.id);
  // The old table read native visibility from the layout and custom visibility
  // from visibleFieldIDs. Prefer the layout over its redundant view-level copy;
  // an explicit empty list is intentional and must never mean “show all”.
  const nativeVisible = rawLayoutVisible ?? rawViewVisible;
  const rawVisible =
    sourceVersion >= 14
      ? (nativeVisible ?? [...defaults.visibleColumnIDs, ...defaultFieldIDs])
      : nativeVisible?.length === 0
        ? []
        : [
            ...(nativeVisible ?? defaults.visibleColumnIDs).filter(
              (id: string) => !fieldIDs.has(id),
            ),
            ...(legacyFieldIDs ??
              (nativeVisible?.some((id: string) => fieldIDs.has(id))
                ? nativeVisible.filter((id: string) => fieldIDs.has(id))
                : defaultFieldIDs)),
          ];
  const addFigureGallery = sourceVersion === 2;
  const legacyBuiltInHeight =
    raw.id === "builtin-table" &&
    ((sourceVersion <= 6 && Number(rawLayout.rowHeight) === 48) ||
      (sourceVersion === 5 &&
        [160, 260].includes(Number(rawLayout.rowHeight))) ||
      (sourceVersion === 7 && Number(rawLayout.rowHeight) === 320) ||
      (sourceVersion === 8 && Number(rawLayout.rowHeight) === 240));
  const legacyDefaultHeight =
    (sourceVersion < 5 && Number(rawLayout.rowHeight) === 120) ||
    (sourceVersion === 4 && Number(rawLayout.rowHeight) === 160) ||
    legacyBuiltInHeight;
  const rawPinned = Array.isArray(rawLayout.pinnedColumnIDs)
    ? rawLayout.pinnedColumnIDs.map(String)
    : defaults.pinnedColumnIDs;
  const pinnedColumnIDs =
    sourceVersion === 4 &&
    rawPinned.length === 1 &&
    rawPinned[0] === "pdfPreview"
      ? []
      : rawPinned;
  const figureKinds = (value: unknown) =>
    Array.isArray(value)
      ? value
          .map(String)
          .filter((kind) => ["figure", "table", "formula"].includes(kind))
          .map((kind) => kind as FigureKind)
      : undefined;
  const layout = {
    ...defaults,
    ...rawLayout,
    columnOrder:
      addFigureGallery && !rawOrder.includes("figureGallery")
        ? [...rawOrder, "figureGallery"]
        : rawOrder,
    columnWidths: {
      ...defaults.columnWidths,
      ...(rawLayout.columnWidths || {}),
    },
    rowHeight: legacyDefaultHeight
      ? defaults.rowHeight
      : Number(rawLayout.rowHeight) >= 32
        ? Number(rawLayout.rowHeight)
        : defaults.rowHeight,
    rowHeights: { ...(rawLayout.rowHeights || {}) },
    visibleColumnIDs:
      addFigureGallery &&
      rawVisible.length > 0 &&
      !rawVisible.includes("figureGallery")
        ? [...rawVisible, "figureGallery"]
        : rawVisible,
    columnLabels: { ...(rawLayout.columnLabels || {}) },
    cellColors: { ...(rawLayout.cellColors || {}) },
    rowColors: { ...(rawLayout.rowColors || {}) },
    citationStyle: ["zotero", "gbt7714", "apa7", "nature", "ieee"].includes(
      String(rawLayout.citationStyle),
    )
      ? rawLayout.citationStyle
      : defaults.citationStyle,
    pinnedColumnIDs,
  };
  delete (layout as Record<string, unknown>).figureKinds;
  if (sourceVersion < 9 && layout.visibleColumnIDs.includes("basicInfo"))
    layout.visibleColumnIDs = layout.visibleColumnIDs.filter(
      (columnID) => !["creators", "year", "date", "DOI"].includes(columnID),
    );
  return {
    id: String(raw.id || ""),
    name: String(raw.name || "未命名视图"),
    // Card views were removed in 0.3.15. Preserve their layout and expose
    // them as table views instead of discarding the user's saved view.
    mode: "table",
    ...(figureKinds(raw.figureKinds || rawLayout.figureKinds)
      ? { figureKinds: figureKinds(raw.figureKinds || rawLayout.figureKinds) }
      : {}),
    ...(raw.sortBy ? { sortBy: raw.sortBy } : {}),
    ...(raw.groupBy ? { groupBy: raw.groupBy } : {}),
    filterText: String(raw.filterText || ""),
    layout,
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
  };
}

function migrateUntouchedBuiltinPrompts(fields: FieldDefinition[]): void {
  for (const field of fields) {
    const legacy = LEGACY_BUILTIN_FIELD_PROMPTS[field.id];
    const replacement = BUILTIN_FIELD_PROMPTS[field.id];
    if (!legacy || !replacement) continue;
    if (
      field.description !== legacy ||
      field.extraction.instruction !== legacy ||
      field.extraction.templateVersion !== 1
    ) {
      continue;
    }
    field.description = replacement;
    field.extraction.instruction = replacement;
    field.extraction.templateVersion = Math.max(
      2,
      field.extraction.templateVersion,
    );
  }
}

function normalizeFieldDefinition(value: unknown): FieldDefinition {
  const field = value as Record<string, any>;
  const legacy = field.ai || {};
  const extraction = field.extraction || {};
  const allowedTypes = new Set([
    "text",
    "longText",
    "select",
    "multiSelect",
    "number",
    "date",
    "checkbox",
    "rating",
    "url",
  ]);
  return {
    id: String(field.id || ""),
    name: String(field.name || ""),
    description: String(field.description || ""),
    type: allowedTypes.has(field.type) ? field.type : "longText",
    options: Array.isArray(field.options)
      ? field.options.map((entry: unknown) => String(entry))
      : [],
    ...(field.archived ? { archived: true } : {}),
    extraction: {
      enabled: Boolean(extraction.enabled ?? legacy.enabled ?? false),
      instruction: String(
        extraction.instruction ?? legacy.prompt ?? field.description ?? "",
      ),
      ...((extraction.outputLanguage ?? legacy.outputLanguage)
        ? {
            outputLanguage: String(
              extraction.outputLanguage ?? legacy.outputLanguage,
            ),
          }
        : {}),
      templateVersion: Number(
        extraction.templateVersion ?? legacy.templateVersion ?? 1,
      ),
    },
  };
}

export function parseWorkspaceNote(note: string): WorkspaceState {
  return parseWorkspacePayload(extractPayload(note, WORKSPACE_NOTE_MARKER));
}

export function isRecordNote(note: string): boolean {
  return note.includes(RECORD_NOTE_MARKER);
}

export function isWorkspaceNote(note: string): boolean {
  return note.includes(WORKSPACE_NOTE_MARKER);
}
