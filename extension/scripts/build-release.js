import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

function buildFamily(family) {
  const stage = mkdtempSync(join(tmpdir(), `class-navi-${family}-`));
  const zipPath = join(outDir, `class-navi-pro-tools-${family}-${version}.zip`);
  try {
    cpSync(join(extensionDir, "manifest.json"), join(stage, "manifest.json"));
    cpSync(join(extensionDir, "options.html"), join(stage, "options.html"));
    cpSync(join(extensionDir, "options.js"), join(stage, "options.js"));
    cpSync(join(extensionDir, "src"), join(stage, "src"), { recursive: true });
    cpSync(join(extensionDir, "icons"), join(stage, "icons"), { recursive: true });

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