import { expect } from "chai";
import {
  normalizeTableTypography,
  tableTypographyStyle,
} from "../../src/core/tableTypography";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { ResearchTextValue } from "../../src/ui/features/shared/ResearchTextValue";

describe("table typography", function () {
  it("provides readable defaults and bounds invalid or migrated values", function () {
    expect(normalizeTableTypography({})).to.deep.equal({
      tableFontFamily: "",
      tableFontSize: 15,
      tableHeadingFontSize: 16,
    });
    expect(
      normalizeTableTypography({
        tableFontSize: "",
        tableHeadingFontSize: "invalid",
      }).tableFontSize,
    ).to.equal(15);
    expect(
      normalizeTableTypography({ tableFontSize: 100, tableHeadingFontSize: 2 }),
    ).to.include({ tableFontSize: 28, tableHeadingFontSize: 10 });
    expect(
      tableTypographyStyle(
        normalizeTableTypography({ tableFontFamily: 'A "quoted" font' }),
      )["--zrdb-table-font-family"],
    ).to.equal(`${JSON.stringify('A "quoted" font')}, system-ui, sans-serif`);
  });

  it("styles only short bold labels at the beginning of a paragraph or explicit line", function () {
    const html = renderToStaticMarkup(
      React.createElement(ResearchTextValue, {
        fieldName: "研究逻辑",
        value:
          "**机制链条：** 调节参数；**自相位调制**展宽光谱。\n\n**证据边界：** 区分证据与推断。\n**另一标签：** 新的一行。正文 **中间标签：** 并非标题。",
      }),
    );
    expect(html.match(/class="zrdb-research-label"/g)).to.have.length(3);
    expect(html).to.match(/<strong><span>自相位调制<\/span><\/strong>/);
    expect(html).to.match(/<strong><span>中间标签：<\/span><\/strong>/);
  });
});
