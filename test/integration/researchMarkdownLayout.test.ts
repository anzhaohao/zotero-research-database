import { assert } from "chai";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { config } from "../../package.json";
import { ResearchTextValue } from "../../src/ui/features/shared/ResearchTextValue";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const CONTENT_URI = "chrome://" + config.addonRef + "/content/";
const RESULTS_EVIDENCE =
  "**形成证据：**Fig. 2a–c 显示仅 L=100 mm 时模式良好且输出能量最高；Fig. 3a–c 显示 340 µJ 时光斑最小、脉宽约 52 fs，接近输入 50 fs，支持时空稳定判断。\n" +
  "**输出：**展宽光谱为 598–945 nm（−20 dB），能量 312 µJ、效率约 92%，1 h 能量稳定性优于 0.3%（均方根）。Fig. 4 重建出 11.8 fs（4–5 个光学周期）脉冲及平坦相位；压缩后能量 260 µJ，总效率约 76.5%。";

async function eventually(
  check: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail(message);
    await Zotero.Promise.delay(20);
  }
}

describe("research Markdown layout in the Zotero host", function () {
  this.timeout(20_000);

  let win: _ZoteroTypes.MainWindow;
  let container: HTMLDivElement;
  let stylesheet: HTMLLinkElement;
  let root: Root;

  beforeEach(async function () {
    assert.match(
      PathUtils.profileDir.replace(/\\/g, "/"),
      /\/\.scaffold\/test\/profile\/?$/i,
      "research text fixtures must only mount in the isolated test profile",
    );
    win = Zotero.getMainWindow();
    assert.exists(win);
    const doc = win.document;
    stylesheet = doc.createElementNS(HTML_NAMESPACE, "link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = CONTENT_URI + "zoteroPane.css";
    container = doc.createElementNS(HTML_NAMESPACE, "div");
    container.className = "zrdb-table-cell";
    container.style.cssText =
      "position:fixed;top:70px;left:40px;width:300px;height:320px;" +
      "z-index:2147483647;background:Canvas;color:CanvasText;";
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

  it("keeps measurements and their Chinese lead-ins in normal inline flow", async function () {
    root.render(
      React.createElement(ResearchTextValue, {
        value: RESULTS_EVIDENCE,
        fieldName: "结果与证据",
      }),
    );
    await eventually(
      () => Boolean(container.querySelector(".zrdb-research-block")),
      "research field was not mounted by React",
    );
    await win.document.fonts.ready;
    const measurements = Array.from(
      container.querySelectorAll<HTMLElement>(".zrdb-research-nowrap"),
    ).map((element) => {
      const range = win.document.createRange();
      range.selectNodeContents(element);
      const style = win.getComputedStyle(element);
      return {
        text: element.textContent,
        display: style.display,
        whiteSpace: style.whiteSpace,
        lines: Array.from(range.getClientRects()).map((rect) => rect.toJSON()),
      };
    });
    const contextualMeasurements = measurements.filter(({ text }) =>
      ["0.3%", "11.8 fs", "76.5%"].some((value) => text?.endsWith(value)),
    );
    assert.deepEqual(
      contextualMeasurements.map(({ text }) => text),
      ["能量稳定性优于 0.3%", "重建出 11.8 fs", "总效率约 76.5%"],
    );
    for (const measurement of contextualMeasurements) {
      assert.equal(measurement.display, "inline");
      assert.equal(measurement.whiteSpace, "nowrap");
      assert.equal(measurement.lines.length, 1);
    }
    assert.equal(container.querySelectorAll("br").length, 1);
    assert.equal(container.querySelectorAll("ol").length, 0);
  });

  it("does not turn decimal measurements or figure references into lists", async function () {
    root.render(
      React.createElement(ResearchTextValue, {
        value: "未达到 8.0 fs 傅里叶极限；Fig. 2 给出了对应证据。",
        fieldName: "局限与迁移",
      }),
    );
    await eventually(
      () => Boolean(container.querySelector(".zrdb-research-block")),
      "decimal and figure fixture was not mounted by React",
    );
    assert.equal(container.querySelectorAll("ol").length, 0);
    assert.equal(container.querySelectorAll("br").length, 0);
    assert.include(container.textContent, "8.0 fs");
    assert.include(container.textContent, "Fig. 2");
  });
});
