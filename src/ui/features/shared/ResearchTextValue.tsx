import React, { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { researchMarkdownSource } from "../../../core/researchText";
import { researchHeadings } from "./researchHeadings";

const REMARK_PLUGINS = [remarkGfm, remarkBreaks, researchHeadings];
const ALLOWED_ELEMENTS = ["p", "br", "strong", "em", "code", "ul", "ol", "li"];
const FIGURE_REFERENCE_PATTERN = String.raw`\b(?:Fig(?:s)?|Figure(?:s)?|Table(?:s)?|Eq)\.\s*\d+[a-z]?(?:\s*[–—-]\s*(?:\d+)?[a-z]?)?`;
const MEASUREMENT_PATTERN = String.raw`[±+−-]?\d+(?:\.\d+)?(?:\s*(?:～|~|–|—)\s*[±+−-]?\d+(?:\.\d+)?)?\s*(?:fs|ps|ns|µs|μs|ms|s|nm|µm|μm|mm|cm|km|m|kHz|MHz|GHz|Hz|dB|nJ|µJ|μJ|mJ|J|nW|µW|μW|mW|kW|W|%|h|min)(?![A-Za-z])`;
// Keep a short Chinese lead-in with its value so a wrapped line does not
// begin with a contextless measurement such as "0.3%" or "11.8 fs".
const MEASUREMENT_LEAD_IN_PATTERN = String.raw`(?:(?<![\p{Script=Han}])[\p{Script=Han}]{1,8}[ \t]+)?`;
const RESEARCH_NO_BREAK_PATTERN = new RegExp(
  `(${FIGURE_REFERENCE_PATTERN}|${MEASUREMENT_LEAD_IN_PATTERN}${MEASUREMENT_PATTERN})`,
  "gu",
);

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
  strong: ({ children, className }) => (
    <strong className={className}>{inlineChildren(children)}</strong>
  ),
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
