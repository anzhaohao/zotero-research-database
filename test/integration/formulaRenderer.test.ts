import { assert } from "chai";
import React, { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { config } from "../../package.json";
import {
  FormulaCopyButton,
  FormulaRenderer,
} from "../../src/ui/features/figures/FormulaRenderer";
import {
  FigurePreviewButton,
  FigureThumbnail,
  type FigureClickTimer,
} from "../../src/ui/features/figures/FigureGallery";
import { assertUnobscured, clickControl } from "../uiHelpers";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const CONTENT_URI = "chrome://" + config.addonRef + "/content/";

async function eventually(
  check: () => boolean,
  message: string | (() => string),
): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() >= deadline)
      assert.fail(typeof message === "function" ? message() : message);
    await Zotero.Promise.delay(20);
  }
}

describe("formula rendering in the Zotero host", function () {
  this.timeout(20_000);

  let win: _ZoteroTypes.MainWindow;
  let container: HTMLDivElement;
  let stylesheet: HTMLLinkElement;
  let root: Root;

  beforeEach(async function () {
    assert.match(
      PathUtils.profileDir.replace(/\\/g, "/"),
      /\/\.scaffold\/test\/profile\/?$/i,
      "formula UI fixtures must only mount in the isolated test profile",
    );
    win = Zotero.getMainWindow();
    assert.exists(win);
    const doc = win.document;
    stylesheet = doc.createElementNS(HTML_NAMESPACE, "link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = CONTENT_URI + "zoteroPane.css";
    stylesheet.id = "zrdb-formula-test-stylesheet";
    container = doc.createElementNS(HTML_NAMESPACE, "div");
    container.id = "zrdb-formula-test-host";
    container.style.cssText =
      "position:fixed;top:70px;left:40px;width:620px;max-width:calc(100vw - 80px);" +
      "max-height:calc(100vh - 110px);overflow:auto;padding:18px;" +
      "z-index:2147483647;background:Canvas;color:CanvasText;border:1px solid GrayText;";
    doc.documentElement.append(stylesheet, container);
    root = createRoot(container);
    await eventually(
      () => Boolean(stylesheet.sheet),
      "plugin chrome stylesheet did not load",
    );
  });

  afterEach(function () {
    root?.unmount();
    container?.remove();
    stylesheet?.remove();
  });

  it("renders fractions and radicals with scoped chrome CSS and packaged fonts", async function () {
    root.render(
      React.createElement(FormulaRenderer, {
        latex: "$\\frac{a_1+b^2}{\\sqrt{x}}=\\sum_{n=1}^{5}n$",
      }),
    );
    await eventually(
      () => Boolean(container.querySelector(".katex-html")),
      "KaTeX HTML was not mounted by React",
    );
    const rendered = container.querySelector<HTMLElement>(".katex-html")!;
    const katex = container.querySelector<HTMLElement>(".katex")!;
    const mathml = container.querySelector(".katex-mathml math");
    assert.exists(mathml, "accessible MathML is present beside the HTML");
    assert.exists(mathml!.querySelector("mfrac"), "fraction MathML");
    assert.exists(mathml!.querySelector("msqrt"), "radical MathML");
    await eventually(
      () => win.getComputedStyle(katex).fontFamily.includes("ZRDB_KaTeX_Main"),
      "scoped KaTeX vendor CSS did not apply through the chrome import",
    );
    assert.equal(win.getComputedStyle(rendered).display, "block");
    assert.equal(
      win.getComputedStyle(container.querySelector(".katex-mathml")!).position,
      "absolute",
      "MathML does not duplicate the visual equation",
    );
    const fonts = win.document.fonts;
    const main = await fonts.load('16px "ZRDB_KaTeX_Main"', "a1+");
    const math = await fonts.load('italic 16px "ZRDB_KaTeX_Math"', "x");
    assert.isAbove(main.length, 0, "packaged main font face loaded");
    assert.isAbove(math.length, 0, "packaged math font face loaded");
    for (const face of [...main, ...math])
      assert.equal(face.status, "loaded", face.family + " is readable");
    assert.isTrue(fonts.check('16px "ZRDB_KaTeX_Main"', "a1+"));
    assert.isTrue(fonts.check('italic 16px "ZRDB_KaTeX_Math"', "x"));
    assertUnobscured(win, rendered);
    const source = await Zotero.File.getResourceAsync(
      CONTENT_URI + "vendor/katex/katex.css",
    );
    assert.include(source, "fonts/ZRDB_KaTeX_Main-Regular.woff2");
    assert.notInclude(source, '.woff) format("woff")');
  });

  it("keeps invalid LaTeX readable and displays a formula without an image", async function () {
    const invalid = "\\unknownZRDBCommand{<script>&}";
    root.render(
      React.createElement(
        "div",
        null,
        React.createElement(
          "div",
          { id: "zrdb-formula-test-fallback" },
          React.createElement(FormulaRenderer, { latex: invalid }),
        ),
        React.createElement(FigureThumbnail, {
          item: { libraryID: -1 } as Zotero.Item,
          figure: {
            provider: "zotero-figure",
            id: "zrdb-test-formula-no-image",
            entryID: "zrdb-test-formula-no-image",
            itemID: -1,
            kind: "formula",
            caption: "Formula without an image",
            pageIndex: 0,
            latex: "\\frac{1}{2}",
            // Invalid in-memory data exercises image failure without reading
            // files or contacting the optional Zotero Figure plugin.
            imageRef: "data:image/png;base64,aW52YWxpZA==",
          },
        }),
      ),
    );
    await eventually(
      () => Boolean(container.querySelector(".zrdb-figure-card .katex")),
      "formula-only card did not render",
    );
    await Zotero.Promise.delay(150);
    await eventually(
      () => !container.querySelector(".zrdb-figure-card img"),
      "invalid image did not enter its fallback path",
    );
    const fallback = container.querySelector<HTMLElement>(
      ".is-fallback .zrdb-formula-source",
    )!;
    assert.equal(fallback.textContent, invalid);
    assert.notExists(fallback.querySelector("script"));
    assertUnobscured(win, fallback);
    const card = container.querySelector<HTMLElement>(".zrdb-figure-card")!;
    assert.exists(card.querySelector(".katex-html"));
    assert.notInclude(card.textContent || "", "图片无法读取");
    assert.notInclude(card.textContent || "", "正在加载图片");
    assert.notExists(card.querySelector("button button"));
    assert.exists(card.querySelector(".zrdb-formula-copy"));
  });

  it("copies separately while preview clicks retain image and PDF actions", async function () {
    const latex = "E=mc^2";
    const actions = { image: 0, pdf: 0, row: 0, copies: [] as string[] };
    const clipboard = Zotero.Utilities.Internal as any;
    const originalCopy = clipboard.copyTextToClipboard;
    const timer = { current: undefined as FigureClickTimer | undefined };
    let effectsReady = false;
    let resolveCopy: (() => void) | undefined;
    let copyResolved = false;
    const events: string[] = [];
    const observePointer = (event: Event) => {
      events.push(
        event.type +
          ":" +
          (event.target as Element)?.localName +
          ":trusted=" +
          event.isTrusted,
      );
    };
    const eventTypes = ["mousedown", "mouseup", "click", "dblclick"];
    const status = () =>
      container.querySelector(".zrdb-formula-copy-status")?.textContent;
    const diagnostics = () =>
      JSON.stringify({
        actions,
        status: status(),
        effectsReady,
        copyResolved,
        focused: win.document.hasFocus(),
        activeElement: win.document.activeElement?.localName,
        events,
      });
    function CopyFixture() {
      // Child passive effects (including the copy status reset) run before this
      // parent effect. DOM presence alone is not an interaction-ready signal.
      useEffect(() => {
        effectsReady = true;
      }, []);
      return React.createElement(
        "div",
        {
          onDoubleClick: () => {
            actions.row++;
          },
        },
        React.createElement(FigurePreviewButton, {
          title: "Formula preview",
          clickTimer: timer,
          onOpenImage: () => {
            actions.image++;
          },
          onOpenPdf: () => {
            actions.pdf++;
          },
          children: React.createElement(FormulaRenderer, { latex }),
        }),
        React.createElement(FormulaCopyButton, { latex }),
      );
    }
    try {
      clipboard.copyTextToClipboard = (value: string) => {
        actions.copies.push(value);
        return new Promise<void>((resolve) => {
          resolveCopy = () => {
            copyResolved = true;
            resolve();
          };
        });
      };
      for (const type of eventTypes)
        container.addEventListener(type, observePointer, true);
      root.render(React.createElement(CopyFixture));
      await eventually(
        () =>
          effectsReady &&
          Boolean(container.querySelector(".zrdb-formula-copy")),
        () => "copy fixture did not finish mounting: " + diagnostics(),
      );
      const copy =
        container.querySelector<HTMLButtonElement>(".zrdb-formula-copy")!;
      clickControl(win, copy);
      await eventually(
        () => actions.copies.length === 1,
        () =>
          "trusted click did not reach clipboard exactly once: " +
          diagnostics(),
      );
      assert.deepEqual(actions.copies, [latex], diagnostics());
      assert.isFalse(copyResolved, "clipboard completion is still pending");
      assert.notEqual(
        status(),
        "已复制",
        "no success before clipboard completion",
      );
      copy.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
      assert.exists(resolveCopy, "clipboard completion callback");
      resolveCopy!();
      await eventually(
        () => status() === "已复制",
        () =>
          "resolved copy action did not report completion: " + diagnostics(),
      );
      await Zotero.Promise.delay(260);
      assert.deepEqual(actions, { image: 0, pdf: 0, row: 0, copies: [latex] });
      const rendered = container.querySelector<HTMLElement>(".katex-html")!;
      clickControl(win, rendered);
      await eventually(
        () => actions.image === 1,
        "single click did not open image",
      );
      clickControl(win, rendered);
      clickControl(win, rendered);
      rendered.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
      await Zotero.Promise.delay(260);
      assert.deepEqual(actions, { image: 1, pdf: 1, row: 0, copies: [latex] });
    } finally {
      resolveCopy?.();
      for (const type of eventTypes)
        container.removeEventListener(type, observePointer, true);
      if (timer.current) timer.current.view.clearTimeout(timer.current.id);
      timer.current = undefined;
      clipboard.copyTextToClipboard = originalCopy;
    }
  });
});
