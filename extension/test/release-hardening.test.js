// release-hardening.test.js — contract: the release sources (what the build
// ZIPs actually contain) ship no licensing gates, license URLs, QMP strings,
// activation UI, debug bypass, or browser-family seam, and the manifest is
// class-navi-only with no background worker.
import { test, expect } from "bun:test";

const root = new URL("../", import.meta.url);

async function text(path) {
  return Bun.file(new URL(path, root)).text();
}

const FORBIDDEN = [
  "license.nimira-timer.com",
  "buy.stripe.com",
  "billing.stripe.com",
  "stripe",
  "Stripe",
  "QMP-",
  "qsLicenseDebug",
  "qs-license",
  "qs:license",
  "BROWSER_FAMILY",
  "browser_family",
  "showGate",
  "hideGate",
  "getStatus",
  "__qsLicensed",
  "__qsLicenseActivated",
  "renderBilling",
  "billingLinks",
  "CHECKOUT_URL",
  "PORTAL_URL",
  "RECOVERY_URL",
];

test("release sources contain zero licensing artifacts and the manifest is class-navi-only", async () => {
  const [manifestText, main, content, optionsHtml, optionsJs] = await Promise.all([
    text("manifest.json"),
    text("src/content-main.js"),
    text("src/content.js"),
    text("options.html"),
    text("options.js"),
  ]);
  const manifest = JSON.parse(manifestText);
  expect(manifest.host_permissions).toEqual(["https://class-navi.digital.kumon.com/*"]);
  expect(manifest.background).toBeUndefined();

  const releaseText = [manifestText, main, content, optionsHtml, optionsJs].join("\n");
  for (const forbidden of FORBIDDEN) {
    expect(releaseText).not.toContain(forbidden);
  }
});