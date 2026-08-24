# 用途

Zotero Research Database 为 Zotero 9 增加同一文献管理区域内的数据库表格视图，并用一个按钮在“Zotero 默认列表”和“数据库表格”之间切换。它直接读取当前 Zotero 集合、保存搜索、标签筛选和搜索结果，不复制标题、作者、PDF，也不建立第二套文献库。

表格是 Zotero 条目的动态投影：原生书目字段直接来自条目元数据，自定义研究属性、锁定状态和内部 manifest 保存在 Zotero 配置目录下的插件本机数据文件中。研究属性同时通过 Zotero 9 的 `ItemPaneManager.registerInfoRow()` 注册到原生“信息”面板；插件不使用 Markdown 充当数据库、不建立第二套书目库，也不直接修改 `zotero.sqlite`。

# 页面展示


https://github.com/user-attachments/assets/6557ee54-17b8-49a1-94cf-07163140a8eb





# 当前能力

- Zotero 原生文献工具栏左侧约 `270px` 处只有一个常驻 SVG 切换按钮：默认列表中显示表格图标，数据库表格中显示列表图标；按钮使用固定尺寸与固定锚点，切换时不漂移，也不增加卡片入口。切回默认列表时完整恢复 Zotero 原生界面。
- 当前集合、保存搜索、标签和搜索范围保持一致；自定义视图选中文献后，右侧 Zotero 详情面板同步切换。
- 表格默认以可纵向滚动的 PDF 页面缩略图栈、标题、基础信息和研究属性开头；默认行高为 `270px`，支持筛选、排序、分组、直接拖动表头换序、列宽和单行高度调整。自定义 pane 覆盖中间 Item pane 的原有矩形，不改变左侧集合树或右侧信息栏的布局；横向滚动到底后仍可抓住最右列表头的宽度手柄。
- PDF 预览列默认扩至 `162px`，缩略图以当前预览列可用宽度重新栅格化（默认约 `148px`）。直接拖动“预览”列表头的列宽即可调大或调小缩略图；尺寸按当前保存视图持久化，且 PDF.js 会按新尺寸重渲染，不靠 CSS 放大低分辨率图片。
- “基础信息”组合显示作者、年份、期刊、机构、DOI 和只读期刊分区标签；当它可见时不再重复显示独立作者、年份、日期和 DOI 列，原始 Zotero 元数据不会被删除。插件不再生成或维护 CSL/国标引用控件。
- 当前保存视图可在“字段、列与外部工具 → 字段与列管理”中统一管理：列布局页可勾选原生列和自定义列、重命名表头、临时固定多列，并通过六点拖柄重排列顺序；自定义字段页可新增、编辑、归档和恢复字段及其 Agent 提示词。表头拖动到左右边缘会持续横向滚动，直到离开边缘或释放鼠标；所有设置只写入当前视图或本机字段方案，不修改真实书目元数据。
- 中文论文只显示原标题；外文论文在标题格内提供“翻译成中文”，优先复用已安装的 Translate for Zotero 公共接口，失败时才回退当前 Agent。译文只填充稳定的“中文标题”研究属性并显示在原标题下一行；不占用独立列，也不修改 Zotero 原生标题、`Extra` 或用 `shortTitle` 冒充翻译。
- 单击单元格会选中该格并联动该文献的 Zotero 详情面板；同一文献行中的普通单元格双击均按统一主 PDF 规则打开附件。编辑、完成、取消、复制和填色操作使用线性图标与悬停说明，交互控件会阻止双击冒泡。编辑器在提交时直接读取当前控件值，避免 Zotero 宿主中的 React 输入事件延迟把非空内容保存为空白。
- 默认的研究问题、研究意义、研究价值、主要成果和中文标题会注册为 Zotero 原生“信息”面板属性行，与数据库表格读写同一份数据；字段重命名、增添、归档和恢复会同步更新原生属性行，不再把所有内容堆进“其他”。
- 个人库共享一套自定义属性字典；保存视图只记录显示字段、筛选、排序、分组和布局。
- 支持短文本、长文本、单选、多选、数值、日期、勾选、评分和 URL 字段。
- 默认提供研究问题、研究意义、研究价值、主要成果和中文标题五个研究属性；字段名、说明、提取说明和输出语言均可修改。
- 长文本研究属性在表格中使用显示层段落、编号、项目符号和短标签排版；JSON/Markdown 包装会转换为简洁的可读块。编辑器、复制和本机记录仍保留原始文字，显示整理不会反写数据。
- 人工编辑后自动锁定；外部 Agent 不会覆盖锁定值，手动解锁后才允许更新。
- Zotero 设置中提供本插件页面，可调整默认视图、默认行高、密度、圆角、阴影与动效，并管理自定义字段的名称、类型、说明、提示词、归档和恢复；界面明暗自动跟随 Zotero，不提供独立切换或覆盖设置。
- “字段、列与外部工具”二级菜单保留“Agent、MinerU 与主 PDF”综合入口，并增加“MinerU 转换”快捷入口；快捷入口直接打开综合页面的 MinerU 标签，不新增顶栏按钮。统一页面支持切换 Codex CLI、Claude Code、HanaAgent、本地 Ollama 和直接启动的自定义 JSON Agent；自定义进程只使用标准输入/输出，不经过 Shell，插件也不保存云端 API Key。
- 每次提取会重新读取本机 Agent 设置，不再沿用数据库视图首次打开时的旧配置。参与提取且未被人工锁定的属性格会显示 Apple 风格细圆环，并依次提示读取全文、Agent 处理和保存阶段；成功短暂显示对勾，失败保留警示圆环，悬停可查看完整原因。
- 完整原文仍用于输入哈希和审计；超过 `20,000` 字符时，实际 Agent 输入改为摘要/引言、方法、结果、讨论、结论、正文中段和文末等重点片段。Codex 提取固定使用 `low` 推理，配置的模型名与超时会真实传入进程；旧版 `120000ms` 默认超时会一次性迁移为 `900000ms`。
- MinerU 支持 Desktop、官方网页 API 和 Docker/本地服务三种模式。Desktop 会投递主 PDF 并提示用户在客户端点击一次“立即解析”，随后自动读取 `%USERPROFILE%\MinerU\config.json` 中的历史目录，等待新的 `full.md`、`content_list*.json` 和图片稳定后回传；Docker 模式在本机服务未运行时可自动启动 Docker Desktop 与 `E:\software\DockerProject\MinerU` 的 `mineru-api` Compose 服务。三种模式都会把结果作为 `【MinerU原文】<PDF名称>.md` 存储型附件放到对应条目下，图表写入论文图表 manifest，重复结果按角色与 SHA-256 去重。设置中的“在 Zotero 原生列表隐藏 MinerU 产物”默认勾选，只在本机视图隐藏插件 manifest 标记的 Markdown/图表子附件；取消勾选立即恢复显示，不删除附件或改变同步数据。
- 每篇条目可在统一外部工具页面显式指定主 PDF，选择结果写入该条目的内部同步记录，不改名、不移动也不修改 PDF。未指定时按“附件标题恰好为 `PDF` → Zotero 最佳附件 → 第一个 PDF”的顺序自动选择；首页预览、MinerU 转换和 PDF 全文回退使用同一附件。
- 内容优先读取 Zotero 条目下的 `【MinerU原文】*.md`，缺失时回退到主 PDF 的 Zotero 本地全文。
- 支持动态比较、固定快照、调用外部 Agent 生成综合结论，以及 CSV、XLSX、HTML 和系统打印 PDF 导出。
- 本地导入接口为 `POST /zotero-research-db/v1/artifacts/import`，可接收论文精读工作流验收后的 Markdown；0.4 预览协议还可接收带页码和区域坐标的图表图片，并按图表 ID 与哈希去重。
- 图表清单存在时，画廊按“一行两图”网格显示，图片宽度随列宽变化、高度按原始比例计算，不裁切也不拉伸，并使用轻量 `9px` 圆角；单击继续调用系统图片查看器，双击回到 Zotero PDF 页码或区域。图表列的新默认宽度为 `440px`，旧版未修改的内置 `280px` 默认值会自动迁移，用户保存视图和其它手动宽度保持不变。
- Agent 提取优先接收主 PDF 的短期本机副本路径，供 HanaAgent、Claude Code 或 Codex CLI 在受限只读目录中直接读取；Agent 无法读取 PDF 时自动回退到 Zotero 全文或 MinerU Markdown，扫描 PDF 也可以在没有 Zotero 文本缓存时直接交给视觉/OCR Agent。自定义 JSON Agent 会收到 `pdfPath`、可选 `text`、`images`、字段定义和 Schema；路径只在任务期间有效，不写入研究属性。

# 属性与本机存储模型

- 书目元数据始终直接读取 Zotero 条目，不写入插件属性副本。
- 每篇论文使用独立的本机记录，保存研究属性、人工锁定、最小审计、主 PDF 附件键、图表清单及附件角色。不同论文不会被塞进同一个巨型 JSON，修改一篇也不会重写其它论文。
- 字段方案、保存视图、动态比较和快照保存在同一个本机数据文件；个人库中的 `Zotero Research Database` 系统条目继续作为快照导出附件的 Zotero 父条目。
- 研究属性不进入 Zotero 云同步，也不会显示在手机端；Zotero 原生标题、作者、DOI、标签、PDF 和普通附件仍可照常同步。插件不执行 SQL，不创建私有 sqlite，也不把内部 JSON 显示在条目的“其他”字段中。
- `registerInfoRow()` 只负责原生信息栏显示和编辑，不会伪造 Zotero 服务器不存在的 DOI 同级核心字段；稳定 `fieldID` 负责把可重命名的属性行与真实值关联起来。
- 从旧版本升级时，插件先完整读取旧 `ZRDB.*` Extra、旧子笔记和 0.3.21 的 `zoteroResearchDatabase.*` 同步记录，写入本机文件并回读校验，成功后才删除对应旧行或无效同步键。任何写入或校验失败都会保留原数据，供下次启动安全重试。
- `Citation Key`、JCR/中科院分区、影响因子、手写 `Extra`、其它插件内容和普通文本保持不变；标题、作者、用户标签、DOI、旧研究子笔记、PDF 和图表附件均不清理。
- 插件内部角色、哈希、运行 ID、图表 ID 和快照 ID 不写入 Zotero 标签；升级仍会精确删除旧 `#ZRDB/*` 内部标签，同时保留附件、图表和用户标签。
- Markdown、HTML、CSV、MinerU 与图片等存储型附件依赖 Zotero 文件同步；研究属性和 manifest 属于本机插件数据，不参与 Zotero 云同步。

# Notion 风格交互

- 顶部使用 C「学术工作台」信息结构和 Notion 中性配色；默认列表/表格切换、排列、字段与工具、视图与导出全部使用带 `aria-label` 的线性 SVG 图标，明暗外观直接跟随 Zotero。
- 排序、分组、升降序和统一行高收进“排列”；统一行高使用带 `220/240/270/300/340px` 五个预设节点的线性滑杆，应用后清除当前视图的逐篇行高覆盖。字段、列、多个临时固定列、外部 Agent 和 MinerU 转换收进“字段、列与外部工具”；列拖动仅由六点拖柄启动，并会在表格左右边缘连续横向滚动；固定列仍共享同一列顺序，跨固定边界拖动会同步固定状态。保存/读取视图、比较和四种导出收进“视图与导出”。
- 不同数据行之间使用绘制在行内底部的 `1.5px` 中性灰分割线，保持 `26%` 对比度并避免绝对定位的下一行背景遮住边线；真实最后一行不重复描边，选中和行高拖动提示会在同一位置切换为蓝色。
- 标题格右侧提供低对比度“复制原标题”图标，悬停显示说明、点击后写入系统剪贴板；该入口不依赖 CSL 样式或国标引用服务，复制失败时会显示明确反馈。
- 动效用于说明状态变化，不用于装饰：视图整体淡入并上移 `4px`，时长约 `160ms`。
- 弹窗只做轻微淡入、`4px` 位移和 `0.99 → 1` 缩放，时长约 `170ms`。
- 悬停、选中和保存反馈主要使用中性背景、细边框和轻微阴影；表格虚拟行不做逐行动画。
- 系统开启“减少动态效果”时，GSAP 动画与 CSS 位移过渡自动关闭。

# 安全边界

- 第一版只支持个人库中的普通文献条目。
- 不直接读取或修改 `zotero.sqlite`，也不创建插件私有的第二套书目数据库。
- 系统条目在 Zotero 原生列表中可见，在插件数据库表格中自动排除。
- 插件不保存云端 API Key；Codex 身份验证与模型选择由 Codex 自己管理，Ollama 只连接用户明确配置的本机端点。
- Codex 单次结构化任务沿用已有登录和 provider，可使用设置页指定的模型，固定使用 `low` 推理，并禁用插件、浏览器、电脑控制、多 Agent、Hook 与 Shell 工具；读取 PDF 时只临时开放主 PDF 工作目录的只读访问。
- 外部 Agent 返回值必须通过插件生成的 JSON Schema；进程失败、超时、取消或结果非法时不会写入研究属性。
- 自定义 Agent 必须配置明确的可执行文件和 JSON 参数数组；插件直接创建进程，不接受任意 Shell 命令模板。
- MinerU 官方网页 API Token 只从用户指定的本机环境变量读取（默认 `MINERU_API_TOKEN`），不写入插件偏好或同步数据；本地部署地址只接受 localhost、回环或私有局域网地址。自动启动只允许回环地址，直接运行文件名受限的 `docker.exe` / `Docker Desktop.exe`，Compose 参数固定为 `api` profile、`mineru-api` 和 `--no-build`，不经过 Shell 或用户命令模板。
- 第一版不支持群组库、公式字段、关系字段、OCR 和证据引用。
- Zotero DOM 结构不兼容时，自定义视图停止注入并保留默认列表。

# 本机 Docker MinerU

- 部署目录：`E:\software\DockerProject\MinerU`。
- 当前镜像：`mineru:3.4.4-vllm0.21.0`，包含 MinerU `3.4.4`、vLLM `0.21.0` 和 PyTorch `2.11.0+cu130`。
- API 只绑定 `127.0.0.1:8000`，插件的“本地部署”地址填写 `http://127.0.0.1:8000`。
- 启动命令：`docker compose --profile api up -d --no-build mineru-api`；状态与日志分别使用 `docker compose --profile api ps` 和 `docker compose --profile api logs --tail 200 mineru-api` 检查。
- 插件会先检查 `/health`；不可用时启动 Docker Desktop，再以固定参数启动上述 Compose 服务并等待健康状态。转换优先使用 MinerU 3.x 的同步 `/file_parse` ZIP 协议，遇到不提供该端点的兼容服务时才回退到 `/tasks` 队列协议。
- 2026-08-04 已确认容器健康、RTX 4060 Laptop GPU 可见，并核对 `/tasks`、`/tasks/{id}`、`/tasks/{id}/result` 与 ZIP 结果协议；随后使用正式 Zotero 条目 `A8FHXTDH` 的主 PDF 完成端到端转换，约 25 秒生成 54,263 字符 Markdown 和 14 张带页码、坐标的图表。
- 2026-08-15 再用正式条目 `X9QP2AAG`《空气激光的原理、产生及应用》完成插件内 Docker 自动启动、PDF 上传、Markdown/12 个图表解析、Zotero 导入和重复运行去重闭环。相同 Docker 结果再次转换时附件键没有增加。

# 开发与验证

```powershell
npm install
npm run lint:check
npm run test:unit
$env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH='E:\software\Zotero\Zotero\zotero.exe'
$env:ZOTERO_PDF_TRANSLATE_XPI_PATH='C:\path\to\zoteropdftranslate@euclpts.com.xpi'
npm test -- --no-watch --abort-on-fail --exit-on-finish
npm run build
```

构建产物位于 `.scaffold/build/zotero-research-database.xpi`。开发和验收使用 `.scaffold/test` 独立 Zotero Profile 与 Data 目录，不直接在正式文献库上开发。

2026-08-15 当前验证结果：

- `npm run lint:check` 通过。
- `npm run test:unit`：本轮继续覆盖 Translate for Zotero 回退、MinerU multipart、剪贴板降级、多个固定列和研究长文本显示规范化；集合切换回归通过模拟 Zotero 集合树 DOM 事件验证。
- Zotero 9.0.6 隔离运行测试：本轮覆盖原生列表/数据库视图切换、集合树事件触发的范围刷新、PDF 页面缩略图栈、原标题复制、MinerU 子行隐藏/恢复和本机研究数据。HanaAgent 外部连通测试仅在存在 `server-info.json` 时运行。
- `npx tsc --noEmit` 与 `git diff --check` 通过。
- `0.3.30` 生产 XPI：`.scaffold/build/zotero-research-database.xpi`，`415,369` 字节，SHA-256 `DE98FCCCFB9AB38063F9780D8D02E3A240709565B3BCB4C201863F7C725A5C8F`。
- 正式条目 `X9QP2AAG` 已分别完成 Docker 和 Desktop 闭环。Desktop 0.14.1 需要用户在客户端点击一次“立即解析”，完成后插件会自动回传；相同 Desktop 结果第二次运行没有新增附件。两个后端对同一图表的字节和标题并非总是一致，因此跨后端合并后保留 2 个 Markdown 与 21 个图表产物；manifest、Zotero 附件和实际文件的 23 个 SHA-256 全部一致。
- `0.2.0` 曾在全新隔离 Profile 通过真实 XPI 扫描安装；后续版本使用同一打包链，并持续增加真实 Zotero DOM 与阅读器标签回归覆盖。
- 尚待用户在真实 Zotero 窗口手动确认单按钮位置、表格和列拖动手感；尚未做两个已登录配置之间的真实云同步往返。

# 安装

不要把 XPI 直接复制到 Profile 的 `extensions` 目录。请在 Zotero 中打开“工具 → 附加组件”，从齿轮菜单选择“Install Add-on From File…”，然后选择：

```text
D:\Postgraduate_JilinUniversity\03_Sundries\02_DevLab\20260815-zotero-research-database\.scaffold\build\zotero-research-database.xpi
```

安装后应在附加组件管理器中看到版本 `0.3.30`。如果 Zotero 要求重启，请先保存当前工作再重启；Zotero 原生文献工具栏左侧红框位置随后会出现一个默认列表/数据库表格切换图标。请勿强杀正在运行的 Zotero；正常关闭后再覆盖安装本版。

# 本地导入接口

请求头：

```text
Content-Type: application/json
X-ZRDB-Token: <插件“外部工具”页面中显示的本地令牌>
```

请求体：

```json
{
  "libraryID": 1,
  "parentItemKey": "ABCD1234",
  "workflowRunID": "20260801_example",
  "artifacts": [
    {
      "role": "mineru-original",
      "path": "D:\\output\\【MinerU原文】示例.md",
      "sha256": "64位小写SHA-256",
      "title": "【MinerU原文】示例.md"
    }
  ]
}
```

同一角色和 SHA-256 再次交付时返回 `unchanged`，不会创建重复附件；内容变化时旧附件标记为历史版本。

## 外文标题翻译

- 外文标题优先复用已安装且启用的 Translate for Zotero 2.4.6 公共接口 `Zotero.PDFTranslate.api.translate`，并把返回结果写入插件研究属性 `translated-title`。
- 公共接口不可用、返回空结果或调用失败时，自动回退当前已配置的 Agent；两条路径都不会修改 Zotero 原始标题、`Extra` 或其它书目字段。
- `translated-title` 使用独立的本机持久化入口和变更通知作用域；保存时不调用通用 Extra 迁移或条目保存逻辑，已有值和人工锁定值也不会被覆盖。
