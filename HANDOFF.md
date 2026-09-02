# Zotero Research Database — 当前交接与后续任务

**日期**：2026-09-02
**分支**：`feat/zotero-research-database`
**当前状态**：P0 修复待真实 Zotero 验收；P1 备份/导出与换机导入已实现并通过全部自动验证

### 当前工作区状态

当前工作区存在未提交改动，必须保留，不要回退：

| 文件                              | 状态      | 说明                                                                   |
| --------------------------------- | --------- | ---------------------------------------------------------------------- |
| `src/storage/localData.ts`        | 已修改    | P1 前置基础：快照、替换、导入前 `.bak` 备份、失败恢复                  |
| `src/ui/refreshPolicy.ts`         | 已修改    | P0：识别 Zotero `library` content type                                 |
| `src/ui/viewController.tsx`       | 已修改    | P0：保留 React root，返回文献库后原地刷新；MutationObserver 100ms 节流 |
| `test/startup.test.ts`            | 已修改    | P0 集成测试更新，断言 React root 不被替换                              |
| `test/unit/refreshPolicy.test.ts` | 已修改    | P0 刷新策略测试                                                        |
| `HANDOFF.md`                      | 新增/更新 | 本交接文档                                                             |

本轮 P1 新增文件（已实现并验证）：

- `src/services/backup.ts`：备份服务。导出/导入 ZIP（只含 `research-data-v1.json`、`prefs.json`、`mapping.json`、`manifest.json`）、manifest 含 `formatVersion`/`addonVersion`（config.version）/`generatedAt`/`schemaVersion`/三个数据文件 SHA-256；严格 itemKey → DOI → 标题匹配，歧义不降级，目标重复报冲突；重映射覆盖 `ItemInternalState.libraryID/itemKey`、`record.libraryID/itemKey`、`figures[].parentItemKey`、`comparisons[].itemKeys`、`snapshots[].rows[].itemKey`；导入前 `replaceLocalPayload(..., { backupCurrent: true })` 自动 `.bak` 备份，写入失败回滚内存，有数据但零匹配时拒绝覆盖；`prefs.json` 不导出/不恢复 `artifactImportToken`（且导入时若 ZIP 内含该键直接拒绝）。
- `src/ui/preferencesController.ts`：`bindLocalControls()` 新增 `exportBackup()`/`importBackup()`，用窗口自带 `FilePicker`（modeSave/modeOpen，`*.zip` 过滤器），`IOUtils.write`/`IOUtils.read` 读写 ZIP，导入后刷新设置控件与字段列表。
- `addon/content/preferences.xhtml`：底部保存区上方新增"数据备份"区块和"导出备份"/"导入备份"按钮（`#zrdb-backup-export` / `#zrdb-backup-import`）。
- `test/unit/backup.test.ts`：14 个用例，覆盖 DOI/标题规范化、匹配优先级、歧义不降级、目标冲突、未匹配收集、全部重映射位置、重映射标识冲突、ZIP 往返、缺文件/多文件、checksum 篡改、manifest/schema/凭据拒绝、非 ZIP 输入、四文件契约。

验证结果（2026-09-02 全部通过）：

```text
npm run lint:check   ✔（注意：prettier --write 重排过 localData.ts 等文件的换行，语义不变，git diff 行数变大）
npm run test:unit    ✔ 115 passing（含 backup 14 例）
npx tsc --noEmit     ✔
npm run build        ✔ → .scaffold/build/zotero-research-database.xpi（2026-09-02 11:03）
```

不要执行 `git add`、`git commit` 或 `git push`。用户会在验收后自行决定提交。

---

## 一、P0 修复总结（已完成）

### 根因

Zotero 9 的 `tab/select` Notifier 中，文献标签的内容类型是 **`library`**，不是 `zotero-pane`（后者是 tab ID 前缀，不是类型）。之前的代码用 `selectedType === "zotero-pane"` 判断，导致从阅读器返回时 `libraryTabActive` 永远为 `false`，刷新链路被完全阻断。

### Codex 的修复方案（当前工作区）

**核心思路**：不再重建 React root，而是**保留现有 React 树，用 `scheduleSourceRefresh()` 原地刷新数据**。

| 文件                              | 改动                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/ui/refreshPolicy.ts`         | 新增 `isLibraryTabType(type)`，判断 `type === "library"`                                                                                                                                                                                                                             |
| `src/ui/viewController.tsx`       | ① 所有 `selectedType === "zotero-pane"` 改为 `isLibraryTabType()`；② 删除 `scheduleDatabaseViewReload` / `cancelDatabaseViewReload`（不再重建 root）；③ 从阅读器返回时调用 `scheduleSourceRefresh()` 而非重建；④ 保留 `debugLog` 诊断日志；⑤ ItemTree MutationObserver 加 100ms 节流 |
| `test/unit/refreshPolicy.test.ts` | 新增 `isLibraryTabType` 测试                                                                                                                                                                                                                                                         |
| `test/startup.test.ts`            | 更新集成测试：断言 React root **不被替换**（`assert.equal(controller.root, firstRoot)`），`type` 从 `zotero-pane` 改为 `library`                                                                                                                                                     |

### 关键代码变更

```typescript
// refreshPolicy.ts — 新增
export function isLibraryTabType(type: unknown): boolean {
  return type === "library";
}

// viewController.tsx — 从阅读器返回时
if (this.mode !== "default") this.scheduleSourceRefresh(); // 不再 scheduleDatabaseViewReload()

// ensureLibraryTabIsActive() — 兜底
if (!isLibraryTabType(this.win.Zotero_Tabs.selectedType)) return false;
```

### 验证状态

- [ ] 用户人工验收（安装新 XPI 后测试：双击 PDF → 切回 → 切文件夹）
- [ ] `npm run lint:check`
- [ ] `npm run test:unit`
- [ ] `npm run build`
- [ ] 提交 git（用户确认后）

---

## 二、后续任务清单（按优先级）

### P1：备份/导出功能（已实现，待真实 Zotero 验收）

**需求**：手动导出插件数据 + 配置，方便迁移到另一台电脑。

**真实 Zotero 验收步骤**：

1. 安装 `.scaffold/build/zotero-research-database.xpi`（或 `npm start` 到隔离 Profile）。
2. 设置页 → "数据备份" → "导出备份"，选择路径保存 ZIP；解压确认只有四个文件且 manifest 含 SHA-256。
3. 把 ZIP 复制到另一台电脑（或隔离 Profile），确认文献已由 Zotero 同步（itemKey 可能变化但 DOI/标题一致）。
4. 设置页 → "导入备份"，确认状态栏报告匹配/跳过/歧义数量，且提示 `artifactImportToken` 不恢复。
5. 检查研究属性、锁定、图表记录、视图与比较快照是否迁移到新 key。

**已知限制**：

- 匹配报告只覆盖 mapping.json 中列出的条目；导入报告中的"跳过"指未匹配。
- 附件本体（PDF、MinerU Markdown 等）不走备份，由 Zotero 自身同步/迁移；备份只迁移插件数据与设置。
- 导入按 ZIP 中原样应用 `prefs.json` 里的路径类设置（如 `mineruExecutable`），换机后若路径不同需在设置页手动修正。

**实现细节（与上文契约一致，已完成）**：

**导出内容**：

- `research-data-v1.json`（研究属性、锁定、manifest、主 PDF 指定）
- 插件偏好设置快照
- `mapping.json`（每条记录附带 `itemKey + DOI + 标题`，用于换机后 key 不匹配时的映射修复）

**格式**：单个 `.zip`（用现有 `jszip` 依赖），内含版本号 + 时间戳 + SHA-256 校验。

**导入逻辑**：

- 校验 `schemaVersion`，不兼容拒绝
- 严格按 `itemKey` → DOI → 标题匹配；高优先级产生多个候选时报告歧义，不降级
- 目标条目被重复使用时报告冲突；只导入唯一匹配条目
- 覆盖 item、figure、comparison、snapshot 中的相关 key 引用
- 导入前自动备份当前数据
- 任何写入失败都要回滚研究数据
- 无有效条目匹配时不得覆盖当前数据

**位置**：设置页（`PreferencesController`）加"导出备份"和"导入备份"按钮。

#### P1 已完成的前置基础

`src/storage/localData.ts` 已提供：

- `LocalPayload`
- `parseLocalPayload(value)`
- `getLocalPayloadSnapshot()`
- `replaceLocalPayload(value, { backupCurrent: true })`
- 导入前将当前数据备份为 `research-data-v1.json.bak`
- 持久化失败时恢复内存中的旧 payload

这些改动尚未通过完整 lint、单元测试、类型检查和构建验证。

#### P1 ZIP 契约

ZIP 必须包含且只包含以下四个文件：

```text
research-data-v1.json
prefs.json
mapping.json
manifest.json
```

`manifest.json` 至少包含 `formatVersion`、插件版本 `config.version`、`generatedAt`、`schemaVersion`，以及 `research-data-v1.json`、`prefs.json`、`mapping.json` 三个文件的 SHA-256。导入时必须拒绝缺文件、多余文件、schema 不兼容、manifest 无效或 checksum 不匹配的 ZIP。

`prefs.json` 只导出用户可见的插件设置，不得导出敏感凭据 `artifactImportToken`。导入报告要明确说明该凭据不会恢复，并保留当前机器的值。

#### P1 匹配和重映射细则

当前条目枚举使用 `Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false)`，只保留 `isRegularItem()`，排除工作区系统条目。

- DOI 规范化：去除 `https://doi.org/`、`http://doi.org/`、`doi:` 前缀，去除首尾空白，统一大小写。
- 标题规范化：去除首尾空白，折叠连续空白，统一大小写。
- 每条备份记录按 `itemKey`、DOI、标题依次匹配。
- 某一级出现多个候选时报告歧义，不能降级到下一级。
- 一个当前目标条目不能被多个备份条目重复使用。

旧 key 到新 key 的重映射必须覆盖：

- `ItemInternalState.libraryID/itemKey`
- `record.libraryID/itemKey`
- `figures[].parentItemKey`
- 工作区 comparisons 的 `itemKeys`
- snapshots 的 `rows[].itemKey`

具体字段和嵌套结构以现有类型、codec 和 repository 实现为准。

#### P1 导入事务

导入顺序固定为：完整读取并校验 ZIP → 枚举当前条目并生成匹配报告 → 导入前备份当前研究数据 → 应用重映射后的 payload。任一步写入失败都必须回滚，且没有有效匹配时绝不能覆盖当前数据。

建议新增 `test/unit/backup.test.ts`，覆盖规范化、匹配优先级、歧义、重复目标冲突、所有重映射位置、ZIP 往返、manifest/checksum、非法 ZIP/schema 和无匹配不覆盖。

---

### P2：切换按钮嵌入工具栏（中风险）

**需求**：把悬浮的 HTML button 改成真正的 XUL `toolbarbutton`，嵌入 `#zotero-items-toolbar` 最右侧，与其它插件按钮共存。

**当前实现**（`viewController.tsx:64-84`）：

- `doc.createElementNS("http://www.w3.org/1999/xhtml", "button")` 创建 HTML button
- CSS `position: absolute; left: 270px`（`addon/content/zoteroPane.css:31-49`）悬浮覆盖

**目标实现**：

- `doc.createXULElement("toolbarbutton")` 创建 XUL 按钮
- 插入 `#zotero-items-toolbar` 末尾（`appendChild`）
- 移除绝对定位 CSS，参与工具栏 flex 布局
- 卸载时按 id 精准移除
- 设置项允许用户调整位置（最左/最右）

**风险**：Zotero 9 工具栏是动态布局，需测试与其它插件共存。

---

### P3：Linked File 存储迁移（高风险）

**需求**：把 MinerU Markdown、图表、快照附件从 stored file（`storage/<key>/`）改为 linked file（用户指定根目录下的 `<itemKey>/` 目录）。

**用户决策**（已确认）：

- 使用 Zotero 云同步，但不在乎附件是否同步
- 目录按稳定 `itemKey` 命名
- 条目从回收站彻底删除时，自动删除对应产物目录（不提示）
- 已有附件全部迁移（B 方案）
- 主 PDF 不动，保持 stored file
- 根目录用户可指定
- 文件名冲突自动加后缀（`fig-xxx-2.png`）

**技术要点**：

1. 设置页加"研究产物根目录"路径选择
2. 新附件：写入 `<根目录>/<itemKey>/` → `Zotero.Attachments.linkFromFileWithRelativePath()` 挂载
3. 已有附件迁移：复制文件 → 建 linked file → 校验 SHA-256 → 删旧 stored 附件 → 更新 manifest
4. 去重逻辑改为"目标路径 + SHA-256"判重
5. 条目删除监听：Notifier `item` 的 `delete` 事件，删 `<根目录>/<itemKey>/` 目录（保留非插件文件）
6. 提供"断链检测"和"打开产物目录"按钮

**风险**：修改 Zotero 数据库附件记录（`linkMode` 0→2），必须在隔离 Profile 验证。

---

### P4：条目删除联动删目录（中风险，依赖 P3）

- 监听回收站清空事件
- 删除 `<根目录>/<itemKey>/` 整个目录
- 安全兜底：目录内有非插件文件时，只删插件产物并保留其余（仍不提示）

---

### P5：代码结构优化（中优先级）

- **拆分巨型组件**：`ResearchDatabaseApp.tsx`（5614 行）按域拆分为 `features/table/`、`features/figures/`、`features/agent/`、`features/export/`
- **Service 层依赖注入**：禁止模块级 `new ResearchRepository()`（如 `primaryPdf.ts:3`）
- **类型安全**：补全 `typings/global.d.ts` 中 Zotero 9 新 API 类型，减少 `(Zotero as any)`

---

### P6：性能优化（低优先级）

- `reloadRecords` 增量 diff：只更新变更的 `itemKey`，不全量重建 Map
- PDF 缩略图 LRU 上限 50 张
- `flatRows` 缓存优化

---

## 三、给 CC + K3 的续跑提示词

将下面整段作为新任务提示词发送给 CC + K3：

```text
继续处理当前工作区的 Zotero Research Database 项目。先阅读仓库根目录 HANDOFF.md，再检查 git status 和现有 diff。当前目标只做 P1“数据备份/导出与换机导入”，不要开始 P2。

当前工作区已有未提交改动，必须保留并基于其继续：
- src/storage/localData.ts：已增加 LocalPayload、parseLocalPayload、getLocalPayloadSnapshot、replaceLocalPayload，以及导入前 research-data-v1.json.bak 备份和持久化失败恢复。
- src/ui/refreshPolicy.ts、src/ui/viewController.tsx、test/startup.test.ts、test/unit/refreshPolicy.test.ts：P0 修复，禁止回退。

实施要求：
1. 新增 src/services/backup.ts，复用现有 jszip。ZIP 必须且只能包含 research-data-v1.json、prefs.json、mapping.json、manifest.json。
2. manifest 至少包含 formatVersion、config.version、generatedAt、schemaVersion，以及三个数据文件的 SHA-256。导入严格校验 ZIP、固定文件名、manifest、schema 和 checksum；失败不得部分导入。
3. prefs.json 只导出用户可见插件设置，绝不导出 artifactImportToken。导入报告必须说明凭据不会恢复并保留当前值。
4. mapping.json 为每个可迁移条目保存 itemKey、DOI、标题。当前条目从 Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true, false) 枚举，只保留 isRegularItem()，排除工作区系统条目。
5. 匹配优先级必须严格是 itemKey -> DOI -> 标题。DOI 去除 doi.org/http 前缀和 doi: 前缀后统一大小写；标题折叠连续空白并统一大小写。某一级出现多个候选时报告歧义，不能降级；目标条目被重复使用时报告冲突；只导入唯一匹配条目。
6. 重映射必须覆盖 ItemInternalState.libraryID/itemKey、record.libraryID/itemKey、figures[].parentItemKey、工作区 comparisons.itemKeys、snapshots.rows[].itemKey。先阅读现有类型和 codec/repository 结构，不能凭空重建 payload。
7. 导入顺序必须是：完整读取和校验 ZIP -> 枚举和匹配 -> 导入前备份当前研究数据 -> 原子应用重映射后的 payload。写入任一步失败要回滚，且无有效匹配时绝不能覆盖当前数据。
8. 在 src/ui/preferencesController.ts 的 bindLocalControls() 接入导出/导入按钮，使用现有 addon.data.ztoolkit.FilePicker 约定；在 addon/content/preferences.xhtml 保存区域附近增加“数据备份”区块和两个按钮，沿用当前 UI 风格。
9. 新增 test/unit/backup.test.ts，覆盖 DOI/标题规范化、匹配优先级、歧义、重复目标冲突、所有重映射位置、ZIP 往返、manifest/checksum、非法 ZIP/schema、无匹配不覆盖。
10. 不要调用 azf-auto-dev-loop。手动编辑使用 apply_patch。不要执行 git add、git commit、git push，也不要回退用户已有改动。

完成后依次运行并修复问题：
npm run lint:check
npm run test:unit
npx tsc --noEmit
npm run build

确认 .scaffold/build/zotero-research-database.xpi 存在。最后更新 HANDOFF.md，写明实际改动文件、测试结果、已知限制、真实 Zotero 验收步骤和下一步建议；不要只给方案，必须完成实现和验证。如果某条命令失败，保留失败输出和根因，不要宣称完成。
```

---

## 四、开发环境

```powershell
# 安装依赖
npm install

# 检查
npm run lint:check
npm run test:unit
npx tsc --noEmit

# 构建
npm run build

# 隔离测试（不污染正式库）
$env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH='E:\software\Zotero\Zotero\zotero.exe'
npm test -- --no-watch --abort-on-fail --exit-on-finish
```

**隔离 Profile**：`.scaffold/test`（独立数据目录，用于验证高风险改动）

---

## 五、关键文件索引

| 文件                               | 职责                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| `src/ui/viewController.tsx`        | 主控制器：视图切换、刷新调度、React root 生命周期        |
| `src/ui/ResearchDatabaseApp.tsx`   | 表格组件（5614 行，待拆分）                              |
| `src/ui/refreshPolicy.ts`          | 刷新策略纯函数                                           |
| `src/storage/repository.ts`        | 数据仓库：研究属性、manifest、主 PDF 指定                |
| `src/storage/localData.ts`         | 本机 JSON 存储（Profile 目录）                           |
| `src/services/artifactEndpoint.ts` | 附件导入（当前用 `importFromFile`，P3 改为 linked file） |
| `src/services/mineru.ts`           | MinerU 转换服务                                          |
| `src/services/primaryPdf.ts`       | 主 PDF 解析                                              |
| `addon/content/zoteroPane.css`     | 样式（P2 需修改按钮定位）                                |
| `test/startup.test.ts`             | 集成测试                                                 |
| `test/unit/refreshPolicy.test.ts`  | 单元测试                                                 |

---

## 六、联系与确认

**用户**：An Zhaofeng
**确认方式**：每个 P 阶段完成后，用户在真实 Zotero 窗口验收，确认后再继续下一阶段。

**当前待确认**：P0 修复是否有效（用户需安装新 XPI 测试：双击 PDF → 切回 → 切文件夹）；P1 导出/导入按钮是否在真实 Zotero 设置页正常弹窗、写盘与匹配。
