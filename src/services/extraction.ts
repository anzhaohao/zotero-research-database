import { applyAgentValues } from "../core/records";
import type {
  AgentDocumentInput,
  FieldDefinition,
  ItemResearchRecord,
  WorkspaceState,
} from "../domain/types";
import { ResearchRepository } from "../storage/repository";
import { resolveSourceText } from "./contentSource";
import type { AgentBridge } from "./externalAgent";

export { validateExtractedValues } from "./externalAgent";

export interface ExtractionProgress {
  itemKey: string;
  fieldIDs: string[];
  state: "running" | "success" | "failed" | "cancelled";
  message: string;
}

type SourceResolver = typeof resolveSourceText;
const MAX_AGENT_INPUT_CHARS = 20_000;

export interface PreparedExtractionText {
  text: string;
  originalLength: number;
  focused: boolean;
}

export interface ExtractionRunOptions {
  /** Restrict a run to these stable research field IDs. */
  requestedFieldIDs?: string[];
}

export class ExternalAgentExtractionService {
  private cancelled = false;

  constructor(
    private repository: ResearchRepository,
    private agent: AgentBridge,
    private sourceResolver: SourceResolver = resolveSourceText,
  ) {}

  cancel(): void {
    this.cancelled = true;
    this.agent.cancel();
  }

  async run(
    items: Zotero.Item[],
    workspace: WorkspaceState,
    onProgress: (progress: ExtractionProgress) => void,
    options: ExtractionRunOptions = {},
  ): Promise<void> {
    this.cancelled = false;
    const requestedFieldIDs = options.requestedFieldIDs?.length
      ? new Set(options.requestedFieldIDs)
      : undefined;
    for (const item of items) {
      let fieldIDs = workspace.fields
        .filter(
          (field) =>
            field.extraction.enabled &&
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
        const record = (await this.repository.loadRecord(
          item,
          true,
          workspace.fields,
        ))!;
        const fields = eligibleFields(
          workspace.fields,
          record,
          requestedFieldIDs,
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
        onProgress({
          itemKey: item.key,
          fieldIDs,
          state: "running",
          message: "正在读取论文全文",
        });
        const source = await this.sourceResolver(item);
        const prepared = prepareExtractionText(source.text);
        stage = "外部 Agent 处理";
        onProgress({
          itemKey: item.key,
          fieldIDs,
          state: "running",
          message: `正在调用外部 Agent（${
            source.pdfPath ? "主 PDF，失败回退文本" : sourceLabel(source.type)
          }，${inputLengthLabel(prepared)}）`,
        });
        const staged = await stageAgentDocument(
          item.key,
          source,
          prepared.text,
        );
        let result;
        try {
          result = await this.agent.extractFields(fields, staged.input);
        } catch (directError) {
          if (!source.text.trim() || !staged.input.pdfPath) throw directError;
          onProgress({
            itemKey: item.key,
            fieldIDs,
            state: "running",
            message: "Agent 直读主 PDF 失败，正在回退到 Zotero 文本",
          });
          result = await this.agent.extractFields(fields, {
            text: prepared.text,
            images: staged.input.images,
            sourceType: source.type,
          });
        } finally {
          await staged.cleanup();
        }
        if (this.cancelled) {
          onProgress({
            itemKey: item.key,
            fieldIDs,
            state: "cancelled",
            message: "已取消，未写入",
          });
          continue;
        }
        stage = "保存研究属性";
        onProgress({
          itemKey: item.key,
          fieldIDs,
          state: "running",
          message: "正在保存研究属性",
        });
        const next = applyAgentValues(record, result.value, {
          executor:
            this.agent.kind === "codex-cli" ? "codex" : "external-agent",
          executorVersion: result.executorVersion,
          inputType: source.type,
          inputHash: source.hash,
          generatedAt: new Date().toISOString(),
          templateVersion: Math.max(
            ...fields.map((field) => field.extraction.templateVersion),
          ),
        });
        await this.repository.saveRecord(item, next, workspace.fields);
        onProgress({
          itemKey: item.key,
          fieldIDs,
          state: "success",
          message: "Agent 提取完成",
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        onProgress({
          itemKey: item.key,
          fieldIDs,
          state: this.cancelled ? "cancelled" : "failed",
          message: this.cancelled
            ? "已取消，未写入"
            : `${stage}失败：${detail}`,
        });
      }
    }
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
  const original: AgentDocumentInput = {
    pdfPath: source.pdfPath,
    text,
    images: source.images,
    sourceType: source.pdfPath ? "pdf-direct" : source.type,
  };
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
    return { input: original, cleanup: async () => undefined };
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
      input: { ...original, pdfPath, images },
      cleanup: async () => {
        await io.remove!(directory, { recursive: true, ignoreAbsent: true });
      },
    };
  } catch {
    await io.remove(directory, { recursive: true, ignoreAbsent: true });
    return { input: original, cleanup: async () => undefined };
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
): FieldDefinition[] {
  return fields.filter(
    (field) =>
      field.extraction.enabled &&
      !field.archived &&
      (!requestedFieldIDs || requestedFieldIDs.has(field.id)) &&
      !record.fields[field.id]?.locked,
  );
}
