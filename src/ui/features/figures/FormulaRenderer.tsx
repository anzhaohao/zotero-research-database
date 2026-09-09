import katex from "katex";
import {
  type SyntheticEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { copyPlainText } from "../../../services/clipboard";

export type FormulaRenderResult = {
  html: string;
  source: string;
};

function stripMathDelimiters(value: string): string {
  const source = value.trim();
  if (source.startsWith("$$") && source.endsWith("$$"))
    return source.slice(2, -2).trim();
  if (source.startsWith("\\[") && source.endsWith("\\]"))
    return source.slice(2, -2).trim();
  if (source.startsWith("\\(") && source.endsWith("\\)"))
    return source.slice(2, -2).trim();
  if (source.length > 1 && source.startsWith("$") && source.endsWith("$"))
    return source.slice(1, -1).trim();
  return source;
}

function isWithinFormulaLimits(source: string): boolean {
  if (source.length > 8192) return false;
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] === "{" && ++depth > 64) return false;
    if (source[index] === "}") depth--;
  }
  return true;
}

export function renderFormulaToHtml(latex: string): FormulaRenderResult | null {
  const source = latex.trim();
  if (!source || !isWithinFormulaLimits(source)) return null;
  try {
    const html = katex.renderToString(stripMathDelimiters(source), {
      displayMode: true,
      output: "htmlAndMathml",
      throwOnError: true,
      strict: "ignore",
      trust: false,
      maxExpand: 1000,
      maxSize: 20,
    });
    if (html.length > 250_000) return null;
    return { html, source };
  } catch {
    return null;
  }
}

export function copyFormulaLatex(
  event: Pick<SyntheticEvent<HTMLElement>, "stopPropagation" | "currentTarget">,
  latex: string,
): Promise<boolean> {
  event.stopPropagation();
  // React clears currentTarget when dispatch finishes, before async copy settles.
  return copyPlainText(latex.trim(), event.currentTarget.ownerDocument);
}

export function FormulaRenderer({ latex }: { latex: string }) {
  const rendered = useMemo(() => renderFormulaToHtml(latex), [latex]);
  const source = latex.trim();
  if (!source) return null;

  if (!rendered)
    return (
      <span
        className="zrdb-formula-renderer is-fallback"
        title={`LaTeX：${source}`}
      >
        <code className="zrdb-formula-source">{source}</code>
      </span>
    );

  return (
    <span
      className="zrdb-formula-renderer"
      title={`LaTeX：${source}`}
      data-latex={source}
    >
      <span
        className="zrdb-formula-rendered"
        aria-label="渲染后的公式"
        dangerouslySetInnerHTML={{ __html: rendered.html }}
      />
    </span>
  );
}

export function FormulaCopyButton({ latex }: { latex: string }) {
  const [status, setStatus] = useState("");
  const request = useRef(0);
  useEffect(() => {
    setStatus("");
    return () => {
      request.current++;
    };
  }, [latex]);
  return (
    <span className="zrdb-formula-renderer zrdb-formula-controls">
      <button
        type="button"
        className="zrdb-formula-copy"
        title="复制原始 LaTeX"
        onClick={(event) => {
          const currentRequest = ++request.current;
          void copyFormulaLatex(event, latex).then((copied) => {
            if (currentRequest === request.current)
              setStatus(copied ? "已复制" : "复制失败");
          });
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        复制 LaTeX
      </button>
      <span className="zrdb-formula-copy-status" aria-live="polite">
        {status}
      </span>
    </span>
  );
}
