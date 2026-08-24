import { expect } from "chai";
import { copyPlainText } from "../../src/services/clipboard";

const originalZotero = (globalThis as any).Zotero;

describe("plain-text clipboard", function () {
  afterEach(function () {
    (globalThis as any).Zotero = originalZotero;
  });

  it("prefers Zotero's privileged clipboard helper", async function () {
    let copied = "";
    (globalThis as any).Zotero = {
      Utilities: {
        Internal: {
          copyTextToClipboard(value: string) {
            copied = value;
          },
        },
      },
    };

    expect(await copyPlainText("引用文本")).to.equal(true);
    expect(copied).to.equal("引用文本");
  });

  it("does not treat an absent optional helper as success", async function () {
    (globalThis as any).Zotero = { Utilities: { Internal: {} } };
    let copied = "";
    const document = {
      defaultView: {
        navigator: {
          clipboard: {
            async writeText(value: string) {
              copied = value;
            },
          },
        },
      },
    } as unknown as Document;

    expect(await copyPlainText("APA citation", document)).to.equal(true);
    expect(copied).to.equal("APA citation");
  });

  it("reports failure when no clipboard implementation exists", async function () {
    (globalThis as any).Zotero = {};
    expect(await copyPlainText("text", null)).to.equal(false);
  });
});
