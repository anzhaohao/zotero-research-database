import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { stdout } from "node:process";

const source = ".scaffold/build/zotero-research-database.xpi";
const releaseDirectory = "release";
const target = releaseDirectory + "/zotero-research-database.xpi";

await mkdir(releaseDirectory, { recursive: true });
try {
  const previous = await readFile(target);
  const current = await readFile(source);
  if (!previous.equals(current)) {
    const archive = releaseDirectory + "/archive";
    await mkdir(archive, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const digest = createHash("sha256")
      .update(previous)
      .digest("hex")
      .slice(0, 12);
    await copyFile(
      target,
      archive + "/zotero-research-database-" + stamp + "-" + digest + ".xpi",
    );
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await copyFile(source, target);
stdout.write("Copied " + source + " to " + target + "\n");
