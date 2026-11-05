import {
  getDataRootOrThrow,
  hasConfiguredDataRoot,
  writeJsonAtomic,
} from "./dataRoot";
import { parseLocalPayload } from "./localData";

const RECOVERY_FILE = "pending-data-recovery.json";
function targetDatabase(): string {
  return PathUtils.join(
    getDataRootOrThrow(),
    hasConfiguredDataRoot() ? "database.json" : "research-data-v1.json",
  );
}
interface RecoveryPlan {
  schemaVersion: 1;
  sourceFile: string;
  sourceHash: string;
  targetFile: string;
  targetHash: string;
  backupFile: string;
}

async function hash(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function validate(bytes: Uint8Array): void {
  parseLocalPayload(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Stage an explicit recovery without touching the running repository's file. */
export async function scheduleDataRecovery(
  sourceFile: string,
  backupFile: string,
): Promise<void> {
  const root = getDataRootOrThrow();
  const targetFile = targetDatabase();
  if (sourceFile === targetFile)
    throw new Error("恢复来源不能是当前数据库本身");
  const source = await IOUtils.read(sourceFile),
    target = await IOUtils.read(targetFile);
  validate(source);
  validate(target);
  if (await IOUtils.exists(backupFile))
    throw new Error("恢复备份文件已存在，请选择新的备份文件名");
  await IOUtils.write(backupFile, target);
  if ((await hash(await IOUtils.read(backupFile))) !== (await hash(target)))
    throw new Error("当前数据库备份校验失败，未安排恢复");
  await writeJsonAtomic(PathUtils.join(root, RECOVERY_FILE), {
    schemaVersion: 1,
    sourceFile,
    sourceHash: await hash(source),
    targetFile,
    targetHash: await hash(target),
    backupFile,
  } satisfies RecoveryPlan);
}

/** Apply before opening repositories; refuse to replace any later user edit. */
export async function completeDataRecovery(): Promise<boolean> {
  const root = getDataRootOrThrow();
  const planPath = PathUtils.join(root, RECOVERY_FILE);
  if (!(await IOUtils.exists(planPath))) return false;
  const plan = JSON.parse(
    new TextDecoder().decode(await IOUtils.read(planPath)),
  ) as RecoveryPlan;
  if (
    plan.schemaVersion !== 1 ||
    plan.targetFile !== targetDatabase() ||
    !/^[a-f0-9]{64}$/.test(plan.sourceHash) ||
    !/^[a-f0-9]{64}$/.test(plan.targetHash)
  )
    throw new Error("数据恢复计划无效，未覆盖当前库");
  const current = await IOUtils.read(plan.targetFile);
  validate(current);
  const currentHash = await hash(current);
  if (currentHash !== plan.sourceHash) {
    if (currentHash !== plan.targetHash)
      throw new Error("安排恢复后当前库已发生变化，已停止恢复以保护最新修改");
    if ((await hash(await IOUtils.read(plan.backupFile))) !== plan.targetHash)
      throw new Error("恢复备份校验失败，未覆盖当前库");
    const source = await IOUtils.read(plan.sourceFile);
    validate(source);
    if ((await hash(source)) !== plan.sourceHash)
      throw new Error("恢复来源已变化，未覆盖当前库");
    const temporary = plan.targetFile + ".recovery.tmp";
    try {
      await IOUtils.write(temporary, source);
      if ((await hash(await IOUtils.read(temporary))) !== plan.sourceHash)
        throw new Error("恢复写入校验失败");
      await (IOUtils as any).move(temporary, plan.targetFile, {
        noOverwrite: false,
      });
      if ((await hash(await IOUtils.read(plan.targetFile))) !== plan.sourceHash)
        throw new Error("恢复结果校验失败");
    } finally {
      await IOUtils.remove(temporary, { ignoreAbsent: true });
    }
  }
  await IOUtils.remove(planPath, { ignoreAbsent: true });
  return true;
}
