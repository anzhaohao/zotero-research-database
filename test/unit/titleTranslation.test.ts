import { expect } from "chai";
import { createEmptyRecord } from "../../src/core/records";
import {
  PDFTranslateUnavailableError,
  translateTitleWithFallback,
  translateTitleWithPDFTranslate,
} from "../../src/services/titleTranslation";

const translation = {
  value: "空气激光的原理",
  audit: {
    executor: "external-agent" as const,
    executorVersion: "test",
    inputType: "manual" as const,
    inputHash: "",
    generatedAt: "2026-08-15T00:00:00.000Z",
    templateVersion: 1,
  },
};

describe("Translate for Zotero title adapter", function () {
  it("calls the public API with the plugin identity and language pair", async function () {
    let received: unknown;
    const runtime = {
      PDFTranslate: {
        api: {
          translate: async (_raw: string, options: unknown) => {
            received = options;
            return { status: "success", result: "空气激光的原理" };
          },
        },
      },
    };

    const result = await translateTitleWithPDFTranslate(
      "Principles of atmospheric lasers",
      42,
      runtime,
    );

    expect(result).to.equal("空气激光的原理");
    expect(received).to.deep.include({
      itemID: 42,
      langfrom: "en",
      langto: "zh-CN",
      pluginID: "zotero-research-database@anzhaofeng.local",
    });
  });

  it("reports every unavailable or failed result for Agent fallback", async function () {
    for (const [runtime, message] of [
      [{}, "公共翻译接口不可用"],
      [
        {
          PDFTranslate: {
            api: {
              translate: async () => ({ status: "success", result: "" }),
            },
          },
        },
        "未返回中文标题",
      ],
      [
        {
          PDFTranslate: {
            api: {
              translate: async () => ({
                status: "fail",
                result: "HTTP 429",
              }),
            },
          },
        },
        "未成功完成标题翻译",
      ],
      [
        {
          PDFTranslate: {
            api: { translate: async () => ({ status: "waiting" }) },
          },
        },
        "未成功完成标题翻译",
      ],
      [
        {
          PDFTranslate: {
            api: {
              translate: async () => {
                throw new Error("network down");
              },
            },
          },
        },
        "公共翻译接口调用失败",
      ],
    ] as const) {
      try {
        await translateTitleWithPDFTranslate("A title", 1, runtime);
        expect.fail("expected Translate for Zotero to fail");
      } catch (error) {
        expect(String(error)).to.include(message);
      }
    }
  });

  it("falls back exactly once and persists only the prepared result", async function () {
    const record = createEmptyRecord(1, "ITEM0001");
    let fallbackCalls = 0;
    let persisted: unknown;
    const result = await translateTitleWithFallback({
      record,
      translatePrimary: async () => {
        throw new PDFTranslateUnavailableError("unavailable");
      },
      translateFallback: async () => {
        fallbackCalls += 1;
        return translation;
      },
      persist: async (value) => {
        persisted = value;
      },
    });

    expect(result).to.deep.equal(translation);
    expect(fallbackCalls).to.equal(1);
    expect(persisted).to.deep.equal(translation);
  });

  it("does not invoke the Agent when persistence fails", async function () {
    const record = createEmptyRecord(1, "ITEM0002");
    let fallbackCalls = 0;
    let error: unknown;
    try {
      await translateTitleWithFallback({
        record,
        translatePrimary: async () => translation,
        translateFallback: async () => {
          fallbackCalls += 1;
          return translation;
        },
        persist: async () => {
          throw new Error("disk full");
        },
      });
    } catch (nextError) {
      error = nextError;
    }

    expect(error).to.be.instanceOf(Error);
    expect((error as Error).message).to.equal("disk full");
    expect(fallbackCalls).to.equal(0);
  });

  it("skips existing and locked translated titles", async function () {
    for (const value of [
      { value: "已有译名", locked: false },
      { value: "", locked: true },
    ]) {
      const record = createEmptyRecord(1, "ITEM0003");
      record.fields["translated-title"] = {
        ...value,
        source: "manual",
        updatedAt: "2026-08-15T00:00:00.000Z",
      };
      let calls = 0;
      const result = await translateTitleWithFallback({
        record,
        translatePrimary: async () => {
          calls += 1;
          return translation;
        },
        translateFallback: async () => {
          calls += 1;
          return translation;
        },
        persist: async () => {
          calls += 1;
        },
      });
      expect(result).to.equal(undefined);
      expect(calls).to.equal(0);
    }
  });
});
