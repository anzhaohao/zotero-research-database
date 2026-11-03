import { copyFile, mkdir } from "node:fs/promises";
import { stdout } from "node:process";

const source = ".scaffold/build/zotero-research-database.xpi";
const releaseDirectory = "release";
const target = releaseDirectory + "/zotero-research-database.xpi";

await mkdir(releaseDirectory, { recursive: true });
await copyFile(source, target);
stdout.write("Copied " + source + " to " + target + "\n");
