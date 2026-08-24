import { defineConfig } from "zotero-plugin-scaffold";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pkg from "./package.json";

const pdfTranslateTestXpi = process.env.ZOTERO_PDF_TRANSLATE_XPI_PATH?.trim();
const pdfTranslateTestTarget = resolve(
  ".scaffold/test/profile/extensions/zoteropdftranslate@euclpts.com.xpi",
);

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: JSON.stringify(process.env.NODE_ENV || "production"),
          "process.env.NODE_ENV": JSON.stringify(
            process.env.NODE_ENV || "production",
          ),
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
    startupDelay: 2_000,
    prefs: {
      "extensions.zotero-research-database.test.pdfTranslateXpiInstalled":
        Boolean(pdfTranslateTestXpi),
    },
    hooks: {
      "test:init": async () => {
        if (!pdfTranslateTestXpi) return;
        await mkdir(dirname(pdfTranslateTestTarget), { recursive: true });
        await copyFile(pdfTranslateTestXpi, pdfTranslateTestTarget);
      },
    },
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
