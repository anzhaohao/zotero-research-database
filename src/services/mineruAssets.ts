/** Portable names and references for newly imported MinerU generations. */
export interface MinerUStoredFile {
  path: string;
  bytes: Uint8Array;
  originalPaths: string[];
}

export function assetRelativePath(value: string): string {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return "";
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export async function mineruAssetHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

const imageExtension = /\.(png|jpe?g|webp|gif|tiff?|bmp|svg|avif)$/i;

export async function prepareMinerUAssets(
  entries: Array<{ name: string; bytes: Uint8Array }>,
  markdown: string,
  markdownSourcePath: string,
): Promise<{ files: MinerUStoredFile[]; markdown: string }> {
  const names = new Map<string, string>();
  const files = new Map<string, MinerUStoredFile>();
  for (const entry of entries) {
    const original = assetRelativePath(entry.name);
    if (!original || /^(?:[a-z]:|\/|\\)/i.test(entry.name))
      throw new Error("MinerU 产物包含不安全的路径：" + entry.name);
    if (names.has(original))
      throw new Error("MinerU 产物路径重复：" + original);
    const image = original.match(imageExtension);
    const hash =
      image || original.split("/").some((p) => p.length > 120)
        ? await mineruAssetHash(entry.bytes)
        : "";
    const extension = image?.[1].toLowerCase().replace(/^jpeg$/, "jpg");
    const stored = image
      ? `images/${hash}.${extension}`
      : hash
        ? `raw/files/${hash}${original.endsWith(".json") ? "_content_list.json" : original.endsWith(".md") ? ".md" : ".bin"}`
        : "raw/" + original;
    validateMinerUStoragePath(stored);
    names.set(original, stored);
    const previous = files.get(stored);
    if (previous) previous.originalPaths.push(original);
    else
      files.set(stored, {
        path: stored,
        bytes: entry.bytes,
        originalPaths: [original],
      });
  }
  const resolve = (value: string, source: string): string | undefined => {
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      /* Literal % is valid in upstream names. */
    }
    const directory = source.includes("/")
      ? source.slice(0, source.lastIndexOf("/") + 1)
      : "";
    return (
      names.get(assetRelativePath(directory + decoded)) ||
      names.get(assetRelativePath(decoded))
    );
  };
  const rewriteMarkdown = (text: string, source: string): string => {
    const rewrite = (target: string) => {
      if (/^(?:[a-z][a-z\d+.-]*:|\/|#|\\)/i.test(target)) return target;
      const stored = resolve(target, source);
      if (!stored)
        throw new Error(`MinerU 图片引用缺失：${target}（来源：${source}）`);
      return stored;
    };
    let output = text.replace(
      /(!\[[^\]]*\]\()(?:<([^>]+)>|([^\s)]+))(\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\)/g,
      (_whole, start: string, bracketed: string, plain: string, title = "") =>
        start + "<" + rewrite(bracketed ?? plain) + ">" + title + ")",
    );
    output = output.replace(
      /(<img\b[^>]*\bsrc\s*=\s*)(["'])(.*?)\2/gi,
      (_whole, start: string, quote: string, target: string) =>
        start + quote + rewrite(target) + quote,
    );
    // Reference definitions are rewritten only when used by a Markdown image.
    const references = new Set(
      Array.from(text.matchAll(/!\[([^\]]*)\]\[([^\]]*)\]/g), (m) =>
        (m[2] || m[1]).toLowerCase(),
      ),
    );
    output = output.replace(
      /^(\s*\[([^\]]+)\]:\s*)(?:<([^>]+)>|(\S+))/gm,
      (
        whole,
        start: string,
        label: string,
        bracketed: string,
        plain: string,
      ) =>
        references.has(label.toLowerCase())
          ? start + "<" + rewrite(bracketed ?? plain) + ">"
          : whole,
    );
    return output;
  };
  const rewriteJSON = (value: unknown, source: string): unknown => {
    if (typeof value === "string") return resolve(value, source) || value;
    if (Array.isArray(value))
      return value.map((entry) => rewriteJSON(entry, source));
    if (value && typeof value === "object") {
      const rewritten = Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          rewriteJSON(entry, source),
        ]),
      );
      const row = value as Record<string, unknown>;
      if (typeof row.img_path === "string" && resolve(row.img_path, source))
        rewritten.zrdb_original_img_path =
          row.zrdb_original_img_path || row.img_path;
      return rewritten;
    }
    return value;
  };
  for (const file of files.values()) {
    const original = file.originalPaths[0];
    if (/\.json$/i.test(original)) {
      try {
        file.bytes = new TextEncoder().encode(
          JSON.stringify(
            rewriteJSON(
              JSON.parse(new TextDecoder().decode(file.bytes)),
              original,
            ),
          ),
        );
      } catch {
        /* Preserve non-JSON auxiliary files unchanged. */
      }
    }
  }
  return {
    files: [...files.values()],
    markdown: rewriteMarkdown(markdown, markdownSourcePath),
  };
}

export function validateMinerUStoragePath(path: string): void {
  for (const component of path.split(/[\\/]/)) {
    if (!component || component === "." || component === "..") continue;
    if (
      component.length > 255 ||
      /[<>:"|?*]/.test(component) ||
      [...component].some((character) => character.charCodeAt(0) <= 31) ||
      /[. ]$/.test(component) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)
    )
      throw new Error("MinerU 目录或文件名无效：" + path);
  }
}
