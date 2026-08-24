import { expect } from "chai";
import {
  mineruFigureRenderPlan,
  readPdfRegionDiskCache,
} from "../../src/services/pdfThumbnail";

describe("MinerU PDF region rendering", function () {
  it("uses a bounded preview and generates a 2400px image on open", function () {
    expect(mineruFigureRenderPlan(true, "high")).to.deep.equal({
      previewWidth: 720,
      openWidth: 2400,
      fallbackToAttachment: false,
    });
  });

  it("falls back to the imported attachment only without a usable region", function () {
    expect(mineruFigureRenderPlan(false, "high")).to.deep.equal({
      fallbackToAttachment: true,
    });
  });

  it("returns the existing disk image before PDF rendering is needed", async function () {
    const previousIO = (globalThis as any).IOUtils;
    const previousZotero = (globalThis as any).Zotero;
    try {
      (globalThis as any).IOUtils = { exists: async () => true };
      (globalThis as any).Zotero = {
        File: {
          generateDataURI: async () => "data:image/png;base64,cached",
        },
      };
      expect(
        await readPdfRegionDiskCache("C:\\cache\\region.png"),
      ).to.deep.equal({
        dataUrl: "data:image/png;base64,cached",
        path: "C:\\cache\\region.png",
      });
    } finally {
      (globalThis as any).IOUtils = previousIO;
      (globalThis as any).Zotero = previousZotero;
    }
  });
});
