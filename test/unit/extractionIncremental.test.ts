import { expect } from "chai";
import { createEmptyRecord, setManualValue } from "../../src/core/records";
import { createDefaultWorkspace } from "../../src/domain/defaults";
import {
  ConfiguredAgentBridge,
  type AgentProfile,
} from "../../src/services/externalAgent";
import {
  ExternalAgentExtractionService,
  type ExtractionProgress,
} from "../../src/services/extraction";
import type { ResearchRepository } from "../../src/storage/repository";

const profile: AgentProfile = {
  kind: "openai-compatible",
  endpoint: "https://example.com/v1",
  model: "test",
  apiProtocol: "responses",
  timeoutMs: 1000,
};
const sse = (value: unknown) =>
  new Response(
    "data: " +
      JSON.stringify({
        type: "response.completed",
        response: { status: "completed", output_text: JSON.stringify(value) },
      }) +
      "\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );

describe("incremental API extraction", function () {
  for (const kind of ["openai-compatible", "ollama", "codex-cli"] as const) {
    it(`rejects PDFs without full text before calling ${kind}`, async function () {
      const workspace = createDefaultWorkspace();
      let calls = 0;
      const repository = {
        loadRecord: async () => createEmptyRecord(1, "SCAN0001"),
      } as unknown as ResearchRepository;
      const bridge = new ConfiguredAgentBridge(
        { ...profile, kind },
        {
          fetch: async () => {
            calls++;
            return sse({});
          },
        },
      );
      const events: ExtractionProgress[] = [];
      await new ExternalAgentExtractionService(
        repository,
        bridge,
        async () => ({
          type: "pdf-fulltext",
          text: "",
          hash: "hash",
          attachmentID: 2,
          pdfPath: "C:\\papers\\scanned.pdf",
        }),
      ).run([{ key: "SCAN0001" } as Zotero.Item], workspace, (event) =>
        events.push(event),
      );
      expect(calls).to.equal(0);
      expect(events.at(-1)?.state).to.equal("failed");
      expect(events.at(-1)?.message).to.include("请先运行 MinerU 或 OCR");
    });
  }

  it("retries only the unfinished fields of each paper", async function () {
    const workspace = createDefaultWorkspace();
    let record = createEmptyRecord(1, "RETRY001");
    const first = workspace.fields[0].id,
      second = workspace.fields[1].id;
    record.fields[first] = { value: "上次已保存", locked: false };
    const requested: string[] = [];
    const repository = {
      loadRecord: async () => record,
      updateRecord: async (
        _item: Zotero.Item,
        updater: (value: typeof record) => typeof record,
      ) => (record = updater(record)),
    } as unknown as ResearchRepository;
    const bridge = new ConfiguredAgentBridge(profile, {
      fetch: async (_url, init) => {
        const ids = Object.keys(
          JSON.parse(String(init?.body)).text.format.schema.properties,
        );
        requested.push(...ids);
        return sse({ [second]: "重试成功" });
      },
    });
    await new ExternalAgentExtractionService(repository, bridge, async () => ({
      type: "pdf-fulltext",
      text: "全文",
      hash: "hash",
      attachmentID: 2,
    })).run([{ key: "RETRY001" } as Zotero.Item], workspace, () => undefined, {
      requestedFieldIDsByItem: new Map([["RETRY001", [second]]]),
    });
    expect(requested).to.deep.equal([second]);
    expect(record.fields[first].value).to.equal("上次已保存");
    expect(record.fields[second].value).to.equal("重试成功");
  });

  it("limits concurrent requests, saves each validated field once and preserves manual changes", async function () {
    const workspace = createDefaultWorkspace();
    let record = createEmptyRecord(1, "PAPER001");
    let active = 0,
      peak = 0,
      writes = 0;
    const events: ExtractionProgress[] = [];
    const first = workspace.fields[0].id;
    const repository = {
      loadRecord: async () => record,
      updateRecord: async (
        _item: Zotero.Item,
        updater: (value: typeof record) => typeof record,
      ) => {
        record = updater(record);
        writes++;
        return record;
      },
    } as unknown as ResearchRepository;
    const bridge = new ConfiguredAgentBridge(profile, {
      fetch: async (_url, init) => {
        active++;
        peak = Math.max(peak, active);
        const body = JSON.parse(String(init?.body));
        const id = Object.keys(body.text.format.schema.properties)[0];
        await new Promise((resolve) =>
          setTimeout(resolve, id === first ? 15 : 5),
        );
        if (id === first) record = setManualValue(record, first, "用户刚修改");
        active--;
        return sse({ [id]: "正文证据" });
      },
    });
    const service = new ExternalAgentExtractionService(
      repository,
      bridge,
      async () => ({
        type: "pdf-fulltext",
        text: "完整论文",
        hash: "hash",
        attachmentID: 2,
      }),
    );
    await service.run(
      [{ key: "PAPER001" } as Zotero.Item],
      workspace,
      (event) => events.push(event),
    );
    expect(peak).to.equal(3);
    expect(writes).to.equal(workspace.fields.length);
    expect(record.fields[first].value).to.equal("用户刚修改");
    expect(
      events.filter((event) => event.record && event.state === "running"),
    ).to.have.length(workspace.fields.length);
    expect(events.at(-1)?.state).to.equal("success");
    expect(events.at(-1)?.fieldIDs).to.deep.equal([]);
  });

  it("retains completed fields when another stream terminates early", async function () {
    const workspace = createDefaultWorkspace();
    workspace.fields = workspace.fields.slice(0, 2);
    let record = createEmptyRecord(1, "PAPER002");
    const events: ExtractionProgress[] = [];
    const repository = {
      loadRecord: async () => record,
      updateRecord: async (
        _item: Zotero.Item,
        updater: (value: typeof record) => typeof record,
      ) => (record = updater(record)),
    } as unknown as ResearchRepository;
    const bridge = new ConfiguredAgentBridge(profile, {
      fetch: async (_url, init) => {
        const id = Object.keys(
          JSON.parse(String(init?.body)).text.format.schema.properties,
        )[0];
        if (id === workspace.fields[0].id) return sse({ [id]: "已验证结果" });
        await new Promise((resolve) => setTimeout(resolve, 10));
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"unfinished"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    await new ExternalAgentExtractionService(repository, bridge, async () => ({
      type: "pdf-fulltext",
      text: "全文",
      hash: "hash",
      attachmentID: 2,
    })).run([{ key: "PAPER002" } as Zotero.Item], workspace, (event) =>
      events.push(event),
    );
    expect(record.fields[workspace.fields[0].id].value).to.equal("已验证结果");
    expect(record.fields[workspace.fields[1].id]?.value || "").to.equal("");
    expect(events.at(-1)?.state).to.equal("failed");
    expect(events.at(-1)?.message).to.include("已保存 1 个字段");
    expect(events.at(-1)?.fieldIDs).to.deep.equal([workspace.fields[1].id]);
  });

  it("cancels remaining fields after a save failure without retrying the model", async function () {
    const fields = createDefaultWorkspace().fields;
    let calls = 0;
    const bridge = new ConfiguredAgentBridge(profile, {
      fetch: async (_url, init) => {
        calls++;
        const id = Object.keys(
          JSON.parse(String(init?.body)).text.format.schema.properties,
        )[0];
        return sse({ [id]: "已验证结果" });
      },
    });
    let failure: unknown;
    try {
      await bridge.extractFields(fields, "全文", undefined, async () => {
        throw new Error("磁盘写入失败");
      });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).to.include("磁盘写入失败");
    expect(calls).to.equal(3);
  });

  it("keeps a saved field on cancellation and starts no queued requests", async function () {
    const fields = createDefaultWorkspace().fields;
    let calls = 0,
      saved = 0;
    const bridge = new ConfiguredAgentBridge(profile, {
      fetch: async (_url, init) => {
        calls++;
        const id = Object.keys(
          JSON.parse(String(init?.body)).text.format.schema.properties,
        )[0];
        return sse({ [id]: "已验证结果" });
      },
    });
    let failure: unknown;
    try {
      await bridge.extractFields(fields, "全文", undefined, async () => {
        saved++;
        bridge.cancel();
      });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).to.include("取消");
    expect(calls).to.equal(3);
    expect(saved).to.equal(1);
  });
});
