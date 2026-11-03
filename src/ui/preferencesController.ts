import {
  createDefaultLayout,
  createID,
  TRANSLATED_TITLE_FIELD_ID,
} from "../domain/defaults";
import type { FieldDefinition, WorkspaceState } from "../domain/types";
import {
  getSharedVisibleColumnIDs,
  syncSharedVisibleColumnIDs,
} from "../core/viewLayout";
import { nativeColumns } from "./features/table/tableColumns";
import {
  createAgentBridge,
  listOpenAICompatibleModels,
  listOllamaModels,
  type AgentProfile,
} from "../services/externalAgent";
import {
  AGENT_PRESETS,
  getAgentModelPresets,
  parseAgentProfile,
} from "../services/agentSettings";
import {
  readLocalCodexModelCatalog,
  resolveCatalogModelId,
} from "../services/codexModels";
import {
  MinerUConversionService,
  parseMinerUProfile,
} from "../services/mineru";
import { ResearchRepository } from "../storage/repository";
import { getPref, setPref } from "../utils/prefs";
import { getDataRoot, setDataRoot } from "../storage/dataRoot";
import {
  flushPortableSettings,
  initializePortableSettings,
} from "../storage/settingsStore";
import {
  getArtifactStorageRoot,
  getCanonicalArtifactStorageRoot,
  migrateStoredArtifacts,
  openArtifactStorageDirectory,
  relocateArtifactStorageRoot,
  scanBrokenArtifactLinks,
  setArtifactStorageRoot,
} from "../services/artifactStorage";
import {
  ensureArtifactImportToken,
  rotateArtifactImportToken,
} from "../services/artifactEndpoint";
import { copyPlainText } from "../services/clipboard";

const prefKeys = [
  "defaultRowHeight",
  "defaultView",
  "hideMinerUArtifactsInNativeList",
  "motionEnabled",
  "density",
  "cornerStrength",
  "shadowStrength",
  "defaultExportScope",
  "viewTogglePosition",
  "artifactStorageRoot",
  "dataRoot",
  "zoteroFigureEnabled",
  "zoteroFigureShowFigures",
  "zoteroFigureShowTables",
  "zoteroFigureShowFormulas",
  "mineruFigureFallback",
  "figureImageQuality",
  "agentKind",
  "agentExecutable",
  "agentArgs",
  "agentEndpoint",
  "agentApiKey",
  "agentModel",
  "agentTimeoutMs",
  "mineruMode",
  "mineruSharedStoreDirectory",
  "mineruOfficialEndpoint",
  "mineruOfficialToken",
  "mineruOfficialTokenEnvironment",
  "mineruSelfHostedEndpoint",
  "mineruSelfHostedAutoStart",
  "mineruSelfHostedProjectDirectory",
  "mineruDockerExecutable",
  "mineruDockerDesktopExecutable",
  "mineruBackend",
  "mineruTier",
  "mineruMethod",
  "mineruModelVersion",
  "mineruLanguage",
  "mineruEnableFormula",
  "mineruEnableTable",
  "mineruTimeoutMs",
  "mineruReuseLlmForZoteroCache",
] as const;

function cloneFields(fields: FieldDefinition[]): FieldDefinition[] {
  return JSON.parse(JSON.stringify(fields)) as FieldDefinition[];
}

function isCheckboxControl(
  control: HTMLInputElement | HTMLSelectElement,
): control is HTMLInputElement {
  // Zotero loads XHTML inputs as <html:input>; tagName includes that prefix.
  return control.localName === "input" && control.type === "checkbox";
}

function inputValue(root: Element, key: string): string | boolean {
  const control = root.querySelector(`[data-pref="${key}"]`) as
    HTMLInputElement | HTMLSelectElement | null;
  if (!control) return "";
  return isCheckboxControl(control) ? control.checked : control.value;
}

export class PreferencesController {
  private repository = new ResearchRepository();
  private workspace?: WorkspaceState;
  private fields: FieldDefinition[] = [];
  private visibleColumnIDs: string[] = [];
  private root?: HTMLElement;
  private savingLocalSettings = false;
  private agentTesting = false;
  private agentModelRequestId = 0;

  constructor(private win: Window) {}

  async mount(): Promise<void> {
    const root = this.win.document.getElementById(
      "zrdb-preferences-root",
    ) as HTMLElement | null;
    if (!root || root.dataset.zrdbBound === "1") return;
    this.root = root;
    root.dataset.zrdbBound = "1";
    this.bindTabBar();
    this.loadLocalControls();
    this.bindLocalControls();
    this.bindAgentTests();
    this.bindAgentModelPicker();
    this.bindArtifactImportToken();
    this.bindModeControls();
    this.updateModeVisibility();
    this.workspace = await this.repository.loadWorkspace();
    this.fields = cloneFields(this.workspace.fields);
    this.visibleColumnIDs = getSharedVisibleColumnIDs(
      this.workspace.views,
      createDefaultLayout().visibleColumnIDs,
    );
    if (!this.workspace.views.length) {
      this.visibleColumnIDs = [
        ...new Set([
          ...this.visibleColumnIDs,
          ...this.fields
            .filter((field) => !field.archived)
            .map((field) => field.id),
        ]),
      ];
    }
    this.renderFields();
    this.bindWorkspaceActions();
  }

  private status(message: string): void {
    const target = this.root?.querySelector<HTMLElement>("#zrdb-pref-status");
    if (target) target.textContent = message;
  }

  private bindTabBar(): void {
    if (!this.root) return;
    const tabs: HTMLElement[] = Array.from(
      this.root.querySelectorAll<HTMLElement>(".zrdb-pref-tab"),
    );
    const panels: HTMLElement[] = Array.from(
      this.root.querySelectorAll<HTMLElement>(".zrdb-pref-panel"),
    );
    const select = (tab: HTMLElement): void => {
      const target = tab.dataset.prefTab;
      for (const entry of tabs) {
        const active = entry === tab;
        entry.classList.toggle("is-active", active);
        entry.setAttribute("aria-selected", String(active));
      }
      for (const panel of panels)
        panel.hidden = panel.dataset.prefPanel !== target;
    };
    for (const tab of tabs) tab.addEventListener("click", () => select(tab));
  }

  private loadLocalControls(): void {
    if (!this.root) return;
    for (const key of prefKeys) {
      const control = this.root.querySelector(`[data-pref="${key}"]`) as
        HTMLInputElement | HTMLSelectElement | null;
      if (!control) continue;
      const value = getPref(key);
      if (isCheckboxControl(control)) control.checked = Boolean(value);
      else
        control.value =
          key === "defaultView" && value === "cards"
            ? "table"
            : String(value ?? "");
    }
  }

  private bindLocalControls(): void {
    this.root
      ?.querySelector("#zrdb-pref-save")
      ?.addEventListener("click", () => {
        void this.saveLocalSettings();
      });
    this.root
      ?.querySelector("#zrdb-data-root-pick")
      ?.addEventListener("click", () => {
        void this.pickDataRoot();
      });
    this.root
      ?.querySelector("#zrdb-data-root-open")
      ?.addEventListener("click", () => {
        void this.openDataRoot();
      });
    this.root
      ?.querySelector("#zrdb-artifact-root-pick")
      ?.addEventListener("click", () => {
        void this.pickArtifactStorageRoot();
      });
    this.root
      ?.querySelector("#zrdb-artifact-root-open")
      ?.addEventListener("click", () => {
        void this.openArtifactStorageRoot();
      });
    this.root
      ?.querySelector("#zrdb-artifact-migrate")
      ?.addEventListener("click", () => {
        void this.migrateArtifacts();
      });
    this.root
      ?.querySelector("#zrdb-artifact-scan")
      ?.addEventListener("click", () => {
        void this.scanArtifacts();
      });
  }

  private async saveLocalSettings(): Promise<void> {
    if (!this.root || this.savingLocalSettings) return;
    this.savingLocalSettings = true;
    const button =
      this.root.querySelector<HTMLButtonElement>("#zrdb-pref-save");
    if (button) button.disabled = true;
    try {
      this.profileFromControls();
      const mineruProfile = this.mineruProfileFromControls();
      // Initialization is cached; do not reload the file over unsaved edits.
      await initializePortableSettings();
      const requestedRoot = String(
        inputValue(this.root, "dataRoot") || "",
      ).trim();
      const previousRoot = String(getPref("dataRoot") || "").trim();
      for (const key of prefKeys) {
        if (key === "dataRoot") continue;
        const raw =
          key === "mineruOfficialEndpoint"
            ? mineruProfile.officialEndpoint
            : inputValue(this.root, key);
        const value = [
          "defaultRowHeight",
          "agentTimeoutMs",
          "mineruTimeoutMs",
        ].includes(key)
          ? Math.max(0, Number(raw))
          : key === "artifactStorageRoot"
            ? setArtifactStorageRoot(String(raw))
            : raw;
        setPref(key, value as never);
      }
      await flushPortableSettings();
      if (requestedRoot !== previousRoot) setDataRoot(requestedRoot);
      const officialEndpointControl = this.root.querySelector<HTMLInputElement>(
        '[data-pref="mineruOfficialEndpoint"]',
      );
      if (officialEndpointControl)
        officialEndpointControl.value = mineruProfile.officialEndpoint;
      this.status(
        requestedRoot !== previousRoot
          ? "已保存本机设置；研究数据库目录将在重启 Zotero 后切换"
          : "已保存本机设置",
      );
      if (this.root.querySelector('[data-pref-tab="agent"].is-active'))
        await this.testAgent(false);
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
    } finally {
      this.savingLocalSettings = false;
      if (button) button.disabled = false;
    }
  }

  private async pickDataRoot(): Promise<void> {
    try {
      const path = await new addon.data.ztoolkit.FilePicker(
        "选择研究数据库目录",
        "folder",
        undefined,
        undefined,
        this.win,
      ).open();
      if (!path || Array.isArray(path)) {
        this.status("已取消选择研究数据库目录");
        return;
      }
      const input = this.root?.querySelector<HTMLInputElement>(
        '[data-pref="dataRoot"]',
      );
      if (input) input.value = path;
      this.status(
        `已选择研究数据库目录：${path}；请点击“保存本机设置”，重启后生效`,
      );
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
    }
  }

  private async openDataRoot(): Promise<void> {
    try {
      const root = getDataRoot();
      if (!root) throw new Error("请先设置研究数据库目录");
      await IOUtils.makeDirectory(root, {
        createAncestors: true,
        ignoreExisting: true,
      });
      await Zotero.launchFile(root);
      this.status(`已打开研究数据库目录：${root}`);
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
    }
  }

  private async pickArtifactStorageRoot(): Promise<void> {
    try {
      const path = await new addon.data.ztoolkit.FilePicker(
        "选择研究产物根目录",
        "folder",
        undefined,
        undefined,
        this.win,
      ).open();
      if (!path || Array.isArray(path)) {
        this.status("已取消选择产物根目录");
        return;
      }
      const root = setArtifactStorageRoot(path);
      const input = this.root?.querySelector<HTMLInputElement>(
        '[data-pref="artifactStorageRoot"]',
      );
      if (input) input.value = root;
      this.status(`已选择研究产物根目录：${root}；请点击“保存本机设置”`);
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
    }
  }

  private async openArtifactStorageRoot(): Promise<void> {
    try {
      const root = await openArtifactStorageDirectory();
      this.status(`已打开研究产物目录：${root}`);
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
    }
  }

  private async migrateArtifacts(): Promise<void> {
    try {
      if (!this.root) return;
      const value = String(inputValue(this.root, "artifactStorageRoot") || "");
      setArtifactStorageRoot(value);
      this.status("正在迁移已有插件产物；主 PDF 不会迁移……");
      const canonical = getCanonicalArtifactStorageRoot();
      const legacy = value.trim();
      const report =
        canonical && legacy && canonical !== legacy
          ? await relocateArtifactStorageRoot(
              legacy,
              canonical,
              this.repository,
            )
          : await migrateStoredArtifacts(this.repository);
      const failure = report.failures.length
        ? `；失败 ${report.failures.length} 项`
        : "";
      this.status(
        `产物迁移完成：迁移 ${report.migrated}，已是 linked file ${report.skipped}，断链 ${report.broken}${failure}`,
      );
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
    }
  }

  private async scanArtifacts(): Promise<void> {
    try {
      const broken = await scanBrokenArtifactLinks();
      this.status(
        broken.length
          ? `断链检测发现 ${broken.length} 个缺失的 linked file：${broken
              .slice(0, 3)
              .map((entry) => `${entry.itemKey}/${entry.attachmentKey}`)
              .join("、")}`
          : `断链检测完成：未发现问题（产物根目录：${getArtifactStorageRoot() || "未设置"}）`,
      );
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
    }
  }

  private bindAgentTests(): void {
    this.root
      ?.querySelector("#zrdb-agent-test")
      ?.addEventListener("click", () => {
        void this.testAgent(false);
      });
    this.root
      ?.querySelector("#zrdb-agent-json-test")
      ?.addEventListener("click", () => {
        void this.testAgent(true);
      });
    this.root
      ?.querySelector("#zrdb-mineru-test")
      ?.addEventListener("click", () => {
        void this.testMinerU();
      });
  }

  private bindArtifactImportToken(): void {
    const token = this.root?.querySelector<HTMLInputElement>(
      "#zrdb-artifact-import-token",
    );
    const refresh = () => {
      if (token) token.value = ensureArtifactImportToken();
    };
    refresh();
    this.root
      ?.querySelector("#zrdb-artifact-token-copy")
      ?.addEventListener("click", () => {
        void copyPlainText(
          token?.value || ensureArtifactImportToken(),
          this.win.document,
        ).then((ok) =>
          this.status(ok ? "接口令牌已复制" : "复制失败，请手动复制"),
        );
      });
    this.root
      ?.querySelector("#zrdb-artifact-token-rotate")
      ?.addEventListener("click", () => {
        if (token) token.value = rotateArtifactImportToken();
        this.status("接口令牌已轮换；旧令牌立即失效");
      });
  }

  private bindModeControls(): void {
    const agentKind = this.root?.querySelector<HTMLSelectElement>(
      '[data-pref="agentKind"]',
    );
    agentKind?.addEventListener("change", () => {
      const kind = agentKind.value;
      if (kind === "claude-code") {
        const preset = AGENT_PRESETS[kind];
        const executable = this.root?.querySelector<HTMLInputElement>(
          '[data-pref="agentExecutable"]',
        );
        const endpoint = this.root?.querySelector<HTMLInputElement>(
          '[data-pref="agentEndpoint"]',
        );
        if (executable) executable.value = preset.executable || "";
        if (endpoint) endpoint.value = preset.endpoint || "";
      }
      if (kind === "ollama" || kind === "openai-compatible") {
        const endpoint = this.root?.querySelector<HTMLInputElement>(
          '[data-pref="agentEndpoint"]',
        );
        if (endpoint)
          endpoint.value =
            kind === "openai-compatible"
              ? "https://api.openai.com/v1"
              : "http://127.0.0.1:11434";
      }
      this.updateModeVisibility();
      void this.refreshAgentModelOptions();
    });
    this.root
      ?.querySelector('[data-pref="mineruMode"]')
      ?.addEventListener("change", () => this.updateModeVisibility());
  }

  /** Populate a real select so model choices are discoverable in Zotero's XHTML UI. */
  private bindAgentModelPicker(): void {
    if (!this.root) return;
    const select = this.root.querySelector<HTMLSelectElement>(
      "#zrdb-agent-model-select",
    );
    const input = this.root.querySelector<HTMLInputElement>(
      "#zrdb-agent-model-custom",
    );
    if (!select || !input) return;
    const syncFromSelect = (): void => {
      const custom = select.value === "__custom__";
      input.hidden = !custom;
      if (!custom) input.value = select.value;
    };
    select.addEventListener("change", syncFromSelect);
    input.addEventListener("input", () => {
      if (select.value !== "__custom__") select.value = "__custom__";
    });
    this.root
      .querySelector("#zrdb-agent-model-refresh")
      ?.addEventListener("click", () => {
        void this.refreshAgentModelOptions();
      });
    for (const selector of [
      '[data-pref="agentEndpoint"]',
      '[data-pref="agentApiKey"]',
    ])
      this.root.querySelector(selector)?.addEventListener("change", () => {
        if (
          ["ollama", "openai-compatible"].includes(
            String(inputValue(this.root!, "agentKind")),
          )
        )
          void this.refreshAgentModelOptions();
      });
    void this.refreshAgentModelOptions();
  }

  private async refreshAgentModelOptions(): Promise<void> {
    if (!this.root) return;
    const input = this.root.querySelector<HTMLInputElement>(
      "#zrdb-agent-model-custom",
    );
    const select = this.root.querySelector<HTMLSelectElement>(
      "#zrdb-agent-model-select",
    );
    if (!input || !select) return;
    const kind = String(
      inputValue(this.root, "agentKind"),
    ) as AgentProfile["kind"];
    const requestId = ++this.agentModelRequestId;
    const presets = [...getAgentModelPresets(kind)];
    let options = presets;
    let codexHint = "";
    let modelLoadHint = "";
    if (kind === "codex-cli") {
      const catalog = await readLocalCodexModelCatalog().catch(() => ({
        models: [],
        defaultModel: undefined,
      }));
      const catalogOptions = catalog.models.map((model) => ({
        value: model.value,
        label:
          model.value === catalog.defaultModel
            ? `${model.label}（本机默认）`
            : model.label,
      }));
      if (catalogOptions.length)
        options = [
          ...presets.slice(0, 1),
          ...catalogOptions,
          ...presets
            .slice(1)
            .filter(
              (preset) =>
                !catalogOptions.some((option) => option.value === preset.value),
            ),
        ];
      const chosen = input.value.trim();
      const resolved = resolveCatalogModelId(chosen, catalog.models);
      if (resolved && resolved !== chosen) {
        // Repair the stored short name once, so the setting stops carrying a value
        // the relay provider rejects and the picker shows the real id.
        codexHint = `本机实际模型 ID 是 ${resolved}，已自动改用并保存。`;
        input.value = resolved;
        setPref("agentModel", resolved);
      } else if (chosen && !resolved) {
        codexHint = "该模型不在本机 Codex 可用列表中，运行可能失败。";
      }
    }
    if (kind === "ollama" || kind === "openai-compatible") {
      try {
        const endpoint = String(inputValue(this.root, "agentEndpoint") || "");
        const timeout = Number(inputValue(this.root, "agentTimeoutMs"));
        const requestTimeout =
          Number.isFinite(timeout) && timeout >= 1000
            ? Math.min(timeout, 30_000)
            : 10_000;
        const models =
          kind === "ollama"
            ? await listOllamaModels(endpoint || undefined, requestTimeout)
            : await listOpenAICompatibleModels(
                endpoint || undefined,
                String(inputValue(this.root, "agentApiKey") || ""),
                requestTimeout,
              );
        for (const model of models)
          if (!options.some((option) => option.value === model))
            options.push({ value: model, label: model });
      } catch (error) {
        modelLoadHint = `模型列表读取失败：${error instanceof Error ? error.message : String(error)}；可选择“自定义模型”手动填写。`;
      }
    }
    if (requestId !== this.agentModelRequestId) return;
    const current = input.value.trim();
    const isKnown = options.some((option) => option.value === current);
    const customOption = { value: "__custom__", label: "自定义模型…" };
    const visibleOptions = [...options, customOption];
    if (current && !isKnown)
      visibleOptions.splice(visibleOptions.length - 1, 0, {
        value: current,
        label: `${current}（当前值）`,
      });
    select.replaceChildren(
      ...visibleOptions.map((option) => {
        const element = this.win.document.createElement("option");
        element.value = option.value;
        element.label = option.label;
        element.textContent = option.label;
        return element;
      }),
    );
    if (current && isKnown) select.value = current;
    else if (current) select.value = "__custom__";
    else if (kind === "ollama" || kind === "openai-compatible")
      select.value = "__custom__";
    else select.value = options[0]?.value || "";
    input.hidden = select.value !== "__custom__";
    const help = this.root.querySelector<HTMLElement>("#zrdb-agent-model-help");
    if (help)
      help.textContent =
        codexHint ||
        modelLoadHint ||
        (kind === "openai-compatible"
          ? "点击“刷新模型列表”读取服务可用模型，也可以手动填写模型 ID。"
          : "") ||
        (kind === "ollama"
          ? "可从本机 Ollama 读取模型；未启动服务时也可以手动填写。"
          : "从列表直接选择；只有使用新模型或自建模型时才选择“自定义模型”。");
  }

  private updateModeVisibility(): void {
    if (!this.root) return;
    const agentKind = String(inputValue(this.root, "agentKind"));
    const mineruMode = String(inputValue(this.root, "mineruMode"));
    for (const element of this.root.querySelectorAll<HTMLElement>(
      "[data-agent-kinds]",
    ))
      element.hidden = !String(element.dataset.agentKinds || "")
        .split(/\s+/)
        .includes(agentKind);
    for (const element of this.root.querySelectorAll<HTMLElement>(
      "[data-mineru-modes]",
    ))
      element.hidden = !String(element.dataset.mineruModes || "")
        .split(/\s+/)
        .includes(mineruMode);
    const endpointLabel = this.root.querySelector<HTMLElement>(
      '[data-agent-endpoint-label="true"]',
    );
    const endpointInput = this.root.querySelector<HTMLInputElement>(
      '[data-pref="agentEndpoint"]',
    );
    const openAICompatible = agentKind === "openai-compatible";
    if (endpointLabel)
      endpointLabel.textContent = openAICompatible
        ? "API 地址（Base URL）"
        : "本机服务地址";
    if (endpointInput)
      endpointInput.placeholder = openAICompatible
        ? "https://api.openai.com/v1"
        : "http://127.0.0.1:11434";
    const currentName = this.root.querySelector<HTMLElement>(
      "#zrdb-agent-current-name",
    );
    if (currentName)
      currentName.textContent =
        this.root.querySelector<HTMLSelectElement>('[data-pref="agentKind"]')
          ?.selectedOptions[0]?.textContent || "论文处理助手";
  }

  private async testMinerU(): Promise<void> {
    try {
      this.status("正在连接 MinerU……");
      const result = await new MinerUConversionService(
        this.mineruProfileFromControls(),
      ).probe();
      this.status(`MinerU 连接成功：${result}`);
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
    }
  }

  private async testAgent(structured: boolean): Promise<void> {
    if (this.agentTesting) return;
    const buttons = [
      this.root?.querySelector<HTMLButtonElement>("#zrdb-agent-test"),
      this.root?.querySelector<HTMLButtonElement>("#zrdb-agent-json-test"),
    ].filter((button): button is HTMLButtonElement => Boolean(button));
    this.agentTesting = true;
    for (const button of buttons) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    const card = this.root?.querySelector<HTMLElement>(
      "#zrdb-agent-status-card",
    );
    const label = this.root?.querySelector<HTMLElement>(
      "#zrdb-agent-current-status",
    );
    if (card) card.className = "zrdb-agent-status-card is-checking";
    if (label)
      label.textContent = structured ? "正在检查输出…" : "正在检查助手…";
    try {
      const agent = createAgentBridge(this.profileFromControls());
      let result: { executable: string; version: string } | undefined;
      if (structured) {
        await agent.testStructuredOutput();
      } else {
        result = await agent.probe();
        await agent.testStructuredOutput();
      }
      if (card) card.className = "zrdb-agent-status-card is-ready";
      if (label) label.textContent = "可用，可以开始提取论文";
      this.status(
        structured
          ? "输出检查通过"
          : `助手可用：${result?.version || result?.executable}`,
      );
    } catch (error) {
      if (card) card.className = "zrdb-agent-status-card is-error";
      if (label) label.textContent = "需要修复";
      const message = error instanceof Error ? error.message : String(error);
      this.status(
        /请在|请选择|请先/.test(message)
          ? message
          : `${message}；请检查高级设置或启动本机服务`,
      );
    } finally {
      this.agentTesting = false;
      for (const button of buttons) {
        button.disabled = false;
        button.setAttribute("aria-busy", "false");
      }
    }
  }

  private profileFromControls(): AgentProfile {
    if (!this.root) throw new Error("设置页面尚未加载");
    return parseAgentProfile({
      kind: inputValue(this.root, "agentKind"),
      executable: inputValue(this.root, "agentExecutable"),
      args: inputValue(this.root, "agentArgs"),
      endpoint: inputValue(this.root, "agentEndpoint"),
      apiKey: inputValue(this.root, "agentApiKey"),
      model: inputValue(this.root, "agentModel"),
      timeoutMs: inputValue(this.root, "agentTimeoutMs"),
    });
  }

  private mineruProfileFromControls() {
    if (!this.root) throw new Error("设置页面尚未加载");
    return parseMinerUProfile({
      mode: inputValue(this.root, "mineruMode"),
      sharedStoreDirectory: inputValue(this.root, "mineruSharedStoreDirectory"),
      officialEndpoint: inputValue(this.root, "mineruOfficialEndpoint"),
      officialToken: inputValue(this.root, "mineruOfficialToken"),
      officialTokenEnvironment: inputValue(
        this.root,
        "mineruOfficialTokenEnvironment",
      ),
      selfHostedEndpoint: inputValue(this.root, "mineruSelfHostedEndpoint"),
      selfHostedAutoStart: inputValue(this.root, "mineruSelfHostedAutoStart"),
      selfHostedProjectDirectory: inputValue(
        this.root,
        "mineruSelfHostedProjectDirectory",
      ),
      dockerExecutable: inputValue(this.root, "mineruDockerExecutable"),
      dockerDesktopExecutable: inputValue(
        this.root,
        "mineruDockerDesktopExecutable",
      ),
      backend: inputValue(this.root, "mineruBackend"),
      tier: inputValue(this.root, "mineruTier"),
      method: inputValue(this.root, "mineruMethod"),
      modelVersion: inputValue(this.root, "mineruModelVersion"),
      language: inputValue(this.root, "mineruLanguage"),
      enableFormula: inputValue(this.root, "mineruEnableFormula"),
      enableTable: inputValue(this.root, "mineruEnableTable"),
      timeoutMs: inputValue(this.root, "mineruTimeoutMs"),
    });
  }

  private renderFields(): void {
    const container =
      this.root?.querySelector<HTMLElement>("#zrdb-fields-list");
    if (!container) return;
    container.replaceChildren();
    for (const column of nativeColumns)
      container.append(this.createNativeColumnRow(column.id, column.label));
    for (const field of this.fields.filter(
      (field) => !field.archived && field.id !== TRANSLATED_TITLE_FIELD_ID,
    ))
      container.append(this.createFieldRow(field));
    this.renderArchivedFields();
  }

  private createNativeColumnRow(id: string, label: string): HTMLElement {
    const row = this.win.document.createElement("div");
    row.className = "zrdb-pref-native-column";
    row.dataset.columnId = id;
    const name = this.win.document.createElement("strong");
    name.textContent = label;
    row.append(name, this.createVisibilityControl(id));
    return row;
  }

  private createVisibilityControl(id: string): HTMLLabelElement {
    const label = this.win.document.createElement("label");
    label.className = "zrdb-pref-visibility";
    const checkbox = this.win.document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.columnVisibility = id;
    checkbox.checked = this.visibleColumnIDs.includes(id);
    checkbox.addEventListener("change", () => {
      const visible = new Set(this.visibleColumnIDs);
      if (checkbox.checked) visible.add(id);
      else visible.delete(id);
      this.visibleColumnIDs = [...visible];
    });
    label.append(checkbox, this.win.document.createTextNode(" 显示"));
    return label;
  }

  private createFieldRow(field: FieldDefinition): HTMLElement {
    const row = this.win.document.createElement("div");
    row.className = "zrdb-pref-field";
    row.dataset.fieldId = field.id;
    const name = this.textInput(field.name, "自定义标题", (value) => {
      field.name = value;
    });
    const prompt = this.win.document.createElement("textarea");
    prompt.placeholder = "给 Agent 的提取提示词";
    prompt.setAttribute("aria-label", "给 Agent 的提示词");
    prompt.value = field.extraction.instruction;
    prompt.addEventListener("change", () => {
      field.extraction.instruction = prompt.value;
      field.extraction.templateVersion += 1;
    });
    const archive = this.win.document.createElement("button");
    archive.type = "button";
    archive.className = "zrdb-field-delete";
    archive.textContent = "删除";
    archive.addEventListener("click", () => {
      field.archived = true;
      this.renderFields();
    });
    row.append(name, this.createVisibilityControl(field.id), archive, prompt);
    return row;
  }

  private renderArchivedFields(): void {
    const details = this.root?.querySelector<HTMLDetailsElement>(
      "#zrdb-archived-fields",
    );
    const container = this.root?.querySelector<HTMLElement>(
      "#zrdb-archived-fields-list",
    );
    if (!details || !container) return;
    const archived = this.fields.filter(
      (field) => field.archived && field.id !== TRANSLATED_TITLE_FIELD_ID,
    );
    details.hidden = archived.length === 0;
    container.replaceChildren();
    for (const field of archived) {
      const row = this.win.document.createElement("div");
      row.className = "zrdb-pref-archived-field";
      row.dataset.fieldId = field.id;
      const name = this.win.document.createElement("span");
      name.textContent = field.name;
      const restore = this.win.document.createElement("button");
      restore.type = "button";
      restore.className = "zrdb-field-restore";
      restore.textContent = "恢复";
      restore.addEventListener("click", () => {
        field.archived = false;
        this.renderFields();
      });
      row.append(name, restore);
      container.append(row);
    }
  }

  private textInput(
    value: string,
    placeholder: string,
    onChange: (value: string) => void,
  ): HTMLInputElement {
    const input = this.win.document.createElement("input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.addEventListener("change", () => onChange(input.value));
    return input;
  }

  private bindWorkspaceActions(): void {
    this.root
      ?.querySelector("#zrdb-add-field")
      ?.addEventListener("click", () => {
        this.fields.push({
          id: createID("field"),
          name: "新字段",
          description: "",
          type: "text",
          options: [],
          extraction: {
            enabled: true,
            instruction: "",
            templateVersion: 1,
          },
        });
        this.visibleColumnIDs.push(this.fields.at(-1)!.id);
        this.renderFields();
      });
    this.root
      ?.querySelector("#zrdb-save-fields")
      ?.addEventListener("click", () => {
        void this.saveFields();
      });
  }

  private async saveFields(): Promise<void> {
    if (!this.workspace) return;
    const names = this.fields.map((field) => field.name.trim()).filter(Boolean);
    if (names.length !== this.fields.length) {
      this.status("字段名称不能为空");
      return;
    }
    try {
      // The table may have saved a layout while preferences remained open.
      const latest = await this.repository.loadWorkspace();
      const fields = cloneFields(this.fields).map((field) =>
        field.archived
          ? field
          : {
              ...field,
              extraction: { ...field.extraction, enabled: true },
            },
      );
      let views = syncSharedVisibleColumnIDs(
        latest.views,
        this.visibleColumnIDs,
      );
      if (!views.length) {
        const now = new Date().toISOString();
        views = [
          {
            id: "builtin-table",
            name: "默认表格",
            mode: "table",
            filterText: "",
            layout: {
              ...createDefaultLayout(),
              visibleColumnIDs: [...this.visibleColumnIDs],
            },
            createdAt: now,
            updatedAt: now,
          },
        ];
      }
      const next: WorkspaceState = { ...latest, fields, views };
      await this.repository.saveWorkspace(next);
      this.workspace = next;
      this.status("字段与列设置已保存到本机研究数据库");
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
    }
  }
}
