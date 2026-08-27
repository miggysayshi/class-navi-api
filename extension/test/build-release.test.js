import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extensionDir = new URL("../", import.meta.url).pathname;

function run(...args) {
  return Bun.spawnSync(args, { cwd: extensionDir, stdout: "pipe", stderr: "pipe" });
}

function zipText(zipPath, file) {
  const result = run("unzip", "-p", zipPath, file);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

test("build-release creates separate clean Chrome and Edge ZIPs without mutating source", () => {
  const outDir = mkdtempSync(join(tmpdir(), "class-navi-release-"));
  const sourceBackgroundBefore = readFileSync(join(extensionDir, "src/background.js"), "utf8");
  const sourceContentBefore = readFileSync(join(extensionDir, "src/content.js"), "utf8");
  const sourceLicenseBefore = readFileSync(join(extensionDir, "src/license.js"), "utf8");

  try {
    const build = run("bun", "scripts/build-release.js", "--out-dir", outDir);
    expect(build.exitCode).toBe(0);

    for (const family of ["chrome", "edge"]) {
      const zipPath = join(outDir, `class-navi-pro-tools-${family}-1.0.0.zip`);
      expect(Bun.file(zipPath).size).toBeGreaterThan(0);
      const listing = run("unzip", "-Z1", zipPath);
      expect(listing.exitCode).toBe(0);
      const files = listing.stdout.toString().split("\n").filter(Boolean);
      expect(files).toContain("manifest.json");
      expect(files).toContain("src/background.js");
      expect(files).toContain("src/content.js");
      expect(files).toContain("src/license.js");
      expect(files.some((name) => name.startsWith("test/"))).toBe(false);
      expect(files.some((name) => name.startsWith("docs/"))).toBe(false);
      expect(files.some((name) => name.startsWith("scripts/"))).toBe(false);
      expect(files).not.toContain("README.md");

      const manifest = JSON.parse(zipText(zipPath, "manifest.json"));
      expect(manifest.host_permissions).toEqual([
        "https://class-navi.digital.kumon.com/*",
        "https://license.nimira-timer.com/*",
      ]);

      const background = zipText(zipPath, "src/background.js");
      const content = zipText(zipPath, "src/content.js");
      const license = zipText(zipPath, "src/license.js");
      expect(background).toContain(`const BROWSER_FAMILY = "${family}"`);
      expect(content).toContain(`const BROWSER_FAMILY = "${family}"`);
      const licenseFamily = family === "chrome" ? "BROWSER_FAMILIES.CHROME" : "BROWSER_FAMILIES.EDGE";
      expect(license).toContain(`const BROWSER_FAMILY = ${licenseFamily}`);

      const releaseText = [JSON.stringify(manifest), background, content, license].join("\n");
      for (const forbidden of [
        "http://localhost",
        "YOUR-LICENSE-SERVER",
        "buy.stripe.com/test_",
        "billing.stripe.com/p/login/test_",
        "REPLACE_WITH",
        "qsLicenseDebug",
        "qs-license-set-debug",
        "qs:license-set-debug",
      ]) {
        expect(releaseText).not.toContain(forbidden);
      }
    }

    expect(readFileSync(join(extensionDir, "src/background.js"), "utf8")).toBe(sourceBackgroundBefore);
    expect(readFileSync(join(extensionDir, "src/content.js"), "utf8")).toBe(sourceContentBefore);
    expect(readFileSync(join(extensionDir, "src/license.js"), "utf8")).toBe(sourceLicenseBefore);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
