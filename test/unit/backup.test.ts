import { expect } from "chai";
import JSZip from "jszip";
import {
  BACKUP_DATA_FILE,
  BACKUP_FILE_NAMES,
  BACKUP_MANIFEST_FILE,
  BACKUP_MAPPING_FILE,
  BACKUP_PREFS_FILE,
  matchBackupRecords,
  normalizeDOI,
  normalizeTitle,
  parseBackupArchive,
  remapLocalPayload,
  type BackupMapping,
  type ImportCandidate,
} from "../../src/services/backup";
import { sha256Text } from "../../src/services/contentSource";

function candidate(
  itemKey: string,
  fields: { doi?: string; title?: string } = {},
): ImportCandidate {
  return { libraryID: 1, itemKey, ...fields };
}

function mapping(
  entries: Array<
    Partial<BackupMapping["entries"][number]> & { itemKey: string }
  >,
): BackupMapping {
  return {
    schemaVersion: 1,
    entries: entries.map((entry) => ({ libraryID: 1, ...entry })),
  };
}

async function buildZip(contents: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(contents))
    zip.file(name, content);
  return zip.generateAsync({ type: "uint8array" });
}

async function validZipContents(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, string>> {
  const data = JSON.stringify({ schemaVersion: 1, items: {} });
  const prefs = JSON.stringify({ defaultRowHeight: 320 });
  const mappingContent = JSON.stringify({ schemaVersion: 1, entries: [] });
  const manifest = {
    formatVersion: 1,
    addonVersion: "0.3.32",
    generatedAt: "2026-09-02T00:00:00.000Z",
    schemaVersion: 1,
    files: {
      [BACKUP_DATA_FILE]: await sha256Text(data),
      [BACKUP_PREFS_FILE]: await sha256Text(prefs),
      [BACKUP_MAPPING_FILE]: await sha256Text(mappingContent),
    },
  };
  return {
    [BACKUP_DATA_FILE]: data,
    [BACKUP_PREFS_FILE]: prefs,
    [BACKUP_MAPPING_FILE]: mappingContent,
    [BACKUP_MANIFEST_FILE]: JSON.stringify(manifest),
    ...overrides,
  };
}

async function expectRejected(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (nextError) {
    error = nextError;
  }
  expect(error, "expected the promise to reject").to.be.instanceOf(Error);
  expect((error as Error).message).to.match(pattern);
}

describe("backup service", function () {
  describe("backup normalization", function () {
    it("normalizes DOI prefixes, whitespace, and case", function () {
      expect(normalizeDOI("https://doi.org/10.1000/XYZ.123")).to.equal(
        "10.1000/xyz.123",
      );
      expect(normalizeDOI("http://doi.org/10.1/A")).to.equal("10.1/a");
      expect(normalizeDOI("doi: 10.2/ABC ")).to.equal("10.2/abc");
      expect(normalizeDOI("DOI:10.3/DEF")).to.equal("10.3/def");
      expect(normalizeDOI("  ")).to.equal(undefined);
      expect(normalizeDOI(undefined)).to.equal(undefined);
    });

    it("normalizes titles by trimming, folding whitespace, and case", function () {
      expect(normalizeTitle("  Deep   Learning\nAdvances ")).to.equal(
        "deep learning advances",
      );
      expect(normalizeTitle("   ")).to.equal(undefined);
    });
  });

  describe("backup matching policy", function () {
    it("prefers itemKey over DOI and title", function () {
      const report = matchBackupRecords(
        mapping([{ itemKey: "AAAA1111", doi: "10.1/a", title: "Wrong" }]),
        [candidate("AAAA1111", { doi: "10.9/other", title: "Other" })],
      );
      expect(report.matched).to.have.length(1);
      expect(report.matched[0].method).to.equal("itemKey");
      expect(report.matched[0].target.itemKey).to.equal("AAAA1111");
    });

    it("falls back to DOI only when itemKey misses, then to title", function () {
      const candidates = [
        candidate("BBBB2222", { doi: "10.1/A", title: "First" }),
        candidate("CCCC3333", { title: "Second  Paper" }),
      ];
      const report = matchBackupRecords(
        mapping([
          {
            itemKey: "OLD00001",
            doi: "https://doi.org/10.1/a",
            title: "First",
          },
          { itemKey: "OLD00002", title: "second paper" },
        ]),
        candidates,
      );
      expect(report.matched.map((entry) => entry.method)).to.deep.equal([
        "doi",
        "title",
      ]);
      expect(report.matched[0].target.itemKey).to.equal("BBBB2222");
      expect(report.matched[1].target.itemKey).to.equal("CCCC3333");
    });

    it("reports ambiguity at one level and never degrades to a weaker level", function () {
      const report = matchBackupRecords(
        mapping([
          { itemKey: "OLD00003", doi: "10.1/dup", title: "Unique Title" },
        ]),
        [
          candidate("DDDD4444", { doi: "10.1/dup", title: "A" }),
          candidate("EEEE5555", { doi: "10.1/DUP", title: "B" }),
          candidate("FFFF6666", { title: "unique title" }),
        ],
      );
      expect(report.matched).to.have.length(0);
      expect(report.ambiguous).to.have.length(1);
      expect(report.ambiguous[0].reason).to.include("DOI");
      expect(
        report.ambiguous[0].candidates.map((c) => c.itemKey),
      ).to.deep.equal(["DDDD4444", "EEEE5555"]);
      expect(report.unmatched).to.have.length(0);
    });

    it("reports a conflict when a target is claimed twice", function () {
      const report = matchBackupRecords(
        mapping([
          { itemKey: "OLD00004", doi: "10.1/shared" },
          { itemKey: "OLD00005", doi: "10.1/shared" },
        ]),
        [candidate("GGGG7777", { doi: "10.1/shared" })],
      );
      expect(report.matched).to.have.length(1);
      expect(report.conflicts).to.have.length(1);
      expect(report.conflicts[0].record.itemKey).to.equal("OLD00005");
    });

    it("collects unmatched records without failing the whole report", function () {
      const report = matchBackupRecords(
        mapping([{ itemKey: "OLD00006", title: "Missing" }]),
        [candidate("HHHH8888", { title: "Other" })],
      );
      expect(report.matched).to.have.length(0);
      expect(report.unmatched).to.have.length(1);
      expect(report.unmatched[0].itemKey).to.equal("OLD00006");
    });
  });

  describe("backup key remapping", function () {
    const matched = [
      {
        record: { libraryID: 1, itemKey: "OLDKEY01" },
        method: "itemKey" as const,
        target: { libraryID: 2, itemKey: "NEWKEY01" },
      },
      {
        record: { libraryID: 1, itemKey: "OLDKEY02" },
        method: "doi" as const,
        target: { libraryID: 2, itemKey: "NEWKEY02" },
      },
    ];

    it("rewrites item, record, figure, comparison, and snapshot keys", function () {
      const payload = {
        schemaVersion: 1,
        workspaceLibraryID: 1,
        workspace: {
          schemaVersion: 13,
          fields: [],
          views: [],
          comparisons: [
            {
              id: "cmp-1",
              name: "比较",
              itemKeys: ["OLDKEY01", "OLDKEY02", "UNMATCHED"],
              fieldIDs: [],
              synthesisPrompt: "",
              createdAt: "2026-01-01",
              updatedAt: "2026-01-01",
            },
          ],
          snapshots: [
            {
              id: "snap-1",
              name: "快照",
              fieldIDs: [],
              rows: [
                {
                  itemKey: "OLDKEY02",
                  title: "T",
                  creators: "",
                  year: "",
                  values: {},
                },
              ],
              synthesis: "",
              createdAt: "2026-01-01",
              exportAttachmentIDs: [],
            },
          ],
          updatedAt: "2026-01-01",
        },
        items: {
          "1:OLDKEY01": {
            schemaVersion: 1,
            libraryID: 1,
            itemKey: "OLDKEY01",
            record: {
              schemaVersion: 1,
              libraryID: 1,
              itemKey: "OLDKEY01",
              revision: 3,
              fields: {},
              updatedAt: "2026-01-01",
            },
            figures: [
              {
                id: "fig-1",
                parentItemKey: "OLDKEY01",
                attachmentKey: "ATTACH01",
                kind: "figure",
                caption: "图",
                pageIndex: 0,
                sha256: "a".repeat(64),
              },
            ],
            artifacts: [],
            updatedAt: "2026-01-01",
          },
          "1:OLDKEY02": {
            schemaVersion: 1,
            libraryID: 1,
            itemKey: "OLDKEY02",
            figures: [
              {
                id: "fig-2",
                parentItemKey: "OLDKEY02",
                attachmentKey: "ATTACH02",
                kind: "table",
                caption: "表",
                pageIndex: 1,
                sha256: "b".repeat(64),
              },
            ],
            artifacts: [],
            updatedAt: "2026-01-01",
          },
        },
      };
      const remapped = remapLocalPayload(payload, matched) as any;
      const moved = remapped.items["2:NEWKEY01"];
      expect(moved.libraryID).to.equal(2);
      expect(moved.itemKey).to.equal("NEWKEY01");
      expect(moved.record.libraryID).to.equal(2);
      expect(moved.record.itemKey).to.equal("NEWKEY01");
      expect(moved.figures[0].parentItemKey).to.equal("NEWKEY01");
      expect(remapped.items["2:NEWKEY02"].figures[0].parentItemKey).to.equal(
        "NEWKEY02",
      );
      expect(remapped.workspaceLibraryID).to.equal(2);
      expect(remapped.workspace.comparisons[0].itemKeys).to.deep.equal([
        "NEWKEY01",
        "NEWKEY02",
        "UNMATCHED",
      ]);
      expect(remapped.workspace.snapshots[0].rows[0].itemKey).to.equal(
        "NEWKEY02",
      );
    });

    it("rejects a remap that would merge two items into one identity", function () {
      const payload = {
        schemaVersion: 1,
        items: {
          "1:OLDKEY01": {
            schemaVersion: 1,
            libraryID: 1,
            itemKey: "OLDKEY01",
            figures: [],
            artifacts: [],
            updatedAt: "2026-01-01",
          },
          "2:NEWKEY01": {
            schemaVersion: 1,
            libraryID: 2,
            itemKey: "NEWKEY01",
            figures: [],
            artifacts: [],
            updatedAt: "2026-01-01",
          },
        },
      };
      expect(() => remapLocalPayload(payload, matched.slice(0, 1))).to.throw(
        /冲突/,
      );
    });
  });

  describe("backup ZIP archives", function () {
    it("round-trips a valid archive with manifest checksums", async function () {
      const bytes = await buildZip(await validZipContents());
      const parsed = await parseBackupArchive(bytes);
      expect(parsed.dataSchemaVersion).to.equal(1);
      expect(parsed.prefs.defaultRowHeight).to.equal(320);
      expect(parsed.mapping.entries).to.have.length(0);
    });

    it("rejects archives with missing or extra files", async function () {
      const withoutManifest = await validZipContents();
      delete withoutManifest[BACKUP_MANIFEST_FILE];
      await expectRejected(
        parseBackupArchive(await buildZip(withoutManifest)),
        /缺少/,
      );

      const withExtra = await validZipContents({ "evil.txt": "x" });
      await expectRejected(
        parseBackupArchive(await buildZip(withExtra)),
        /不允许/,
      );
    });

    it("rejects archives whose checksum no longer matches", async function () {
      const tampered = await validZipContents({
        [BACKUP_PREFS_FILE]: JSON.stringify({ defaultRowHeight: 1 }),
      });
      await expectRejected(
        parseBackupArchive(await buildZip(tampered)),
        /校验和不匹配/,
      );
    });

    it("rejects invalid manifest, schema, and credential payloads", async function () {
      const badManifest = await validZipContents({
        [BACKUP_MANIFEST_FILE]: JSON.stringify({ formatVersion: 99 }),
      });
      await expectRejected(
        parseBackupArchive(await buildZip(badManifest)),
        /manifest/,
      );

      const contents = await validZipContents();
      const data = JSON.stringify({ schemaVersion: 2, items: {} });
      const manifest = JSON.parse(contents[BACKUP_MANIFEST_FILE]);
      manifest.schemaVersion = 2;
      manifest.files[BACKUP_DATA_FILE] = await sha256Text(data);
      const badSchema = {
        ...contents,
        [BACKUP_DATA_FILE]: data,
        [BACKUP_MANIFEST_FILE]: JSON.stringify(manifest),
      };
      await expectRejected(
        parseBackupArchive(await buildZip(badSchema)),
        /schemaVersion/,
      );

      const prefsWithToken = JSON.stringify({ artifactImportToken: "secret" });
      const manifest2 = JSON.parse(contents[BACKUP_MANIFEST_FILE]);
      manifest2.files[BACKUP_PREFS_FILE] = await sha256Text(prefsWithToken);
      const withToken = {
        ...contents,
        [BACKUP_PREFS_FILE]: prefsWithToken,
        [BACKUP_MANIFEST_FILE]: JSON.stringify(manifest2),
      };
      await expectRejected(
        parseBackupArchive(await buildZip(withToken)),
        /敏感凭据/,
      );
    });

    it("rejects non-ZIP input without touching anything", async function () {
      await expectRejected(
        parseBackupArchive(new TextEncoder().encode("not a zip")),
        /ZIP/,
      );
    });
  });

  describe("backup import safeguards", function () {
    it("never lets an empty match set reach a write", async function () {
      const contents = await validZipContents({
        [BACKUP_MAPPING_FILE]: JSON.stringify({
          schemaVersion: 1,
          entries: [{ libraryID: 1, itemKey: "GONE0001", title: "Gone" }],
        }),
      });
      const manifest = JSON.parse(contents[BACKUP_MANIFEST_FILE]);
      manifest.files[BACKUP_MAPPING_FILE] = await sha256Text(
        contents[BACKUP_MAPPING_FILE],
      );
      contents[BACKUP_MANIFEST_FILE] = JSON.stringify(manifest);
      // An empty-items payload is legal but never overwrites current data: the
      // import throws before replaceLocalPayload when nothing matches.
      const archive = await parseBackupArchive(await buildZip(contents));
      const report = matchBackupRecords(archive.mapping, [
        candidate("REAL0001", { title: "Real" }),
      ]);
      expect(report.matched).to.have.length(0);
      expect(report.unmatched).to.have.length(1);
    });

    it("exports exactly the four contract files", async function () {
      const bytes = await buildZip(await validZipContents());
      const zip = await JSZip.loadAsync(bytes);
      const names = Object.keys(zip.files).filter(
        (name) => !zip.files[name].dir,
      );
      expect(names.sort()).to.deep.equal([...BACKUP_FILE_NAMES].sort());
    });
  });
});
