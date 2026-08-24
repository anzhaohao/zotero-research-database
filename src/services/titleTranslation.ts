import { config } from "../../package.json";
import { TRANSLATED_TITLE_FIELD_ID } from "../domain/defaults";
import type {
  FieldAudit,
  FieldDefinition,
  ItemResearchRecord,
} from "../domain/types";
import type { AgentBridge } from "./externalAgent";

export interface PDFTranslateTask {
  status?: unknown;
  result?: unknown;
}

export interface PDFTranslateAPI {
  translate(
    raw: string,
    options: {
      pluginID: string;
      itemID?: number;
      langfrom: string;
      langto: string;
    },
  ): Promise<PDFTranslateTask>;
}

export interface PDFTranslateRuntime {
  PDFTranslate?: { api?: Partial<PDFTranslateAPI> };
}

export interface PreparedTitleTranslation {
  value: string;
  audit: FieldAudit;
}

export interface TitleTranslationFallbackOptions {
  record: ItemResearchRecord;
  translatePrimary: () => Promise<PreparedTitleTranslation>;
  translateFallback: () => Promise<PreparedTitleTranslation>;
  persist: (translation: PreparedTitleTranslation) => Promise<unknown>;
}

/** Errors that mean the optional Translate for Zotero adapter cannot serve. */
export class PDFTranslateUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PDFTranslateUnavailableError";
  }
}

export function isPDFTranslateUnavailableError(
  error: unknown,
): error is PDFTranslateUnavailableError {
  return error instanceof PDFTranslateUnavailableError;
}

export function hasProtectedTranslatedTitle(
  record: ItemResearchRecord,
): boolean {
  const existing = record.fields[TRANSLATED_TITLE_FIELD_ID];
  return Boolean(existing?.locked || String(existing?.value ?? "").trim());
}

/**
 * Keep the optional API failure boundary separate from persistence. A local
 * save failure therefore propagates directly and can never trigger Agent a
 * second time.
 */
export async function translateTitleWithFallback(
  options: TitleTranslationFallbackOptions,
): Promise<PreparedTitleTranslation | undefined> {
  if (hasProtectedTranslatedTitle(options.record)) return undefined;

  let translation: PreparedTitleTranslation;
  try {
    translation = await options.translatePrimary();
  } catch (error) {
    if (!isPDFTranslateUnavailableError(error)) throw error;
    translation = await options.translateFallback();
  }
  await options.persist(translation);
  return translation;
}

/** Use the configured Agent bridge for the title field only. */
export async function translateTitleWithAgent(
  raw: string,
  field: FieldDefinition,
  agent: AgentBridge,
): Promise<PreparedTitleTranslation> {
  const result = await agent.extractFields([field], raw);
  const value = result.value[TRANSLATED_TITLE_FIELD_ID];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("外部 Agent 未返回中文标题");
  }
  return {
    value: value.trim(),
    audit: {
      executor: agent.kind === "codex-cli" ? "codex" : "external-agent",
      executorVersion: result.executorVersion,
      inputType: "manual",
      inputHash: "",
      generatedAt: new Date().toISOString(),
      templateVersion: field.extraction.templateVersion,
    },
  };
}

/** Use Translate for Zotero's public API without touching Zotero fields. */
export async function translateTitleWithPDFTranslate(
  raw: string,
  itemID?: number,
  runtime: PDFTranslateRuntime = ((globalThis as any).Zotero ||
    {}) as PDFTranslateRuntime,
): Promise<string> {
  const api = runtime.PDFTranslate?.api;
  if (typeof api?.translate !== "function") {
    throw new PDFTranslateUnavailableError(
      "Translate for Zotero 公共翻译接口不可用",
    );
  }
  let task: PDFTranslateTask;
  try {
    task = await api.translate.call(api, raw, {
      pluginID: config.addonID,
      itemID,
      langfrom: "en",
      langto: "zh-CN",
    });
  } catch (error) {
    throw new PDFTranslateUnavailableError(
      "Translate for Zotero 公共翻译接口调用失败",
      { cause: error },
    );
  }
  if (task?.status !== "success") {
    throw new PDFTranslateUnavailableError(
      "Translate for Zotero 未成功完成标题翻译",
    );
  }
  const result = task?.result;
  if (typeof result !== "string" || !result.trim()) {
    throw new PDFTranslateUnavailableError(
      "Translate for Zotero 未返回中文标题",
    );
  }
  return result.trim();
}
