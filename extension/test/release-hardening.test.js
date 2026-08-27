import { test, expect } from "bun:test";

const root = new URL("../", import.meta.url);

async function text(path) {
  return Bun.file(new URL(path, root)).text();
}

test("release sources use the production license origin and contain no debug bypass", async () => {
  const [background, content, license, manifestText] = await Promise.all([
    text("src/background.js"),
    text("src/content.js"),
    text("src/license.js"),
    text("manifest.json"),
  ]);
  const manifest = JSON.parse(manifestText);
  const productionOrigin = "https://license.nimira-timer.com";

  expect(background).toContain(`const API_BASE = "${productionOrigin}"`);
  expect(content).toContain(`const API_BASE = "${productionOrigin}"`);
  expect(license).toContain(`const RECOVERY_URL = "${productionOrigin}/portal"`);
  expect(license).toContain(
    'const CHECKOUT_URL = "https://buy.stripe.com/14A8wP4Kpfr57ZIgDY8k800"'
  );
  expect(license).toContain(
    'const PORTAL_URL = "https://billing.stripe.com/p/login/14A8wP4Kpfr57ZIgDY8k800"'
  );
  expect(manifest.host_permissions).toEqual([
    "https://class-navi.digital.kumon.com/*",
    `${productionOrigin}/*`,
  ]);

  const releaseText = [background, content, license, manifestText].join("\n");
  for (const forbidden of [
    "http://localhost:8787",
    "YOUR-LICENSE-SERVER",
    "buy.stripe.com/test_",
    "billing.stripe.com/p/login/test_",
    "REPLACE_WITH_PORTAL_ID",
    "qsLicenseDebug",
    "qs-license-set-debug",
    "qs:license-set-debug",
    "function setDebug",
    "debug-on",
    "debug-off",
  ]) {
    expect(releaseText).not.toContain(forbidden);
  }
});
