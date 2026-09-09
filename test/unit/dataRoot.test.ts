import { access } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "chai";
import {
  DATA_ROOT_MANIFEST,
  getDataRoot,
  hasConfiguredDataRoot,
  initializeDataRoot,
  setDataRoot,
} from "../../src/storage/dataRoot";
import { createStorageRuntime } from "./storageRuntime";

describe("portable research database root", function () {
  it("freezes the active root until a new plugin scope starts", async function () {
    const runtime = await createStorageRuntime();
    try {
      const target = join(runtime.directory, "selected");
      expect(getDataRoot()).to.equal(runtime.legacyRoot);
      expect(hasConfiguredDataRoot()).to.equal(false);
      const original = await initializeDataRoot();
      setDataRoot(target);
      expect(runtime.prefs.get(runtime.rootPref)).to.equal(target);
      expect(getDataRoot()).to.equal(runtime.legacyRoot);
      expect(hasConfiguredDataRoot()).to.equal(false);
      expect(await initializeDataRoot()).to.equal(original);
      expect(
        await access(join(target, DATA_ROOT_MANIFEST)).then(
          () => true,
          () => false,
        ),
      ).to.equal(false);

      runtime.restart();
      expect(getDataRoot()).to.equal(target);
      expect(hasConfiguredDataRoot()).to.equal(true);
      expect((await initializeDataRoot()).root).to.equal(target);
      await access(join(target, DATA_ROOT_MANIFEST));
    } finally {
      await runtime.close();
    }
  });

  it("the first folder selection still keeps the current default scope", async function () {
    const runtime = await createStorageRuntime();
    try {
      const target = join(runtime.directory, "first-selection");
      setDataRoot(target);
      expect(getDataRoot()).to.equal(runtime.legacyRoot);
      expect(hasConfiguredDataRoot()).to.equal(false);
      runtime.restart();
      expect(getDataRoot()).to.equal(target);
      expect(hasConfiguredDataRoot()).to.equal(true);
    } finally {
      await runtime.close();
    }
  });

  it("clearing the pointer uses the default only after restart", async function () {
    const runtime = await createStorageRuntime();
    try {
      const target = join(runtime.directory, "existing");
      runtime.prefs.set(runtime.rootPref, target);
      expect(hasConfiguredDataRoot()).to.equal(true);
      expect(setDataRoot("  ")).to.equal("");
      expect(getDataRoot()).to.equal(target);
      expect(hasConfiguredDataRoot()).to.equal(true);
      expect((await initializeDataRoot()).root).to.equal(target);
      runtime.restart();
      expect(getDataRoot()).to.equal(runtime.legacyRoot);
      expect(hasConfiguredDataRoot()).to.equal(false);
    } finally {
      await runtime.close();
    }
  });
});
