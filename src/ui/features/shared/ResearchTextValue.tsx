import React, { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { researchMarkdownSource } from "../../../core/researchText";

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const ALLOWED_ELEMENTS = ["p", "br", "strong", "em", "code", "ul", "ol", "li"];
const RESEARCH_NO_BREAK_PATTERN =
  /(\b(?:Fig(?:s)?|Figure(?:s)?|Table(?:s)?|Eq)\.\s*\d+[a-z]?(?:\s*[–—-]\s*(?:\d+)?[a-z]?)?|[±+−-]?\d+(?:\.\d+)?(?:\s*(?:～|~|–|—)\s*[±+−-]?\d+(?:\.\d+)?)?\s*(?:fs|ps|ns|µs|μs|ms|s|nm|µm|μm|mm|cm|km|m|kHz|MHz|GHz|Hz|dB|nJ|µJ|μJ|mJ|J|nW|µW|μW|mW|kW|W|%|h|min)(?![A-Za-z]))/g;

function researchInlineText(value: string): React.ReactNode[] {
  return value.split(RESEARCH_NO_BREAK_PATTERN).map((part, index) =>
    part ? (
      <span
        className={index % 2 === 1 ? "zrdb-research-nowrap" : undefined}
        key={index}
      >
        {part}
      </span>
    ) : null,
  );
}

function inlineChildren(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) =>
    typeof child === "string" ? researchInlineText(child) : child,
  );
}

const COMPONENTS: Components = {
  p: ({ children }) => (
    <p className="zrdb-research-block is-paragraph">
      {inlineChildren(children)}
    </p>
  ),
  strong: ({ children }) => <strong>{inlineChildren(children)}</strong>,
  em: ({ children }) => <em>{inlineChildren(children)}</em>,
  code: ({ children }) => <code>{inlineChildren(children)}</code>,
  ul: ({ children }) => <ul className="zrdb-research-list">{children}</ul>,
  ol: ({ children }) => <ol className="zrdb-research-list">{children}</ol>,
  li: ({ children }) => (
    <li className="zrdb-research-list-item">{inlineChildren(children)}</li>
  ),
};

export function ResearchTextValue({
  value,
  fieldName,
}: {
  value: unknown;
  fieldName: string;
}) {
  const source = researchMarkdownSource(value, fieldName);
  const content = useMemo(
    () =>
      source ? (
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          allowedElements={ALLOWED_ELEMENTS}
          unwrapDisallowed
          components={COMPONENTS}
        >
          {source}
        </ReactMarkdown>
      ) : null,
    [source],
  );
  if (!source) return <span className="zrdb-empty-value">—</span>;
  return <div className="zrdb-research-text">{content}</div>;
}
