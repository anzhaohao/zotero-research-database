import { createID } from "../domain/defaults";
import type {
  FieldDefinition,
  FieldType,
  WorkspaceState,
} from "../domain/types";
import {
  createAgentBridge,
  listOllamaModels,
  type AgentProfile,
} from "../services/externalAgent";
import {
  AGENT_PRESETS,
  getAgentModelPresets,
  parseAgentProfile,
} from "../services/agentSettings";
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
  "agentModel",
  "agentTimeoutMs",
  "mineruMode",
  "mineruExecutable",
  "mineruArgs",
  "mineruDesktopOutputDirectory",
  "mineruOfficialEndpoint",
  "mineruOfficialTokenEnvironment",
  "mineruSelfHostedEndpoint",
  "mineruSelfHostedAutoStart",
  "mineruSelfHostedProjectDirectory",
  "mineruDockerExecutable",
  "mineruDockerDesktopExecutable",
  "mineruBackend",
  "mineruMethod",
  "mineruModelVersion",
  "mineruLanguage",
  "mineruEnableFormula",
  "mineruEnableTable",
  "mineruTimeoutMs",
] as const;

const fieldTypes: Array<[FieldType, string]> = [
  ["text", "短文本"],
  ["longText", "长文本"],
  ["select", "单选"],
  ["multiSelect", "多选"],
  ["number", "数值"],
  ["date", "日期"],
  ["checkbox", "勾选"],
  ["rating", "评分"],
  ["url", "URL"],
];

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
    | HTMLInputElement
    | HTMLSelectElement
    | null;
  if (!control) return "";
  return isCheckboxControl(control) ? control.checked : control.value;
}

export class PreferencesController {
  private repository = new ResearchRepository();
  private workspace?: WorkspaceState;
  private fields: FieldDefinition[] = [];
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
        | HTMLInputElement
        | HTMLSelectElement
        | null;
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
      this.mineruProfileFromControls();
      // Initialization is cached; do not reload the file over unsaved edits.
      await initializePortableSettings();
      const requestedRoot = String(
        inputValue(this.root, "dataRoot") || "",
      ).trim();
      const previousRoot = String(getPref("dataRoot") || "").trim();
      for (const key of prefKeys) {
        if (key === "dataRoot") continue;
        const raw = inputValue(this.root, key);
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
      if (kind === "claude-code" || kind === "hana-agent") {
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
      this.updateModeVisibility();
      void this.refreshAgentModelOptions();
    });
    this.root
      ?.querySelector('[data-pref="mineruMode"]')
      ?.addEventListener("change", () => this.updateModeVisibility());
  }

  /** Add friendly model suggestions while keeping the field editable. */
  private bindAgentModelPicker(): void {
    if (!this.root) return;
    const input = this.root.querySelector<HTMLInputElement>(
      '[data-pref="agentModel"]',
    );
    if (!input) return;
    const listId = "zrdb-agent-model-options";
    let list = this.root.querySelector<HTMLDataListElement>(`#${listId}`);
    if (!list) {
      list = this.win.document.createElement("datalist");
      list.id = listId;
      input.after(list);
    }
    input.setAttribute("list", listId);
    this.root
      .querySelector('[data-pref="agentEndpoint"]')
      ?.addEventListener("change", () => {
        if (String(inputValue(this.root!, "agentKind")) === "ollama")
          void this.refreshAgentModelOptions();
      });
    void this.refreshAgentModelOptions();
  }

  private async refreshAgentModelOptions(): Promise<void> {
    if (!this.root) return;
    const input = this.root.querySelector<HTMLInputElement>(
      '[data-pref="agentModel"]',
    );
    const list = this.root.querySelector<HTMLDataListElement>(
      "#zrdb-agent-model-options",
    );
    if (!input || !list) return;
    const kind = String(
      inputValue(this.root, "agentKind"),
    ) as AgentProfile["kind"];
    const requestId = ++this.agentModelRequestId;
    const options = [...getAgentModelPresets(kind)];
    if (kind === "ollama") {
      try {
        const endpoint = String(inputValue(this.root, "agentEndpoint") || "");
        const timeout = Number(inputValue(this.root, "agentTimeoutMs"));
        const models = await listOllamaModels(
          endpoint || undefined,
          Number.isFinite(timeout) && timeout >= 1000
            ? Math.min(timeout, 30_000)
            : 10_000,
        );
        for (const model of models)
          if (!options.some((option) => option.value === model))
            options.push({ value: model, label: model });
      } catch {
        // Keep the editable input usable when Ollama is not running yet.
      }
    }
    if (requestId !== this.agentModelRequestId) return;
    const current = input.value.trim();
    if (current && !options.some((option) => option.value === current))
      options.unshift({ value: current, label: `${current}（当前值）` });
    list.replaceChildren(
      ...options.map((option) => {
        const element = this.win.document.createElement("option");
        element.value = option.value;
        element.label = option.label;
        return element;
      }),
    );
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
    if (endpointLabel)
      endpointLabel.textContent =
        agentKind === "hana-agent"
          ? "服务信息文件（可留空自动检测）"
          : "本机服务地址";
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
      this.status(
        `${error instanceof Error ? error.message : String(error)}；请检查高级设置或启动本机服务`,
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
      model: inputValue(this.root, "agentModel"),
      timeoutMs: inputValue(this.root, "agentTimeoutMs"),
    });
  }

  private mineruProfileFromControls() {
    if (!this.root) throw new Error("设置页面尚未加载");
    return parseMinerUProfile({
      mode: inputValue(this.root, "mineruMode"),
      executable: inputValue(this.root, "mineruExecutable"),
      args: inputValue(this.root, "mineruArgs"),
      desktopOutputDirectory: inputValue(
        this.root,
        "mineruDesktopOutputDirectory",
      ),
      officialEndpoint: inputValue(this.root, "mineruOfficialEndpoint"),
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
    for (const field of this.fields)
      container.append(this.createFieldRow(field));
  }

  private createFieldRow(field: FieldDefinition): HTMLElement {
    const row = this.win.document.createElement("div");
    row.className = `zrdb-pref-field${field.archived ? " is-archived" : ""}`;
    const name = this.textInput(field.name, "字段名称", (value) => {
      field.name = value;
    });
    const type = this.win.document.createElement("select");
    for (const [value, label] of fieldTypes) {
      const option = this.win.document.createElement("option");
      option.value = value;
      option.textContent = label;
      type.append(option);
    }
    type.value = field.type;
    type.addEventListener("change", () => {
      field.type = type.value as FieldType;
      this.renderFields();
    });
    const description = this.textInput(
      field.description,
      "字段说明",
      (value) => {
        field.description = value;
      },
    );
    const prompt = this.win.document.createElement("textarea");
    prompt.placeholder = "给 Agent 的提取提示词";
    prompt.value = field.extraction.instruction;
    prompt.addEventListener("change", () => {
      field.extraction.instruction = prompt.value;
      field.extraction.templateVersion += 1;
    });
    const enabledLabel = this.win.document.createElement("label");
    const enabled = this.win.document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = field.extraction.enabled;
    enabled.addEventListener("change", () => {
      field.extraction.enabled = enabled.checked;
    });
    enabledLabel.append(
      enabled,
      this.win.document.createTextNode(" 参与 Agent 提取"),
    );
    const options = this.textInput(
      field.options.join("，"),
      "选项（逗号分隔）",
      (value) => {
        field.options = value
          .split(/[，,]/)
          .map((entry) => entry.trim())
          .filter(Boolean);
      },
    );
    options.hidden = !["select", "multiSelect"].includes(field.type);
    const archive = this.win.document.createElement("button");
    archive.type = "button";
    archive.textContent = field.archived ? "恢复" : "归档";
    archive.addEventListener("click", () => {
      field.archived = !field.archived;
      this.renderFields();
    });
    for (const control of [name, type, description, prompt, enabled, options])
      control.disabled = Boolean(field.archived);
    row.append(name, type, description, prompt, enabledLabel, options, archive);
    return row;
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
            enabled: false,
            instruction: "",
            templateVersion: 1,
          },
        });
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
      const next = { ...latest, fields: cloneFields(this.fields) };
      await this.repository.saveWorkspace(next);
      this.workspace = next;
      this.status("字段方案已保存到本机研究数据库");
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
    }
  }
}
