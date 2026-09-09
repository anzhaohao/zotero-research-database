import React, { useCallback, useEffect, useRef, useState } from "react";
import { TRANSLATED_TITLE_FIELD_ID } from "../../../domain/defaults";
import type {
  FieldDefinition,
  ItemResearchRecord,
} from "../../../domain/types";
import { type EditableNativeField } from "../../../storage/repository";
import { copyPlainText } from "../../../services/clipboard";
import {
  translatedTitle,
  itemField,
  nativeValue,
  creators,
  year,
  journalBadges,
  displayValue,
} from "../shared/display";
import { UIIcon } from "../shared/ui";

export function TitleCell({
  item,
  record,
  translating,
  failureReason,
  onTranslate,
}: {
  item: Zotero.Item;
  record: ItemResearchRecord | undefined;
  translating: boolean;
  failureReason?: string;
  onTranslate: () => void;
}) {
  const translation = translatedTitle(item, record);
  const foreignTitle = !/\p{Script=Han}/u.test(itemField(item, "title"));
  const locked = record?.fields[TRANSLATED_TITLE_FIELD_ID]?.locked === true;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (copyTimer.current !== undefined)
        (globalThis as any).clearTimeout(copyTimer.current);
    },
    [],
  );
  return (
    <div className="zrdb-paper-title">
      <div className="zrdb-paper-title-heading">
        <strong>{nativeValue(item, "title")}</strong>
        <button
          type="button"
          className="zrdb-original-title-copy"
          aria-label={
            copyState === "copied"
              ? "原标题已复制"
              : copyState === "failed"
                ? "原标题复制失败"
                : "复制原标题"
          }
          title={
            copyState === "copied"
              ? "原标题已复制"
              : copyState === "failed"
                ? "原标题复制失败"
                : "复制原标题"
          }
          data-copy-state={copyState}
          onClick={(event) => {
            event.stopPropagation();
            const view = event.currentTarget.ownerDocument?.defaultView;
            void copyPlainText(
              itemField(item, "title") || "未命名文献",
              event.currentTarget.ownerDocument,
            ).then((copied) => {
              setCopyState(copied ? "copied" : "failed");
              if (!view) return;
              if (copyTimer.current !== undefined)
                view.clearTimeout(copyTimer.current);
              copyTimer.current = view.setTimeout(
                () => setCopyState("idle"),
                1200,
              );
            });
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <UIIcon name={copyState === "copied" ? "check" : "copy"} />
        </button>
      </div>
      {translation && <span>{translation}</span>}
      {foreignTitle && !translation && (
        <button
          type="button"
          className="zrdb-title-translate"
          disabled={translating || locked}
          title={
            locked
              ? "中文标题已锁定"
              : failureReason
                ? `上次翻译失败：${failureReason}；点击重试`
                : "优先使用 Translate for Zotero，失败后自动调用当前 Agent"
          }
          onClick={(event) => {
            event.stopPropagation();
            onTranslate();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {translating
            ? "正在翻译…"
            : locked
              ? "中文标题已锁定"
              : failureReason
                ? "重试翻译"
                : "翻译成中文"}
        </button>
      )}
      {failureReason && (
        <small className="zrdb-title-translation-error" title={failureReason}>
          {failureReason}
        </small>
      )}
    </div>
  );
}

export function BasicInfoCell({ item }: { item: Zotero.Item }) {
  const institution =
    itemField(item, "university") ||
    itemField(item, "institution") ||
    itemField(item, "publisher") ||
    "未记录";
  const journal =
    itemField(item, "publicationTitle") ||
    itemField(item, "proceedingsTitle") ||
    itemField(item, "bookTitle") ||
    "未记录";
  const doi = itemField(item, "DOI") || "未记录";
  const rows = [
    ["作者", creators(item) || "未记录"],
    ["年份", year(item) || "未记录"],
    ["期刊", journal],
    ["机构", institution],
    ["DOI", doi],
  ];
  return (
    <div className="zrdb-basic-info">
      {rows.map(([label, value]) => (
        <div className="zrdb-basic-row" key={label}>
          <b>{label}</b>
          <span>{value}</span>
        </div>
      ))}
      {journalBadges(item).length > 0 && (
        <div className="zrdb-journal-badges">
          {journalBadges(item).map((badge, index) => (
            <span key={badge} data-tone={index % 3}>
              {badge}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function InlineCellEditor({
  field,
  nativeField,
  value,
  onSave,
  onCancel,
}: {
  field?: FieldDefinition;
  nativeField?: EditableNativeField;
  value: unknown;
  onSave: (value: unknown) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(displayValue(value));
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >(null);

  useEffect(() => {
    const editor = editorRef.current;
    editor?.focus();
    if (editor && "select" in editor)
      (editor as HTMLInputElement | HTMLTextAreaElement).select();
  }, []);

  const parsedValue = useCallback((): unknown => {
    const currentDraft = editorRef.current
      ? field?.type === "checkbox"
        ? String((editorRef.current as HTMLInputElement).checked)
        : editorRef.current.value
      : draft;
    if (!field) return currentDraft;
    if (field.type === "number" || field.type === "rating") {
      return currentDraft.trim() ? Number(currentDraft) : null;
    }
    if (field.type === "checkbox") return currentDraft === "true";
    if (field.type === "multiSelect") {
      return currentDraft
        .split(/[，,]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    return currentDraft;
  }, [draft, field]);

  const commit = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(parsedValue());
    } catch (error) {
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      setSaving(false);
    }
  }, [onSave, parsedValue, saving]);

  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    const multiline = field?.type === "longText";
    if (
      event.key === "Enter" &&
      (!multiline || event.ctrlKey || event.metaKey) &&
      !event.shiftKey
    ) {
      event.preventDefault();
      void commit();
    }
  };

  let editor: React.ReactNode;
  if (field?.type === "checkbox") {
    editor = (
      <input
        ref={editorRef as React.RefObject<HTMLInputElement>}
        className="zrdb-inline-checkbox"
        type="checkbox"
        autoFocus
        checked={draft === "true"}
        onClick={stop}
        onChange={(event) => {
          event.stopPropagation();
          setDraft(String(event.target.checked));
        }}
        onKeyDown={onKeyDown}
      />
    );
  } else if (field?.type === "select") {
    editor = (
      <select
        ref={editorRef as React.RefObject<HTMLSelectElement>}
        className="zrdb-inline-editor"
        autoFocus
        value={draft}
        onClick={stop}
        onChange={(event) => {
          event.stopPropagation();
          setDraft(event.target.value);
        }}
        onKeyDown={onKeyDown}
      >
        <option value="" />
        {field.options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    );
  } else if (field?.type === "longText") {
    editor = (
      <textarea
        ref={editorRef as React.RefObject<HTMLTextAreaElement>}
        className="zrdb-inline-editor multiline"
        rows={3}
        value={draft}
        onClick={stop}
        onDoubleClick={stop}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
    );
  } else {
    editor = (
      <input
        ref={editorRef as React.RefObject<HTMLInputElement>}
        className="zrdb-inline-editor"
        type={
          field?.type === "number" || field?.type === "rating"
            ? "number"
            : field?.type === "date" || nativeField === "date"
              ? "text"
              : field?.type === "url" || nativeField === "url"
                ? "url"
                : "text"
        }
        value={draft}
        disabled={saving}
        onClick={stop}
        onDoubleClick={stop}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
    );
  }

  return (
    <span
      className="zrdb-inline-editor-shell"
      onClick={stop}
      onDoubleClick={stop}
    >
      {editor}
      <span className="zrdb-edit-actions">
        <button
          type="button"
          className="zrdb-icon-button primary"
          disabled={saving}
          data-tooltip={saving ? "保存中" : "完成编辑"}
          aria-label={saving ? "保存中" : "完成编辑"}
          title={saving ? "保存中" : "完成编辑"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void commit()}
        >
          <UIIcon name="check" />
        </button>
        <button
          type="button"
          className="zrdb-icon-button"
          disabled={saving}
          data-tooltip="取消编辑"
          aria-label="取消编辑"
          title="取消编辑"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          <UIIcon name="close" />
        </button>
      </span>
    </span>
  );
}
