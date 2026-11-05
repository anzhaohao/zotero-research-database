import { importArtifacts } from "./artifactEndpoint";
import { readExistingMinerUMarkdown, sha256Text } from "./contentSource";
import { mineruFileIO } from "./mineruFileIO";
import {
  readMinerUArchiveEntries,
  type MinerUArchiveEntry,
} from "./mineruArchive";
import { resolvePrimaryPdf } from "./primaryPdf";
import { clearPref, getPref, setPref } from "../utils/prefs";
import { getDataRoot } from "../storage/dataRoot";
import {
  claimSharedMinerUWork,
  writeSharedMinerUIndex,
  writeSharedMinerUResult,
  type SharedMinerUIdentity,
} from "./mineruSharedStore";

const SUBPROCESS_MODULE = "resource://gre/modules/Subprocess.sys.mjs";
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const MINERU_SETTINGS_VERSION = 6;
const DEFAULT_MINERU_OFFICIAL_ENDPOINT = "https://mineru.net/api/v4";
const DEFAULT_MINERU_TOKEN_ENVIRONMENT = "MINERU_API_TOKEN";
const DOCKER_START_TIMEOUT_MS = 4 * 60 * 1000;
const LLM_FOR_ZOTERO_MINERU_CACHE_DIR = "llm-for-zotero-mineru";

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

export type MinerUMode = "official-api" | "self-hosted";

export type MinerUTier = "flash" | "basic" | "standard" | "advanced";

const MINERU_TIERS: MinerUTier[] = ["flash", "basic", "standard", "advanced"];

/** MinerU 4.x replaced the 3.x backend choice with four quality tiers. */
export function mineruTier(value: unknown): MinerUTier {
  const text = String(value ?? "")
    .trim()
    .toLocaleLowerCase();
  return (MINERU_TIERS as string[]).includes(text)
    ? (text as MinerUTier)
    : "standard";
}

export interface MinerUProfile {
  mode: MinerUMode;
  sharedStoreDirectory: string;
  officialEndpoint: string;
  officialToken: string;
  officialTokenEnvironment: string;
  selfHostedEndpoint: string;
  selfHostedAutoStart: boolean;
  selfHostedProjectDirectory: string;
  dockerExecutable: string;
  dockerDesktopExecutable: string;
  backend: string;
  tier: MinerUTier;
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
  archive?: Uint8Array;
  archiveEntries?: MinerUArchiveEntry[];
  markdownArchivePath?: string;
}

export interface MinerUSettingsInput {
  mode: unknown;
  sharedStoreDirectory?: unknown;
  officialEndpoint: unknown;
  officialToken?: unknown;
  officialTokenEnvironment: unknown;
  selfHostedEndpoint: unknown;
  selfHostedAutoStart?: unknown;
  selfHostedProjectDirectory?: unknown;
  dockerExecutable?: unknown;
  dockerDesktopExecutable?: unknown;
  backend: unknown;
  tier?: unknown;
  method: unknown;
  modelVersion: unknown;
  language: unknown;
  enableFormula: unknown;
  enableTable: unknown;
  timeoutMs: unknown;
}

function defaultSharedStoreDirectory(): string {
  try {
    const root = getDataRoot();
    if (root && typeof PathUtils !== "undefined")
      return PathUtils.join(root, "mineru-shared-store");
  } catch {
    // Unit tests and first-run setup may not have a Zotero path yet.
  }
  return "";
}

export function parseMinerUProfile(input: MinerUSettingsInput): MinerUProfile {
  const mode = ["official-api", "self-hosted"].includes(String(input.mode))
    ? (String(input.mode) as MinerUMode)
    : "self-hosted";
  const method = ["auto", "txt", "ocr"].includes(String(input.method))
    ? (String(input.method) as MinerUProfile["method"])
    : "auto";
  const modelVersion =
    String(input.modelVersion) === "pipeline" ? "pipeline" : "vlm";
  const timeout = Number(input.timeoutMs);
  const officialEndpoint = normalizeOfficialEndpoint(
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
    sharedStoreDirectory:
      String(input.sharedStoreDirectory || "").trim() ||
      defaultSharedStoreDirectory(),
    officialEndpoint,
    officialToken: String(input.officialToken || "").trim(),
    officialTokenEnvironment:
      String(
        input.officialTokenEnvironment || DEFAULT_MINERU_TOKEN_ENVIRONMENT,
      ).trim() || DEFAULT_MINERU_TOKEN_ENVIRONMENT,
    selfHostedEndpoint,
    selfHostedAutoStart:
      input.selfHostedAutoStart === undefined
        ? true
        : Boolean(input.selfHostedAutoStart),
    selfHostedProjectDirectory: String(
      input.selfHostedProjectDirectory || "",
    ).trim(),
    dockerExecutable: String(input.dockerExecutable || "").trim(),
    dockerDesktopExecutable: String(input.dockerDesktopExecutable || "").trim(),
    backend: String(input.backend || "pipeline").trim() || "pipeline",
    tier: mineruTier(input.tier),
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
    sharedStoreDirectory: getPref("mineruSharedStoreDirectory"),
    officialEndpoint: getPref("mineruOfficialEndpoint"),
    officialToken: getPref("mineruOfficialToken"),
    officialTokenEnvironment: getPref("mineruOfficialTokenEnvironment"),
    selfHostedEndpoint: getPref("mineruSelfHostedEndpoint"),
    selfHostedAutoStart: getPref("mineruSelfHostedAutoStart"),
    selfHostedProjectDirectory: getPref("mineruSelfHostedProjectDirectory"),
    dockerExecutable: getPref("mineruDockerExecutable"),
    dockerDesktopExecutable: getPref("mineruDockerDesktopExecutable"),
    backend: getPref("mineruBackend"),
    tier: mineruTier(getPref("mineruTier")),
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
  setPref("mineruSharedStoreDirectory", profile.sharedStoreDirectory);
  setPref("mineruOfficialEndpoint", profile.officialEndpoint);
  setPref("mineruOfficialToken", profile.officialToken);
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
  setPref("mineruTier", profile.tier);
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
  if (String(getPref("mineruMode") || "") === "local-client")
    setPref("mineruMode", "self-hosted");
  if (
    String(getPref("mineruMode") || "self-hosted") !== "official-api" &&
    String(getPref("mineruOfficialEndpoint") || "") ===
      DEFAULT_MINERU_OFFICIAL_ENDPOINT
  )
    setPref("mineruOfficialEndpoint", "");
  if (version < 6) {
    const endpoint = String(getPref("mineruOfficialEndpoint") || "");
    const normalized = normalizeOfficialEndpoint(endpoint);
    if (endpoint && endpoint !== normalized)
      setPref("mineruOfficialEndpoint", normalized);
  }
  if (!String(getPref("mineruTier") || "").trim())
    setPref("mineruTier", "standard");
  if (version < 5) {
    const legacyEnvironment = String(
      getPref("mineruOfficialTokenEnvironment") || "",
    ).trim();
    if (legacyEnvironment && !isEnvironmentVariableName(legacyEnvironment)) {
      if (!String(getPref("mineruOfficialToken") || "").trim())
        setPref("mineruOfficialToken", legacyEnvironment);
      setPref(
        "mineruOfficialTokenEnvironment",
        DEFAULT_MINERU_TOKEN_ENVIRONMENT,
      );
    }
  }
  for (const key of [
    "mineruExecutable",
    "mineruArgs",
    "mineruDesktopOutputDirectory",
  ])
    clearPref(key);
  setPref("mineruSettingsVersion", MINERU_SETTINGS_VERSION);
}

export class MinerUConversionService {
  private cancelled = false;
  private running?: ProcessHandle;
  private controller?: AbortController;
  private importing = false;

  constructor(private profile: MinerUProfile) {}

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.controller?.abort();
    const running = this.running;
    if (running) {
      try {
        await running.kill(800);
      } catch {
        // The process may already have exited; runProcess will observe that.
      }
    }
  }

  isImporting(): boolean {
    return this.importing;
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new Error("已取消 MinerU 任务");
  }

  async run(
    items: Zotero.Item[],
    onProgress: (progress: MinerUProgress) => void,
    options: { forceRefresh?: boolean } = {},
  ): Promise<void> {
    this.cancelled = false;
    const reuseLlmCache =
      !options.forceRefresh && getPref("mineruReuseLlmForZoteroCache") === true;
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
        this.throwIfCancelled();
        if (!options.forceRefresh && (await readExistingMinerUMarkdown(item))) {
          onProgress({
            itemKey: item.key,
            state: "success",
            message:
              "已有 MinerU Markdown，已复用且未重复解析；需要新版本时请勾选重新解析",
          });
          continue;
        }

        const identity: SharedMinerUIdentity = {
          libraryID: item.libraryID,
          attachmentKey: pdf.key,
          pdfSha256: await sha256Bytes(await mineruFileIO.read(pdfPath)),
          pdfFileName: PathUtils.filename(pdfPath),
        };
        const claim = await claimSharedMinerUWork({
          root: this.profile.sharedStoreDirectory,
          identity,
          timeoutMs: this.profile.timeoutMs,
          forceRefresh: options.forceRefresh,
          cancelled: () => this.cancelled,
          onWaiting: () =>
            onProgress({
              itemKey: item.key,
              state: "running",
              message: "另一任务正在解析相同 PDF，等待复用其产物",
            }),
        });
        let result: MinerUConversionResult | undefined;
        let sourceLabel = "共享缓存";
        try {
          if (claim.cacheHit) {
            result = await mineruResultFromDirectory(claim.paperDirectory);
            await writeSharedMinerUIndex(
              this.profile.sharedStoreDirectory,
              identity,
              "cache-import",
            );
          } else {
            let sourceDirectory: string | undefined;
            if (reuseLlmCache) {
              sourceDirectory = await findLlmForZoteroMineruCache(pdf.id);
              if (sourceDirectory) {
                result =
                  await mineruResultFromLlmForZoteroCache(sourceDirectory);
                sourceLabel = "llm-for-zotero 缓存";
              }
            }
            if (!result?.markdown.trim()) {
              onProgress({
                itemKey: item.key,
                state: "running",
                message: options.forceRefresh
                  ? `正在重新解析主 PDF（${modeLabel(this.profile.mode)}）`
                  : `正在转换主 PDF（${modeLabel(this.profile.mode)}）`,
              });
              result = await this.convert(pdfPath, item.key, (message) =>
                onProgress({ itemKey: item.key, state: "running", message }),
              );
              sourceLabel = modeLabel(this.profile.mode);
              sourceDirectory = undefined;
            }
            this.throwIfCancelled();
            await writeSharedMinerUResult({
              root: this.profile.sharedStoreDirectory,
              identity,
              result,
              sourceMode: sourceDirectory ? "cache-import" : this.profile.mode,
              sourceDirectory,
              overwrite: options.forceRefresh,
            });
          }
        } finally {
          await claim.release();
        }
        this.throwIfCancelled();
        if (!result.markdown.trim())
          throw new Error("MinerU 没有生成 Markdown");
        await mineruFileIO.makeDirectory(directory, { ignoreExisting: true });
        const title = await this.importConversionResult(
          item,
          pdf,
          pdfPath,
          result,
          directory,
        );
        onProgress({
          itemKey: item.key,
          state: "success",
          message: `${title} 与 ${result.figures.length} 个图表已导入条目（${sourceLabel}）`,
        });
      } catch (error) {
        const cancelledBeforeImport = this.cancelled && !this.importing;
        this.importing = false;
        onProgress({
          itemKey: item.key,
          state: cancelledBeforeImport ? "cancelled" : "failed",
          message: cancelledBeforeImport
            ? "已取消，未导入"
            : error instanceof Error
              ? error.message
              : String(error),
        });
      } finally {
        this.importing = false;
        await mineruFileIO.remove(directory, {
          recursive: true,
          ignoreAbsent: true,
        });
      }
    }
  }

  private async importConversionResult(
    item: Zotero.Item,
    pdf: Zotero.Item,
    pdfPath: string,
    result: MinerUConversionResult,
    directory: string,
  ): Promise<string> {
    const title = `【MinerU原文】${safeBaseName(pdfPath)}.md`;
    const markdownPath = PathUtils.join(directory, title);
    await mineruFileIO.writeUTF8(markdownPath, result.markdown);
    this.throwIfCancelled();
    const figureArtifacts = [];
    for (const figure of result.figures) {
      this.throwIfCancelled();
      const extension = safeImageExtension(figure.imageName);
      const imageHash = await sha256Bytes(figure.bytes);
      const imagePath = PathUtils.join(
        directory,
        `${figure.kind}-${imageHash.slice(0, 16)}${extension}`,
      );
      await mineruFileIO.write(imagePath, figure.bytes);
      this.throwIfCancelled();
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
    // Zotero attachment creation is not safely cancellable. Once this point
    // is reached, finish the import and report its real outcome.
    this.importing = true;
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
    this.importing = false;
    return title;
  }

  async probe(): Promise<string> {
    if (this.profile.mode === "self-hosted") {
      await this.ensureSelfHostedReady();
      return `MinerU 本地服务 ${this.profile.selfHostedEndpoint}`;
    }
    const endpoint = this.profile.officialEndpoint;
    const url = `${endpoint}/extract/task/invalid-zrdb-connection-test`;
    const response = await fetchWithTimeout(
      url,
      { headers: this.officialHeaders() },
      this.profile.timeoutMs,
    );
    // A missing synthetic task proves that the official route and token work.
    await jsonResponse(response, "测试 MinerU 连接", [-60012]);
    return `MinerU 网页 API（HTTP ${response.status}，认证已通过）`;
  }

  private async convert(
    pdfPath: string,
    itemKey: string,
    onStatus: (message: string) => void,
  ): Promise<MinerUConversionResult> {
    if (this.profile.mode === "official-api") {
      return this.convertWithOfficialApi(pdfPath, itemKey);
    }
    await this.ensureSelfHostedReady(onStatus);
    return this.convertWithSelfHosted(pdfPath);
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
      `MinerU 容器已提交启动，但 ${this.profile.selfHostedEndpoint}/v1/health 在 ${DOCKER_START_TIMEOUT_MS / 1000} 秒内未就绪`,
    );
  }

  private async resolveDockerExecutable(): Promise<string> {
    const configured = this.profile.dockerExecutable.trim();
    const commandName =
      Services.appinfo.OS === "WINNT" ? "docker.exe" : "docker";
    if (!configured) {
      try {
        return await getSubprocess().pathSearch(commandName);
      } catch (error) {
        throw new Error(
          "没有找到 Docker CLI；请安装 Docker，或在设置中填写 docker.exe 路径",
          { cause: error },
        );
      }
    }
    if (
      !/^(?:docker(?:\.exe)?)$/i.test(configured) &&
      !/(?:^|[\\/])docker(?:\.exe)?$/i.test(configured)
    )
      throw new Error("Docker CLI 必须指向 docker 或 docker.exe");
    if (configured.includes("\\") || configured.includes("/")) {
      if (!(await mineruFileIO.exists(configured)))
        throw new Error(`Docker CLI 不存在：${configured}`);
      return configured;
    }
    try {
      return await getSubprocess().pathSearch(configured);
    } catch (error) {
      throw new Error(
        "没有找到 Docker CLI；请安装 Docker，或在设置中填写 docker.exe 路径",
        { cause: error },
      );
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
    const configured = this.profile.dockerDesktopExecutable.trim();
    const executable = configured || (await findDockerDesktopExecutable());
    if (
      Services.appinfo.OS === "WINNT" &&
      !/(?:^|[\\/])Docker Desktop\.exe$/i.test(executable)
    )
      throw new Error("Docker Desktop 路径必须指向 Docker Desktop.exe");
    if (!(await mineruFileIO.exists(executable)))
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
      stat = (await mineruFileIO.stat(directory)) as { type?: string };
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
      if (await mineruFileIO.exists(path)) {
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

  private async convertWithOfficialApi(
    pdfPath: string,
    itemKey: string,
  ): Promise<MinerUConversionResult> {
    this.controller = createCompatibleAbortController();
    const deadline = Date.now() + this.profile.timeoutMs;
    try {
      const fileName = PathUtils.filename(pdfPath);
      const create = await fetchWithTimeout(
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
        },
        remainingTimeout(deadline),
        this.controller?.signal,
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
      const upload = await fetchWithTimeout(
        uploadUrl,
        {
          method: "PUT",
          body: await mineruFileIO.read(pdfPath),
        },
        remainingTimeout(deadline),
        this.controller?.signal,
      );
      if (!upload.ok) throw new Error(`上传主 PDF 失败：HTTP ${upload.status}`);

      while (Date.now() < deadline) {
        await delay(2000);
        const response = await fetchWithTimeout(
          `${this.profile.officialEndpoint}/extract-results/batch/${encodeURIComponent(batchID)}`,
          { headers: this.officialHeaders() },
          remainingTimeout(deadline),
          this.controller?.signal,
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
            await downloadBytes(
              zipUrl,
              this.controller?.signal,
              remainingTimeout(deadline),
            ),
            safeBaseName(pdfPath),
          );
        }
      }
      throw new Error("MinerU 网页 API 超时");
    } finally {
      this.controller = undefined;
    }
  }

  /**
   * MinerU 4.1 task flow: create task -> upload bytes -> poll task -> download
   * the result archive. Returns undefined when the endpoint does not expose the
   * task API so the legacy v1 upload/job protocol can be attempted.
   */
  private async convertWithV1TasksApi(
    bytes: Uint8Array,
    fileName: string,
    pdfPath: string,
    deadline: number,
  ): Promise<MinerUConversionResult | undefined> {
    const endpoint = this.profile.selfHostedEndpoint;
    const created = await fetchWithTimeout(
      endpoint + "/v1/tasks",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tier: this.profile.tier,
          ocr_mode: this.profile.method,
          output_formats: ["default"],
          files: [
            {
              file_name: fileName,
              bytes: bytes.byteLength,
              sha256sum: await sha256Bytes(bytes),
            },
          ],
        }),
      },
      remainingTimeout(deadline),
      this.controller?.signal,
    );
    if ([404, 405].includes(created.status)) return undefined;
    if (!created.ok)
      throw new Error(
        "MinerU 任务创建失败：HTTP " +
          created.status +
          " " +
          tail(await created.text()),
      );
    const task = (await created.json()) as unknown as Record<string, unknown>;
    const taskID = String(task.task_id || "");
    const files = Array.isArray(task.files) ? task.files : [];
    const source = files[0] as Record<string, unknown> | undefined;
    const sourceID = String(source?.file_id || "");
    const upload = source?.upload as Record<string, unknown> | undefined;
    const uploadURL = String(upload?.url || "");
    if (!taskID || !sourceID || !uploadURL)
      throw new Error("MinerU 任务创建响应缺少上传信息");

    const uploadHeaders = {
      ...((upload?.headers as Record<string, string> | null) || {}),
      "content-type": "application/octet-stream",
    };
    const uploaded = await fetchWithTimeout(
      resolveMinerUUrl(endpoint, uploadURL),
      {
        method: String(upload?.method || "PUT").toUpperCase(),
        headers: uploadHeaders,
        body: bytes,
      },
      remainingTimeout(deadline),
      this.controller?.signal,
    );
    if (!uploaded.ok)
      throw new Error(
        "MinerU 上传失败：HTTP " +
          uploaded.status +
          " " +
          tail(await uploaded.text()),
      );

    while (Date.now() < deadline) {
      await delay(1500);
      const response = await fetchWithTimeout(
        endpoint + "/v1/tasks/" + encodeURIComponent(taskID),
        {},
        remainingTimeout(deadline),
        this.controller?.signal,
      );
      if (!response.ok)
        throw new Error("MinerU 任务查询失败：HTTP " + response.status);
      const status = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      const state = String(status.status || "").toLocaleLowerCase();
      if (["failed", "canceled"].includes(state))
        throw new Error(
          "MinerU 解析失败：" + (mineruTaskError(status) || state),
        );
      if (!["completed", "partial"].includes(state)) continue;

      const resultFiles = Array.isArray(status.files) ? status.files : [];
      const result = resultFiles.find((entry) => {
        const row = entry as Record<string, unknown> | undefined;
        return String(row?.file_id || "") === sourceID;
      }) as Record<string, unknown> | undefined;
      const resultStatus = String(result?.status || "").toLocaleLowerCase();
      const resultURL = String(result?.result_url || "");
      if (resultStatus === "failed" || !resultURL)
        throw new Error(
          "MinerU 解析失败：" +
            (mineruTaskError(result || status) || "没有结果下载地址"),
        );
      const resultResponse = await fetchWithTimeout(
        resolveMinerUUrl(endpoint, resultURL),
        {},
        remainingTimeout(deadline),
        this.controller?.signal,
      );
      if (!resultResponse.ok)
        throw new Error("MinerU 结果下载失败：HTTP " + resultResponse.status);
      return this.selfHostedResponse(resultResponse, pdfPath);
    }
    throw new Error("MinerU 任务超时");
  }

  /**
   * Legacy MinerU v1 flow: create upload -> put content -> complete -> parse
   * job -> poll -> download the result archive. Returns undefined when the
   * endpoint does not expose this API so the older 3.x protocol can be tried.
   */
  private async convertWithV1UploadApi(
    bytes: Uint8Array,
    fileName: string,
    pdfPath: string,
    deadline: number,
  ): Promise<MinerUConversionResult | undefined> {
    const endpoint = this.profile.selfHostedEndpoint;
    const created = await fetchWithTimeout(
      `${endpoint}/v1/uploads`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: fileName,
          bytes: bytes.byteLength,
          mime_type: "application/pdf",
          purpose: "parse",
        }),
      },
      remainingTimeout(deadline),
      this.controller?.signal,
    );
    if ([404, 405].includes(created.status)) return undefined;
    if (!created.ok)
      throw new Error(
        `MinerU 上传初始化失败：HTTP ${created.status} ${tail(await created.text())}`,
      );
    const upload = (await created.json()) as unknown as Record<string, unknown>;
    const uploadID = String(upload.id || "");
    if (!uploadID) throw new Error("MinerU 上传初始化没有返回 id");

    const uploaded = await fetchWithTimeout(
      String(
        upload.upload_url ||
          `${endpoint}/v1/uploads/${encodeURIComponent(uploadID)}/content`,
      ),
      {
        method: String(upload.upload_method || "PUT").toUpperCase(),
        headers: {
          "content-type": "application/pdf",
          ...((upload.upload_headers as Record<string, string> | null) || {}),
        },
        body: bytes,
      },
      remainingTimeout(deadline),
      this.controller?.signal,
    );
    if (!uploaded.ok)
      throw new Error(
        `MinerU 上传失败：HTTP ${uploaded.status} ${tail(await uploaded.text())}`,
      );

    const completed = await fetchWithTimeout(
      `${endpoint}/v1/uploads/${encodeURIComponent(uploadID)}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      remainingTimeout(deadline),
      this.controller?.signal,
    );
    if (!completed.ok)
      throw new Error(
        `MinerU 上传确认失败：HTTP ${completed.status} ${tail(await completed.text())}`,
      );
    const completedUpload = (await completed.json()) as unknown as Record<
      string,
      unknown
    >;
    const file = (completedUpload.file as Record<string, unknown> | null) || {};
    const fileID = String(file.id || "");
    if (!fileID) throw new Error("MinerU 上传完成但没有返回 file_id");

    const submitted = await fetchWithTimeout(
      `${endpoint}/v1/parse/jobs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          files: [{ source: { type: "file_id", file_id: fileID } }],
          tier: this.profile.tier,
          ocr_mode: this.profile.method,
          output_formats: ["markdown", "zip"],
        }),
      },
      remainingTimeout(deadline),
      this.controller?.signal,
    );
    if (!submitted.ok)
      throw new Error(
        `MinerU 解析任务创建失败：HTTP ${submitted.status} ${tail(await submitted.text())}`,
      );
    const job = (await submitted.json()) as unknown as Record<string, unknown>;
    const jobID = String(job.job_id || "");
    if (!jobID) throw new Error("MinerU 解析任务没有返回 job_id");

    while (Date.now() < deadline) {
      await delay(1500);
      const response = await fetchWithTimeout(
        `${endpoint}/v1/parse/jobs/${encodeURIComponent(jobID)}`,
        {},
        remainingTimeout(deadline),
        this.controller?.signal,
      );
      if (!response.ok)
        throw new Error(`MinerU 解析任务查询失败：HTTP ${response.status}`);
      const status = (await response.json()) as unknown as Record<
        string,
        unknown
      >;
      const state = String(status.status || "").toLocaleLowerCase();
      if (["failed", "canceled"].includes(state))
        throw new Error(
          `MinerU 解析失败：${mineruJobError(status) || "未知错误"}`,
        );
      if (!["completed", "partial"].includes(state)) continue;

      const archiveID = mineruJobOutputFileID(status, "zip");
      if (archiveID) {
        const archive = await fetchWithTimeout(
          `${endpoint}/v1/files/${encodeURIComponent(archiveID)}/content`,
          {},
          remainingTimeout(deadline),
          this.controller?.signal,
        );
        if (!archive.ok)
          throw new Error(`MinerU 结果下载失败：HTTP ${archive.status}`);
        return this.selfHostedResponse(archive, pdfPath);
      }
      const markdownID = mineruJobOutputFileID(status, "markdown");
      if (markdownID) {
        const markdownResponse = await fetchWithTimeout(
          `${endpoint}/v1/files/${encodeURIComponent(markdownID)}/content`,
          {},
          remainingTimeout(deadline),
          this.controller?.signal,
        );
        if (!markdownResponse.ok)
          throw new Error(
            `MinerU Markdown 下载失败：HTTP ${markdownResponse.status}`,
          );
        const markdown = new TextDecoder().decode(
          new Uint8Array(await markdownResponse.arrayBuffer()),
        );
        if (markdown.trim()) return { markdown, figures: [] };
      }
      throw new Error("MinerU 解析任务完成但没有可下载的结果");
    }
    throw new Error("MinerU 解析任务超时");
  }

  private async convertWithSelfHosted(
    pdfPath: string,
  ): Promise<MinerUConversionResult> {
    this.controller = createCompatibleAbortController();
    const deadline = Date.now() + this.profile.timeoutMs;
    try {
      const bytes = await mineruFileIO.read(pdfPath);
      const fileName = safeFilename(pdfPath);
      const taskResult = await this.convertWithV1TasksApi(
        bytes,
        fileName,
        pdfPath,
        deadline,
      );
      if (taskResult) return taskResult;
      const v1Result = await this.convertWithV1UploadApi(
        bytes,
        fileName,
        pdfPath,
        deadline,
      );
      if (v1Result) return v1Result;
      const directMultipart = this.selfHostedMultipart(bytes, fileName);
      const direct = await fetchWithTimeout(
        `${this.profile.selfHostedEndpoint}/file_parse`,
        {
          method: "POST",
          headers: { "content-type": directMultipart.contentType },
          body: directMultipart.body,
        },
        remainingTimeout(deadline),
        this.controller?.signal,
      );
      if (![404, 405].includes(direct.status)) {
        if (!direct.ok)
          throw new Error(
            `MinerU 本地解析失败：HTTP ${direct.status} ${tail(await direct.text())}`,
          );
        return this.selfHostedResponse(direct, pdfPath);
      }

      const taskMultipart = this.selfHostedMultipart(bytes, fileName);
      const submitted = await fetchWithTimeout(
        `${this.profile.selfHostedEndpoint}/tasks`,
        {
          method: "POST",
          headers: { "content-type": taskMultipart.contentType },
          body: taskMultipart.body,
        },
        remainingTimeout(deadline),
        this.controller?.signal,
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
        const response = await fetchWithTimeout(
          `${this.profile.selfHostedEndpoint}/tasks/${encodeURIComponent(taskID)}`,
          {},
          remainingTimeout(deadline),
          this.controller?.signal,
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
          const result = await fetchWithTimeout(
            `${this.profile.selfHostedEndpoint}/tasks/${encodeURIComponent(taskID)}/result`,
            {},
            remainingTimeout(deadline),
            this.controller?.signal,
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
    const directToken = this.profile.officialToken.trim();
    const environment = this.profile.officialTokenEnvironment.trim();
    if (!directToken && !isEnvironmentVariableName(environment)) {
      throw new Error(
        "MinerU API Token 未配置；请直接填写 API Token，或提供合法的环境变量名",
      );
    }
    const token =
      directToken || String(Services.env.get(environment) || "").trim();
    if (!token) {
      throw new Error(
        `未找到环境变量 ${environment}；请直接填写 API Token，或在启动 Zotero 前设置该环境变量`,
      );
    }
    return { Authorization: `Bearer ${token}` };
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
          timer = setTimeout(async () => {
            try {
              await process.kill(800);
            } finally {
              reject(
                new Error(
                  `外部进程运行超时：${PathUtils.filename(executable)}`,
                ),
              );
            }
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
      if (this.running === process && this.cancelled) {
        try {
          await process.kill(800);
        } catch {
          // Already exited.
        }
      }
      this.running = undefined;
    }
  }
}

function isEnvironmentVariableName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
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

/**
 * Locate the llm-for-zotero MinerU cache directory for a given source
 * attachment. Returns the per-attachment cache directory when it contains a
 * non-empty full.md, otherwise an empty string. The directory layout is
 * `<ZoteroDataDir>/llm-for-zotero-mineru/<attachmentID>/full.md`.
 */
export async function findLlmForZoteroMineruCache(
  attachmentID: number,
): Promise<string> {
  if (!Number.isFinite(attachmentID) || attachmentID <= 0) return "";
  const zotero = Zotero as unknown as {
    DataDirectory?: { dir?: string };
  };
  const dataDir = zotero.DataDirectory?.dir;
  if (!dataDir) return "";
  const itemDir = PathUtils.join(
    dataDir,
    LLM_FOR_ZOTERO_MINERU_CACHE_DIR,
    String(attachmentID),
  );
  const fullMdPath = PathUtils.join(itemDir, "full.md");
  try {
    if (!(await mineruFileIO.exists(fullMdPath))) return "";
    const markdown = toText(await mineruFileIO.readUTF8(fullMdPath));
    if (!markdown.trim()) return "";
    return itemDir;
  } catch {
    return "";
  }
}

/**
 * Read a cached llm-for-zotero MinerU result from its per-attachment cache
 * directory. Reuses the same manifest parsing (3.x content_list / 4.x structured)
 * backends so figure captions, page indices and bounding boxes are preserved.
 */
export async function mineruResultFromLlmForZoteroCache(
  itemDir: string,
): Promise<MinerUConversionResult> {
  const fullMdPath = PathUtils.join(itemDir, "full.md");
  const markdown = toText(await mineruFileIO.readUTF8(fullMdPath));
  if (!markdown.trim())
    throw new Error("llm-for-zotero MinerU 缓存中没有 Markdown");
  const paths = await findFiles(itemDir, () => true);
  const relativeNames = paths
    .map((path) => relativeLocalPath(itemDir, path))
    .filter(Boolean);
  const absoluteByRelativeName = new Map(
    paths
      .map((path) => [relativeLocalPath(itemDir, path), path] as const)
      .filter(([name]) => Boolean(name)),
  );
  const figureMap = new Map<string, MinerUParsedFigure>();
  for (const manifestPath of paths.filter((path) => isContentListName(path))) {
    let rows: unknown[];
    try {
      rows = mineruContentRows(
        JSON.parse(
          toText(await mineruFileIO.readUTF8(manifestPath)),
        ) as unknown,
      );
    } catch {
      continue;
    }
    const manifestName = relativeLocalPath(itemDir, manifestPath);
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
        bytes: await mineruFileIO.read(imagePath),
      });
    }
  }
  return { markdown, figures: [...figureMap.values()] };
}

export async function mineruResultFromDirectory(
  directory: string,
  preferredBaseName = "",
): Promise<MinerUConversionResult> {
  const paths = await findFiles(directory, () => true);
  const markdownPaths = paths.filter((path) => /\.md$/i.test(path));
  if (!markdownPaths.length) throw new Error("MinerU 结果目录中没有 Markdown");
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
          toText(await mineruFileIO.readUTF8(manifestPath)),
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
        bytes: await mineruFileIO.read(imagePath),
      });
    }
  }
  return {
    markdown: toText(await mineruFileIO.readUTF8(selected)),
    figures: [...figureMap.values()],
  };
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
  // 3.x emits *_content_list.json; 4.x replaced it with structured_content.json.
  return (
    /(?:^|[\\/])(?:[^\\/]+_)?content_list(?:_v\d+)?\.json$/i.test(path) ||
    /(?:^|[\\/])structured_content\.json$/i.test(path) ||
    /(?:^|[\\/])(?:(?:[^\\/]+_)?middle|middle_json)\.json$/i.test(path)
  );
}

async function endpointHealthy(endpoint: string): Promise<boolean> {
  // MinerU 4.x moved health checks to /v1/health; keep /health for 3.x servers.
  for (const path of ["/v1/health", "/health"]) {
    try {
      const response = await fetchWithTimeout(`${endpoint}${path}`, {}, 5_000);
      if (response.ok) return true;
    } catch {
      // Try the next candidate path.
    }
  }
  return false;
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
  const files = await readMinerUArchiveEntries(bytes);
  const decoder = new TextDecoder();
  const markdownEntries = files.filter((entry) => /\.md$/i.test(entry.name));
  const candidates = markdownEntries.map((entry) => ({
    name: entry.name,
    text: decoder.decode(entry.bytes),
  }));
  if (!candidates.length) throw new Error("MinerU 结果压缩包中没有 Markdown");
  candidates.sort(
    (a, b) =>
      markdownScore(b.name, preferredBaseName, b.text.length) -
      markdownScore(a.name, preferredBaseName, a.text.length),
  );
  const figureMap = new Map<string, MinerUParsedFigure>();
  const archiveNames = files.map((file) => file.name);
  for (const manifest of files.filter((entry) =>
    isContentListName(entry.name),
  )) {
    let content: unknown;
    try {
      content = JSON.parse(decoder.decode(manifest.bytes));
    } catch {
      continue;
    }
    const rows = mineruContentRows(content);
    for (const value of rows) {
      const descriptor = mineruFigureDescriptor(
        value,
        manifest.name,
        archiveNames,
      );
      if (!descriptor) continue;
      const imageEntry = files.find(
        (file) => file.name === descriptor.imageName,
      );
      if (!imageEntry) continue;
      figureMap.set(descriptor.id, { ...descriptor, bytes: imageEntry.bytes });
    }
  }
  return {
    markdown: candidates[0].text,
    figures: [...figureMap.values()],
    archive: bytes,
    archiveEntries: files,
    markdownArchivePath: candidates[0].name,
  };
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

function mineruJobOutputFileID(
  job: Record<string, unknown>,
  format: string,
): string {
  const files = Array.isArray(job.files) ? job.files : [];
  for (const entry of files) {
    const outputs = (entry as Record<string, unknown>)?.output_files as
      Record<string, unknown> | undefined;
    const target = outputs?.[format] as Record<string, unknown> | undefined;
    const fileID = String(target?.file_id || "");
    if (fileID) return fileID;
  }
  return "";
}

function mineruJobError(job: Record<string, unknown>): string {
  const files = Array.isArray(job.files) ? job.files : [];
  for (const entry of files) {
    const error = (entry as Record<string, unknown>)?.error as
      Record<string, unknown> | undefined;
    const message = String(error?.message || error?.code || "");
    if (message) return message;
  }
  return "";
}

function mineruTaskError(task: Record<string, unknown>): string {
  const direct = String(task.error || task.err_msg || "");
  if (direct) return direct;
  const files = Array.isArray(task.files) ? task.files : [];
  for (const entry of files) {
    const row = entry as Record<string, unknown> | undefined;
    const error = row?.error as Record<string, unknown> | undefined;
    const message = String(error?.message || error?.code || "");
    if (message) return message;
  }
  return "";
}

function resolveMinerUUrl(endpoint: string, value: string): string {
  try {
    return new URL(value, endpoint + "/").toString();
  } catch {
    return value;
  }
}

function mineruContentRows(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  const record = content as Record<string, unknown> | undefined;
  if (Array.isArray(record?.content_list))
    return record.content_list as unknown[];
  // MinerU 4.x structured_content.json: { pages: [{ page_idx, blocks: [...] }] }
  if (Array.isArray(record?.pages))
    return mineruStructuredRows(record.pages as unknown[]);
  return [];
}

function mineruStructuredRows(pages: unknown[]): unknown[] {
  const rows: unknown[] = [];
  for (const [fallbackIndex, page] of pages.entries()) {
    const pageRecord = page as Record<string, unknown>;
    const pageIndex = Number(pageRecord?.page_idx ?? fallbackIndex) || 0;
    const blocks = Array.isArray(pageRecord?.blocks)
      ? (pageRecord.blocks as unknown[])
      : [];
    for (const block of blocks) {
      const row = mineruStructuredRow(
        block as Record<string, unknown>,
        pageIndex,
      );
      if (row) rows.push(row);
    }
  }
  return rows;
}

function mineruStructuredRow(
  block: Record<string, unknown>,
  pageIndex: number,
): Record<string, unknown> | undefined {
  const blockType = String(block?.type || "").toLocaleLowerCase();
  if (!["image", "table", "chart"].includes(blockType)) return undefined;
  const nested = Array.isArray(block?.content)
    ? (block.content as Record<string, unknown>[])
    : [];
  // middle_json.json nests a <type>_body block carrying `image_path`;
  // structured_content.json stores the archive path in `image_source`.
  const payload =
    nested.find((entry) => entry?.image_path) ||
    ({
      image_path: block?.image_source || block?.image_path,
    } as Record<string, unknown>);
  const imagePath = String(payload?.image_path || "");
  if (!imagePath) return undefined;
  const captionKey =
    blockType === "table"
      ? "table_caption"
      : blockType === "chart"
        ? "chart_caption"
        : "image_caption";
  const captions = nested
    .filter((entry) =>
      String(entry?.type || "")
        .toLocaleLowerCase()
        .startsWith(`${blockType}_caption`),
    )
    .flatMap((entry) =>
      Array.isArray(entry?.content)
        ? (entry.content as Record<string, unknown>[]).map((item) =>
            String(item?.content || ""),
          )
        : [String(entry?.content || "")],
    )
    .filter(Boolean);
  // structured_content.json keeps captions in a dedicated array instead.
  const inlineCaptions = captions.length
    ? captions
    : Array.isArray(block?.captions)
      ? (block.captions as Record<string, unknown>[])
          .map((entry) => String(entry?.content || ""))
          .filter(Boolean)
      : [];
  return {
    type: blockType,
    page_idx: pageIndex,
    bbox: block.bbox,
    img_path: imagePath,
    [captionKey]: inlineCaptions,
  };
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
    id: `mineru:${kind}:${encodeURIComponent(normalizeArchivePath(String(row.zrdb_original_img_path || imagePath)))}`,
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
  // @types/node 26 typed Uint8Array as Uint8Array<ArrayBufferLike>; hashing
  // requires a plain ArrayBuffer view.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  const paths = await mineruFileIO.getChildren(directory);
  const output: string[] = [];
  for (const path of paths) {
    const stat = await mineruFileIO.stat(path);
    if (stat.type === "directory")
      output.push(...(await findFiles(path, accept, depth + 1)));
    else if (accept(path)) output.push(path);
  }
  return output;
}

async function jsonResponse(
  response: Response,
  action: string,
  allowedErrorCodes: number[] = [],
): Promise<Record<string, any>> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error(`${action}失败：${responseFailureDetail(response, body)}`, {
      cause: error,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${action}失败：${responseFailureDetail(response, body)}`);
  }
  const value = parsed as Record<string, any>;
  if ([401, 403].includes(response.status))
    throw new Error(
      `${action}失败：HTTP ${response.status}；MinerU 认证失败，请检查 API Token`,
    );
  const code = "code" in value ? Number(value.code) : 0;
  if (!response.ok || (code !== 0 && !allowedErrorCodes.includes(code))) {
    throw new Error(`${action}失败：${value.msg || `HTTP ${response.status}`}`);
  }
  return value;
}

function responseFailureDetail(response: Response, body: string): string {
  if ([401, 403].includes(response.status))
    return `HTTP ${response.status}；MinerU 认证失败，请检查 API Token`;
  const excerpt = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return `HTTP ${response.status}；${excerpt || (body.trim() ? "服务返回了非 JSON 响应" : "服务返回了空响应")}`;
}

async function downloadBytes(
  url: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<Uint8Array> {
  const response = await fetchWithTimeout(url, {}, timeoutMs, signal);
  if (!response.ok)
    throw new Error(`下载 MinerU 结果失败：HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<Response> {
  if (parentSignal?.aborted) throw new Error("MinerU 请求已取消");
  const controller = createCompatibleAbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let parentListener: (() => void) | undefined;
  const signal = controller?.signal || parentSignal;
  if (controller && parentSignal) {
    parentListener = () => controller.abort();
    parentSignal.addEventListener("abort", parentListener, { once: true });
  }
  const request = fetch(input, signal ? { ...init, signal } : init);
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        controller?.abort();
        reject(new Error("MinerU 网络请求超时"));
      },
      Math.max(1, timeoutMs),
    );
  });
  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (timedOut) throw new Error("MinerU 网络请求超时", { cause: error });
    if (parentSignal?.aborted)
      throw new Error("MinerU 请求已取消", { cause: error });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (parentSignal && parentListener)
      parentSignal.removeEventListener("abort", parentListener);
  }
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function normalizeOfficialEndpoint(value: string): string {
  return normalizeEndpoint(value).replace(
    /\/(?:file-urls\/batch|extract\/task(?:\/[^/]+)?|extract-results\/batch(?:\/[^/]+)?)$/i,
    "",
  );
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

/** PathUtils.filename throws NS_ERROR_FILE_UNRECOGNIZED_PATH for bare names. */
function safeFilename(path: string): string {
  try {
    return PathUtils.filename(path);
  } catch {
    return String(path).split(/[\\/]/).filter(Boolean).at(-1) || "";
  }
}

function safeBaseName(path: string): string {
  const base = safeFilename(path)
    .replace(/\.pdf$/i, "")
    .replace(/[<>:"/\\|?*]/g, "_");
  return [...base]
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .slice(0, 120);
}

function modeLabel(mode: MinerUMode): string {
  if (mode === "official-api") return "网页 API";
  return "本地部署";
}

function getSubprocess(): SubprocessAPI {
  return (ChromeUtils.importESModule(SUBPROCESS_MODULE) as any)
    .Subprocess as SubprocessAPI;
}

export function dockerDesktopExecutableCandidates(
  platform: string,
  environment: Record<string, string | undefined>,
  joinPath: (...parts: string[]) => string = (...parts) =>
    PathUtils.join(...parts),
): string[] {
  if (platform === "WINNT") {
    const candidates: string[] = [];
    for (const root of [
      environment.ProgramFiles,
      environment["ProgramFiles(x86)"],
      environment.LOCALAPPDATA
        ? joinPath(environment.LOCALAPPDATA, "Programs")
        : undefined,
    ]) {
      if (root)
        candidates.push(
          joinPath(root, "Docker", "Docker", "Docker Desktop.exe"),
        );
    }
    return candidates;
  }
  if (platform === "Darwin")
    return ["/Applications/Docker.app/Contents/MacOS/Docker"];
  return ["/usr/bin/docker-desktop", "/usr/local/bin/docker-desktop"];
}

async function findDockerDesktopExecutable(): Promise<string> {
  const platform = Services.appinfo.OS;
  const environment = {
    ProgramFiles: Services.env.get("ProgramFiles"),
    "ProgramFiles(x86)": Services.env.get("ProgramFiles(x86)"),
    LOCALAPPDATA: Services.env.get("LOCALAPPDATA"),
  };
  const candidates = dockerDesktopExecutableCandidates(platform, environment);
  for (const candidate of candidates) {
    if (await mineruFileIO.exists(candidate)) return candidate;
  }
  throw new Error(
    "未找到 Docker Desktop；请安装 Docker Desktop，或在设置中填写其可执行文件路径",
  );
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
