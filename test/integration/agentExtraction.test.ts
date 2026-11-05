import { assert } from "chai";
import {
  ConfiguredAgentBridge,
  type AgentProfile,
} from "../../src/services/externalAgent";
import {
  ExternalAgentExtractionService,
  type ExtractionProgress,
} from "../../src/services/extraction";
import { resolveSourceText } from "../../src/services/contentSource";
import { ResearchRepository } from "../../src/storage/repository";
import {
  parseLocalPayload,
  getLocalPayloadSnapshot,
} from "../../src/storage/localData";

describe("live API paper extraction in Zotero", function () {
  it("fills a real complete paper, saves incremental fields and reloads verified results", async function () {
    this.timeout(360_000);
    const fixturePath = String(
      Zotero.Prefs.get(
        "extensions.zotero-research-database.test.liveAgentFixture",
        true,
      ) || "",
    );
    if (!fixturePath) this.skip();
    const fixture = JSON.parse(await IOUtils.readUTF8(fixturePath));
    const prefs = new Map<string, unknown>();
    for (const line of (await IOUtils.readUTF8(fixture.prefsPath)).split(
      /\r?\n/,
    )) {
      const match = /^user_pref\(("(?:[^"\\]|\\.)*"),\s*(.*)\);$/.exec(line);
      if (match) {
        try {
          prefs.set(JSON.parse(match[1]), JSON.parse(match[2]));
        } catch {
          /* Ignore non-preference lines. */
        }
      }
    }
    const profile = JSON.parse(
      String(
        prefs.get("extensions.zotero.zoteroResearchDatabase.agentProviders"),
      ),
    ).find((entry: any) => entry.name === fixture.providerName) as AgentProfile;
    assert.equal(profile.kind, "openai-compatible");
    const workspace = parseLocalPayload(
      JSON.parse(await IOUtils.readUTF8(fixture.databasePath)),
    ).workspace!;
    const fields = workspace.fields.filter((field) => !field.archived);
    workspace.fields = fields;
    const paper = new Zotero.Item("journalArticle");
    paper.libraryID = Zotero.Libraries.userLibraryID;
    paper.setField("title", "ZRDB live full-paper validation");
    await paper.saveTx();
    const repository = new ResearchRepository();
    const started = Date.now();
    const events: Array<{
      elapsedMs: number;
      message: string;
      remaining: number;
      state: string;
    }> = [];
    let last: ExtractionProgress | undefined;
    try {
      const attachment = await Zotero.Attachments.linkFromFile({
        file: fixture.markdownPath,
        parentItemID: paper.id,
        title: "【MinerU原文】live-paper.md",
      });
      await repository.saveManifests(
        paper,
        [{ attachmentKey: attachment.key, role: "mineru-original" }],
        [],
      );
      const resolved = await resolveSourceText(paper, repository);
      assert.equal(resolved.text, await IOUtils.readUTF8(fixture.markdownPath));
      assert.isAbove(resolved.text.length, 30_000);
      const service = new ExternalAgentExtractionService(
        repository,
        () => new ConfiguredAgentBridge({ ...profile, timeoutMs: 120_000 }),
        (item) => resolveSourceText(item, repository),
      );
      await service.run([paper], workspace, (event) => {
        last = event;
        events.push({
          elapsedMs: Date.now() - started,
          message: event.message,
          remaining: event.fieldIDs.length,
          state: event.state,
        });
      });
      const record = await repository.loadRecord(paper);
      const values = Object.fromEntries(
        fields.map((field) => [field.id, record?.fields[field.id]?.value]),
      );
      const snapshot = await getLocalPayloadSnapshot();
      const diskRecord =
        snapshot.items[paper.libraryID + ":" + paper.key]?.record;
      await IOUtils.writeUTF8(
        fixture.reportPath,
        JSON.stringify(
          {
            success: last?.state === "success",
            model: profile.model,
            effort: profile.reasoningEffort,
            totalMs: Date.now() - started,
            sourceCharacters: resolved.text.length,
            events,
            values,
            diskValues: diskRecord?.fields,
          },
          null,
          2,
        ),
      );
      assert.equal(last?.state, "success", last?.message);
      assert.lengthOf(
        events.filter((event) => event.message.startsWith("已保存")),
        fields.length,
      );
      for (const field of fields) {
        assert.isNotEmpty(String(values[field.id] || ""), field.name);
        assert.deepEqual(diskRecord?.fields[field.id]?.value, values[field.id]);
      }
      assert.match(String(values["results-evidence"]), /220[\s\S]{0,30}470/);
    } finally {
      await paper.eraseTx();
    }
  });
});
