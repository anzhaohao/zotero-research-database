import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, it } from "mocha";
import {
  copyFormulaLatex,
  FormulaRenderer,
  renderFormulaToHtml,
} from "../../src/ui/features/figures/FormulaRenderer";
import {
  FigurePreviewButton,
  FigureThumbnail,
  type FigureClickTimer,
} from "../../src/ui/features/figures/FigureGallery";

const originalZotero = (globalThis as any).Zotero;

describe("formula renderer", function () {
  it("renders common LaTeX to KaTeX HTML and MathML", function () {
    const result = renderFormulaToHtml(String.raw`\frac{a}{b} + \sqrt{x}`);
    assert.ok(result);
    assert.equal(result.source, String.raw`\frac{a}{b} + \sqrt{x}`);
    assert.match(result.html, /katex/);
    assert.match(result.html, /MathML/);
  });

  it("accepts display delimiters without rendering them as content", function () {
    for (const source of [
      "$$x^2$$",
      "$x^2$",
      String.raw`\(x^2\)`,
      String.raw`\[x^2\]`,
    ]) {
      const result = renderFormulaToHtml(source);
      assert.ok(result);
      assert.match(result.html, /<msup>/);
      assert.doesNotMatch(result.html, /\$/);
      assert.equal(result.source, source);
    }
  });

  it("returns null so callers can show the original source on parse errors", function () {
    const result = renderFormulaToHtml(String.raw`\notARealCommand{x}`);
    assert.equal(result, null);
  });

  it("keeps source text available for copying", function () {
    const source = String.raw`E = mc^2`;
    assert.equal(renderFormulaToHtml(source)?.source, source);
  });

  it("bounds source length, nesting, and macro expansion with plain-text fallback", function () {
    const sources = [
      "x".repeat(8193),
      "{".repeat(65) + "x" + "}".repeat(65),
      String.raw`\def\recurse{\recurse}\recurse`,
    ];
    for (const source of sources) {
      assert.equal(renderFormulaToHtml(source), null);
      const markup = renderToStaticMarkup(
        createElement(FormulaRenderer, { latex: source }),
      );
      assert.match(markup, /is-fallback/);
      assert.match(markup, /zrdb-formula-source/);
    }
  });

  it("does not permit untrusted HTML or remote resources in formulas", function () {
    for (const source of [
      String.raw`\href{javascript:alert(1)}{x}`,
      String.raw`\includegraphics{https://example.invalid/image.png}`,
      String.raw`\htmlClass{injected}{x}`,
    ]) {
      const html = renderFormulaToHtml(source)?.html || "";
      assert.doesNotMatch(html, /<(?:a|img|script)\b/);
      assert.doesNotMatch(html, /class="injected"/);
    }
  });

  it("keeps formula copy controls outside the preview button and omits missing-image text", function () {
    const markup = renderToStaticMarkup(
      createElement(FigureThumbnail, {
        item: { libraryID: 1 } as Zotero.Item,
        figure: {
          provider: "zotero-figure",
          id: "formula-1",
          entryID: "formula-1",
          itemID: 1,
          kind: "formula",
          caption: "Energy",
          pageIndex: 0,
          latex: "E=mc^2",
        },
      }),
    );
    let buttons = 0;
    for (const [tag] of markup.matchAll(/<\/?button\b/g)) {
      buttons += tag.startsWith("</") ? -1 : 1;
      assert.ok(
        buttons <= 1,
        "copy button must not nest inside preview button",
      );
    }
    assert.equal(buttons, 0);
    assert.match(markup, /复制 LaTeX/);
    assert.match(markup, /katex/);
    assert.doesNotMatch(markup, /图片无法读取|正在加载图片|双击复制/);
  });
});

describe("formula card interactions", function () {
  afterEach(function () {
    (globalThis as any).Zotero = originalZotero;
  });

  function preview() {
    let nextTimer = 0;
    let images = 0;
    let pdfs = 0;
    let stopped = 0;
    const pending = new Map<number, () => void>();
    const view = {
      setTimeout(callback: () => void) {
        pending.set(++nextTimer, callback);
        return nextTimer;
      },
      clearTimeout(id: number) {
        pending.delete(id);
      },
    };
    const clickTimer = { current: undefined as FigureClickTimer | undefined };
    const button = FigurePreviewButton({
      title: "Formula",
      clickTimer,
      onOpenImage: () => {
        images++;
      },
      onOpenPdf: () => {
        pdfs++;
      },
      children: createElement(FormulaRenderer, { latex: "x^2" }),
    });
    const event = {
      stopPropagation() {
        stopped++;
      },
      currentTarget: { ownerDocument: { defaultView: view } },
    };
    return {
      click: () => button.props.onClick(event),
      doubleClick: () => button.props.onDoubleClick(event),
      flush() {
        const callbacks = [...pending.values()];
        pending.clear();
        callbacks.forEach((callback) => callback());
      },
      result: () => ({ images, pdfs, stopped, timers: pending.size }),
    };
  }

  it("opens the image once after a single click on formula content", function () {
    const card = preview();
    card.click();
    assert.deepEqual(card.result(), {
      images: 0,
      pdfs: 0,
      stopped: 1,
      timers: 1,
    });
    card.flush();
    assert.deepEqual(card.result(), {
      images: 1,
      pdfs: 0,
      stopped: 1,
      timers: 0,
    });
  });

  it("cancels pending image actions and opens the PDF on a double click", function () {
    const card = preview();
    card.click();
    card.click();
    card.doubleClick();
    card.flush();
    assert.deepEqual(card.result(), {
      images: 0,
      pdfs: 1,
      stopped: 3,
      timers: 0,
    });
  });

  it("copies through the existing service without retaining the React event", async function () {
    (globalThis as any).Zotero = {};
    let finishCopy!: () => void;
    let source = "";
    let stopped = false;
    let released = false;
    const document = {
      defaultView: {
        navigator: {
          clipboard: {
            writeText(value: string) {
              source = value;
              return new Promise<void>((resolve) => {
                finishCopy = resolve;
              });
            },
          },
        },
      },
    } as unknown as Document;
    const event = {
      stopPropagation() {
        stopped = true;
      },
      get currentTarget() {
        assert.equal(
          released,
          false,
          "event target was accessed after dispatch",
        );
        return { ownerDocument: document } as HTMLElement;
      },
    };
    const pending = copyFormulaLatex(event, String.raw`\frac{a}{b}`);
    released = true;
    finishCopy();
    assert.equal(await pending, true);
    assert.equal(stopped, true);
    assert.equal(source, String.raw`\frac{a}{b}`);
  });

  it("returns a real copy failure without triggering preview actions", async function () {
    (globalThis as any).Zotero = {};
    let stopped = false;
    const card = preview();
    const result = await copyFormulaLatex(
      {
        stopPropagation() {
          stopped = true;
        },
        currentTarget: { ownerDocument: null } as unknown as HTMLElement,
      },
      "x^2",
    );
    if (!stopped) card.click();
    card.flush();
    assert.equal(result, false);
    assert.deepEqual(card.result(), {
      images: 0,
      pdfs: 0,
      stopped: 0,
      timers: 0,
    });
  });
});

describe("bundled formula assets", function () {
  it("scopes vendor selectors and references only bundled woff2 fonts", function () {
    const path = resolve("addon/content/vendor/katex/katex.css");
    const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      const selector = match[1].trim();
      if (selector === "@font-face") continue;
      for (const part of selector.split(","))
        assert.ok(part.trim().startsWith(".zrdb-formula-renderer"), part);
    }
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)];
    assert.equal(urls.length, 20);
    for (const [, url] of urls) {
      assert.match(url, /^fonts\/ZRDB_KaTeX_[A-Za-z0-9-]+\.woff2$/);
      assert.equal(existsSync(resolve(dirname(path), url)), true);
    }
    assert.match(
      readFileSync(resolve(dirname(path), "LICENSE.txt"), "utf8"),
      /The MIT License/,
    );
  });

  it("pins the dependency to the installed and locked vendor version", function () {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    const installed = JSON.parse(
      readFileSync("node_modules/katex/package.json", "utf8"),
    );
    assert.equal(pkg.dependencies.katex, "0.16.22");
    assert.equal(lock.packages[""].dependencies.katex, pkg.dependencies.katex);
    assert.equal(
      lock.packages["node_modules/katex"].version,
      pkg.dependencies.katex,
    );
    assert.equal(installed.version, pkg.dependencies.katex);
  });
});
