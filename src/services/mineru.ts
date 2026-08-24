import JSZip, { type JSZipObject } from "jszip";
import { importArtifacts } from "./artifactEndpoint";
import { sha256Text } from "./contentSource";
import { resolvePrimaryPdf } from "./primaryPdf";
import { getPref, setPref } from "../utils/prefs";

const SUBPROCESS_MODULE = "resource://gre/modules/Subprocess.sys.mjs";
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const MINERU_SETTINGS_VERSION = 2;
const MINERU_DESKTOP_PATH = "E:\\software\\MinerU\\MinerU.exe";
const MINERU_DOCKER_PROJECT_PATH = "E:\\software\\DockerProject\\MinerU";
const DOCKER_EXECUTABLE_PATH =
  "E:\\software\\docker\\resources\\bin\\docker.exe";
const DOCKER_DESKTOP_PATH = "E:\\software\\docker\\Docker Desktop.exe";
const DOCKER_START_TIMEOUT_MS = 4 * 60 * 1000;

interface ProcessHandle {
  stdin: { close(): Promise<unknown> };
  stdout: { readString(): Promise<string> };
  stderr?: { readString(): Promise<string> };
  wait(): Promise<{ exitCode: number }>;
  kill(timeout?: number): Promise<{ exitCode: number }>;
}

interface SubprocessAPI {
  call(options: {
    command: string;
    arguments?: string[];
    environmentAppend?: boolean;
    stderr?: "ignore" | "stdout" | "pipe";
    workdir?: string;
  }): Promise<ProcessHandle>;
  pathSearch(command: string): Promise<string>;
}

interface DesktopDirectorySnapshot {
  path: string;
  lastModified: number;
}

export type MinerUMode = "local-client" | "official-api" | "self-hosted";

export interface MinerUProfile {
  mode: MinerUMode;
  executable: string;
  args: string[];
  desktopOutputDirectory: string;
  officialEndpoint: string;
  officialTokenEnvironment: string;
  selfHostedEndpoint: string;
  selfHostedAutoStart: boolean;
  selfHostedProjectDirectory: string;
  dockerExecutable: string;
  dockerDesktopExecutable: string;
  backend: string;
  method: "auto" | "txt" | "ocr";
  modelVersion: "pipeline" | "vlm";
  language: string;
  enableFormula: boolean;
  enableTable: boolean;
  timeoutMs: number;
}

export interface MinerUProgress {
  itemKey: string;
  state: "running" | "success" | "failed" | "cancelled";
  message: string;
}

export interface MinerUParsedFigure {
  id: string;
  kind: "figure" | "table";
  caption: string;
  pageIndex: number;
  rect?: { x: number; y: number; width: number; height: number };
  imageName: string;
  bytes: Uint8Array;
}

export interface MinerUConversionResult {
  markdown: string;
  figures: MinerUParsedFigure[];
}

export interface MinerUSettingsInput {
  mode: unknown;
  executable: unknown;
  args: unknown;
  desktopOutputDirectory?: unknown;
  officialEndpoint: unknown;
  officialTokenEnvironment: unknown;
  selfHostedEndpoint: unknown;
  selfHostedAutoStart?: unknown;
  selfHostedProjectDirectory?: unknown;
  dockerExecutable?: unknown;
  dockerDesktopExecutable?: unknown;
  backend: unknown;
  method: unknown;
  modelVersion: unknown;
  language: unknown;
  enableFormula: unknown;
  enableTable: unknown;
  timeoutMs: unknown;
}

export function parseMinerUProfile(input: MinerUSettingsInput): MinerUProfile {
  const mode = ["local-client", "official-api", "self-hosted"].includes(
    String(input.mode),
  )
    ? (String(input.mode) as MinerUMode)
    : "local-client";
  const rawArgs = String(input.args || "").trim();
  let args: string[] = [];
  if (rawArgs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch (error) {
      throw new Error(
        'MinerU 参数必须是 JSON 字符串数组，例如 ["--lang","ch"]',
        {
          cause: error,
        },
      );
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((entry) => typeof entry !== "string")
    ) {
      throw new Error("MinerU 参数必须是 JSON 字符串数组");
    }
    args = parsed;
  }
  const method = ["auto", "txt", "ocr"].includes(String(input.method))
    ? (String(input.method) as MinerUProfile["method"])
    : "auto";
  const modelVersion =
    String(input.modelVersion) === "pipeline" ? "pipeline" : "vlm";
  const timeout = Number(input.timeoutMs);
  const officialEndpoint = normalizeEndpoint(
    String(input.officialEndpoint || ""),
  );
  if (
    mode === "official-api" &&
    (!officialEndpoint || !officialEndpoint.startsWith("https://"))
  ) {
    throw new Error("MinerU 网页 API 必须使用 HTTPS");
  }
  const selfHostedEndpoint = normalizeEndpoint(
    String(input.selfHostedEndpoint || "http://127.0.0.1:8000"),
  );
  if (!isPrivateEndpoint(selfHostedEndpoint)) {
    throw new Error("本地部署地址必须是 localhost、回环地址或局域网地址");
  }
  return {
    mode,
    executable:
      String(input.executable || MINERU_DESKTOP_PATH).trim() ||
      MINERU_DESKTOP_PATH,
    args,
    desktopOutputDirectory: String(input.desktopOutputDirectory || "").trim(),
    officialEndpoint,
    officialTokenEnvironment:
      String(input.officialTokenEnvironment || "MINERU_API_TOKEN").trim() ||
      "MINERU_API_TOKEN",
    selfHostedEndpoint,
    selfHostedAutoStart:
      input.selfHostedAutoStart === undefined
        ? true
        : Boolean(input.selfHostedAutoStart),
    selfHostedProjectDirectory:
      String(
        input.selfHostedProjectDirectory || MINERU_DOCKER_PROJECT_PATH,
      ).trim() || MINERU_DOCKER_PROJECT_PATH,
    dockerExecutable:
      String(input.dockerExecutable || DOCKER_EXECUTABLE_PATH).trim() ||
      DOCKER_EXECUTABLE_PATH,
    dockerDesktopExecutable:
      String(input.dockerDesktopExecutable || DOCKER_DESKTOP_PATH).trim() ||
      DOCKER_DESKTOP_PATH,
    backend: String(input.backend || "pipeline").trim() || "pipeline",
    method,
    modelVersion,
    language: String(input.language || "ch").trim() || "ch",
    enableFormula: Boolean(input.enableFormula),
    enableTable: Boolean(input.enableTable),
    timeoutMs:
      Number.isFinite(timeout) && timeout >= 10_000
        ? timeout
        : DEFAULT_TIMEOUT_MS,
  };
}

export function readMinerUProfile(): MinerUProfile {
  return parseMinerUProfile({
    mode: getPref("mineruMode"),
    executable: getPref("mineruExecutable"),
    args: getPref("mineruArgs"),
    desktopOutputDirectory: getPref("mineruDesktopOutputDirectory"),
    officialEndpoint: getPref("mineruOfficialEndpoint"),
    officialTokenEnvironment: getPref("mineruOfficialTokenEnvironment"),
    selfHostedEndpoint: getPref("mineruSelfHostedEndpoint"),
    selfHostedAutoStart: getPref("mineruSelfHostedAutoStart"),
    selfHostedProjectDirectory: getPref("mineruSelfHostedProjectDirectory"),
    dockerExecutable: getPref("mineruDockerExecutable"),
    dockerDesktopExecutable: getPref("mineruDockerDesktopExecutable"),
    backend: getPref("mineruBackend"),
    method: getPref("mineruMethod"),
    modelVersion: getPref("mineruModelVersion"),
    language: getPref("mineruLanguage"),
    enableFormula: getPref("mineruEnableFormula"),
    enableTable: getPref("mineruEnableTable"),
    timeoutMs: getPref("mineruTimeoutMs"),
  });
}

export function saveMinerUProfile(profile: MinerUProfile): void {
  setPref("mineruMode", profile.mode);
  setPref("mineruExecutable", profile.executable);
  setPref("mineruArgs", JSON.stringify(profile.args));
  setPref("mineruDesktopOutputDirectory", profile.desktopOutputDirectory);
  setPref("mineruOfficialEndpoint", profile.officialEndpoint);
  setPref("mineruOfficialTokenEnvironment", profile.officialTokenEnvironment);
  setPref("mineruSelfHostedEndpoint", profile.selfHostedEndpoint);
  setPref("mineruSelfHostedAutoStart", profile.selfHostedAutoStart);
  setPref(
    "mineruSelfHostedProjectDirectory",
    profile.selfHostedProjectDirectory,
  );
  setPref("mineruDockerExecutable", profile.dockerExecutable);
  setPref("mineruDockerDesktopExecutable", profile.dockerDesktopExecutable);
  setPref("mineruBackend", profile.backend);
  setPref("mineruMethod", profile.method);
  setPref("mineruModelVersion", profile.modelVersion);
  setPref("mineruLanguage", profile.language);
  setPref("mineruEnableFormula", profile.enableFormula);
  setPref("mineruEnableTable", profile.enableTable);
  setPref("mineruTimeoutMs", profile.timeoutMs);
}

/** Upgrade only untouched local defaults; never alter Zotero workspace data. */
export function migrateMinerUPreferences(): void {
  const version = Number(getPref("mineruSettingsVersion") || 0);
  if (version >= MINERU_SETTINGS_VERSION) return;
  if (String(getPref("mineruExecutable") || "") === "mineru")
    setPref("mineruExecutable", MINERU_DESKTOP_PATH);
  if (
    String(getPref("mineruMode") || "local-client") !== "official-api" &&
    String(getPref("mineruOfficialEndpoint") || "") ===
      "https://mineru.net/api/v4"
  )
    setPref("mineruOfficialEndpoint", "");
  if (version < 2) {
    if (!String(getPref("mineruSelfHostedProjectDirectory") || "").trim())
      setPref("mineruSelfHostedProjectDirectory", MINERU_DOCKER_PROJECT_PATH);
    if (!String(getPref("mineruDockerExecutable") || "").trim())
      setPref("mineruDockerExecutable", DOCKER_EXECUTABLE_PATH);
    if (!String(getPref("mineruDockerDesktopExecutable") || "").trim())
      setPref("mineruDockerDesktopExecutable", DOCKER_DESKTOP_PATH);
  }
  setPref("mineruSettingsVersion", MINERU_SETTINGS_VERSION);
}

export class MinerUConversionService {
  private cancelled = false;
  private running?: ProcessHandle;
  private controller?: AbortController;

  constructor(private profile: MinerUProfile) {}

  cancel(): void {
    this.cancelled = true;
    this.controller?.abort();
    if (this.running) void this.running.kill(800);
  }

  async run(
    items: Zotero.Item[],
    onProgress: (progress: MinerUProgress) => void,
  ): Promise<void> {
    this.cancelled = false;
    for (const item of items) {
      if (this.cancelled) {
        onProgress({
          itemKey: item.key,
          state: "cancelled",
          message: "已取消",
        });
        continue;
      }
      const directory = PathUtils.join(
        PathUtils.tempDir,
        `zrdb-mineru-${item.key}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      try {
        const resolution = await resolvePrimaryPdf(item);
        if (!resolution) throw new Error("条目下没有可用的主 PDF");
        const pdf = resolution.attachment;
        const pdfPath = await pdf.getFilePathAsync();
        if (!pdfPath) throw new Error("主 PDF 文件不在本机，无法转换");
        onProgress({
          itemKey: item.key,
          state: "running",
          message:
            this.profile.mode === "local-client" &&
            isMinerUDesktop(this.profile)
              ? "正在投递主 PDF 到 MinerU Desktop"
              : `正在转换主 PDF（${modeLabel(this.profile.mode)}）`,
        });
        await IOUtils.makeDirectory(directory, { ignoreExisting: true });
        const result = await this.convert(
          pdfPath,
          directory,
          item.key,
          (message) =>
            onProgress({ itemKey: item.key, state: "running", message }),
        );
        if (!result.markdown.trim())
          throw new Error("MinerU 没有生成 Markdown");
        const baseName = safeBaseName(pdfPath);
        const title = `【MinerU原文】${baseName}.md`;
        const markdownPath = PathUtils.join(directory, title);
        await IOUtils.writeUTF8(markdownPath, result.markdown);
        const figureArtifacts = [];
        for (const figure of result.figures) {
          const extension = safeImageExtension(figure.imageName);
          const imageHash = await sha256Bytes(figure.bytes);
          const imagePath = PathUtils.join(
            directory,
            `${figure.kind}-${imageHash.slice(0, 16)}${extension}`,
          );
          await (IOUtils as any).write(imagePath, figure.bytes);
          figureArtifacts.push({
            role: figure.kind,
            path: imagePath,
            sha256: imageHash,
            title:
              figure.caption.trim() ||
              `${figure.kind === "table" ? "表格" : "图"} · 第 ${figure.pageIndex + 1} 页`,
            figure: {
              id: figure.id,
              caption: figure.caption,
              pageIndex: figure.pageIndex,
              rect: figure.rect,
              sourcePdfAttachmentKey: pdf.key,
            },
          } as const);
        }
        onProgress({
          itemKey: item.key,
          state: "running",
          message: "正在导入 Zotero 条目",
        });
        await importArtifacts({
          libraryID: item.libraryID,
          parentItemKey: item.key,
          workflowRunID: `mineru-${Date.now()}-${item.key}`,
          artifacts: [
            {
              role: "mineru-original",
              path: markdownPath,
              sha256: await sha256Text(result.markdown),
              title,
            },
            ...figureArtifacts,
          ],
        });
        onProgress({
          itemKey: item.key,
          state: "success",
          message: `${title} 与 ${result.figures.length} 个图表已导入条目`,
        });
      } catch (error) {
        onProgress({
          itemKey: item.key,
          state: this.cancelled ? "cancelled" : "failed",
          message: this.cancelled
            ? "已取消，未导入"
            : error instanceof Error
              ? error.message
              : String(error),
        });
      } finally {
        await IOUtils.remove(directory, {
          recursive: true,
          ignoreAbsent: true,
        });
      }
    }
  }

  async probe(): Promise<string> {
    if (this.profile.mode === "local-client") {
      const executable = await this.resolveExecutable();
      if (isMinerUDesktop(this.profile)) {
        const outputDirectory = await this.resolveDesktopOutputDirectory();
        return `MinerU Desktop：${executable}；自动监听 ${outputDirectory}`;
      }
      const output = await this.runProcess(
        executable,
        ["--version"],
        PathUtils.tempDir,
      );
      return output.trim() || executable;
    }
    if (this.profile.mode === "self-hosted") {
      await this.ensureSelfHostedReady();
      return `MinerU 本地服务 ${this.profile.selfHostedEndpoint}`;
    }
    const endpoint = this.profile.officialEndpoint;
    const url =
      this.profile.mode === "official-api"
        ? `${endpoint}/extract/task/invalid-zrdb-connection-test`
        : `${endpoint}/health`;
    const headers =
      this.profile.mode === "official-api" ? this.officialHeaders() : {};
    const response = await fetch(url, { headers });
    if (this.profile.mode === "official-api") {
      if ([401, 403].includes(response.status))
        throw new Error("MinerU Token 无效");
      return `MinerU 网页 API（HTTP ${response.status}，认证已通过）`;
    }
    if (!response.ok)
      throw new Error(`MinerU 本地服务连接失败：HTTP ${response.status}`);
    return `MinerU 本地服务 ${endpoint}`;
  }

  private async convert(
    pdfPath: string,
    directory: string,
    itemKey: string,
    onStatus: (message: string) => void,
  ): Promise<MinerUConversionResult> {
    if (this.profile.mode === "local-client") {
      if (isMinerUDesktop(this.profile))
        return this.convertWithDesktop(pdfPath, onStatus);
      return this.convertWithLocalClient(pdfPath, directory);
    }
    if (this.profile.mode === "official-api") {
      return this.convertWithOfficialApi(pdfPath, itemKey);
    }
    await this.ensureSelfHostedReady(onStatus);
    return this.convertWithSelfHosted(pdfPath);
  }

  private async convertWithDesktop(
    pdfPath: string,
    onStatus: (message: string) => void,
  ): Promise<MinerUConversionResult> {
    const outputDirectory = await this.resolveDesktopOutputDirectory();
    await IOUtils.makeDirectory(outputDirectory, { ignoreExisting: true });
    const baseline = await desktopDirectorySnapshot(outputDirectory);
    await this.openWithDesktop(pdfPath);
    onStatus(
      "已打开 MinerU Desktop；请在客户端点击“立即解析”，完成后将自动回传",
    );
    const resultDirectory = await waitForDesktopResultDirectory({
      outputDirectory,
      pdfFileName: PathUtils.filename(pdfPath),
      baseline,
      timeoutMs: this.profile.timeoutMs,
      cancelled: () => this.cancelled,
    });
    onStatus("已检测到 Desktop 结果；正在读取 Markdown 与图表");
    return mineruResultFromDirectory(resultDirectory, safeBaseName(pdfPath));
  }

  private async resolveDesktopOutputDirectory(): Promise<string> {
    if (this.profile.desktopOutputDirectory)
      return this.profile.desktopOutputDirectory;
    const root = defaultMinerUHomeDirectory();
    if (!root)
      throw new Error(
        "无法确定 MinerU Desktop 输出目录；请在设置中填写结果目录",
      );
    const configPath = PathUtils.join(root, "config.json");
    if (await IOUtils.exists(configPath)) {
      try {
        const configured = mineruDesktopHistoryPathFromConfig(
          toText(await Zotero.File.getContentsAsync(configPath, "utf-8")),
        );
        if (configured) return configured;
      } catch {
        // Keep the conventional ~/MinerU directory when the client config is malformed.
      }
    }
    return root;
  }

  private async ensureSelfHostedReady(
    onStatus: (message: string) => void = () => undefined,
  ): Promise<void> {
    if (await endpointHealthy(this.profile.selfHostedEndpoint)) return;
    if (!this.profile.selfHostedAutoStart)
      throw new Error(
        "MinerU 本地服务未运行；请启动服务或在设置中开启自动启动",
      );
    if (!isLoopbackEndpoint(this.profile.selfHostedEndpoint))
      throw new Error(
        "远程或局域网 MinerU 服务无法由本机插件自动启动，请在服务器上启动服务",
      );

    const docker = await this.resolveDockerExecutable();
    if (!(await this.dockerEngineReady(docker))) {
      onStatus("Docker 引擎未运行；正在启动 Docker Desktop");
      await this.startDockerDesktop();
      const dockerDeadline = Date.now() + DOCKER_START_TIMEOUT_MS;
      while (Date.now() < dockerDeadline && !this.cancelled) {
        await delay(2000);
        if (await this.dockerEngineReady(docker)) break;
      }
      if (this.cancelled) throw new Error("已取消 MinerU Docker 启动");
      if (!(await this.dockerEngineReady(docker)))
        throw new Error(
          "Docker Desktop 启动超时；请确认 WSL/GPU 后端可用后重试",
        );
    }

    const invocation = await this.resolveDockerComposeInvocation();
    onStatus("Docker 已就绪；正在启动 MinerU API 容器");
    await this.runProcess(
      docker,
      invocation.arguments,
      invocation.workdir,
      DOCKER_START_TIMEOUT_MS,
    );
    onStatus("MinerU 容器已启动；正在等待健康检查");
    const serviceDeadline = Date.now() + DOCKER_START_TIMEOUT_MS;
    while (Date.now() < serviceDeadline && !this.cancelled) {
      if (await endpointHealthy(this.profile.selfHostedEndpoint)) return;
      await delay(2000);
    }
    if (this.cancelled) throw new Error("已取消 MinerU Docker 启动");
    throw new Error(
      `MinerU 容器已提交启动，但 ${this.profile.selfHostedEndpoint}/health 在 ${DOCKER_START_TIMEOUT_MS / 1000} 秒内未就绪`,
    );
  }

  private async resolveDockerExecutable(): Promise<string> {
    const configured = this.profile.dockerExecutable.trim();
    if (!/(?:^|[\\/])docker(?:\.exe)?$/i.test(configured))
      throw new Error("Docker CLI 必须指向 docker 或 docker.exe");
    if (configured.includes("\\") || configured.includes("/")) {
      if (!(await IOUtils.exists(configured)))
        throw new Error(`Docker CLI 不存在：${configured}`);
      return configured;
    }
    try {
      return await getSubprocess().pathSearch(configured);
    } catch (error) {
      throw new Error("没有找到 Docker CLI；请在设置中填写 docker.exe 路径", {
        cause: error,
      });
    }
  }

  private async dockerEngineReady(docker: string): Promise<boolean> {
    try {
      await this.runProcess(
        docker,
        ["info", "--format", "{{.ServerVersion}}"],
        PathUtils.tempDir,
        15_000,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async startDockerDesktop(): Promise<void> {
    const executable = this.profile.dockerDesktopExecutable.trim();
    if (!/(?:^|[\\/])Docker Desktop\.exe$/i.test(executable))
      throw new Error("Docker Desktop 路径必须指向 Docker Desktop.exe");
    if (!(await IOUtils.exists(executable)))
      throw new Error(`Docker Desktop 不存在：${executable}`);
    const process = await getSubprocess().call({
      command: executable,
      arguments: ["--minimized"],
      environmentAppend: true,
      stderr: "ignore",
    });
    await process.stdin.close();
    void process.wait();
  }

  private async resolveDockerComposeInvocation(): Promise<{
    workdir: string;
    arguments: string[];
  }> {
    const directory = this.profile.selfHostedProjectDirectory.trim();
    if (!isAbsoluteLocalPath(directory))
      throw new Error("MinerU Docker 项目目录必须是本机绝对路径");
    let stat: { type?: string };
    try {
      stat = (await (IOUtils as any).stat(directory)) as { type?: string };
    } catch (error) {
      throw new Error(`MinerU Docker 项目目录不存在：${directory}`, {
        cause: error,
      });
    }
    if (stat.type !== "directory")
      throw new Error(`MinerU Docker 项目路径不是目录：${directory}`);
    const candidates = ["compose.yaml", "compose.yml"];
    let composeFile = "";
    for (const candidate of candidates) {
      const path = PathUtils.join(directory, candidate);
      if (await IOUtils.exists(path)) {
        composeFile = path;
        break;
      }
    }
    if (!composeFile)
      throw new Error(`MinerU Docker 项目缺少 compose.yaml：${directory}`);
    const compose = toText(
      await Zotero.File.getContentsAsync(composeFile, "utf-8"),
    );
    if (!/^\s{2}mineru-api:\s*$/m.test(compose))
      throw new Error("Compose 文件中没有受支持的 mineru-api 服务");
    return {
      workdir: directory,
      arguments: buildMinerUDockerComposeArguments(composeFile),
    };
  }

  private async convertWithLocalClient(
    pdfPath: string,
    directory: string,
  ): Promise<MinerUConversionResult> {
    const executable = await this.resolveExecutable();
    await this.runProcess(
      executable,
      [
        "-p",
        pdfPath,
        "-o",
        directory,
        "-b",
        this.profile.backend,
        "-m",
        this.profile.method,
        "-l",
        this.profile.language,
        "-f",
        String(this.profile.enableFormula),
        "-t",
        String(this.profile.enableTable),
        ...this.profile.args,
      ],
      directory,
    );
    const markdownFiles = await findFiles(directory, (path) =>
      /\.md$/i.test(path),
    );
    if (!markdownFiles.length)
      throw new Error("MinerU 客户端没有生成 Markdown 文件");
    const selected = selectMarkdownPath(markdownFiles, safeBaseName(pdfPath));
    return {
      markdown: toText(await Zotero.File.getContentsAsync(selected, "utf-8")),
      figures: [],
    };
  }

  private async convertWithOfficialApi(
    pdfPath: string,
    itemKey: string,
  ): Promise<MinerUConversionResult> {
    this.controller = createCompatibleAbortController();
    const deadline = Date.now() + this.profile.timeoutMs;
    try {
      const fileName = PathUtils.filename(pdfPath);
      const create = await fetch(
        `${this.profile.officialEndpoint}/file-urls/batch`,
        {
          method: "POST",
          headers: {
            ...this.officialHeaders(),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            files: [
              {
                name: fileName,
                data_id: itemKey,
                is_ocr: this.profile.method === "ocr",
              },
            ],
            model_version: this.profile.modelVersion,
            enable_formula: this.profile.enableFormula,
            enable_table: this.profile.enableTable,
            language: this.profile.language,
          }),
          signal: this.controller?.signal,
        },
      );
      const created = await jsonResponse(create, "申请 MinerU 上传地址");
      const data = created.data as Record<string, unknown> | undefined;
      const batchID = String(data?.batch_id || "");
      const fileUrls = data?.file_urls as unknown[] | undefined;
      const firstUrl = fileUrls?.[0];
      const uploadUrl =
        typeof firstUrl === "string"
          ? firstUrl
          : String(
              (firstUrl as Record<string, unknown> | undefined)?.url || "",
            );
      if (!batchID || !uploadUrl)
        throw new Error("MinerU 没有返回上传地址或批次 ID");
      const upload = await fetch(uploadUrl, {
        method: "PUT",
        body: await IOUtils.read(pdfPath),
        signal: this.controller?.signal,
      });
      if (!upload.ok) throw new Error(`上传主 PDF 失败：HTTP ${upload.status}`);

      while (Date.now() < deadline) {
        await delay(2000);
        const response = await fetch(
          `${this.profile.officialEndpoint}/extract-results/batch/${encodeURIComponent(batchID)}`,
          { headers: this.officialHeaders(), signal: this.controller?.signal },
        );
        const payload = await jsonResponse(response, "查询 MinerU 任务");
        const resultValue = (
          payload.data as Record<string, unknown> | undefined
        )?.extract_result;
        const results = Array.isArray(resultValue)
          ? resultValue
          : [resultValue];
        const result = results.find((entry) => {
          const row = entry as Record<string, unknown> | undefined;
          return row?.data_id === itemKey || row?.file_name === fileName;
        }) as Record<string, unknown> | undefined;
        if (!result) continue;
        const state = String(result.state || "").toLocaleLowerCase();
        if (state === "failed")
          throw new Error(`MinerU 解析失败：${result.err_msg || "未知错误"}`);
        if (state === "done") {
          const zipUrl = String(result.full_zip_url || "");
          if (!zipUrl) throw new Error("MinerU 任务完成但没有结果下载地址");
          return mineruResultFromZip(
            await downloadBytes(zipUrl, this.controller?.signal),
            safeBaseName(pdfPath),
          );
        }
      }
      throw new Error("MinerU 网页 API 超时");
    } finally {
      this.controller = undefined;
    }
  }

  private async convertWithSelfHosted(
    pdfPath: string,
  ): Promise<MinerUConversionResult> {
    this.controller = createCompatibleAbortController();
    const deadline = Date.now() + this.profile.timeoutMs;
    try {
      const bytes = await IOUtils.read(pdfPath);
      const fileName = PathUtils.filename(pdfPath);
      const directMultipart = this.selfHostedMultipart(bytes, fileName);
      const direct = await fetch(
        `${this.profile.selfHostedEndpoint}/file_parse`,
        {
          method: "POST",
          headers: { "content-type": directMultipart.contentType },
          body: directMultipart.body,
          signal: this.controller?.signal,
        },
      );
      if (![404, 405].includes(direct.status)) {
        if (!direct.ok)
          throw new Error(
            `MinerU 本地解析失败：HTTP ${direct.status} ${tail(await direct.text())}`,
          );
        return this.selfHostedResponse(direct, pdfPath);
      }

      const taskMultipart = this.selfHostedMultipart(bytes, fileName);
      const submitted = await fetch(
        `${this.profile.selfHostedEndpoint}/tasks`,
        {
          method: "POST",
          headers: { "content-type": taskMultipart.contentType },
          body: taskMultipart.body,
          signal: this.controller?.signal,
        },
      );
      if (!submitted.ok)
        throw new Error(`MinerU 本地服务提交失败：HTTP ${submitted.status}`);
      const submission = (await submitted.json()) as unknown as Record<
        string,
        unknown
      >;
      const taskID = String(submission.task_id || "");
      if (!taskID) throw new Error("MinerU 本地服务没有返回 task_id");

      while (Date.now() < deadline) {
        await delay(1500);
        const response = await fetch(
          `${this.profile.selfHostedEndpoint}/tasks/${encodeURIComponent(taskID)}`,
          { signal: this.controller?.signal },
        );
        if (!response.ok)
          throw new Error(`MinerU 本地任务查询失败：HTTP ${response.status}`);
        const status = (await response.json()) as unknown as Record<
          string,
          unknown
        >;
        const state = String(status.status || "").toLocaleLowerCase();
        if (["failed", "error"].includes(state)) {
          throw new Error(`MinerU 本地解析失败：${status.error || "未知错误"}`);
        }
        if (["completed", "done", "success"].includes(state)) {
          const result = await fetch(
            `${this.profile.selfHostedEndpoint}/tasks/${encodeURIComponent(taskID)}/result`,
            { signal: this.controller?.signal },
          );
          if (!result.ok)
            throw new Error(`MinerU 本地结果下载失败：HTTP ${result.status}`);
          return this.selfHostedResponse(result, pdfPath);
        }
      }
      throw new Error("MinerU 本地部署任务超时");
    } finally {
      this.controller = undefined;
    }
  }

  private selfHostedMultipart(
    bytes: Uint8Array,
    fileName: string,
  ): {
    body: Uint8Array;
    contentType: string;
  } {
    return buildSelfHostedMultipartBody({
      bytes,
      fileName,
      boundary: createSelfHostedMultipartBoundary(bytes),
      backend: this.profile.backend,
      parseMethod: this.profile.method,
      language: this.profile.language,
      enableFormula: this.profile.enableFormula,
      enableTable: this.profile.enableTable,
    });
  }

  private async selfHostedResponse(
    response: Response,
    pdfPath: string,
  ): Promise<MinerUConversionResult> {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("json")) {
      const value = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      const markdown = markdownFromInlineResult(value);
      if (!markdown) throw new Error("MinerU 本地结果没有 Markdown");
      return { markdown, figures: [] };
    }
    return mineruResultFromZip(
      new Uint8Array(await response.arrayBuffer()),
      safeBaseName(pdfPath),
    );
  }

  private officialHeaders(): Record<string, string> {
    const token = Services.env.get(this.profile.officialTokenEnvironment);
    if (!token) {
      throw new Error(
        `未找到环境变量 ${this.profile.officialTokenEnvironment}；请在启动 Zotero 前设置 MinerU Token`,
      );
    }
    return { Authorization: `Bearer ${token}` };
  }

  private async resolveExecutable(): Promise<string> {
    const configured = this.profile.executable;
    if (configured.includes("\\") || configured.includes("/")) {
      if (!(await IOUtils.exists(configured)))
        throw new Error(`MinerU 可执行文件不存在：${configured}`);
      return configured;
    }
    try {
      return await getSubprocess().pathSearch(configured);
    } catch (error) {
      throw new Error(
        "没有找到 MinerU 客户端；请在设置中填写 mineru 可执行文件路径",
        { cause: error },
      );
    }
  }

  private async openWithDesktop(pdfPath: string): Promise<void> {
    const executable = await this.resolveExecutable();
    const process = await getSubprocess().call({
      command: executable,
      arguments: [pdfPath],
      environmentAppend: true,
      stderr: "ignore",
    });
    await process.stdin.close();
    void process.wait();
  }

  private async runProcess(
    executable: string,
    args: string[],
    workdir: string,
    timeoutMs = this.profile.timeoutMs,
  ): Promise<string> {
    const process = await getSubprocess().call({
      command: executable,
      arguments: args,
      environmentAppend: true,
      stderr: "pipe",
      workdir,
    });
    this.running = process;
    const stdout = process.stdout.readString();
    const stderr = process.stderr?.readString() || Promise.resolve("");
    await process.stdin.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        process.wait(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            void process.kill(800);
            reject(
              new Error(`外部进程运行超时：${PathUtils.filename(executable)}`),
            );
          }, timeoutMs);
        }),
      ]);
      const output = await stdout;
      const errors = await stderr;
      if (result.exitCode !== 0) {
        throw new Error(
          `${PathUtils.filename(executable)} 运行失败（退出码 ${result.exitCode}）：${tail(errors || output)}`,
        );
      }
      return output;
    } finally {
      if (timer) clearTimeout(timer);
      this.running = undefined;
    }
  }
}

export function mineruDesktopHistoryPathFromConfig(value: string): string {
  const outer = JSON.parse(value) as Record<string, unknown>;
  const rawConfig = outer.config;
  const config =
    typeof rawConfig === "string"
      ? (JSON.parse(rawConfig) as Record<string, unknown>)
      : (rawConfig as Record<string, unknown> | undefined) || outer;
  const state = (config.state as Record<string, unknown> | undefined) || config;
  return String(state.history_path || "").trim();
}

export function buildMinerUDockerComposeArguments(
  composeFile: string,
): string[] {
  return [
    "compose",
    "-f",
    composeFile,
    "--profile",
    "api",
    "up",
    "-d",
    "--no-build",
    "mineru-api",
  ];
}

export async function mineruResultFromDirectory(
  directory: string,
  preferredBaseName = "",
): Promise<MinerUConversionResult> {
  const paths = await findFiles(directory, () => true);
  const markdownPaths = paths.filter((path) => /\.md$/i.test(path));
  if (!markdownPaths.length)
    throw new Error("MinerU Desktop 结果目录中没有 Markdown");
  const selected = selectMarkdownPath(markdownPaths, preferredBaseName);
  const relativeNames = paths
    .map((path) => relativeLocalPath(directory, path))
    .filter(Boolean);
  const absoluteByRelativeName = new Map(
    paths
      .map((path) => [relativeLocalPath(directory, path), path] as const)
      .filter(([name]) => Boolean(name)),
  );
  const figureMap = new Map<string, MinerUParsedFigure>();
  for (const manifestPath of paths.filter((path) => isContentListName(path))) {
    let rows: unknown[];
    try {
      rows = mineruContentRows(
        JSON.parse(
          toText(await Zotero.File.getContentsAsync(manifestPath, "utf-8")),
        ) as unknown,
      );
    } catch {
      continue;
    }
    const manifestName = relativeLocalPath(directory, manifestPath);
    for (const value of rows) {
      const descriptor = mineruFigureDescriptor(
        value,
        manifestName,
        relativeNames,
      );
      if (!descriptor) continue;
      const imagePath = absoluteByRelativeName.get(descriptor.imageName);
      if (!imagePath) continue;
      figureMap.set(descriptor.id, {
        ...descriptor,
        bytes: await IOUtils.read(imagePath),
      });
    }
  }
  return {
    markdown: toText(await Zotero.File.getContentsAsync(selected, "utf-8")),
    figures: [...figureMap.values()],
  };
}

async function desktopDirectorySnapshot(
  outputDirectory: string,
): Promise<Map<string, number>> {
  const snapshot = new Map<string, number>();
  let children: string[];
  try {
    children = await (IOUtils as any).getChildren(outputDirectory);
  } catch {
    return snapshot;
  }
  for (const path of children) {
    try {
      const stat = await (IOUtils as any).stat(path);
      if (stat.type === "directory")
        snapshot.set(path, Number(stat.lastModified || 0));
    } catch {
      // A Desktop task may still be moving its temporary directory.
    }
  }
  return snapshot;
}

async function waitForDesktopResultDirectory(options: {
  outputDirectory: string;
  pdfFileName: string;
  baseline: Map<string, number>;
  timeoutMs: number;
  cancelled: () => boolean;
}): Promise<string> {
  const deadline = Date.now() + options.timeoutMs;
  const expectedPrefix = `${options.pdfFileName}-`.toLocaleLowerCase();
  let stablePath = "";
  let stableSignature = "";
  let stableChecks = 0;
  while (Date.now() < deadline) {
    if (options.cancelled()) throw new Error("已取消等待 MinerU Desktop 回传");
    const current = await desktopDirectorySnapshot(options.outputDirectory);
    const candidates = [...current.entries()]
      .filter(([path, modified]) => {
        const name = PathUtils.filename(path).toLocaleLowerCase();
        const previous = options.baseline.get(path);
        return (
          name.startsWith(expectedPrefix) &&
          (previous === undefined || modified > previous)
        );
      })
      .sort((a, b) => b[1] - a[1]);
    for (const [path] of candidates) {
      try {
        const files = await findFiles(path, () => true);
        if (!files.some((file) => /\.md$/i.test(file))) continue;
        const signatureParts: string[] = [];
        for (const file of files) {
          const stat = await (IOUtils as any).stat(file);
          signatureParts.push(
            `${relativeLocalPath(path, file)}:${Number(stat.size || 0)}:${Number(stat.lastModified || 0)}`,
          );
        }
        const signature = signatureParts.sort().join("|");
        if (stablePath === path && stableSignature === signature)
          stableChecks += 1;
        else {
          stablePath = path;
          stableSignature = signature;
          stableChecks = 1;
        }
        if (stableChecks >= 2) return path;
        break;
      } catch {
        // Files are still being generated; retry without importing partial output.
      }
    }
    await delay(1200);
  }
  throw new Error(
    `等待 MinerU Desktop 回传超时；请确认客户端已完成解析，输出目录为 ${options.outputDirectory}`,
  );
}

function defaultMinerUHomeDirectory(): string {
  try {
    const home = Services.dirsvc.get(
      "Home",
      Components.interfaces.nsIFile,
    ) as nsIFile;
    return PathUtils.join(home.path, "MinerU");
  } catch {
    return "";
  }
}

function createCompatibleAbortController(): AbortController | undefined {
  const owners: unknown[] = [globalThis];
  try {
    if (typeof Zotero !== "undefined") owners.push(Zotero.getMainWindow?.());
  } catch {
    // The main window may disappear while Zotero is closing.
  }
  try {
    if (typeof Services !== "undefined")
      owners.push(Services.appShell?.hiddenDOMWindow as unknown);
  } catch {
    // Zotero 9 can reject hiddenDOMWindow access from an add-on sandbox.
  }
  for (const owner of owners) {
    const Constructor = (owner as { AbortController?: typeof AbortController })
      ?.AbortController;
    if (typeof Constructor !== "function") continue;
    try {
      return new Constructor();
    } catch {
      // Try another DOM owner when a privileged window exposes an invalid stub.
    }
  }
  return undefined;
}

function relativeLocalPath(root: string, path: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  const prefix = `${normalizedRoot}\\`;
  const alternatePrefix = `${normalizedRoot}/`;
  const rootLower = normalizedRoot.toLocaleLowerCase();
  const pathLower = path.toLocaleLowerCase();
  if (pathLower === rootLower) return "";
  let relative = "";
  if (pathLower.startsWith(prefix.toLocaleLowerCase()))
    relative = path.slice(prefix.length);
  else if (pathLower.startsWith(alternatePrefix.toLocaleLowerCase()))
    relative = path.slice(alternatePrefix.length);
  return normalizeArchivePath(relative);
}

function isContentListName(path: string): boolean {
  return /(?:^|[\\/])(?:[^\\/]+_)?content_list(?:_v\d+)?\.json$/i.test(path);
}

async function endpointHealthy(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function isLoopbackEndpoint(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLocaleLowerCase();
    return ["localhost", "127.0.0.1", "::1"].includes(host);
  } catch {
    return false;
  }
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

export function buildSelfHostedMultipartBody(input: {
  bytes: Uint8Array;
  fileName: string;
  boundary: string;
  backend: string;
  parseMethod: MinerUProfile["method"];
  language: string;
  enableFormula: boolean;
  enableTable: boolean;
}): { body: Uint8Array; contentType: string } {
  if (!/^[A-Za-z0-9_-]{1,70}$/.test(input.boundary))
    throw new Error("Invalid multipart boundary");
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const text = (value: string) => parts.push(encoder.encode(value));
  const field = (name: string, value: string) => {
    text(`--${input.boundary}\r\n`);
    text(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
    text(`${value}\r\n`);
  };

  text(`--${input.boundary}\r\n`);
  text(
    `Content-Disposition: form-data; name="files"; filename="${multipartQuotedValue(input.fileName)}"\r\n`,
  );
  text("Content-Type: application/pdf\r\n\r\n");
  parts.push(input.bytes);
  text("\r\n");
  field("backend", input.backend);
  field("parse_method", input.parseMethod);
  field("lang_list", input.language);
  field("formula_enable", String(input.enableFormula));
  field("table_enable", String(input.enableTable));
  field("return_md", "true");
  field("return_content_list", "true");
  field("return_images", "true");
  field("response_format_zip", "true");
  text(`--${input.boundary}--\r\n`);

  const body = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return {
    body,
    contentType: `multipart/form-data; boundary=${input.boundary}`,
  };
}

function createSelfHostedMultipartBoundary(bytes: Uint8Array): string {
  const encoder = new TextEncoder();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const random = new Uint32Array(4);
    crypto.getRandomValues(random);
    const suffix = Array.from(random, (value) =>
      value.toString(16).padStart(8, "0"),
    ).join("");
    const boundary = `zrdb-mineru-${suffix}`;
    if (!containsBytes(bytes, encoder.encode(`\r\n--${boundary}`)))
      return boundary;
  }
  throw new Error("Unable to create a safe multipart boundary");
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (
    let offset = 0;
    offset <= haystack.length - needle.length;
    offset++
  ) {
    for (let index = 0; index < needle.length; index++) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return true;
  }
  return false;
}

function multipartQuotedValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replace(/[\r\n]/g, "_");
}

export async function markdownFromZip(
  bytes: Uint8Array,
  preferredBaseName = "",
): Promise<string> {
  return (await mineruResultFromZip(bytes, preferredBaseName)).markdown;
}

export async function mineruResultFromZip(
  bytes: Uint8Array,
  preferredBaseName = "",
): Promise<MinerUConversionResult> {
  return hasNativeZipReader()
    ? mineruResultFromNativeZip(bytes, preferredBaseName)
    : mineruResultFromJSZip(bytes, preferredBaseName);
}

async function mineruResultFromJSZip(
  bytes: Uint8Array,
  preferredBaseName: string,
): Promise<MinerUConversionResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new Error("无法打开 MinerU 结果压缩包", { cause: error });
  }
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  const markdownEntries = files.filter((entry) => /\.md$/i.test(entry.name));
  const candidates = await Promise.all(
    markdownEntries.map(async (entry) => ({
      name: entry.name,
      text: await entry.async("string"),
    })),
  );
  if (!candidates.length) throw new Error("MinerU 结果压缩包中没有 Markdown");
  candidates.sort(
    (a, b) =>
      markdownScore(b.name, preferredBaseName, b.text.length) -
      markdownScore(a.name, preferredBaseName, a.text.length),
  );
  const figureMap = new Map<string, MinerUParsedFigure>();
  for (const manifest of files.filter((entry) =>
    isContentListName(entry.name),
  )) {
    let content: unknown;
    try {
      content = JSON.parse(await manifest.async("string"));
    } catch {
      continue;
    }
    const rows = mineruContentRows(content);
    for (const value of rows) {
      const row = value as Record<string, unknown>;
      const sourceKind = String(row?.type || "").toLocaleLowerCase();
      if (!["image", "table", "chart"].includes(sourceKind)) continue;
      const imagePath = normalizeArchivePath(String(row.img_path || ""));
      if (!imagePath) continue;
      const imageEntry = resolveArchiveImage(files, manifest.name, imagePath);
      if (!imageEntry) continue;
      const kind = sourceKind === "table" ? "table" : "figure";
      const id = `mineru:${kind}:${encodeURIComponent(imagePath)}`;
      const pageIndex = Math.max(0, Math.floor(Number(row.page_idx) || 0));
      figureMap.set(id, {
        id,
        kind,
        caption: mineruCaption(row, sourceKind),
        pageIndex,
        rect: normalizeMinerURect(row.bbox),
        imageName: imageEntry.name,
        bytes: await imageEntry.async("uint8array"),
      });
    }
  }
  return { markdown: candidates[0].text, figures: [...figureMap.values()] };
}

function hasNativeZipReader(): boolean {
  return (
    typeof Components !== "undefined" &&
    typeof PathUtils !== "undefined" &&
    typeof IOUtils !== "undefined"
  );
}

async function mineruResultFromNativeZip(
  bytes: Uint8Array,
  preferredBaseName: string,
): Promise<MinerUConversionResult> {
  const temporaryPath = PathUtils.join(
    PathUtils.tempDir,
    `zrdb-mineru-result-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
  );
  let reader: nsIZipReader | undefined;
  try {
    await (IOUtils as any).write(temporaryPath, bytes);
    const file = (Components.classes as any)[
      "@mozilla.org/file/local;1"
    ].createInstance(Components.interfaces.nsIFile) as nsIFile;
    file.initWithPath(temporaryPath);
    reader = (Components.classes as any)[
      "@mozilla.org/libjar/zip-reader;1"
    ].createInstance(Components.interfaces.nsIZipReader) as nsIZipReader;
    reader.open(file);
    const names: string[] = [];
    const iterator = reader.findEntries("*");
    while (iterator.hasMore()) {
      const name = iterator.getNext();
      if (!reader.getEntry(name).isDirectory) names.push(name);
    }
    const candidates = names
      .filter((name) => /\.md$/i.test(name))
      .map((name) => ({
        name,
        text: new TextDecoder().decode(readNativeZipEntry(reader!, name)),
      }));
    if (!candidates.length) throw new Error("MinerU 结果压缩包中没有 Markdown");
    candidates.sort(
      (a, b) =>
        markdownScore(b.name, preferredBaseName, b.text.length) -
        markdownScore(a.name, preferredBaseName, a.text.length),
    );
    const figureMap = new Map<string, MinerUParsedFigure>();
    for (const manifestName of names.filter((name) =>
      isContentListName(name),
    )) {
      let rows: unknown[];
      try {
        const content = JSON.parse(
          new TextDecoder().decode(readNativeZipEntry(reader, manifestName)),
        ) as unknown;
        rows = mineruContentRows(content);
      } catch {
        continue;
      }
      for (const value of rows) {
        const descriptor = mineruFigureDescriptor(value, manifestName, names);
        if (!descriptor) continue;
        figureMap.set(descriptor.id, {
          ...descriptor,
          bytes: readNativeZipEntry(reader, descriptor.imageName),
        });
      }
    }
    return { markdown: candidates[0].text, figures: [...figureMap.values()] };
  } catch (error) {
    if (error instanceof Error && error.message.includes("MinerU")) throw error;
    throw new Error("Zotero 无法读取 MinerU 结果压缩包", { cause: error });
  } finally {
    try {
      reader?.close();
    } catch {
      // The reader may already be closed after a malformed archive error.
    }
    await IOUtils.remove(temporaryPath, { ignoreAbsent: true });
  }
}

function readNativeZipEntry(reader: nsIZipReader, name: string): Uint8Array {
  const input = reader.getInputStream(name);
  try {
    const binary = (Components.classes as any)[
      "@mozilla.org/binaryinputstream;1"
    ].createInstance(
      Components.interfaces.nsIBinaryInputStream,
    ) as nsIBinaryInputStream;
    binary.setInputStream(input);
    return Uint8Array.from(binary.readByteArray(Number(binary.available())));
  } finally {
    input.close();
  }
}

function markdownFromInlineResult(value: Record<string, unknown>): string {
  const results = value.results as Record<string, unknown> | undefined;
  for (const result of Object.values(results || {})) {
    const markdown = String(
      (result as Record<string, unknown>)?.md_content || "",
    );
    if (markdown.trim()) return markdown;
  }
  return "";
}

function normalizeArchivePath(value: string): string {
  const parts = value
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== ".");
  if (!parts.length || parts.includes("..")) return "";
  return parts.join("/");
}

function resolveArchiveImage(
  files: JSZipObject[],
  manifestName: string,
  imagePath: string,
): JSZipObject | undefined {
  const name = resolveArchiveImageName(
    files.map((file) => file.name),
    manifestName,
    imagePath,
  );
  return name ? files.find((file) => file.name === name) : undefined;
}

function resolveArchiveImageName(
  names: string[],
  manifestName: string,
  imagePath: string,
): string | undefined {
  const normalizedManifest = normalizeArchivePath(manifestName);
  const directory = normalizedManifest.includes("/")
    ? normalizedManifest.slice(0, normalizedManifest.lastIndexOf("/"))
    : "";
  const candidates = [
    directory ? `${directory}/${imagePath}` : imagePath,
    imagePath,
  ].map((entry) => entry.toLocaleLowerCase());
  return names.find((fileName) => {
    const name = normalizeArchivePath(fileName).toLocaleLowerCase();
    return (
      candidates.includes(name) ||
      candidates.some((candidate) => name.endsWith(`/${candidate}`))
    );
  });
}

function mineruContentRows(content: unknown): unknown[] {
  return Array.isArray(content)
    ? content
    : Array.isArray((content as Record<string, unknown>)?.content_list)
      ? ((content as Record<string, unknown>).content_list as unknown[])
      : [];
}

function mineruFigureDescriptor(
  value: unknown,
  manifestName: string,
  names: string[],
): Omit<MinerUParsedFigure, "bytes"> | undefined {
  const row = value as Record<string, unknown>;
  const sourceKind = String(row?.type || "").toLocaleLowerCase();
  if (!["image", "table", "chart"].includes(sourceKind)) return undefined;
  const imagePath = normalizeArchivePath(String(row.img_path || ""));
  if (!imagePath) return undefined;
  const imageName = resolveArchiveImageName(names, manifestName, imagePath);
  if (!imageName) return undefined;
  const kind = sourceKind === "table" ? "table" : "figure";
  return {
    id: `mineru:${kind}:${encodeURIComponent(imagePath)}`,
    kind,
    caption: mineruCaption(row, sourceKind),
    pageIndex: Math.max(0, Math.floor(Number(row.page_idx) || 0)),
    rect: normalizeMinerURect(row.bbox),
    imageName,
  };
}

function mineruCaption(
  row: Record<string, unknown>,
  sourceKind: string,
): string {
  const key =
    sourceKind === "table"
      ? "table_caption"
      : sourceKind === "chart"
        ? "chart_caption"
        : "image_caption";
  const value = row[key];
  return Array.isArray(value)
    ? value.map(String).filter(Boolean).join(" ")
    : String(value || "").trim();
}

function normalizeMinerURect(
  value: unknown,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const [x0, y0, x1, y1] = value.slice(0, 4).map(Number);
  if (
    [x0, y0, x1, y1].some((entry) => !Number.isFinite(entry)) ||
    x1 <= x0 ||
    y1 <= y0
  )
    return undefined;
  // MinerU normally reports coordinates on a 0..1000 page grid, but newer
  // backends may already return normalized 0..1 values. Preserve the latter
  // instead of shrinking them by another factor of 1000.
  const divisor =
    Math.max(Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1)) <= 1
      ? 1
      : 1000;
  const clamp = (entry: number) => Math.max(0, Math.min(1, entry / divisor));
  const left = clamp(x0);
  const top = clamp(y0);
  const right = clamp(x1);
  const bottom = clamp(y1);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function safeImageExtension(path: string): string {
  const match = path
    .toLocaleLowerCase()
    .match(/\.(png|jpe?g|webp|gif|tiff?|bmp)$/);
  return match ? `.${match[1] === "jpeg" ? "jpg" : match[1]}` : ".png";
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isMinerUDesktop(profile: MinerUProfile): boolean {
  return /(?:^|[\\/])MinerU\.exe$/i.test(profile.executable.trim());
}

function selectMarkdownPath(
  paths: string[],
  preferredBaseName: string,
): string {
  return [...paths].sort(
    (a, b) =>
      markdownScore(b, preferredBaseName, 0) -
      markdownScore(a, preferredBaseName, 0),
  )[0];
}

function markdownScore(
  name: string,
  preferredBaseName: string,
  length: number,
): number {
  const normalized = name.replaceAll("\\", "/").toLocaleLowerCase();
  const fileName = normalized.split("/").at(-1) || normalized;
  const preferred = preferredBaseName.toLocaleLowerCase();
  let score = Math.min(length / 1000, 50);
  if (fileName === "full.md") score += 2000;
  if (preferred && fileName === `${preferred}.md`) score += 900;
  if (preferred && fileName.includes(preferred)) score += 300;
  if (fileName === "readme.md") score -= 1000;
  return score;
}

async function findFiles(
  directory: string,
  accept: (path: string) => boolean,
  depth = 0,
): Promise<string[]> {
  if (depth > 8) return [];
  const paths = await (IOUtils as any).getChildren(directory);
  const output: string[] = [];
  for (const path of paths) {
    const stat = await (IOUtils as any).stat(path);
    if (stat.type === "directory")
      output.push(...(await findFiles(path, accept, depth + 1)));
    else if (accept(path)) output.push(path);
  }
  return output;
}

async function jsonResponse(
  response: Response,
  action: string,
): Promise<Record<string, any>> {
  let value: Record<string, any>;
  try {
    value = (await response.json()) as Record<string, any>;
  } catch (error) {
    throw new Error(`${action}失败：服务没有返回 JSON`, { cause: error });
  }
  if (!response.ok || ("code" in value && value.code !== 0)) {
    throw new Error(`${action}失败：${value.msg || `HTTP ${response.status}`}`);
  }
  return value;
}

async function downloadBytes(
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error(`下载 MinerU 结果失败：HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isPrivateEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase();
    return (
      ["localhost", "127.0.0.1", "::1"].includes(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

function safeBaseName(path: string): string {
  const base = PathUtils.filename(path)
    .replace(/\.pdf$/i, "")
    .replace(/[<>:"/\\|?*]/g, "_");
  return [...base]
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .slice(0, 120);
}

function modeLabel(mode: MinerUMode): string {
  if (mode === "official-api") return "网页 API";
  if (mode === "self-hosted") return "本地部署";
  return "本地客户端";
}

function getSubprocess(): SubprocessAPI {
  return (ChromeUtils.importESModule(SUBPROCESS_MODULE) as any)
    .Subprocess as SubprocessAPI;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return "";
}

function tail(value: string, length = 1600): string {
  const trimmed = value.trim();
  return trimmed.length > length ? trimmed.slice(-length) : trimmed;
}
