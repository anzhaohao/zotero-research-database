import { createDefaultLayout, createID } from "../domain/defaults";
import type {
  FieldDefinition,
  FieldType,
  WorkspaceState,
} from "../domain/types";
import {
  createAgentBridge,
  type AgentProfile,
} from "../services/externalAgent";
import { AGENT_PRESETS, parseAgentProfile } from "../services/agentSettings";
import {
  MinerUConversionService,
  parseMinerUProfile,
} from "../services/mineru";
import { ResearchRepository } from "../storage/repository";
import { getPref, setPref } from "../utils/prefs";

const prefKeys = [
  "defaultRowHeight",
  "defaultView",
  "hideMinerUArtifactsInNativeList",
  "motionEnabled",
  "density",
  "cornerStrength",
  "shadowStrength",
  "defaultExportScope",
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

const nativeColumns = [
  ["pdfPreview", "PDF 首页预览"],
  ["title", "文献标题"],
  ["basicInfo", "基础信息"],
  ["creators", "作者"],
  ["year", "年份"],
  ["date", "日期"],
  ["DOI", "DOI"],
  ["url", "URL"],
  ["tags", "标签"],
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

function inputValue(root: Element, key: string): string | boolean {
  const control = root.querySelector(`[data-pref="${key}"]`) as
    | HTMLInputElement
    | HTMLSelectElement
    | null;
  if (!control) return "";
  return control.tagName.toLocaleLowerCase() === "input" &&
    (control as HTMLInputElement).type === "checkbox"
    ? (control as HTMLInputElement).checked
    : control.value;
}

export class PreferencesController {
  private repository = new ResearchRepository();
  private workspace?: WorkspaceState;
  private fields: FieldDefinition[] = [];
  private root?: HTMLElement;

  constructor(private win: Window) {}

  async mount(): Promise<void> {
    const root = this.win.document.getElementById(
      "zrdb-preferences-root",
    ) as HTMLElement | null;
    if (!root || root.dataset.zrdbBound === "1") return;
    this.root = root;
    root.dataset.zrdbBound = "1";
    this.loadLocalControls();
    this.bindLocalControls();
    this.bindAgentTests();
    this.bindModeControls();
    this.updateModeVisibility();
    this.workspace = await this.repository.loadWorkspace();
    this.fields = cloneFields(this.workspace.fields);
    this.renderNativeColumns();
    this.renderFields();
    this.bindWorkspaceActions();
  }

  private status(message: string): void {
    const target = this.root?.querySelector<HTMLElement>("#zrdb-pref-status");
    if (target) target.textContent = message;
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
      if (
        control.tagName.toLocaleLowerCase() === "input" &&
        (control as HTMLInputElement).type === "checkbox"
      )
        (control as HTMLInputElement).checked = Boolean(value);
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
        if (!this.root) return;
        try {
          this.profileFromControls();
          this.mineruProfileFromControls();
          for (const key of prefKeys) {
            const raw = inputValue(this.root, key);
            const value = [
              "defaultRowHeight",
              "agentTimeoutMs",
              "mineruTimeoutMs",
            ].includes(key)
              ? Math.max(0, Number(raw))
              : raw;
            setPref(key, value as never);
          }
          this.status("已保存本机设置；下一次 Agent 任务会立即使用新配置");
        } catch (error) {
          this.status(error instanceof Error ? error.message : String(error));
        }
      });
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
    });
    this.root
      ?.querySelector('[data-pref="mineruMode"]')
      ?.addEventListener("change", () => this.updateModeVisibility());
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
        agentKind === "hana-agent" ? "server-info.json" : "本机端点";
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
    try {
      const agent = createAgentBridge(this.profileFromControls());
      this.status(structured ? "正在测试结构化 JSON……" : "正在连接 Agent……");
      if (structured) {
        await agent.testStructuredOutput();
        this.status("结构化 JSON 测试通过");
      } else {
        const result = await agent.probe();
        this.status(`连接成功：${result.version}；${result.executable}`);
      }
    } catch (error) {
      this.status(error instanceof Error ? error.message : String(error));
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

  private renderNativeColumns(): void {
    const container = this.root?.querySelector<HTMLElement>(
      "#zrdb-native-columns",
    );
    if (!container) return;
    container.replaceChildren();
    for (const [id, name] of nativeColumns) {
      const row = this.win.document.createElement("div");
      row.className = "zrdb-pref-native-column";
      const label = this.win.document.createElement("strong");
      label.textContent = name;
      const code = this.win.document.createElement("code");
      code.textContent = id;
      const badge = this.win.document.createElement("span");
      badge.textContent = "Zotero 元数据 · 只读定义";
      row.append(label, code, badge);
      container.append(row);
    }
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
    const language = this.textInput(
      field.extraction.outputLanguage,
      "输出语言",
      (value) => {
        field.extraction.outputLanguage = value;
      },
    );
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
    for (const control of [
      name,
      type,
      description,
      prompt,
      language,
      enabled,
      options,
    ])
      control.disabled = Boolean(field.archived);
    row.append(
      name,
      type,
      description,
      prompt,
      language,
      enabledLabel,
      options,
      archive,
    );
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
            outputLanguage: "中文",
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
    this.root
      ?.querySelector("#zrdb-reset-layout")
      ?.addEventListener("click", () => {
        void this.resetLayouts();
      });
  }

  private async saveFields(): Promise<void> {
    if (!this.workspace) return;
    const names = this.fields.map((field) => field.name.trim()).filter(Boolean);
    if (names.length !== this.fields.length) {
      this.status("字段名称不能为空");
      return;
    }
    const next = { ...this.workspace, fields: cloneFields(this.fields) };
    await this.repository.saveWorkspace(next);
    this.workspace = next;
    this.status("字段方案已保存到 Zotero 工作区");
  }

  private async resetLayouts(): Promise<void> {
    if (!this.workspace) return;
    const next = {
      ...this.workspace,
      views: this.workspace.views.map((view) => ({
        ...view,
        visibleColumnIDs: createDefaultLayout().visibleColumnIDs,
        layout: createDefaultLayout(),
        updatedAt: new Date().toISOString(),
      })),
    };
    await this.repository.saveWorkspace(next);
    this.workspace = next;
    setPref("defaultRowHeight", 320);
    this.loadLocalControls();
    this.status("所有已保存视图已恢复默认布局；论文字段值没有改变");
  }
}
