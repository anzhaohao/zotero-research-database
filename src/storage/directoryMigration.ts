import { mineruFileIO } from "../services/mineruFileIO";
import { config } from "../../package.json";
import {
  getDataRootOrThrow,
  getLegacyDataRoot,
  resetDataRootScope,
  writeJsonAtomic,
} from "./dataRoot";
import { parseLocalPayload } from "./localData";

const PENDING = config.prefsPrefix + ".pendingDirectoryMigration";
type Pair = { source: string; target: string };
export interface DirectoryMigrationPlan {
  schemaVersion: 1;
  pairs: Pair[];
  sourceRoot: string;
  preferences: {
    dataRoot: string;
    artifactStorageRoot: string;
    mineruSharedStoreDirectory: string;
  };
}

function canonical(path: string): string {
  const value = PathUtils.normalize(path)
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return /^(?:[a-z]:|\/\/)/i.test(value) ? value.toLowerCase() : value;
}

function below(path: string, root: string): boolean {
  return canonical(path).startsWith(canonical(root) + "/");
}

function absolute(path: string): string {
  if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path))
    throw new Error("数据目录必须为绝对路径");
  return PathUtils.normalize(path);
}

export function pendingDirectoryMigration():
  DirectoryMigrationPlan | undefined {
  const raw = Zotero.Prefs.get(PENDING, true);
  if (!raw) return undefined;
  const value = JSON.parse(String(raw)) as DirectoryMigrationPlan;
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.pairs) ||
    !value.preferences ||
    typeof value.sourceRoot !== "string"
  )
    throw new Error("目录迁移计划损坏，原目录未切换");
  validatePlan(value);
  return value;
}

function validatePlan(plan: DirectoryMigrationPlan): void {
  absolute(plan.sourceRoot);
  for (const key of [
    "dataRoot",
    "artifactStorageRoot",
    "mineruSharedStoreDirectory",
  ] as const) {
    if (typeof plan.preferences[key] !== "string")
      throw new Error("目录迁移计划损坏");
    if (plan.preferences[key]) absolute(plan.preferences[key]);
  }
  for (const pair of plan.pairs) {
    if (
      !pair ||
      typeof pair.source !== "string" ||
      typeof pair.target !== "string"
    )
      throw new Error("目录迁移计划损坏");
    absolute(pair.source);
    absolute(pair.target);
    if (
      canonical(pair.source) === canonical(pair.target) ||
      below(pair.target, pair.source) ||
      below(pair.source, pair.target)
    )
      throw new Error("新旧数据目录不能互相嵌套，原目录未切换");
    for (const other of plan.pairs) {
      if (pair === other) continue;
      if (
        canonical(pair.source) === canonical(other.source) &&
        canonical(pair.target) !== canonical(other.target)
      )
        throw new Error("同一原目录不能迁移到两个不同目标");
      if (
        canonical(pair.target) === canonical(other.source) ||
        below(pair.target, other.source)
      )
        throw new Error("新目录不能位于其它待迁移的原目录内");
      if (
        canonical(pair.target) === canonical(other.target) &&
        canonical(pair.source) !== canonical(other.source)
      )
        throw new Error("不同原目录不能合并到同一个目标目录");
    }
  }
}

/** Save intent only. Copy at startup, before repositories or background jobs exist. */
export function scheduleDirectoryMigration(input: {
  dataRoot: string;
  artifactStorageRoot: string;
  mineruSharedStoreDirectory: string;
  sourceArtifactRoot: string;
  sourceSharedRoot: string;
}): void {
  const sourceRoot = getDataRootOrThrow();
  const targetRoot = absolute(
    input.dataRoot.trim() || getLegacyDataRoot() || "",
  );
  const targetArtifacts = absolute(
    input.artifactStorageRoot.trim() ||
      PathUtils.join(
        targetRoot,
        "artifacts",
        String(Zotero.Libraries.userLibraryID),
      ),
  );
  const targetShared = absolute(
    input.mineruSharedStoreDirectory.trim() ||
      PathUtils.join(targetRoot, "mineru-shared-store"),
  );
  const pairs = [
    { source: sourceRoot, target: targetRoot },
    { source: input.sourceArtifactRoot, target: targetArtifacts },
    { source: input.sourceSharedRoot, target: targetShared },
  ].filter(
    (pair) => pair.source && canonical(pair.source) !== canonical(pair.target),
  );
  if (!pairs.length) {
    Zotero.Prefs.clear(PENDING, true);
    return;
  }
  const plan: DirectoryMigrationPlan = {
    schemaVersion: 1,
    pairs,
    sourceRoot,
    preferences: {
      dataRoot: input.dataRoot.trim(),
      artifactStorageRoot: input.artifactStorageRoot.trim(),
      mineruSharedStoreDirectory: input.mineruSharedStoreDirectory.trim(),
    },
  };
  validatePlan(plan);
  Zotero.Prefs.set(PENDING, JSON.stringify(plan), true);
}

function remap(path: string, pairs: Pair[]): string {
  if (!/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path)) return path;
  const pair = [...pairs]
    .sort((a, b) => b.source.length - a.source.length)
    .find(
      (pair) =>
        canonical(path) === canonical(pair.source) || below(path, pair.source),
    );
  if (!pair) return path;
  const relative = path
    .replace(/\\/g, "/")
    .slice(pair.source.replace(/[\\/]+$/, "").length)
    .replace(/^\/+/, "");
  return relative
    ? PathUtils.join(pair.target, ...relative.split("/"))
    : pair.target;
}

function remapJSON(value: unknown, pairs: Pair[]): unknown {
  if (typeof value === "string") return remap(value, pairs);
  if (Array.isArray(value))
    return value.map((entry) => remapJSON(entry, pairs));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        remapJSON(entry, pairs),
      ]),
    );
  return value;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(result), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Validated, non-destructive copy; an interrupted copy can be safely retried. */
export async function copyDirectoryMigration(
  plan: DirectoryMigrationPlan,
): Promise<number> {
  validatePlan(plan);
  let copied = 0;
  const visited = new Set<string>();
  const walk = async (source: string, target: string, root: boolean) => {
    if (visited.has(canonical(source) + ">" + canonical(target))) return;
    visited.add(canonical(source) + ">" + canonical(target));
    const nativeFile = Zotero.File?.pathToFile?.(source);
    if (nativeFile?.isSymlink?.())
      throw new Error("迁移目录包含符号链接，未切换：" + source);
    const stat = await mineruFileIO.stat(source);
    if (stat.type === "directory") {
      await mineruFileIO.makeDirectory(target, {
        createAncestors: true,
        ignoreExisting: true,
      });
      for (const child of await mineruFileIO.getChildren(source)) {
        const name = child.split(/[\\/]/).pop()!;
        if (name.endsWith(".tmp") || name.endsWith(".lock")) continue;
        const mapped = remap(child, plan.pairs);
        const legacyDatabase =
          root &&
          canonical(source) === canonical(plan.sourceRoot) &&
          name === "research-data-v1.json";
        // Only the active database filename is copied. A stale alternate must
        // never compete with a newer canonical database for the same target.
        if (
          legacyDatabase &&
          (await mineruFileIO.exists(
            PathUtils.join(source, "database.json"),
          )) &&
          canonical(source) !== canonical(getLegacyDataRoot() || "")
        )
          continue;
        if (
          root &&
          canonical(source) === canonical(plan.sourceRoot) &&
          canonical(source) === canonical(getLegacyDataRoot() || "") &&
          name === "database.json" &&
          (await mineruFileIO.exists(
            PathUtils.join(source, "research-data-v1.json"),
          ))
        )
          continue;
        const database =
          root &&
          canonical(source) === canonical(plan.sourceRoot) &&
          ["research-data-v1.json", "database.json"].includes(name);
        const destination = PathUtils.join(
          target,
          database
            ? plan.preferences.dataRoot
              ? "database.json"
              : "research-data-v1.json"
            : name,
        );
        await walk(
          child,
          mapped !== child && !database ? mapped : destination,
          false,
        );
      }
      return;
    }
    if (stat.type !== "regular")
      throw new Error("迁移遇到不支持的文件类型：" + source);
    const original = await mineruFileIO.read(source);
    let bytes = original;
    const name = source.split(/[\\/]/).pop()!;
    const parent = source
      .slice(0, source.length - name.length)
      .replace(/[\\/]+$/, "");
    const metadata =
      canonical(parent) === canonical(plan.sourceRoot) &&
      [
        "database.json",
        "research-data-v1.json",
        "settings.json",
        "mappings.json",
        "manifest.json",
      ].includes(name);
    if (metadata) {
      const raw = JSON.parse(new TextDecoder().decode(original));
      if (name === "database.json" || name === "research-data-v1.json")
        parseLocalPayload(raw);
      if (
        name === "settings.json" &&
        (raw.schemaVersion !== 1 ||
          !raw.values ||
          Array.isArray(raw.values) ||
          typeof raw.values !== "object")
      )
        throw new Error("研究数据库设置无效，迁移未切换");
      const mapped = remapJSON(raw, plan.pairs);
      if (name === "settings.json")
        (mapped as any).values.mineruSharedStoreDirectory =
          plan.preferences.mineruSharedStoreDirectory;
      if (JSON.stringify(raw) !== JSON.stringify(mapped))
        bytes = new TextEncoder().encode(JSON.stringify(mapped, null, 2));
    }
    const expected = await digest(bytes);
    if (await mineruFileIO.exists(target)) {
      if ((await digest(await mineruFileIO.read(target))) !== expected)
        throw new Error("目标已有不同内容，未覆盖或切换：" + target);
    } else {
      const temporary = target + ".zrdb-migration.tmp";
      try {
        await mineruFileIO.write(temporary, bytes);
        if ((await digest(await mineruFileIO.read(temporary))) !== expected)
          throw new Error("迁移校验失败：" + target);
        await mineruFileIO.move(temporary, target, { noOverwrite: true });
        copied += 1;
      } finally {
        await mineruFileIO.remove(temporary, { ignoreAbsent: true });
      }
    }
    if (
      (await digest(await mineruFileIO.read(source))) !==
      (await digest(original))
    )
      throw new Error("迁移期间源文件被修改，未切换：" + source);
  };
  for (const pair of plan.pairs) {
    if (!(await mineruFileIO.exists(pair.source))) {
      if (canonical(pair.source) === canonical(plan.sourceRoot))
        throw new Error("原研究数据库目录不存在，未切换：" + pair.source);
      continue;
    }
    await walk(pair.source, pair.target, true);
  }
  return copied;
}

/** Run before dataRoot/settings/repository initialization. Sources always remain. */
export async function completeDirectoryMigration(): Promise<
  number | undefined
> {
  const plan = pendingDirectoryMigration();
  if (!plan) return undefined;
  const copied = await copyDirectoryMigration(plan);
  const changed: Array<{ item: Zotero.Item; previous: string }> = [];
  const previousPrefs = Object.fromEntries(
    Object.keys(plan.preferences).map((key) => [
      key,
      Zotero.Prefs.get(config.prefsPrefix + "." + key, true),
    ]),
  );
  let settingsRollback: { path: string; bytes: Uint8Array } | undefined;
  try {
    // Relink existing attachment identities; never create duplicate attachments.
    const items = await Zotero.Items.getAll(
      Zotero.Libraries.userLibraryID,
      false,
    );
    for (const item of items) {
      if (!item.isAttachment()) continue;
      const previous = await item.getFilePathAsync();
      if (!previous) continue;
      const next = remap(previous, plan.pairs);
      if (next === previous) continue;
      if (!(await mineruFileIO.exists(next)))
        throw new Error("迁移后附件缺失：" + next);
      if (
        (await digest(await mineruFileIO.read(previous))) !==
        (await digest(await mineruFileIO.read(next)))
      )
        throw new Error("迁移后附件校验不一致：" + next);
      changed.push({ item, previous });
      await item.relinkAttachmentFile(next);
    }
    const targetRoot = plan.preferences.dataRoot || getLegacyDataRoot()!;
    const settingsPath = PathUtils.join(targetRoot, "settings.json");
    if (await mineruFileIO.exists(settingsPath)) {
      const bytes = await mineruFileIO.read(settingsPath);
      const settings = JSON.parse(new TextDecoder().decode(bytes));
      if (
        settings.schemaVersion !== 1 ||
        !settings.values ||
        typeof settings.values !== "object"
      )
        throw new Error("研究数据库设置无效，迁移未切换");
      if (
        settings.values.mineruSharedStoreDirectory !==
        plan.preferences.mineruSharedStoreDirectory
      ) {
        settingsRollback = { path: settingsPath, bytes };
        settings.values.mineruSharedStoreDirectory =
          plan.preferences.mineruSharedStoreDirectory;
        await writeJsonAtomic(settingsPath, settings);
      }
    }
    for (const [key, value] of Object.entries(plan.preferences))
      Zotero.Prefs.set(config.prefsPrefix + "." + key, value, true);
    Zotero.Prefs.clear(PENDING, true);
    resetDataRootScope();
  } catch (error) {
    if (settingsRollback)
      await mineruFileIO.write(settingsRollback.path, settingsRollback.bytes);
    for (const [key, value] of Object.entries(previousPrefs)) {
      try {
        if (value === undefined)
          Zotero.Prefs.clear(config.prefsPrefix + "." + key, true);
        else
          Zotero.Prefs.set(config.prefsPrefix + "." + key, value as any, true);
      } catch (rollbackError) {
        Zotero.logError(rollbackError as Error);
      }
    }
    for (const { item, previous } of changed.reverse())
      await item
        .relinkAttachmentFile(previous)
        .catch((rollbackError: unknown) =>
          Zotero.logError(
            rollbackError instanceof Error
              ? rollbackError
              : new Error(String(rollbackError)),
          ),
        );
    throw error;
  }
  return copied;
}
