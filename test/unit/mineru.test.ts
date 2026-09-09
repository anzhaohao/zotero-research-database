import { expect } from "chai";
import {
  buildSelfHostedMultipartBody,
  buildMinerUDockerComposeArguments,
  markdownFromZip,
  MinerUConversionService,
  mineruDesktopHistoryPathFromConfig,
  mineruResultFromZip,
  parseMinerUProfile,
  readMinerUProfile,
  saveMinerUProfile,
} from "../../src/services/mineru";

const encoder = new TextEncoder();

function indexOfBytes(
  value: Uint8Array,
  target: Uint8Array,
  start = 0,
): number {
  outer: for (
    let offset = start;
    offset <= value.length - target.length;
    offset++
  ) {
    for (let index = 0; index < target.length; index++) {
      if (value[offset + index] !== target[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function decodeMultipart(
  body: Uint8Array,
  contentType: string,
): {
  boundary: string;
  fields: Record<string, string>;
  file: { name: string; contentType: string; bytes: Uint8Array };
  partCount: number;
} {
  const boundary = contentType.match(
    /^multipart\/form-data; boundary=([A-Za-z0-9_-]{1,70})$/,
  )?.[1];
  if (!boundary)
    throw new Error(`Invalid multipart content type: ${contentType}`);
  const marker = encoder.encode(`--${boundary}`);
  const separator = encoder.encode("\r\n\r\n");
  const nextMarker = encoder.encode(`\r\n--${boundary}`);
  let cursor = marker.length;
  if (body[cursor] !== 13 || body[cursor + 1] !== 10)
    throw new Error("Missing first delimiter CRLF");
  cursor += 2;
  const fields: Record<string, string> = {};
  let file:
    | { name: string; contentType: string; bytes: Uint8Array }
    | undefined;
  let partCount = 0;

  while (cursor < body.length) {
    const headerEnd = indexOfBytes(body, separator, cursor);
    if (headerEnd < 0) throw new Error("Missing multipart header terminator");
    const headers = new TextDecoder().decode(body.slice(cursor, headerEnd));
    const payloadStart = headerEnd + separator.length;
    const delimiter = indexOfBytes(body, nextMarker, payloadStart);
    if (delimiter < 0) throw new Error("Missing multipart part delimiter");
    const payload = body.slice(payloadStart, delimiter);
    const disposition = headers.match(
      /^Content-Disposition: form-data; name="([^"]+)"(?:; filename="((?:\\.|[^"])*)")?$/m,
    );
    if (!disposition) throw new Error(`Invalid part disposition: ${headers}`);
    const name = disposition[1];
    if (name === "files") {
      const partContentType = headers.match(/^Content-Type: ([^\r\n]+)$/m)?.[1];
      if (!disposition[2] || !partContentType)
        throw new Error("Missing file metadata");
      file = {
        name: disposition[2].replace(/\\([\\"])/g, "$1"),
        contentType: partContentType,
        bytes: payload,
      };
    } else {
      fields[name] = new TextDecoder().decode(payload);
    }
    partCount += 1;
    cursor = delimiter + nextMarker.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) {
      cursor += 2;
      if (body[cursor] !== 13 || body[cursor + 1] !== 10)
        throw new Error("Missing closing delimiter CRLF");
      cursor += 2;
      if (cursor !== body.length)
        throw new Error("Bytes follow closing delimiter");
      break;
    }
    if (body[cursor] !== 13 || body[cursor + 1] !== 10)
      throw new Error("Missing delimiter CRLF");
    cursor += 2;
  }
  if (!file) throw new Error("Missing file part");
  return { boundary, fields, file, partCount };
}

function selfHostedProfile() {
  return parseMinerUProfile({
    mode: "self-hosted",
    executable: "mineru",
    args: "[]",
    officialEndpoint: "",
    officialTokenEnvironment: "MINERU_API_TOKEN",
    selfHostedEndpoint: "http://127.0.0.1:8000",
    selfHostedAutoStart: false,
    backend: "pipeline",
    method: "ocr",
    modelVersion: "vlm",
    language: "ch",
    enableFormula: true,
    enableTable: false,
    timeoutMs: 120000,
  });
}

async function convertWithSelfHosted(
  service: MinerUConversionService,
  pdfPath: string,
): Promise<{ markdown: string; figures: unknown[] }> {
  return (
    service as unknown as {
      convertWithSelfHosted(
        path: string,
      ): Promise<{ markdown: string; figures: unknown[] }>;
    }
  ).convertWithSelfHosted(pdfPath);
}

function replaceGlobal(name: string, value: unknown): () => void {
  const target = globalThis as unknown as Record<string, unknown>;
  const hadOwnValue = Object.prototype.hasOwnProperty.call(target, name);
  const previous = target[name];
  target[name] = value;
  return () => {
    if (hadOwnValue) target[name] = previous;
    else delete target[name];
  };
}

describe("MinerU integration", function () {
  it("constructs each conversion service from the latest saved profile", function () {
    const values = new Map<string, unknown>();
    const restore = replaceGlobal("Zotero", {
      Prefs: {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown) => values.set(key, value),
      },
    });
    try {
      const initial = parseMinerUProfile({
        mode: "local-client",
        executable: "E:\\software\\MinerU\\MinerU.exe",
        args: "[]",
        desktopOutputDirectory: "C:\\MinerU\\history",
        officialEndpoint: "",
        officialTokenEnvironment: "MINERU_API_TOKEN",
        selfHostedEndpoint: "http://127.0.0.1:8000",
        selfHostedAutoStart: false,
        selfHostedProjectDirectory: "E:\\MinerU",
        dockerExecutable: "docker.exe",
        dockerDesktopExecutable: "Docker Desktop.exe",
        backend: "pipeline",
        method: "auto",
        modelVersion: "vlm",
        language: "ch",
        enableFormula: false,
        enableTable: false,
        timeoutMs: 60_000,
      });
      saveMinerUProfile(initial);
      const firstService = new MinerUConversionService(readMinerUProfile());

      const updated = parseMinerUProfile({
        ...initial,
        mode: "self-hosted",
        executable: "mineru",
        selfHostedEndpoint: "http://127.0.0.1:9000",
        selfHostedAutoStart: true,
        backend: "vlm",
        method: "ocr",
        enableFormula: true,
        enableTable: true,
      });
      saveMinerUProfile(updated);
      const secondService = new MinerUConversionService(readMinerUProfile());

      expect(firstService).not.to.equal(secondService);
      expect((firstService as any).profile.mode).to.equal("local-client");
      expect((secondService as any).profile.mode).to.equal("self-hosted");
      expect((secondService as any).profile.selfHostedEndpoint).to.equal(
        "http://127.0.0.1:9000",
      );
      expect((secondService as any).profile.method).to.equal("ocr");
      expect((secondService as any).profile.enableFormula).to.equal(true);
    } finally {
      restore();
    }
  });

  it("parses the three supported modes without accepting shell arguments", function () {
    const profile = parseMinerUProfile({
      mode: "self-hosted",
      executable: "mineru",
      args: '["--image-analysis","false"]',
      officialEndpoint: "https://mineru.net/api/v4/",
      officialTokenEnvironment: "MINERU_API_TOKEN",
      selfHostedEndpoint: "http://127.0.0.1:8000/",
      backend: "pipeline",
      method: "ocr",
      modelVersion: "vlm",
      language: "ch",
      enableFormula: true,
      enableTable: true,
      timeoutMs: 120000,
    });

    expect(profile.mode).to.equal("self-hosted");
    expect(profile.args).to.deep.equal(["--image-analysis", "false"]);
    expect(profile.selfHostedEndpoint).to.equal("http://127.0.0.1:8000");
    expect(profile.officialEndpoint).to.equal("https://mineru.net/api/v4");
    expect(() =>
      parseMinerUProfile({
        ...profile,
        args: "--backend pipeline",
      }),
    ).to.throw("JSON 字符串数组");
  });

  it("selects full.md from a MinerU result archive", async function () {
    const encoded =
      "UEsDBAoAAAAAAEtTBF0cmVpYDQAAAA0AAAAJAAAAUkVBRE1FLm1kbm90IHRoZSBwYXBlclBLAwQKAAAAAABLUwRdAAAAAAAAAAAAAAAABgAAAHBhcGVyL1BLAwQKAAAAAABLUwRdAAAAAAAAAAAAAAAACwAAAHBhcGVyL2F1dG8vUEsDBAoAAAAAAEtTBF0l9xzHDgAAAA4AAAATAAAAcGFwZXIvYXV0by9wYXBlci5tZGZhbGxiYWNrIHBhcGVyUEsDBAoAAAAAAEtTBF3gVWpDHwAAAB8AAAANAAAAcGFwZXIvZnVsbC5tZCMgRnVsbCBwYXBlclxuQ29udmVydGVkIGNvbnRlbnRQSwECFAAKAAAAAABLUwRdHJlaWA0AAAANAAAACQAAAAAAAAAAAAAAAAAAAAAAUkVBRE1FLm1kUEsBAhQACgAAAAAAS1MEXQAAAAAAAAAAAAAAAAYAAAAAAAAAAAAQAAAANAAAAHBhcGVyL1BLAQIUAAoAAAAAAEtTBF0AAAAAAAAAAAAAAAALAAAAAAAAAAAAEAAAAFgAAABwYXBlci9hdXRvL1BLAQIUAAoAAAAAAEtTBF0l9xzHDgAAAA4AAAATAAAAAAAAAAAAAAAAAIEAAABwYXBlci9hdXRvL3BhcGVyLm1kUEsBAhQACgAAAAAAS1MEXeBVakMfAAAAHwAAAA0AAAAAAAAAAAAAAAAAwAAAAHBhcGVyL2Z1bGwubWRQSwUGAAAAAAUABQAgAQAACgEAAAAA";
    const bytes = Uint8Array.from(atob(encoded), (character) =>
      character.charCodeAt(0),
    );

    expect(await markdownFromZip(bytes, "paper")).to.equal(
      "# Full paper\\nConverted content",
    );
  });

  it("encodes the complete self-hosted request as explicit multipart bytes", function () {
    const fileBytes = Uint8Array.from([0, 13, 10, 45, 45, 98, 128, 255, 1]);
    const boundary = "zrdb-test-boundary-0123456789";
    const request = buildSelfHostedMultipartBody({
      bytes: fileBytes,
      fileName: 'paper "draft".pdf',
      boundary,
      backend: "pipeline",
      parseMethod: "ocr",
      language: "ch",
      enableFormula: true,
      enableTable: false,
    });
    const decoded = decodeMultipart(request.body, request.contentType);

    expect(request.contentType).to.equal(
      `multipart/form-data; boundary=${boundary}`,
    );
    expect(
      new TextDecoder().decode(request.body.slice(0, boundary.length + 4)),
    ).to.equal(`--${boundary}\r\n`);
    expect(
      new TextDecoder().decode(request.body.slice(-(boundary.length + 8))),
    ).to.equal(`\r\n--${boundary}--\r\n`);
    expect(decoded.boundary).to.equal(boundary);
    expect(decoded.partCount).to.equal(10);
    expect(decoded.file.name).to.equal('paper "draft".pdf');
    expect(decoded.file.contentType).to.equal("application/pdf");
    expect([...decoded.file.bytes]).to.deep.equal([...fileBytes]);
    expect(decoded.fields).to.deep.equal({
      backend: "pipeline",
      parse_method: "ocr",
      lang_list: "ch",
      formula_enable: "true",
      table_enable: "false",
      return_md: "true",
      return_content_list: "true",
      return_images: "true",
      response_format_zip: "true",
    });
  });

  it("uses explicit bytes without constructing FormData or Blob", async function () {
    const fileBytes = Uint8Array.from([0, 255, 37, 80, 68, 70, 13, 10]);
    const response = new Response(
      JSON.stringify({ results: { paper: { md_content: "# Inline" } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    let request: RequestInit | undefined;
    const restore = [
      replaceGlobal("IOUtils", { read: async () => fileBytes }),
      replaceGlobal("PathUtils", {
        filename: (path: string) => path.split(/[\\/]/).at(-1) || path,
      }),
      replaceGlobal("fetch", async (_url: unknown, init: RequestInit) => {
        request = init;
        return response;
      }),
      replaceGlobal(
        "FormData",
        class ForbiddenFormData {
          constructor() {
            throw new Error("FormData construction is forbidden");
          }
        },
      ),
      replaceGlobal(
        "Blob",
        class ForbiddenBlob {
          constructor() {
            throw new Error("Blob construction is forbidden");
          }
        },
      ),
    ];
    try {
      const result = await convertWithSelfHosted(
        new MinerUConversionService(selfHostedProfile()),
        "C:\\papers\\binary.pdf",
      );
      expect(result.markdown).to.equal("# Inline");
      const contentType =
        new Headers(request?.headers).get("content-type") || "";
      const decoded = decodeMultipart(request?.body as Uint8Array, contentType);
      expect(decoded.file.name).to.equal("binary.pdf");
      expect([...decoded.file.bytes]).to.deep.equal([...fileBytes]);
    } finally {
      restore.reverse().forEach((restoreGlobal) => restoreGlobal());
    }
  });

  it("builds independent multipart bodies for the 404 and 405 fallbacks", async function () {
    for (const fallbackStatus of [404, 405]) {
      const fileBytes = Uint8Array.from([0, 1, 2, 13, 10, 128, 255]);
      const requests: Array<{ url: string; init: RequestInit }> = [];
      const restore = [
        replaceGlobal("IOUtils", { read: async () => fileBytes }),
        replaceGlobal("PathUtils", {
          filename: (path: string) => path.split(/[\\/]/).at(-1) || path,
        }),
        replaceGlobal("fetch", async (url: unknown, init: RequestInit) => {
          requests.push({ url: String(url), init });
          if (requests.length === 1)
            return new Response("unsupported", { status: fallbackStatus });
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      ];
      try {
        let failure: unknown;
        try {
          await convertWithSelfHosted(
            new MinerUConversionService(selfHostedProfile()),
            "C:\\papers\\fallback.pdf",
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).to.be.instanceOf(Error);
        expect((failure as Error).message).to.include("没有返回 task_id");
        expect(requests.map(({ url }) => url)).to.deep.equal([
          "http://127.0.0.1:8000/file_parse",
          "http://127.0.0.1:8000/tasks",
        ]);
        const decoded = requests.map(({ init }) =>
          decodeMultipart(
            init.body as Uint8Array,
            new Headers(init.headers).get("content-type") || "",
          ),
        );
        expect(requests[0].init.body).to.not.equal(requests[1].init.body);
        expect(decoded[0].boundary).to.not.equal(decoded[1].boundary);
        expect(decoded[0].fields).to.deep.equal(decoded[1].fields);
        expect(decoded[0].file.name).to.equal("fallback.pdf");
        expect(decoded[1].file.name).to.equal("fallback.pdf");
        expect([...decoded[0].file.bytes]).to.deep.equal([...fileBytes]);
        expect([...decoded[1].file.bytes]).to.deep.equal([...fileBytes]);
      } finally {
        restore.reverse().forEach((restoreGlobal) => restoreGlobal());
      }
    }
  });

  it("does not fall back for non-404/405 direct endpoint failures", async function () {
    const fileBytes = Uint8Array.from([37, 80, 68, 70]);
    const restoreIO = replaceGlobal("IOUtils", {
      read: async () => fileBytes,
    });
    const restorePath = replaceGlobal("PathUtils", {
      filename: (path: string) => path.split(/[\\/]/).at(-1) || path,
    });
    try {
      for (const status of [400, 401, 403, 409, 422, 429, 500, 503]) {
        const requests: string[] = [];
        const restoreFetch = replaceGlobal(
          "fetch",
          async (url: unknown, _init: RequestInit) => {
            requests.push(String(url));
            return new Response(`explicit failure ${status}`, { status });
          },
        );
        try {
          let failure: unknown;
          try {
            await convertWithSelfHosted(
              new MinerUConversionService(selfHostedProfile()),
              "C:\\papers\\failure.pdf",
            );
          } catch (error) {
            failure = error;
          }
          expect(failure).to.be.instanceOf(Error);
          expect((failure as Error).message).to.include(
            `HTTP ${status} explicit failure ${status}`,
          );
          expect(requests).to.deep.equal(["http://127.0.0.1:8000/file_parse"]);
        } finally {
          restoreFetch();
        }
      }
    } finally {
      restorePath();
      restoreIO();
    }
  });

  it("turns MinerU content_list images into stable figure artifacts", async function () {
    const encoded =
      "UEsDBAoAAAAAALFeBF0AAAAAAAAAAAAAAAAGAAAAcGFwZXIvUEsDBAoAAAAAALFeBF1GQWwtBwAAAAcAAAANAAAAcGFwZXIvZnVsbC5tZCMgUGFwZXJQSwMECgAAAAAAsV4EXcFFUnqEAAAAhAAAABcAAABwYXBlci9jb250ZW50X2xpc3QuanNvblt7InR5cGUiOiJjaGFydCIsImltZ19wYXRoIjoiaW1hZ2VzL2NoYXJ0LTEucG5nIiwiY2hhcnRfY2FwdGlvbiI6WyJGaWd1cmUgMSIsIkFyY2hpdGVjdHVyZSJdLCJwYWdlX2lkeCI6MiwiYmJveCI6WzEwMCwyMDAsNzAwLDgwMF19XVBLAwQKAAAAAACxXgRdAAAAAAAAAAAAAAAADQAAAHBhcGVyL2ltYWdlcy9QSwMECgAAAAAAsV4EXc37PLYEAAAABAAAABgAAABwYXBlci9pbWFnZXMvY2hhcnQtMS5wbmcBAgMEUEsBAhQACgAAAAAAsV4EXQAAAAAAAAAAAAAAAAYAAAAAAAAAAAAQAAAAAAAAAHBhcGVyL1BLAQIUAAoAAAAAALFeBF1GQWwtBwAAAAcAAAANAAAAAAAAAAAAAAAAACQAAABwYXBlci9mdWxsLm1kUEsBAhQACgAAAAAAsV4EXcFFUnqEAAAAhAAAABcAAAAAAAAAAAAAAAAAVgAAAHBhcGVyL2NvbnRlbnRfbGlzdC5qc29uUEsBAhQACgAAAAAAsV4EXQAAAAAAAAAAAAAAAA0AAAAAAAAAAAAQAAAADwEAAHBhcGVyL2ltYWdlcy9QSwECFAAKAAAAAACxXgRdzfs8tgQAAAAEAAAAGAAAAAAAAAAAAAAAAAA6AQAAcGFwZXIvaW1hZ2VzL2NoYXJ0LTEucG5nUEsFBgAAAAAFAAUANQEAAHQBAAAAAA==";
    const bytes = Uint8Array.from(atob(encoded), (character) =>
      character.charCodeAt(0),
    );

    let result;
    try {
      result = await mineruResultFromZip(bytes, "paper");
    } catch (error) {
      throw new Error(
        `MinerU figure archive diagnostic: ${
          error instanceof Error
            ? `${error.name}: ${error.message}\n${error.stack || ""}`
            : String(error)
        }`,
      );
    }

    const diagnostic = JSON.stringify({
      markdown: result.markdown,
      figures: result.figures.map(({ bytes, ...figure }) => ({
        ...figure,
        byteLength: bytes.length,
      })),
    });
    if (result.markdown !== "# Paper")
      throw new Error(`Unexpected Markdown: ${diagnostic}`);
    if (result.figures.length !== 1)
      throw new Error(`Unexpected figure count: ${diagnostic}`);
    const figure = result.figures[0];
    if (figure.id !== "mineru:figure:images%2Fchart-1.png")
      throw new Error(`Unexpected figure ID: ${diagnostic}`);
    if (figure.kind !== "figure")
      throw new Error(`Unexpected figure kind: ${diagnostic}`);
    if (figure.caption !== "Figure 1 Architecture")
      throw new Error(`Unexpected caption: ${diagnostic}`);
    if (figure.pageIndex !== 2)
      throw new Error(`Unexpected page index: ${diagnostic}`);
    if (
      !figure.rect ||
      figure.rect.x !== 0.1 ||
      figure.rect.y !== 0.2 ||
      Math.abs(figure.rect.width - 0.6) > Number.EPSILON ||
      Math.abs(figure.rect.height - 0.6) > Number.EPSILON
    )
      throw new Error(`Unexpected rect: ${diagnostic}`);
    if ([...figure.bytes].join(",") !== "1,2,3,4")
      throw new Error(`Unexpected image bytes: ${diagnostic}`);
  });

  it("keeps the official API blank until that mode is selected", function () {
    const base = {
      executable: "E:\\software\\MinerU\\MinerU.exe",
      args: "[]",
      officialEndpoint: "",
      officialTokenEnvironment: "MINERU_API_TOKEN",
      selfHostedEndpoint: "http://127.0.0.1:8000",
      backend: "pipeline",
      method: "auto",
      modelVersion: "vlm",
      language: "ch",
      enableFormula: true,
      enableTable: true,
      timeoutMs: 120000,
    };
    expect(
      parseMinerUProfile({ ...base, mode: "local-client" }).officialEndpoint,
    ).to.equal("");
    expect(() =>
      parseMinerUProfile({ ...base, mode: "official-api" }),
    ).to.throw("必须使用 HTTPS");
  });

  it("reads the Desktop history directory from the nested client config", function () {
    expect(
      mineruDesktopHistoryPathFromConfig(
        JSON.stringify({
          config: JSON.stringify({
            state: { history_path: "C:\\Users\\tester\\MinerU" },
          }),
        }),
      ),
    ).to.equal("C:\\Users\\tester\\MinerU");
  });

  it("builds a fixed compose invocation without a shell command", function () {
    expect(
      buildMinerUDockerComposeArguments(
        "E:\\software\\DockerProject\\MinerU\\compose.yaml",
      ),
    ).to.deep.equal([
      "compose",
      "-f",
      "E:\\software\\DockerProject\\MinerU\\compose.yaml",
      "--profile",
      "api",
      "up",
      "-d",
      "--no-build",
      "mineru-api",
    ]);
  });

  it("aborts a hanging self-hosted request when the conversion is cancelled", async function () {
    const restoreIO = replaceGlobal("IOUtils", {
      read: async () => Uint8Array.from([37, 80, 68, 70]),
    });
    const restorePath = replaceGlobal("PathUtils", {
      filename: (path: string) => path.split(/[\\/]/).at(-1) || path,
    });
    let aborted = false;
    const restoreFetch = replaceGlobal(
      "fetch",
      async (_url: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    try {
      const service = new MinerUConversionService(selfHostedProfile());
      const pending = convertWithSelfHosted(service, "C:\\papers\\hang.pdf");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.cancel();
      let failure: unknown;
      try {
        await pending;
      } catch (error) {
        failure = error;
      }
      expect(failure).to.be.instanceOf(Error);
      expect((failure as Error).message).to.equal("MinerU 请求已取消");
      expect(aborted).to.equal(true);
    } finally {
      restoreFetch();
      restorePath();
      restoreIO();
    }
  });
});
