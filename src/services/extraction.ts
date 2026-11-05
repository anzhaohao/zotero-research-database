import { applyAgentValues } from "../core/records";
import type {
  AgentDocumentInput,
  FieldDefinition,
  ItemResearchRecord,
  WorkspaceState,
} from "../domain/types";
import { ResearchRepository } from "../storage/repository";
import { resolveSourceText } from "./contentSource";
import type { AgentBridge, AgentResult } from "./externalAgent";

export { validateExtractedValues } from "./externalAgent";

export interface ExtractionProgress {
  itemKey: string;
  fieldIDs: string[];
  state: "running" | "success" | "failed" | "cancelled";
  message: string;
  /** A validated, persisted result, available before the rest of the paper finishes. */
  record?: ItemResearchRecord;
}

type SourceResolver = typeof resolveSourceText;
const MAX_AGENT_INPUT_CHARS = 200_000;

export interface PreparedExtractionText {
  text: string;
  originalLength: number;
  focused: boolean;
}

export interface ExtractionRunOptions {
  requestedFieldIDsByItem?: ReadonlyMap<string, readonly string[]>;
  /** Restrict a run to these stable research field IDs. */
  requestedFieldIDs?: string[];
  /** Allow an explicit single-cell regeneration to replace manual edits. */
  overwriteLockedFields?: boolean;
}

export class ExternalAgentExtractionService {
  private cancelled = false;
  private activeAgent?: AgentBridge;

  constructor(
    private repository: ResearchRepository,
    private agent: AgentBridge | (() => AgentBridge),
    private sourceResolver: SourceResolver = resolveSourceText,
  ) {}

  cancel(): void {
    this.cancelled = true;
    if (this.activeAgent) this.activeAgent.cancel();
    else if (typeof this.agent !== "function") this.agent.cancel();
  }

  async run(
    items: Zotero.Item[],
    workspace: WorkspaceState,
    onProgress: (progress: ExtractionProgress) => void,
    options: ExtractionRunOptions = {},
  ): Promise<void> {
    this.cancelled = false;
    for (const item of items) {
      const requested =
        options.requestedFieldIDsByItem?.get(item.key) ||
        options.requestedFieldIDs;
      const requestedFieldIDs = requested?.length
        ? new Set(requested)
        : undefined;
      const completed = new Set<string>();
      let fieldIDs = workspace.fields
        .filter(
          (field) =>
            !field.archived &&
            (!requestedFieldIDs || requestedFieldIDs.has(field.id)),
        )
        .map((field) => field.id);
      if (this.cancelled) {
        onProgress({
          itemKey: item.key,
          fieldIDs,
          state: "cancelled",
          message: "已取消",
        });
        continue;
      }
      let stage = "读取研究属性";
      try {
        this.throwIfCancelled();
        const record = (await this.repository.loadRecord(
          item,
          true,
          workspace.fields,
        ))!;
        const fields = eligibleFields(
          workspace.fields,
          record,
          requestedFieldIDs,
          options.overwriteLockedFields,
        );
        fieldIDs = fields.map((field) => field.id);
        if (!fields.length) {
          onProgress({
            itemKey: item.key,
            fieldIDs,
            state: "success",
            message: "没有待更新字段",
          });
          continue;
        }
        stage = "读取论文全文";
        this.throwIfCancelled();
        onProgress({
          itemKey: item.key,
          fieldIDs,
          state: "running",
          message: "正在读取论文全文",
        });
        const source = await this.sourceResolver(item);
        this.throwIfCancelled();
        const prepared = prepareExtractionText(source.text);
        if (prepared.focused)
          throw new Error(
            "论文全文超过 200,000 字符，本次未发送；为避免遗漏，插件不会自动截断全文。请拆分超长文档后重试",
          );
        stage = "外部 Agent 处理";
        onProgress({
          itemKey: item.key,
          fieldIDs,
          state: "running",
          message: `正在调用外部 Agent（${
            source.pdfPath && !prepared.text.trim()
              ? "主 PDF（无全文文本）"
              : sourceLabel(source.type)
          }，${inputLengthLabel(prepared)}）`,
        });
        // A fresh bridge per paper makes session isolation explicit and keeps
        // process and cancellation bookkeeping scoped to the current paper.
        const agent =
          typeof this.agent === "function" ? this.agent() : this.agent;
        if (
          !prepared.text.trim() &&
          (agent.kind === "openai-compatible" ||
            agent.kind === "ollama" ||
            agent.kind === "codex-cli")
        ) {
          throw new Error(
            "PDF 没有可确认完整的可读全文。请先运行 MinerU 或 OCR，再填充文献；当前填充方式需要完整论文文本",
          );
        }
        const staged = await stageAgentDocument(
          item.key,
          source,
          prepared.text,
        );
        let result;
        let latestRecord = record;
        const persistResult = async (
          partial: AgentResult<Record<string, unknown>>,
        ) => {
          this.throwIfCancelled();
          const values = Object.fromEntries(
            Object.entries(partial.value).filter(([id]) => !completed.has(id)),
          );
          if (!Object.keys(values).length) return;
          const audit = {
            executor: agent.kind === "codex-cli" ? "codex" : "external-agent",
            executorVersion: partial.executorVersion,
            inputType: source.type,
            inputHash: source.hash,
            generatedAt: new Date().toISOString(),
            templateVersion: Math.max(
              ...fields
                .filter((field) => Object.hasOwn(values, field.id))
                .map((field) => field.extraction.templateVersion),
            ),
          } as const;
          const updater = (current: ItemResearchRecord) =>
            applyAgentValues(current, values, audit, {
              overwriteLocked: options.overwriteLockedFields,
            });
          if (typeof this.repository.updateRecord === "function") {
            latestRecord = await this.repository.updateRecord(
              item,
              updater,
              workspace.fields,
            );
          } else {
            latestRecord = updater(latestRecord);
            await this.repository.saveRecord(
              item,
              latestRecord,
              workspace.fields,
            );
          }
          Object.keys(values).forEach((id) => completed.add(id));
          fieldIDs = fields
            .map((field) => field.id)
            .filter((id) => !completed.has(id));
          onProgress({
            itemKey: item.key,
            fieldIDs,
            state: "running",
            message: `已保存 ${completed.size}/${fields.length} 个字段，其余继续生成`,
            record: latestRecord,
          });
        };
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const agentStartedAt = Date.now();
        try {
          this.activeAgent = agent;
          heartbeat = setInterval(() => {
            const elapsedSeconds = Math.max(
              1,
              Math.floor((Date.now() - agentStartedAt) / 1000),
            );
            onProgress({
              itemKey: item.key,
              fieldIDs,
              state: "running",
              message: "外部 Agent 处理中（已等待 " + elapsedSeconds + " 秒）",
            });
          }, 15_000);
          this.throwIfCancelled();
          let lastProgressAt = 0;
          result = await agent.extractFields(
            fields,
            staged.input,
            (progress) => {
              if (Date.now() - lastProgressAt < 500) return;
              lastProgressAt = Date.now();
              onProgress({
                itemKey: item.key,
                fieldIDs,
                state: "running",
                message:
                  progress.phase === "writing"
                    ? "AI 正在生成（已接收 " +
                      progress.receivedCharacters +
                      " 字符）"
                    : "AI 已连接，正在分析论文",
              });
            },
            persistResult,
          );
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          if (this.activeAgent === agent) this.activeAgent = undefined;
          await staged.cleanup();
        }
        this.throwIfCancelled();
        stage = "保存研究属性";
        onProgress({
          itemKey: item.key,
          fieldIDs,
          state: "running",
          message: "正在保存研究属性",
        });
        await persistResult(result);
        onProgress({
          itemKey: item.key,
          fieldIDs,
          state: "success",
          message: "Agent 提取完成",
          record: latestRecord,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        onProgress({
          itemKey: item.key,
          fieldIDs,
          state: this.cancelled ? "cancelled" : "failed",
          message: this.cancelled
            ? completed.size
              ? `已取消，已保存的 ${completed.size} 个字段保留`
              : "已取消，未写入"
            : `${stage}失败：${detail}${completed.size ? `（已保存 ${completed.size} 个字段）` : ""}`,
        });
      }
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new Error("已取消，未写入研究属性");
  }
}

interface StagedAgentDocument {
  input: AgentDocumentInput;
  cleanup: () => Promise<void>;
}

/**
 * Put a copy of the selected PDF in a short-lived directory. CLI agents get
 * read-only access to that directory instead of the whole Zotero data tree;
 * HanaAgent still receives a normal local path and can use its vision/OCR
 * pipeline. The path is never written to a research record.
 */
async function stageAgentDocument(
  itemKey: string,
  source: {
    type: "mineru-markdown" | "pdf-fulltext";
    pdfPath?: string;
    images?: string[];
  },
  text: string,
): Promise<StagedAgentDocument> {
  const textOnly: AgentDocumentInput = {
    text,
    sourceType: source.type,
  };
  // Reuse readable paper content instead of copying and parsing the same PDF
  // a second time. Direct PDF reading is only needed for scanned/unindexed files.
  if (text.trim()) return { input: textOnly, cleanup: async () => undefined };
  const pathUtils = (globalThis as any).PathUtils as
    | {
        tempDir?: string;
        join?: (...parts: string[]) => string;
        filename?: (path: string) => string;
      }
    | undefined;
  const io = (globalThis as any).IOUtils as
    | {
        makeDirectory?: (
          path: string,
          options?: { ignoreExisting?: boolean },
        ) => Promise<void>;
        read?: (path: string) => Promise<Uint8Array>;
        write?: (path: string, bytes: Uint8Array) => Promise<void>;
        remove?: (
          path: string,
          options?: { recursive?: boolean; ignoreAbsent?: boolean },
        ) => Promise<void>;
      }
    | undefined;
  if (
    !source.pdfPath ||
    !pathUtils?.tempDir ||
    typeof pathUtils.join !== "function" ||
    typeof io?.makeDirectory !== "function" ||
    typeof io.read !== "function" ||
    typeof io.write !== "function" ||
    typeof io.remove !== "function"
  ) {
    throw new Error("无法安全暂存 PDF，且没有可供 Agent 使用的全文文本");
  }

  const directory = pathUtils.join(
    pathUtils.tempDir,
    `zotero-research-db-agent-${itemKey}-${Date.now()}`,
  );
  try {
    await io.makeDirectory(directory, { ignoreExisting: true });
    const pdfPath = pathUtils.join(directory, "primary.pdf");
    await io.write(pdfPath, new Uint8Array(await io.read(source.pdfPath)));
    const images: string[] = [];
    for (const [index, imagePath] of (source.images || []).entries()) {
      try {
        const filename =
          typeof pathUtils.filename === "function"
            ? pathUtils.filename(imagePath)
            : `image-${index + 1}.png`;
        const destination = pathUtils.join(
          directory,
          `${index + 1}-${filename}`,
        );
        await io.write(destination, new Uint8Array(await io.read(imagePath)));
        images.push(destination);
      } catch {
        // An optional figure must never prevent the primary PDF from running.
      }
    }
    return {
      input: { text, pdfPath, images, sourceType: "pdf-direct" },
      cleanup: async () => {
        await io.remove!(directory, { recursive: true, ignoreAbsent: true });
      },
    };
  } catch (error) {
    await io.remove(directory, { recursive: true, ignoreAbsent: true });
    throw new Error("PDF 暂存失败且没有可供 Agent 使用的全文文本", {
      cause: error,
    });
  }
}

function sourceLabel(type: "mineru-markdown" | "pdf-fulltext"): string {
  return type === "mineru-markdown" ? "MinerU Markdown" : "PDF 全文";
}

function inputLengthLabel(prepared: PreparedExtractionText): string {
  if (!prepared.focused)
    return `${prepared.originalLength.toLocaleString()} 字符`;
  return `重点片段 ${prepared.text.length.toLocaleString()} / ${prepared.originalLength.toLocaleString()} 字符`;
}

/**
 * Keep the sections that normally carry research questions, methods and
 * conclusions. The complete source is still hashed for the audit record.
 */
export function prepareExtractionText(
  value: string,
  maxChars = MAX_AGENT_INPUT_CHARS,
): PreparedExtractionText {
  const text = value.trim();
  if (text.length <= maxChars) {
    return { text, originalLength: text.length, focused: false };
  }

  const ranges: Array<{ start: number; end: number; label: string }> = [
    { start: 0, end: Math.min(text.length, 7_000), label: "摘要与引言" },
  ];
  const sections: Array<{
    label: string;
    pattern: RegExp;
    before: number;
    after: number;
  }> = [
    {
      label: "结论",
      pattern:
        /(?:^|\n)\s*(?:\d+(?:\.\d+)*[.)]?\s*)?(?:conclusions?|concluding\s+remarks?|summary\s+and\s+outlook|结论(?:与展望)?|总结(?:与展望)?)/im,
      before: 500,
      after: 4_000,
    },
    {
      label: "结果",
      pattern:
        /(?:^|\n)\s*(?:\d+(?:\.\d+)*[.)]?\s*)?(?:results?|findings?|结果(?:与分析)?)/im,
      before: 300,
      after: 3_200,
    },
    {
      label: "研究方法",
      pattern:
        /(?:^|\n)\s*(?:\d+(?:\.\d+)*[.)]?\s*)?(?:methods?|methodology|experimental(?:\s+setup)?|materials?\s+and\s+methods?|研究方法|实验(?:方法|装置)?)/im,
      before: 300,
      after: 2_700,
    },
    {
      label: "讨论",
      pattern:
        /(?:^|\n)\s*(?:\d+(?:\.\d+)*[.)]?\s*)?(?:discussion|results?\s+and\s+discussion|讨论)/im,
      before: 300,
      after: 2_700,
    },
  ];
  for (const section of sections) {
    const match = section.pattern.exec(text);
    if (!match || match.index === undefined) continue;
    ranges.push({
      start: Math.max(0, match.index - section.before),
      end: Math.min(text.length, match.index + section.after),
      label: section.label,
    });
  }
  ranges.push({
    start: Math.max(0, Math.floor(text.length / 2) - 1_500),
    end: Math.min(text.length, Math.floor(text.length / 2) + 1_500),
    label: "正文中段",
  });
  ranges.push({
    start: Math.max(0, text.length - 3_000),
    end: text.length,
    label: "文末",
  });

  const pieces: string[] = [];
  let remaining = maxChars;
  for (const range of ranges) {
    if (remaining <= 0) break;
    const marker = `\n\n[${range.label}]\n`;
    if (marker.length >= remaining) break;
    const excerpt = text
      .slice(range.start, Math.min(range.end, range.start + remaining))
      .trim();
    if (!excerpt || pieces.some((piece) => piece.includes(excerpt))) continue;
    const piece = `${marker}${excerpt}`;
    pieces.push(piece);
    remaining -= piece.length;
  }
  const focusedText = pieces.join("").slice(0, maxChars).trim();
  return {
    text: focusedText || text.slice(0, maxChars),
    originalLength: text.length,
    focused: true,
  };
}

function eligibleFields(
  fields: FieldDefinition[],
  record: ItemResearchRecord,
  requestedFieldIDs?: ReadonlySet<string>,
  overwriteLockedFields = false,
): FieldDefinition[] {
  return fields.filter(
    (field) =>
      !field.archived &&
      (!requestedFieldIDs || requestedFieldIDs.has(field.id)) &&
      (overwriteLockedFields || !record.fields[field.id]?.locked),
  );
}
