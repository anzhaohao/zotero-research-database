import { expect } from "chai";
import JSZip from "jszip";
import {
  tableToCSV,
  tableToHTML,
  tableToXLSX,
} from "../../src/services/tableExport";

describe("database table exports", function () {
  const columns = [
    { id: "title", label: "标题别名" },
    { id: "question", label: "研究问题" },
  ];
  const rows = [
    {
      key: "A",
      values: { title: "中文，标题", question: "第一行\n第二行" },
      color: "blue" as const,
      cellColors: { question: "yellow" as const },
    },
  ];

  it("keeps aliases, Chinese, and line breaks in CSV/HTML", function () {
    expect(tableToCSV(columns, rows)).to.include('"标题别名"');
    expect(tableToCSV(columns, rows)).to.include("第一行\n第二行");
    const html = tableToHTML(columns, rows);
    expect(html).to.include("第一行<br>第二行");
    expect(html).to.include('class="color-yellow"');
  });

  it("creates a valid XLSX package with bounded semantic styles", async function () {
    let blob: Blob;
    try {
      blob = await tableToXLSX(columns, rows);
    } catch (error) {
      throw new Error(`XLSX generation failed: ${String(error)}`);
    }
    expect(blob.size).to.be.greaterThan(0);
    // Zotero's privileged window can generate/download the Blob, but its test
    // realm cannot reliably feed that Blob back into a separately bundled
    // JSZip instance. Validate the package contents in the Node unit run.
    if ((globalThis as any).Zotero) return;
    let buffer: ArrayBuffer;
    try {
      buffer = await blob.arrayBuffer();
    } catch (error) {
      throw new Error(`XLSX Blob read failed: ${String(error)}`);
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch (error) {
      throw new Error(`XLSX ZIP parse failed: ${String(error)}`);
    }
    expect(zip.file("xl/worksheets/sheet1.xml")).not.to.equal(null);
    const styles = await zip.file("xl/styles.xml")!.async("string");
    expect(styles).to.include('fillId="2"');
    expect(styles).to.include('fillId="4"');
  });
});
