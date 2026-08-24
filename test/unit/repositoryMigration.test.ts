import { expect } from "chai";
import { writeRecordExtra } from "../../src/core/extraProperties";
import { createEmptyRecord, setManualValue } from "../../src/core/records";
import { ResearchRepository } from "../../src/storage/repository";
import {
  createItemInternalState,
  type ResearchDataStore,
  type ResearchDataWriteOptions,
} from "../../src/storage/syncedData";

describe("legacy Extra migration safety", function () {
  it("keeps every old ZRDB line when the synced write fails", async function () {
    const previous = (globalThis as any).Zotero;
    (globalThis as any).Zotero = { Libraries: { userLibraryID: 1 } };
    const record = setManualValue(
      createEmptyRecord(1, "ABCD1234"),
      "research-significance",
      "必须保留",
    );
    const original = writeRecordExtra("Citation Key: keep", record);
    let extra = original;
    let saves = 0;
    const item = {
      id: 1,
      key: "ABCD1234",
      libraryID: 1,
      isRegularItem: () => true,
      getField: (field: string) => (field === "extra" ? extra : ""),
      setField: (field: string, value: string) => {
        if (field === "extra") extra = value;
      },
      getNotes: () => [],
      saveTx: async () => {
        saves += 1;
      },
    } as unknown as Zotero.Item;
    const failingStore: ResearchDataStore = {
      getWorkspace: () => undefined,
      setWorkspace: async () => undefined,
      getItem: () => undefined,
      setItem: async () => {
        throw new Error("simulated synced storage failure");
      },
    };
    try {
      let error: unknown;
      try {
        await new ResearchRepository(failingStore).loadRecord(item);
      } catch (nextError) {
        error = nextError;
      }
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include("simulated");
      expect(extra).to.equal(original);
      expect(saves).to.equal(0);
    } finally {
      (globalThis as any).Zotero = previous;
    }
  });

  it("saves translated-title with its isolated scope and never touches Extra", async function () {
    const previous = (globalThis as any).Zotero;
    (globalThis as any).Zotero = { Libraries: { userLibraryID: 1 } };
    const originalExtra = "Citation Key: keep\nZRDB: legacy-must-stay";
    let extra = originalExtra;
    let fieldWrites = 0;
    let saves = 0;
    let writeOptions: ResearchDataWriteOptions | undefined;
    let state = {
      ...createItemInternalState(1, "ABCD1234"),
      record: createEmptyRecord(1, "ABCD1234"),
    };
    const item = {
      id: 1,
      key: "ABCD1234",
      libraryID: 1,
      isRegularItem: () => true,
      getField: (field: string) => (field === "extra" ? extra : ""),
      setField: (field: string, value: string) => {
        fieldWrites += 1;
        if (field === "extra") extra = value;
      },
      saveTx: async () => {
        saves += 1;
      },
    } as unknown as Zotero.Item;
    const store: ResearchDataStore = {
      getWorkspace: () => undefined,
      setWorkspace: async () => undefined,
      getItem: () => state,
      setItem: async (next, options) => {
        state = next;
        writeOptions = options;
      },
    };
    try {
      const saved = await new ResearchRepository(store).saveTranslatedTitle(
        item,
        "空气激光的原理",
        {
          executor: "external-agent",
          executorVersion: "test",
          inputType: "manual",
          inputHash: "",
          generatedAt: "2026-08-15T00:00:00.000Z",
          templateVersion: 1,
        },
      );
      expect(saved.fields["translated-title"].value).to.equal("空气激光的原理");
      expect(writeOptions?.changeScope).to.equal("translated-title");
      expect(extra).to.equal(originalExtra);
      expect(fieldWrites).to.equal(0);
      expect(saves).to.equal(0);
    } finally {
      (globalThis as any).Zotero = previous;
    }
  });
});
