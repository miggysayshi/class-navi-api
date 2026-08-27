// build-release.test.js — contract: scripts/build-release.js emits Chrome and
// Edge ZIPs that ship only the extension, with ZERO license artifacts: no
// license/background source files, no license URLs, no QMP strings, no
// activation UI, no debug bypass, no browser-family seam; manifest has only
// the class-navi host permission and no background worker.
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

const LICENSE_TOKENS = [
  "license",
  "LICENSE",
  "License",
  "stripe",
  "Stripe",
  "QMP-",
  "qsLicenseDebug",
  "BROWSER_FAMILY",
  "browser_family",
  "qs-license",
  "qs:license",
  "buy.stripe.com",
  "billing.stripe.com",
  "license.nimira-timer.com",
  "CHECKOUT_URL",
  "PORTAL_URL",
  "RECOVERY_URL",
];

test("build-release creates separate Chrome and Edge ZIPs with no license artifacts, without mutating source", () => {
  const outDir = mkdtempSync(join(tmpdir(), "class-navi-release-"));
  const sourcesBefore = [
    "manifest.json",
    "options.html",
    "options.js",
    "src/content-main.js",
    "src/content.js",
    "scripts/build-release.js",
  ].map((f) => [f, readFileSync(join(extensionDir, f), "utf8")]);

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
      expect(files).toContain("src/content-main.js");
      expect(files).toContain("src/content.js");
      expect(files).not.toContain("src/license.js");
      expect(files).not.toContain("src/background.js");
      expect(files.some((name) => name.startsWith("test/"))).toBe(false);
      expect(files.some((name) => name.startsWith("docs/"))).toBe(false);
      expect(files.some((name) => name.startsWith("scripts/"))).toBe(false);
      expect(files).not.toContain("README.md");

      const manifest = JSON.parse(zipText(zipPath, "manifest.json"));
      expect(manifest.host_permissions).toEqual(["https://class-navi.digital.kumon.com/*"]);
      expect(manifest.background).toBeUndefined();

      // every shipped text file must be free of every licensing token
      for (const file of files) {
        if (/\.(js|json|html)$/.test(file)) {
          const content = zipText(zipPath, file);
          for (const token of LICENSE_TOKENS) {
            expect(content).not.toContain(token);
          }
        }
      }
    }

    // build never mutates the source tree
    for (const [f, before] of sourcesBefore) {
      expect(readFileSync(join(extensionDir, f), "utf8")).toBe(before);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});