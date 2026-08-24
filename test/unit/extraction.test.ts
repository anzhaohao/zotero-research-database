import { expect } from "chai";
import { createEmptyRecord, setManualValue } from "../../src/core/records";
import { createDefaultWorkspace } from "../../src/domain/defaults";
import type { SourceText } from "../../src/domain/types";
import {
  ExternalAgentExtractionService,
  prepareExtractionText,
  type ExtractionProgress,
} from "../../src/services/extraction";
import type { AgentBridge } from "../../src/services/externalAgent";
import type { ResearchRepository } from "../../src/storage/repository";

describe("external Agent extraction", function () {
  describe("progress", function () {
    it("reports only eligible fields and identifies the failing stage", async function () {
      const workspace = createDefaultWorkspace();
      const record = setManualValue(
        createEmptyRecord(1, "ITEM0001"),
        "research-question",
        "人工内容",
      );
      const repository = {
        loadRecord: async () => record,
        saveRecord: async () => undefined,
      } as unknown as ResearchRepository;
      const agent = {
        kind: "codex-cli",
        cancel() {},
        probe: async () => ({ executable: "codex.exe", version: "test" }),
        testStructuredOutput: async () => undefined,
        extractFields: async () => {
          throw new Error("模型暂时不可用");
        },
        synthesizeComparison: async () => ({ value: "", executorVersion: "" }),
      } satisfies AgentBridge;
      const source: SourceText = {
        type: "pdf-fulltext",
        text: "paper text",
        hash: "hash",
        attachmentID: 2,
      };
      const events: ExtractionProgress[] = [];
      const service = new ExternalAgentExtractionService(
        repository,
        agent,
        async () => source,
      );

      await service.run(
        [{ key: "ITEM0001" } as Zotero.Item],
        workspace,
        (event) => events.push(event),
      );

      expect(events[0].message).to.equal("正在读取论文全文");
      expect(events[1].message).to.include("PDF 全文，10 字符");
      expect(events.at(-1)?.state).to.equal("failed");
      expect(events.at(-1)?.message).to.equal(
        "外部 Agent 处理失败：模型暂时不可用",
      );
      expect(events.at(-1)?.fieldIDs).not.to.include("research-question");
      expect(events.at(-1)?.fieldIDs).to.include("research-outcomes");
    });
  });

  describe("input preparation", function () {
    it("keeps short paper text unchanged", function () {
      const prepared = prepareExtractionText("  Abstract\nA short paper.  ");

      expect(prepared).to.deep.equal({
        text: "Abstract\nA short paper.",
        originalLength: 23,
        focused: false,
      });
    });

    it("focuses long papers while retaining the opening and conclusion", function () {
      const opening = "OPENING-ABSTRACT research question";
      const conclusion = "CONCLUSION-RESULT the unique final finding";
      const paper = [
        opening,
        "a".repeat(24_000),
        "\n6. Conclusion\n",
        conclusion,
        "z".repeat(24_000),
      ].join("");

      const prepared = prepareExtractionText(paper);

      expect(prepared.focused).to.equal(true);
      expect(prepared.originalLength).to.equal(paper.length);
      expect(prepared.text.length).to.be.at.most(20_000);
      expect(prepared.text).to.include(opening);
      expect(prepared.text).to.include(conclusion);
      expect(prepared.text).to.include("[结论]");
    });
  });

  it("restricts a title translation run to the requested field", async function () {
    const workspace = createDefaultWorkspace();
    const record = createEmptyRecord(1, "ITEM0003");
    let requested: string[] = [];
    let saved = record;
    const repository = {
      loadRecord: async () => record,
      saveRecord: async (_item: Zotero.Item, next: typeof record) => {
        saved = next;
      },
    } as unknown as ResearchRepository;
    const agent = {
      kind: "codex-cli",
      cancel() {},
      probe: async () => ({ executable: "codex", version: "test" }),
      testStructuredOutput: async () => undefined,
      extractFields: async (fields: typeof workspace.fields) => {
        requested = fields.map((field) => field.id);
        return {
          value: { "translated-title": "空气激光的原理" },
          executorVersion: "test",
        };
      },
      synthesizeComparison: async () => ({ value: "", executorVersion: "" }),
    } satisfies AgentBridge;
    const service = new ExternalAgentExtractionService(
      repository,
      agent,
      async () => ({
        type: "pdf-fulltext",
        text: "paper",
        hash: "hash",
        attachmentID: 2,
      }),
    );

    await service.run(
      [{ key: "ITEM0003" } as Zotero.Item],
      workspace,
      () => undefined,
      { requestedFieldIDs: ["translated-title"] },
    );

    expect(requested).to.deep.equal(["translated-title"]);
    expect(saved.fields["translated-title"].value).to.equal("空气激光的原理");
    expect(saved.fields).not.to.have.property("research-question");
  });

  it("falls back from direct PDF access to prepared Zotero text", async function () {
    const workspace = createDefaultWorkspace();
    const record = createEmptyRecord(1, "ITEM0002");
    const repository = {
      loadRecord: async () => record,
      saveRecord: async () => undefined,
    } as unknown as ResearchRepository;
    let calls = 0;
    const agent = {
      kind: "hana-agent",
      cancel() {},
      probe: async () => ({ executable: "hana", version: "test" }),
      testStructuredOutput: async () => undefined,
      extractFields: async (_fields: unknown, input: unknown) => {
        calls += 1;
        if (calls === 1) throw new Error("PDF 读取失败");
        expect(input).to.deep.include({ text: "fallback text" });
        expect(input).not.to.have.property("pdfPath");
        return { value: {}, executorVersion: "test" };
      },
      synthesizeComparison: async () => ({ value: "", executorVersion: "" }),
    } satisfies AgentBridge;
    const events: ExtractionProgress[] = [];
    const service = new ExternalAgentExtractionService(
      repository,
      agent,
      async () => ({
        type: "pdf-fulltext",
        text: "fallback text",
        hash: "hash",
        attachmentID: 2,
        pdfPath: "C:\\papers\\primary.pdf",
      }),
    );

    await service.run(
      [{ key: "ITEM0002" } as Zotero.Item],
      workspace,
      (event) => events.push(event),
    );

    expect(calls).to.equal(2);
    expect(events.some((event) => event.message.includes("回退"))).to.equal(
      true,
    );
    expect(events.at(-1)?.state).to.equal("success");
  });
});
