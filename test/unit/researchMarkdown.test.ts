import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect } from "chai";
import { ResearchTextValue } from "../../src/ui/features/shared/ResearchTextValue";

function render(value: unknown, fieldName = "研究字段"): string {
  return renderToStaticMarkup(
    React.createElement(ResearchTextValue, { value, fieldName }),
  );
}

describe("restricted research Markdown rendering", function () {
  it("keeps decimals as text instead of creating ordered lists", function () {
    const html = render("11.8 fs未达到8.0 fs傅里叶极限", "局限与迁移");
    expect(html).not.to.include("<ol");
    expect(html).to.include("11.8 fs");
    expect(html).to.include("8.0 fs");
  });

  it("renders emphasis, single line breaks, and semantic lists", function () {
    const html = render("**标签：** 第一行\n第二行\n\n1. 一步\n2. 二步");
    expect(html).to.include("<strong>");
    expect(html).to.include("标签：");
    expect(html).to.include("<br/>");
    expect(html).to.include("<ol");
    expect(html.match(/<li/g)).to.have.length(2);
  });

  it("renders compact Chinese labels without exposing Markdown markers", function () {
    const html = render("**形成证据：**Fig. 2展示展宽光谱。", "结果与证据");
    expect(html).to.include("<strong>");
    expect(html).to.include("形成证据：");
    expect(html).not.to.include("**");
  });

  it("does not render raw HTML, images, links, or formulas", function () {
    const html = render(
      "<img src=x onerror=alert(1)>\n![隐藏](https://example.com/a.png)\n[链接](https://example.com)\n$E=mc^2$",
    );
    expect(html).not.to.include("<img");
    expect(html).not.to.include("<a");
    expect(html).to.include("&lt;img");
    expect(html).to.include("链接");
    expect(html).to.include("$E=mc^2$");
  });

  it("marks measurements and figure references as no-break text", function () {
    const html = render("Fig. 3a–c对应50 fs、−20 dB和598～945 nm");
    expect(html).to.include('class="zrdb-research-nowrap">Fig. 3a–c</span>');
    expect(html).to.include('class="zrdb-research-nowrap">50 fs</span>');
    expect(html).to.include('class="zrdb-research-nowrap">−20 dB</span>');
    expect(html).to.include('class="zrdb-research-nowrap">598～945 nm</span>');
  });

  it("keeps a short Chinese lead-in with a spaced measurement", function () {
    const html = render(
      "稳定性优于 0.3%；Fig. 4 重建出 11.8 fs，总效率约 76.5%。",
      "结果与证据",
    );
    expect(html).to.include(
      'class="zrdb-research-nowrap">稳定性优于 0.3%</span>',
    );
    expect(html).to.include(
      'class="zrdb-research-nowrap">重建出 11.8 fs</span>',
    );
    expect(html).to.include(
      'class="zrdb-research-nowrap">总效率约 76.5%</span>',
    );
    expect(html).not.to.include("<ol");
  });
});
