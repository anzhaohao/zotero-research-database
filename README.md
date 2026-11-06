# 用途

Zotero Research Database 为 Zotero 9/10 增加同一文献管理区域内的数据库表格视图，并用一个按钮在“Zotero 默认列表”和“数据库表格”之间切换。它直接读取当前 Zotero 集合、保存搜索、标签筛选和搜索结果，不复制标题、作者、PDF，也不建立第二套文献库。

表格是 Zotero 条目的动态投影：原生书目字段直接来自条目元数据，自定义研究属性、锁定状态和内部 manifest 保存在 Zotero 配置目录下的插件本机数据文件中。研究属性同时通过 Zotero 9 的 `ItemPaneManager.registerInfoRow()` 注册到原生“信息”面板；插件不使用 Markdown 充当数据库、不建立第二套书目库，也不直接修改 `zotero.sqlite`。

# 页面展示
<img width="1920" height="1032" alt="image" src="https://github.com/user-attachments/assets/62894049-daed-4e38-b103-dfa339086ab0" />

https://github.com/user-attachments/assets/6557ee54-17b8-49a1-94cf-07163140a8eb

# 当前能力

- Zotero 原生文献工具栏左侧约 `270px` 处只有一个常驻 SVG 切换按钮：默认列表中显示表格图标，数据库表格中显示列表图标；按钮使用固定尺寸与固定锚点，切换时不漂移，也不增加卡片入口。切回默认列表时完整恢复 Zotero 原生界面。
- 当前集合、保存搜索、标签和搜索范围保持一致；自定义视图选中文献后，右侧 Zotero 详情面板同步切换。
- 表格默认以可纵向滚动的 PDF 页面缩略图栈、标题、基础信息和研究属性开头；默认行高为 `270px`，支持筛选、排序、分组、直接拖动表头换序、列宽和单行高度调整。自定义 pane 覆盖中间 Item pane 的原有矩形，不改变左侧集合树或右侧信息栏的布局；横向滚动到底后仍可抓住最右列表头的宽度手柄。
- PDF 预览列默认扩至 `162px`，缩略图以当前预览列可用宽度重新栅格化（默认约 `148px`）。直接拖动“预览”列表头的列宽即可调大或调小缩略图；尺寸按当前保存视图持久化，且 PDF.js 会按新尺寸重渲染，不靠 CSS 放大低分辨率图片。
- “基础信息”组合显示作者、年份、期刊、机构、DOI 和只读期刊分区标签；当它可见时不再重复显示独立作者、年份、日期和 DOI 列，原始 Zotero 元数据不会被删除。插件不再生成或维护 CSL/国标引用控件。
- 当前保存视图支持通过表头六点拖柄调整列顺序，并可在“字段与工具 → 固定列”中临时固定多列；自定义字段集中在插件设置中管理，可新增、编辑、归档、恢复并配置 Agent 提示词。表头拖动到左右边缘会持续横向滚动，直到离开边缘或释放鼠标；所有设置只写入当前视图或本机字段方案，不修改真实书目元数据。
- 中文论文只显示原标题；外文论文在标题格内提供“翻译成中文”，优先复用已安装的 Translate for Zotero 公共接口，失败时才回退当前 Agent。译文只填充稳定的“中文标题”研究属性并显示在原标题下一行；不占用独立列，也不修改 Zotero 原生标题、`Extra` 或用 `shortTitle` 冒充翻译。
- 单击单元格会选中该格并联动该文献的 Zotero 详情面板；同一文献行中的普通单元格双击均按统一主 PDF 规则打开附件。编辑、完成、取消、复制和填色操作使用线性图标与悬停说明，交互控件会阻止双击冒泡。编辑器在提交时直接读取当前控件值，避免 Zotero 宿主中的 React 输入事件延迟把非空内容保存为空白。
- 默认的研究问题、研究意义、研究价值、主要成果和中文标题会注册为 Zotero 原生“信息”面板属性行，与数据库表格读写同一份数据；字段重命名、增添、归档和恢复会同步更新原生属性行，不再把所有内容堆进“其他”。
- 个人库共享一套自定义属性字典；保存视图只记录显示字段、筛选、排序、分组和布局。
- 支持短文本、长文本、单选、多选、数值、日期、勾选、评分和 URL 字段。
- 默认提供研究问题、研究意义、研究价值、主要成果和中文标题五个研究属性；字段设置保留标题、显隐和 Agent 提示词，自定义字段可归档后恢复。
- 长文本研究属性在表格中使用显示层段落、编号、项目符号和短标签排版；JSON/Markdown 包装会转换为简洁的可读块。编辑器、复制和本机记录仍保留原始文字，显示整理不会反写数据。
- 人工编辑后自动锁定；批量 Agent 提取不会覆盖锁定值，单元格上的“重新生成”按钮可用于显式覆盖当前字段。
- Zotero 设置中提供本插件页面，可调整默认视图、默认行高、密度、圆角、阴影与动效，并统一管理原生列和自定义字段；界面明暗自动跟随 Zotero，不提供独立切换或覆盖设置。
- “字段与工具”二级菜单保留“Agent、MinerU 与主 PDF”综合入口，并增加“MinerU 转换”快捷入口；快捷入口直接打开综合页面的 MinerU 标签，不新增顶栏按钮。统一页面支持 Codex CLI、Claude Code、本地 Ollama、OpenAI 兼容 API 和直接启动的自定义 JSON Agent；自定义进程只使用标准输入/输出，不经过 Shell。
- 每次提取会重新读取本机 Agent 设置，不再沿用数据库视图首次打开时的旧配置。参与提取且未被人工锁定的属性格会显示 Apple 风格细圆环，并依次提示读取全文、Agent 处理和保存阶段；成功短暂显示对勾，失败保留警示圆环，悬停可查看完整原因。
- 完整原文仍用于输入哈希和审计；超过 `20,000` 字符时，实际 Agent 输入改为摘要/引言、方法、结果、讨论、结论、正文中段和文末等重点片段。Codex 与 Claude Code 的模型、思考强度和超时会按当前供应商设置传入进程；旧版 `120000ms` 默认超时会一次性迁移为 `900000ms`。
- MinerU 只保留官方网页 API 和 Docker/self-hosted API 两种模式，不再提供 MinerU Desktop/客户端模式。Docker 模式在本机服务未运行时可自动启动 Docker Desktop 与用户配置的 `mineru-api` Compose 服务；Docker CLI、Docker Desktop、Compose 项目目录和共享产物目录均支持自动检测或手动填写，安装包不携带开发机路径。插件同时兼容 MinerU 4.x（v1 接口 + 质量档）与 3.x（`/file_parse`）服务。两种模式都会把结果作为 `【MinerU原文】<PDF名称>.md` 存储型附件放到对应条目下，图表写入论文图表 manifest，重复结果按角色与 SHA-256 去重。设置中的“在 Zotero 原生列表隐藏 MinerU 产物”默认勾选，只在本机视图隐藏插件 manifest 标记的 Markdown/图表子附件；取消勾选立即恢复显示，不删除附件或改变同步数据。
- Research Database 与 Bilingual Reader 可共用设置中的 MinerU 共享产物目录；未填写时跟随研究数据库目录，也可以指定已有共享目录。产物按 PDF SHA-256 保存，并建立 Zotero 附件索引；转换时优先复用已有 Zotero Markdown 附件和完整共享缓存，同一 PDF 的并发任务通过跨插件文件锁避免重复解析。可选择优先导入 llm-for-zotero 的已有缓存。勾选“重新解析并生成新产物”才会绕过复用并重新调用所选 API：新产物先在暂存目录校验，再覆盖共享缓存，失败时恢复旧版本；Zotero 旧附件保留为历史，新附件成为当前版本。
- 每篇条目可在统一外部工具页面显式指定主 PDF，选择结果写入该条目的内部同步记录，不改名、不移动也不修改 PDF。未指定时按“附件标题恰好为 `PDF` → Zotero 最佳附件 → 第一个 PDF”的顺序自动选择；首页预览、MinerU 转换和 PDF 全文回退使用同一附件。
- 内容优先读取 Zotero 条目下的 `【MinerU原文】*.md`，缺失时回退到主 PDF 的 Zotero 本地全文。
- 支持动态比较、固定快照、调用外部 Agent 生成综合结论，以及 CSV、XLSX、HTML 和系统打印 PDF 导出。
- 本机 CLI 可在“设置 → 外部 Agent → 本机 CLI”中添加或编辑，支持 Codex CLI、Claude Code 和其他非交互 CLI；每项有独立名称、路径与参数，保存后可从“助手类型”选择。原 HTTP 产物回传接口和本地令牌已移除，内置 MinerU 仍通过内部导入流程写入附件。
- 图表清单存在时，画廊按“一行两图”网格显示，图片宽度随列宽变化、高度按原始比例计算，不裁切也不拉伸，并使用轻量 `9px` 圆角；单击继续调用系统图片查看器，双击回到 Zotero PDF 页码或区域。图表列的新默认宽度为 `440px`，旧版未修改的内置 `280px` 默认值会自动迁移，用户保存视图和其它手动宽度保持不变。
- Agent 提取优先接收主 PDF 的短期本机副本路径，供 Claude Code 或 Codex CLI 在受限只读目录中直接读取；Agent 无法读取 PDF 时自动回退到 Zotero 全文或 MinerU Markdown，扫描 PDF 也可以在没有 Zotero 文本缓存时直接交给视觉/OCR Agent。自定义 JSON Agent 会收到 `pdfPath`、可选 `text`、`images`、字段定义和 Schema；路径只在任务期间有效，不写入研究属性。

# 属性与本机存储模型

- 书目元数据始终直接读取 Zotero 条目，不写入插件属性副本。
- 每篇论文使用独立键值记录，保存研究属性、人工锁定、最小审计、主 PDF 附件键、图表清单及附件角色；这些记录集中保存在数据目录的 `database.json`，写入通过队列和原子替换避免并发覆盖。
- 字段方案、保存视图、动态比较和快照保存在同一个本机数据文件；个人库中的 `Zotero Research Database` 系统条目继续作为快照导出附件的 Zotero 父条目。
- 研究属性不进入 Zotero 云同步，也不会显示在手机端；Zotero 原生标题、作者、DOI、标签、PDF 和普通附件仍可照常同步。插件不执行 SQL，不创建私有 sqlite，也不把内部 JSON 显示在条目的“其他”字段中。
- `registerInfoRow()` 只负责原生信息栏显示和编辑，不会伪造 Zotero 服务器不存在的 DOI 同级核心字段；稳定 `fieldID` 负责把可重命名的属性行与真实值关联起来。
- 从旧版本升级时，插件先完整读取旧 `ZRDB.*` Extra、旧子笔记和 0.3.21 的 `zoteroResearchDatabase.*` 同步记录，写入本机文件并回读校验，成功后才删除对应旧行或无效同步键。任何写入或校验失败都会保留原数据，供下次启动安全重试。
- `Citation Key`、JCR/中科院分区、影响因子、手写 `Extra`、其它插件内容和普通文本保持不变；标题、作者、用户标签、DOI、旧研究子笔记、PDF 和图表附件均不清理。
- 插件内部角色、哈希、运行 ID、图表 ID 和快照 ID 不写入 Zotero 标签；升级仍会精确删除旧 `#ZRDB/*` 内部标签，同时保留附件、图表和用户标签。
- Markdown、HTML、CSV、MinerU 与图片等存储型附件依赖 Zotero 文件同步；研究属性和 manifest 属于本机插件数据，不参与 Zotero 云同步。

# Notion 风格交互

- 顶部使用 C「学术工作台」信息结构和 Notion 中性配色；默认列表/表格切换、排列、字段与工具、视图与导出全部使用带 `aria-label` 的线性 SVG 图标，明暗外观直接跟随 Zotero。
- 排序、分组、升降序和统一行高收进“排列”；统一行高使用带 `220/240/270/300/340px` 五个预设节点的线性滑杆，应用后清除当前视图的逐篇行高覆盖。多个临时固定列、外部 Agent 和 MinerU 转换收进“字段与工具”；列拖动仅由六点拖柄启动，并会在表格左右边缘连续横向滚动；固定列仍共享同一列顺序，跨固定边界拖动会同步固定状态。保存/读取视图、比较和四种导出收进“视图与导出”。
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
- Codex 身份验证与模型选择由 Codex 自己管理，Ollama 只连接用户明确配置的本机端点。OpenAI 兼容 API 与 MinerU 的凭据仅保存在本机 Zotero 偏好中，不进入便携设置或备份。
- Codex 单次结构化任务沿用已有登录和 provider，可使用设置页指定的模型和思考强度，并禁用插件、浏览器、电脑控制、多 Agent、Hook 与 Shell 工具；读取 PDF 时只临时开放主 PDF 工作目录的只读访问。
- 外部 Agent 返回值必须通过插件生成的 JSON Schema；进程失败、超时、取消或结果非法时不会写入研究属性。
- 自定义 Agent 必须配置明确的可执行文件和 JSON 参数数组；插件直接创建进程，不接受任意 Shell 命令模板。
- MinerU 官方网页 API Token 可直接保存在本机 Zotero 偏好中，也可从用户指定的环境变量读取（默认 `MINERU_API_TOKEN`），不会进入便携设置、备份或同步数据；本地部署地址只接受 localhost、回环或私有局域网地址。自动启动只允许回环地址，直接运行文件名受限的 `docker.exe` / `Docker Desktop.exe`，Compose 参数固定为 `api` profile、`mineru-api` 和 `--no-build`，不经过 Shell 或用户命令模板。
- 第一版不支持群组库、公式字段、关系字段、OCR 和证据引用。
- Zotero DOM 结构不兼容时，自定义视图停止注入并保留默认列表。

# Docker MinerU（可选的本地部署）

- 在插件设置中填写包含 `compose.yaml` 的 MinerU 项目目录；不同电脑的目录可以不同。
- 当前镜像：`mineru:4.0.2-vllm0.21.0`，包含 MinerU `4.0.2`、vLLM `0.21.0` 和 PyTorch `2.11.0+cu130`。
- API 只绑定 `127.0.0.1:8000`，插件的“本地部署”地址填写 `http://127.0.0.1:8000`。
- 启动命令：`docker compose --profile api up -d --no-build mineru-api`；状态与日志分别使用 `docker compose --profile api ps` 和 `docker compose --profile api logs --tail 200 mineru-api` 检查。
- 启动命令需要镜像已存在（首次先 `docker compose --profile api build`）；插件以 `--no-build` 启动，不会在转换时触发构建。
- 健康检查先请求 `/v1/health`（MinerU 4.x），404 时回退 `/health`（3.x）；服务不可用时先启动 Docker Desktop，再以固定参数启动上述 Compose 服务并等待健康状态。
- 转换优先走 MinerU 4.x 的 v1 接口：`POST /v1/uploads` 建上传 → `PUT .../content` 传字节 → `POST .../complete` 取 `file_id` → `POST /v1/parse/jobs` 建任务（带 `tier`）→ 轮询 `GET /v1/parse/jobs/{id}` → `GET /v1/files/{file_id}/content` 下载结果 ZIP。端点对 `/v1/uploads` 明确返回 404/405 时才回退到 3.x 的同步 `/file_parse` ZIP 协议，再回退 `/tasks` 队列协议。
- 已在隔离 Zotero Profile 中验证容器健康、上传、Markdown/图表解析、Zotero 导入和重复运行去重；不同电脑需要按本机 Docker 和 MinerU 项目位置配置。

# 开发与验证

```powershell
npm install
npm run lint:check
npm run test:unit
$env:ZOTERO_PLUGIN_ZOTERO_BIN_PATH='C:\path\to\zotero.exe'
$env:ZOTERO_PDF_TRANSLATE_XPI_PATH='C:\path\to\zoteropdftranslate@euclpts.com.xpi'
npm test -- --no-watch --abort-on-fail --exit-on-finish
npm run build
```

构建临时产物位于 `.scaffold/build/zotero-research-database.xpi`；`npm run build` 会自动将可交付 XPI 同步到根目录 `release/zotero-research-database.xpi`。历史 XPI 统一放在 `release/archive/`。开发和验收使用 `.scaffold/test` 独立 Zotero Profile 与 Data 目录，不直接在正式文献库上开发。

2026-11-02 当前验证结果：

- `npm run lint:check`、`npx tsc --noEmit` 与 `git diff --check` 通过。
- `npm run test:unit`：261 项通过，覆盖 MinerU 共享缓存、OpenAI 兼容 Agent、设置持久化、公式渲染、记录更新与有界缓存。
- Zotero 10 隔离运行测试：27 项通过，覆盖原生列表/数据库视图切换、MinerU 产物隐藏/恢复、PDF 缩略图、列宽拖动、集合刷新和记录/产物刷新隔离；未配置的外部服务连通测试保持跳过。
- `0.3.39` 生产 XPI：`release/zotero-research-database.xpi`，`899,708` 字节，SHA-256 `7A9C4EB1ED58ECDA4285C8ABEAED2D8F666ADA77A1805767BF4AAF5497D69363`。
- 尚未做两个已登录配置之间的真实云同步往返；超大集合首次打开和整份 JSON 原子重写仍是后续性能优化重点。

# 安装

不要把 XPI 直接复制到 Profile 的 `extensions` 目录。请在 Zotero 中打开“工具 → 附加组件”，从齿轮菜单选择“Install Add-on From File…”，然后选择：

```text
<repository-root>\release\zotero-research-database.xpi
```

安装后应在附加组件管理器中看到版本 `0.3.45`。如果 Zotero 要求重启，请先保存当前工作再重启；Zotero 原生文献工具栏左侧红框位置随后会出现一个默认列表/数据库表格切换图标。请勿强杀正在运行的 Zotero；正常关闭后再覆盖安装本版。

# 本机 CLI 配置与换机

- 打开“设置 → 外部 Agent → 本机 CLI → 添加本机 CLI”，填写名称、调用方式和程序位置，也可点击“选择程序”。点击“保存到助手”后进入“助手类型”列表并选中；“编辑当前 CLI”更新原助手。供应商分别保存各助手的模型、思考强度与并发数；API 的地址、密钥与协议也按供应商与助手恢复。
- 点击“自动查找 Codex / Claude Code”会搜索 PATH、常见安装目录和 Codex Desktop 工具目录，将找到的原生程序添加到助手类型；不依赖 npm。也可手动选择程序。应先在该电脑安装并登录。
- 所有调用方式均提供“拉取上游模型”。Codex 使用 app-server 的 model/list；Claude Code 读取本机设置中的上游 API 模型接口，只有 OAuth 登录而无模型枚举凭据时会显示说明，可继续手填模型。其他 CLI 可在编辑器填写模型查询参数，输出 data / models 数组；无法枚举的 CLI 仍可手动输入模型。
- “其他 CLI · 提示词模式”要求程序支持非交互调用并输出 JSON。默认通过标准输入传入提示词和 JSON Schema；通过参数传入时使用 `{prompt}`，例如 `["--print", "{prompt}"]`。另支持 `{model}`、`{effort}` 和 `{schema}`；所有替换保持为字面参数，不执行 Shell 或展开环境变量。
- “其他 CLI · JSON 协议”保留兼容的自定义程序方式：标准输入是包含 `task`、`prompt`、`schema` 等字段的 JSON，标准输出仅返回结果 JSON。`probe` 请求返回 `{"ok":true}`，提取任务返回 Schema 规定的字段对象；若配置模型和思考强度，请求也包含 `model` 与 `reasoningEffort`。
- 保存路径不等于模型连接已通过。保存后使用“检查助手”验证；不能非交互输出、只提供 TUI 或不返回兼容 JSON 的 CLI 需要自行提供适配脚本，不能仅填路径就保证可用。
- 完整论文建议使用标准输入，避免命令行参数长度限制。脚本型 CLI 应填写解释器的程序路径（如 Node 或 Python），再将脚本路径放入启动参数；Windows 的 `.cmd` / `.ps1` 启动器不能当作原生可执行程序直接运行。
- 新电脑应重新安装、登录 CLI，再选择或填写本机路径。CLI 登录状态、供应商凭据和本地代理服务不由插件自动迁移。

## 外文标题翻译

- 外文标题优先复用已安装且启用的 Translate for Zotero 2.4.6 公共接口 `Zotero.PDFTranslate.api.translate`，并把返回结果写入插件研究属性 `translated-title`。
- 公共接口不可用、返回空结果或调用失败时，自动回退当前已配置的 Agent；两条路径都不会修改 Zotero 原始标题、`Extra` 或其它书目字段。
- `translated-title` 使用独立的本机持久化入口和变更通知作用域；保存时不调用通用 Extra 迁移或条目保存逻辑，已有值和人工锁定值也不会被覆盖。

## MinerU 产物路径

- 新结果保留论文 SHA-256 目录，临时目录使用 papers/.tmp-随机ID。图片统一保存为 images/内容SHA-256.扩展名；parse.json 保留原始名称，Markdown 和图表清单同步引用新名称，历史产物继续兼容。
- 文件读写、复制、移动、删除及目录迁移统一处理 Windows 长路径，特殊前缀只存在于实际文件操作。导入前检查文件名与图片引用，完整暂存并校验后替换，写入或索引失败回滚旧结果。
- 当共享产物路径超过 Zotero 10 可稳定回读的长度时，插件仍把源文件保存在研究产物目录，但会先复制到短临时路径并导入 Zotero storage；短路径继续使用 linked file。manifest 始终保存共享目录中的相对路径和 SHA-256，因此备份、迁移和图片预览都能继续使用共享源文件。
- 文献处理使用可移动、可缩放的普通独立窗口；关闭运行中的窗口会请求取消并等待，Zotero 导入阶段等待完成。队列按实际成功、失败和取消数量显示结果与具体错误。
