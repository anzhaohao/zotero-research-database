import { useCallback, useEffect, useRef, useState } from "react";
import { config } from "../../../../package.json";
import type { ItemResearchRecord, WorkspaceState } from "../../../domain/types";
import { createEmptyRecord } from "../../../core/records";
import type { ResearchRepository } from "../../../storage/repository";
import { onLocalResearchDataChanged } from "../../../storage/localData";
import { getPref } from "../../../utils/prefs";
import {
  invalidateZoteroFigureCache,
  listZoteroFigures,
  type ZoteroFigureKind,
} from "../../../services/zoteroFigure";
import {
  figureDataSignature,
  isZoteroFigureRecord,
  type FigureRecord,
} from "../figures/figureRecords";
import { mergeCachedMapLoad, planCachedMapLoad } from "./reloadCache";
import { reconcileRows, ReloadQueue } from "./reloadQueue";

interface Context {
  items: Zotero.Item[];
  repository: ResearchRepository;
  workspace?: WorkspaceState;
  activeViewID: string;
  mode: string;
  onWorkspaceChanged?: (state: WorkspaceState) => void;
}

interface Request extends Context {
  state: WorkspaceState;
  refreshFigures: boolean;
  refreshRecords: boolean;
  recordKeys: Set<string>;
  figureKeys: Set<string>;
}

async function mapBounded<T, Result>(
  values: T[],
  load: (value: T) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(values.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, values.length) }, async () => {
      while (index < values.length) {
        const current = index++;
        results[current] = await load(values[current]);
      }
    }),
  );
  return results;
}

function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    )
      return false;
    return left.every((entry, index) => sameData(entry, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  // Repository records are immutable snapshots. Revision + timestamp is the
  // stable identity for a record and avoids serializing every field on reload.
  if (
    typeof a.itemKey === "string" &&
    typeof b.itemKey === "string" &&
    typeof a.revision === "number" &&
    typeof b.revision === "number"
  )
    return (
      a.libraryID === b.libraryID &&
      a.itemKey === b.itemKey &&
      a.revision === b.revision &&
      a.updatedAt === b.updatedAt
    );
  // Figure arrays are normally reference-stable; compare the complete
  // display/source signature when a fresh snapshot materializes them.
  if (
    typeof a.id === "string" &&
    typeof b.id === "string" &&
    ((a as Record<string, unknown>).kind === "figure" ||
      (a as Record<string, unknown>).kind === "table" ||
      isZoteroFigureRecord(a as unknown as FigureRecord))
  )
    return (
      figureDataSignature(a as unknown as FigureRecord) ===
      figureDataSignature(b as unknown as FigureRecord)
    );
  return false;
}

export function useResearchData(context: Context) {
  const [records, setRecords] = useState(new Map<string, ItemResearchRecord>());
  const [figures, setFigures] = useState(new Map<string, FigureRecord[]>());
  const recordsRef = useRef(records);
  const figuresRef = useRef(figures);
  const ownersRef = useRef(new Map<string, number>());
  const contextRef = useRef(context);
  const aliveRef = useRef(true);
  contextRef.current = context;
  recordsRef.current = records;
  figuresRef.current = figures;
  const queueRef = useRef<ReloadQueue<Request> | undefined>(undefined);

  if (!queueRef.current) {
    queueRef.current = new ReloadQueue<Request>(
      (previous, next) => ({
        ...next,
        refreshRecords: previous.refreshRecords || next.refreshRecords,
        refreshFigures: previous.refreshFigures || next.refreshFigures,
        recordKeys: new Set([...previous.recordKeys, ...next.recordKeys]),
        figureKeys: new Set([...previous.figureKeys, ...next.figureKeys]),
      }),
      async (request, isCurrent) => {
        const items = request.items;
        const keys = items.map((item) => item.key);
        const itemByKey = new Map(items.map((item) => [item.key, item]));
        const validCache = <T>(cache: Map<string, T>, dirty: Set<string>) =>
          new Map(
            [...cache].filter(
              ([key]) =>
                !dirty.has(key) &&
                ownersRef.current.get(key) === itemByKey.get(key)?.libraryID,
            ),
          );
        const recordPlan = planCachedMapLoad(
          keys,
          validCache(recordsRef.current, request.recordKeys),
          request.refreshRecords,
        );
        const loadedRecords = await mapBounded(
          recordPlan.missingKeys,
          async (key) => {
            const item = itemByKey.get(key)!;
            return [
              key,
              (await request.repository.loadRecord(item)) ||
                createEmptyRecord(item.libraryID, key),
            ] as const;
          },
        );
        if (!isCurrent() || !aliveRef.current) return;

        const view =
          request.state.views.find(
            (value) => value.id === request.activeViewID,
          ) ||
          request.state.views.find(
            (value) => value.id === `builtin-${request.mode}`,
          );
        const kinds = view?.figureKinds;
        const allowed = new Set<ZoteroFigureKind>(
          kinds ||
            (
              [
                ["figure", "zoteroFigureShowFigures"],
                ["table", "zoteroFigureShowTables"],
                ["formula", "zoteroFigureShowFormulas"],
              ] as const
            )
              .filter(([, pref]) => getPref(pref) !== false)
              .map(([kind]) => kind),
        );
        if (request.refreshFigures || request.figureKeys.size) {
          for (const libraryID of new Set(items.map((item) => item.libraryID)))
            invalidateZoteroFigureCache(libraryID);
        }
        const figurePlan = planCachedMapLoad(
          keys,
          validCache(figuresRef.current, request.figureKeys),
          request.refreshFigures,
        );
        const loadedFigures = await mapBounded(
          figurePlan.missingKeys,
          async (key) => {
            const item = itemByKey.get(key)!;
            try {
              if (getPref("zoteroFigureEnabled") !== false) {
                try {
                  const native = await listZoteroFigures(item, allowed);
                  if (native.length)
                    return [key, native as FigureRecord[]] as const;
                } catch (error) {
                  Zotero.logError(
                    error instanceof Error ? error : new Error(String(error)),
                  );
                }
              }
              const value =
                getPref("mineruFigureFallback") === false
                  ? []
                  : (await request.repository.loadFigures(item)).filter(
                      (figure) => allowed.has(figure.kind),
                    );
              return [key, value as FigureRecord[]] as const;
            } catch (error) {
              Zotero.logError(
                error instanceof Error ? error : new Error(String(error)),
              );
              return [key, [] as FigureRecord[]] as const;
            }
          },
        );
        if (!isCurrent() || !aliveRef.current) return;

        const nextRecords = reconcileRows(
          recordsRef.current,
          mergeCachedMapLoad(keys, recordPlan.cached, new Map(loadedRecords)),
          sameData,
        );
        const nextFigures = reconcileRows(
          figuresRef.current,
          mergeCachedMapLoad(keys, figurePlan.cached, new Map(loadedFigures)),
          sameData,
        );
        recordsRef.current = nextRecords;
        figuresRef.current = nextFigures;
        ownersRef.current = new Map(
          items.map((item) => [item.key, item.libraryID]),
        );
        setRecords(nextRecords);
        setFigures(nextFigures);
      },
    );
  }

  const reloadRecords = useCallback(
    (
      state: WorkspaceState,
      refreshFigures = false,
      refreshRecords = false,
      dirty?: { records?: string[]; figures?: string[] },
    ) => {
      const latest = contextRef.current;
      return queueRef.current!.enqueue({
        ...latest,
        // Capture the current range on every enqueue, never an old callback closure.
        items: [...latest.items],
        state,
        refreshFigures,
        refreshRecords,
        recordKeys: new Set(dirty?.records),
        figureKeys: new Set(dirty?.figures),
      });
    },
    [],
  );

  const requestRefresh = useCallback(
    (
      figures = false,
      records = false,
      dirty?: { records?: string[]; figures?: string[] },
    ) => {
      const workspace = contextRef.current.workspace;
      if (workspace)
        void reloadRecords(workspace, figures, records, dirty).catch(
          (error: unknown) => {
            Zotero.logError(
              error instanceof Error ? error : new Error(String(error)),
            );
          },
        );
    },
    [reloadRecords],
  );

  const range = context.items
    .map((item) => `${item.libraryID}:${item.key}`)
    .join("|");
  useEffect(() => {
    requestRefresh();
  }, [range, context.workspace, requestRefresh]);
  const view =
    context.workspace?.views.find(
      (entry) => entry.id === context.activeViewID,
    ) ||
    context.workspace?.views.find(
      (entry) => entry.id === `builtin-${context.mode}`,
    );
  const figureKinds = JSON.stringify(view?.figureKinds);
  useEffect(() => {
    requestRefresh(true);
  }, [figureKinds, requestRefresh]);

  useEffect(() => {
    aliveRef.current = true;
    const unsubscribe = onLocalResearchDataChanged((change) => {
      const { workspace, items, repository } = contextRef.current;
      if (!workspace) return;
      if (change.itemKey && change.libraryID !== undefined) {
        if (
          !items.some(
            (item) =>
              item.key === change.itemKey &&
              item.libraryID === change.libraryID,
          )
        )
          return;
        requestRefresh(false, false, {
          records: [change.itemKey],
          figures: change.scope === "translated-title" ? [] : [change.itemKey],
        });
      } else {
        // A workspace or complete backup replacement can also change fields/views.
        requestRefresh(true, true);
        void repository
          .loadWorkspace()
          .then((state) => {
            if (aliveRef.current)
              contextRef.current.onWorkspaceChanged?.(state);
          })
          .catch((error: unknown) => {
            Zotero.logError(
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      }
    });
    const ids = [
      "zoteroFigureEnabled",
      "zoteroFigureShowFigures",
      "zoteroFigureShowTables",
      "zoteroFigureShowFormulas",
      "mineruFigureFallback",
      "figureImageQuality",
    ].map((key) =>
      Zotero.Prefs.registerObserver(
        `${config.prefsPrefix}.${key}`,
        () => requestRefresh(true),
        true,
      ),
    );
    return () => {
      aliveRef.current = false;
      queueRef.current?.invalidate();
      unsubscribe();
      ids.forEach((id) => Zotero.Prefs.unregisterObserver(id));
    };
  }, [requestRefresh]);

  return { records, setRecords, figures, setFigures, reloadRecords };
}
