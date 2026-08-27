// no-gates.test.js — contract: the extension ships with NO runtime or
// user-facing licensing/activation gate. Every feature (patterns dropdown,
// marking, aggregates, level stats) boots unconditionally; content.js is a
// patterns relay only; options is a patterns editor only; no license source
// files exist; the build emits ZIPs with zero license artifacts.
import { test, expect } from "bun:test";

const root = new URL("../", import.meta.url);

async function text(path) {
  return Bun.file(new URL(path, root)).text();
}

test("manifest has only the class-navi host permission and no background worker", async () => {
  const manifest = JSON.parse(await text("manifest.json"));
  expect(manifest.host_permissions).toEqual(["https://class-navi.digital.kumon.com/*"]);
  expect(manifest.background).toBeUndefined();
  const main = manifest.content_scripts.find((c) => c.world === "MAIN");
  const isolated = manifest.content_scripts.find((c) => !c.world);
  expect(main.js).not.toContain("src/license.js");
  expect(main.js).not.toContain("src/background.js");
  const allJs = [...main.js, ...isolated.js];
  expect(allJs.some((f) => f.includes("license") || f.includes("background"))).toBe(false);
  expect(manifest.permissions).toEqual(["storage"]);
});

test("content-main MutationObserver calls runBoots directly — no license gate anywhere", async () => {
  const main = await text("src/content-main.js");
  expect(main).toContain("runBoots()");
  expect(main).not.toContain("QS.license");
  expect(main).not.toContain("__qsLicensed");
  expect(main).not.toContain("__qsLicenseActivated");
  expect(main).not.toContain("getStatus");
  expect(main).not.toContain("showGate");
  expect(main).not.toContain("hideGate");
  expect(main).not.toContain("isActive");
});

test("refreshLevelStats has no license guard (always renders when data exists)", async () => {
  const main = await text("src/content-main.js");
  // the old guard removed the chip and returned when unlicensed — it must be gone
  expect(main).not.toContain("__qsLicensed");
  expect(main).not.toMatch(/qs-level-stats[\s\S]{0,300}__qsLicensed/);
  expect(main).not.toMatch(/__qsLicensed[\s\S]{0,300}qs-level-stats/);
});

test("content.js is a patterns relay only — no license relay, direct fetch, or family seam", async () => {
  const content = await text("src/content.js");
  expect(content).toContain("qs:request-patterns");
  expect(content).toContain("qs:patterns");
  expect(content).toContain("loadPatterns");
  expect(content).not.toContain("license");
  expect(content).not.toContain("LICENSE");
  expect(content).not.toContain("BROWSER_FAMILY");
  expect(content).not.toContain("browser_family");
  expect(content).not.toContain("API_BASE");
  expect(content).not.toContain("directFetch");
  expect(content).not.toContain("sendToWorker");
  expect(content).not.toContain("chrome.runtime.sendMessage");
});

test("options page is a patterns editor only — no license or billing surface", async () => {
  const html = await text("options.html");
  const js = await text("options.js");
  expect(html).toContain("pattern-list");
  expect(html).not.toContain("license");
  expect(html).not.toContain("billing");
  expect(html).not.toContain("src/license.js");
  expect(js).toContain("QS.storage.loadPatterns");
  expect(js).not.toContain("renderBilling");
  expect(js).not.toContain("billingLinks");
  expect(js).not.toContain("QS.license");
});

test("license and background source files no longer exist", async () => {
  const hasLicense = await Bun.file(new URL("src/license.js", root)).exists();
  const hasBackground = await Bun.file(new URL("src/background.js", root)).exists();
  expect(hasLicense).toBe(false);
  expect(hasBackground).toBe(false);
});