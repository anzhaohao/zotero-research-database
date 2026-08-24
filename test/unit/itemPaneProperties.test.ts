import { expect } from "chai";
import { createDefaultFields } from "../../src/domain/defaults";
import { ItemPaneProperties } from "../../src/ui/itemPaneProperties";

describe("native Zotero research property rows", function () {
  it("registers, renames and archives fields by stable field ID", function () {
    const previous = (globalThis as any).Zotero;
    const registered: any[] = [];
    const unregistered: string[] = [];
    (globalThis as any).Zotero = {
      ItemPaneManager: {
        registerInfoRow: (options: any) => {
          registered.push(options);
          return `plugin-${options.rowID}`;
        },
        unregisterInfoRow: (rowID: string) => {
          unregistered.push(rowID);
          return true;
        },
        refreshInfoRow: () => undefined,
      },
      getMainWindows: () => [],
    };
    try {
      const controller = new ItemPaneProperties();
      const field = createDefaultFields()[0];
      controller.syncFields([field]);
      expect(registered).to.have.length(1);
      expect(registered[0].rowID).to.equal(`property-${field.id}`);
      expect(registered[0].label.text).to.equal(field.name);
      expect(registered[0].editable).to.equal(true);

      controller.syncFields([{ ...field, name: "核心科学问题" }]);
      expect(unregistered).to.deep.equal([`plugin-property-${field.id}`]);
      expect(registered).to.have.length(2);
      expect(registered[1].label.text).to.equal("核心科学问题");

      controller.syncFields([
        { ...field, name: "核心科学问题", archived: true },
      ]);
      expect(unregistered).to.deep.equal([
        `plugin-property-${field.id}`,
        `plugin-property-${field.id}`,
      ]);
    } finally {
      (globalThis as any).Zotero = previous;
    }
  });
});
