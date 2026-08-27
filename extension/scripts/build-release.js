import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outFlag = process.argv.indexOf("--out-dir");
const outDir = resolve(outFlag >= 0 && process.argv[outFlag + 1]
  ? process.argv[outFlag + 1]
  : join(extensionDir, "..", "release"));

const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("manifest version is invalid");

const sourceFiles = [
  join(extensionDir, "manifest.json"),
  join(extensionDir, "src", "background.js"),
  join(extensionDir, "src", "content.js"),
  join(extensionDir, "src", "license.js"),
];
const sourceText = sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n");
const required = [
  "https://license.nimira-timer.com",
  "https://buy.stripe.com/14A8wP4Kpfr57ZIgDY8k800",
  "https://billing.stripe.com/p/login/14A8wP4Kpfr57ZIgDY8k800",
];
for (const value of required) {
  if (!sourceText.includes(value)) throw new Error("release configuration is incomplete");
}
for (const value of [
  "http://localhost",
  "YOUR-LICENSE-SERVER",
  "buy.stripe.com/test_",
  "billing.stripe.com/p/login/test_",
  "REPLACE_WITH",
  "qsLicenseDebug",
  "qs-license-set-debug",
  "qs:license-set-debug",
]) {
  if (sourceText.includes(value)) throw new Error("release configuration contains a forbidden value");
}

function replaceExact(path, before, after) {
  const text = readFileSync(path, "utf8");
  const parts = text.split(before);
  if (parts.length !== 2) throw new Error(`browser-family seam not unique: ${path}`);
  writeFileSync(path, parts.join(after));
}

function buildFamily(family) {
  const stage = mkdtempSync(join(tmpdir(), `class-navi-${family}-`));
  const zipPath = join(outDir, `class-navi-pro-tools-${family}-${version}.zip`);
  try {
    cpSync(join(extensionDir, "manifest.json"), join(stage, "manifest.json"));
    cpSync(join(extensionDir, "options.html"), join(stage, "options.html"));
    cpSync(join(extensionDir, "options.js"), join(stage, "options.js"));
    cpSync(join(extensionDir, "src"), join(stage, "src"), { recursive: true });
    cpSync(join(extensionDir, "icons"), join(stage, "icons"), { recursive: true });

    replaceExact(
      join(stage, "src", "background.js"),
      'const BROWSER_FAMILY = "edge";',
      `const BROWSER_FAMILY = "${family}";`
    );
    replaceExact(
      join(stage, "src", "content.js"),
      'const BROWSER_FAMILY = "edge";',
      `const BROWSER_FAMILY = "${family}";`
    );
    replaceExact(
      join(stage, "src", "license.js"),
      "const BROWSER_FAMILY = BROWSER_FAMILIES.EDGE;",
      `const BROWSER_FAMILY = BROWSER_FAMILIES.${family === "chrome" ? "CHROME" : "EDGE"};`
    );

    if (existsSync(zipPath)) rmSync(zipPath);
    const zipped = Bun.spawnSync(["zip", "-X", "-q", "-r", zipPath, "."], {
      cwd: stage,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (zipped.exitCode !== 0) {
      throw new Error(`zip failed for ${family}`);
    }
    return zipPath;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

mkdirSync(outDir, { recursive: true });
const outputs = [buildFamily("chrome"), buildFamily("edge")];
for (const path of outputs) console.log(path);
