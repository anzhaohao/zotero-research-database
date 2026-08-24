import { expect } from "chai";
import { researchDisplayBlocks } from "../../src/core/researchText";

describe("research field display formatting", function () {
  it("formats numbered and labelled content without changing the source", function () {
    const source =
      "研究意义：1. 理论价值：补足现有解释。 2. 应用价值：支持工程决策。";
    const before = source;
    expect(researchDisplayBlocks(source, "研究意义")).to.deep.equal([
      {
        kind: "bullet",
        marker: "1.",
        label: "理论价值",
        text: "补足现有解释。",
      },
      {
        kind: "bullet",
        marker: "2.",
        label: "应用价值",
        text: "支持工程决策。",
      },
    ]);
    expect(source).to.equal(before);
  });

  it("renders fenced JSON arrays as concise bullets", function () {
    expect(
      researchDisplayBlocks(
        '```json\n{"主要成果":["提出新方法","完成验证"]}\n```',
        "主要成果",
      ),
    ).to.deep.equal([
      { kind: "bullet", marker: "•", text: "提出新方法" },
      { kind: "bullet", marker: "•", text: "完成验证" },
    ]);
  });

  it("splits legacy numbered text even when the Agent omitted spaces", function () {
    const source = "1.背景：补足解释。2.必要性：需要验证。3.影响：支持应用。";
    expect(researchDisplayBlocks(source, "研究意义")).to.have.length(3);
    expect(source).to.equal(
      "1.背景：补足解释。2.必要性：需要验证。3.影响：支持应用。",
    );
  });

  it("keeps malformed JSON visible instead of discarding it", function () {
    expect(
      researchDisplayBlocks('{"研究问题":"未闭合"', "研究问题"),
    ).to.deep.equal([
      { kind: "paragraph", label: '{"研究问题"', text: '"未闭合"' },
    ]);
  });
});
