import { expect } from "chai";
import { prepareMinerUAssets } from "../../src/services/mineruAssets";
import {
  mineruDisplayPath,
  mineruNativePath,
} from "../../src/services/mineruFileIO";
import { parseHarnessModels } from "../../src/services/localHarnessModels";

describe("portable MinerU image names", function () {
  it("distinguishes same basenames and deduplicates identical content with original names retained", async function () {
    const result = await prepareMinerUAssets(
      [
        { name: "a/images/图.png", bytes: new Uint8Array([1]) },
        { name: "b/images/图.png", bytes: new Uint8Array([2]) },
        { name: "c/" + "名".repeat(500) + ".png", bytes: new Uint8Array([1]) },
        {
          name: "a/content_list.json",
          bytes: new TextEncoder().encode('[{"img_path":"images/图.png"}]'),
        },
      ],
      '![a](images/图.png) ![b](../b/images/图.png)\n<img src="images/图.png">\n![ref][fig]\n[fig]: images/图.png',
      "a/full.md",
    );
    const images = result.files.filter((f) => f.path.startsWith("images/"));
    expect(images).to.have.length(2);
    expect(images[0].originalPaths).to.have.length(2);
    for (const file of images)
      expect(file.path).to.match(/^images\/[a-f0-9]{64}\.png$/);
    expect(result.markdown)
      .to.include(images[0].path)
      .and.include(images[1].path);
    expect(
      JSON.parse(
        new TextDecoder().decode(
          result.files.find((f) => f.path.endsWith("content_list.json"))!.bytes,
        ),
      )[0].img_path,
    ).to.equal(images[0].path);
  });

  it("rejects missing image references and duplicate source paths before writing", async function () {
    for (const entries of [
      [],
      [
        { name: "a.png", bytes: new Uint8Array([1]) },
        { name: "a.png", bytes: new Uint8Array([2]) },
      ],
    ]) {
      let error: unknown;
      try {
        await prepareMinerUAssets(entries, "![missing](absent.png)", "full.md");
      } catch (e) {
        error = e;
      }
      expect(error).to.be.instanceOf(Error);
    }
  });

  it("keeps Windows prefixes only at the IO boundary, including UNC paths", function () {
    const previous = (globalThis as any).Services;
    (globalThis as any).Services = { appinfo: { OS: "WINNT" } };
    try {
      for (const path of ["C:\\中文\\paper.md", "\\\\server\\share\\paper.md"])
        expect(mineruDisplayPath(mineruNativePath(path))).to.equal(path);
      expect(mineruNativePath(mineruNativePath("C:\\a"))).to.equal(
        "\\\\?\\C:\\a",
      );
    } finally {
      (globalThis as any).Services = previous;
    }
  });

  it("reads API and CLI model formats and removes duplicate models", function () {
    expect(
      parseHarnessModels({
        data: [{ id: "one" }, { id: "two" }, { id: "one" }],
      }),
    ).to.deep.equal(["one", "two"]);
    expect(
      parseHarnessModels({
        models: ["one", { slug: "two" }, { model: "three" }],
      }),
    ).to.deep.equal(["one", "two", "three"]);
    expect(() => parseHarnessModels({ error: "offline" })).to.throw("模型数组");
  });
});
