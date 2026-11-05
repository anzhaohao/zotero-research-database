import { expect } from "chai";
import { researchMarkdownSource } from "../../src/core/researchText";

describe("research field display formatting", function () {
  it("formats numbered and labelled content without changing the source", function () {
    const source =
      "研究意义：1. 理论价值：补足现有解释。 2. 应用价值：支持工程决策。";
    const before = source;
    expect(researchMarkdownSource(source, "研究意义")).to.equal(
      "1. **理论价值：** 补足现有解释。\n2. **应用价值：** 支持工程决策。",
    );
    expect(source).to.equal(before);
  });

  it("renders fenced JSON arrays as concise bullets", function () {
    expect(
      researchMarkdownSource(
        '```json\n{"主要成果":["提出新方法","完成验证"]}\n```',
        "主要成果",
      ),
    ).to.equal("- 提出新方法\n- 完成验证");
  });

  it("splits legacy numbered text even when the Agent omitted spaces", function () {
    const source = "1.背景：补足解释。2.必要性：需要验证。3.影响：支持应用。";
    expect(researchMarkdownSource(source, "研究意义")).to.equal(
      "1. **背景：** 补足解释。\n2. **必要性：** 需要验证。\n3. **影响：** 支持应用。",
    );
    expect(source).to.equal(
      "1.背景：补足解释。2.必要性：需要验证。3.影响：支持应用。",
    );
  });

  it("does not mistake decimals for numbered lists", function () {
    const source = "11.8 fs未达到8.0 fs傅里叶极限";
    expect(researchMarkdownSource(source, "局限与迁移")).to.equal(source);
    expect(researchMarkdownSource("8.0 fs为变换极限", "局限与迁移")).to.equal(
      "8.0 fs为变换极限",
    );
  });

  it("keeps technical tokens and versions out of automatic numbering", function () {
    const source = "采用v2.0方案，Fig. 2对应50 fs与−20 dB结果，波长11.8 nm。";
    expect(researchMarkdownSource(source, "结果与证据")).to.equal(source);
  });

  it("preserves figure citations with enumeration punctuation", function () {
    for (const citation of [
      "（Fig. 2、Fig. 3）",
      "(Fig. 2. Fig. 3)",
      "图2、图3",
      "Fig. 12、Fig. 13",
      "Eq. 2) 和 Eq. 3)",
    ]) {
      const source = "**调参检验：** 比较光谱和脉宽" + citation + "。";
      expect(researchMarkdownSource(source, "研究实施")).to.equal(source);
    }
  });

  it("preserves prose numbering and technical dashes instead of inventing lists", function () {
    const source =
      "**条件：** 选择 2、4、6 片薄片，使用 Fig. 2、Fig. 3 验证；误差取 x - y，范围 2 - 4 mm。";
    expect(researchMarkdownSource(source, "研究实施")).to.equal(source);
  });

  it("preserves figure citations inside a genuine legacy numbered list", function () {
    expect(
      researchMarkdownSource(
        "1.观测：比较（Fig. 2、Fig. 3）。 2.测量：用（Fig. 4）验证。",
        "研究实施",
      ),
    ).to.equal(
      "1. **观测：** 比较（Fig. 2、Fig. 3）。\n2. **测量：** 用（Fig. 4）验证。",
    );
  });

  it("separates compact Markdown labels for display without changing the source", function () {
    const source = "**形成证据：**Fig. 2展示展宽光谱。";
    expect(researchMarkdownSource(source, "结果与证据")).to.equal(
      "**形成证据：** Fig. 2展示展宽光谱。",
    );
    expect(source).to.equal("**形成证据：**Fig. 2展示展宽光谱。");
    expect(
      researchMarkdownSource("**输出：** 展宽光谱", "结果与证据"),
    ).to.equal("**输出：** 展宽光谱");
  });

  it("keeps malformed JSON visible instead of discarding it", function () {
    expect(researchMarkdownSource('{"研究问题":"未闭合"', "研究问题")).to.equal(
      '{"研究问题":"未闭合"',
    );
  });
});
