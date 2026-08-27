// test/license.test.js — pure license-status logic (Quick Mark Pro)
import { test, expect } from "bun:test";
await import("../src/license.js");
const { deriveState, graceDays, fmtDate, GRACE_MS } = globalThis.QS.license;

const NOW = Date.UTC(2026, 6, 1, 12, 0, 0); // 2026-07-01 12:00 UTC

// ── original regression coverage ──────────────────────────────────────────

test("deriveState: no key → unlicensed", () => {
  const s = deriveState({ key: false, instance: "i1", validation: null, cache: null, error: null }, NOW);
  expect(s.state).toBe("unlicensed");
  expect(s.reason).toBe("no-key");
});

test("deriveState: valid validation → active with expiry", () => {
  const s = deriveState(
    { key: true, validation: { valid: true, expiresAt: "2026-08-01T00:00:00Z", checkedAt: NOW } },
    NOW
  );
  expect(s.state).toBe("active");
  expect(s.expiresAt).toBe("2026-08-01T00:00:00Z");
});

test("deriveState: rejected key → invalid", () => {
  const s = deriveState({ key: true, validation: { valid: false, error: "invalid license key" } }, NOW);
  expect(s.state).toBe("invalid");
  expect(s.message).toContain("invalid");
});

test("deriveState ignores obsolete debug fields in release builds", () => {
  expect(deriveState({ key: false, debug: "on" }, NOW).state).toBe("unlicensed");
  expect(deriveState({ key: true, debug: "off" }, NOW).state).toBe("unlicensed");
});

test("deriveState: recent valid cache + no validation → offline grace", () => {
  const s = deriveState(
    { key: true, validation: null, cache: { valid: true, checkedAt: NOW - 24 * 3600 * 1000 }, error: "fetch failed" },
    NOW
  );
  expect(s.state).toBe("grace");
  expect(s.remainingMs).toBeGreaterThan(0);
  expect(s.remainingMs).toBeLessThan(GRACE_MS);
});

test("deriveState: stale cache + network error → unreachable", () => {
  const s = deriveState(
    { key: true, validation: null, cache: { valid: true, checkedAt: NOW - 10 * 24 * 3600 * 1000 }, error: "fetch failed" },
    NOW
  );
  expect(s.state).toBe("unreachable");
});

test("deriveState: stale cache, no error → unlicensed (no-validation)", () => {
  const s = deriveState({ key: true, validation: null, cache: { valid: true, checkedAt: NOW - 10 * 24 * 3600 * 1000 } }, NOW);
  expect(s.state).toBe("unlicensed");
});

test("graceDays rounds up and floors at 0", () => {
  expect(graceDays({ remainingMs: 6 * 24 * 3600 * 1000 + 1 })).toBe(7);
  expect(graceDays({ remainingMs: 0 })).toBe(0);
  expect(graceDays(null)).toBe(0);
});

test("fmtDate formats ISO and handles garbage", () => {
  expect(fmtDate("2026-09-01T00:00:00Z")).toBe("Sep 1, 2026");
  expect(fmtDate(null)).toBe("");
  expect(fmtDate("nope")).toBe("");
});

test("showGate renders the activation card without throwing (regression: state was undefined in showGate scope)", () => {
  const makeEl = () => ({
    style: {},
    textContent: "",
    disabled: false,
    href: "",
    children: [],
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener() {},
    remove() {
      this.removed = true;
    },
  });
  const body = makeEl();
  globalThis.document = {
    getElementById: () => null,
    createElement: () => makeEl(),
    body,
  };
  const { showGate } = globalThis.QS.license;
  const gate = showGate({ state: "unlicensed" });
  expect(gate).not.toBeNull();
  expect(gate.children.length).toBeGreaterThanOrEqual(6); // title, sub, msg, input, err, btn, buy, portal, stateLine
  delete globalThis.document;
});

test("bridge ignores its own request messages (self-match regression: every request ate its own response)", async () => {
  let handler = null;
  const inbox = [];
  const fakeWindow = {
    addEventListener: (type, fn) => {
      if (type === "message") handler = fn;
    },
    postMessage: (msg) => {
      inbox.push(msg);
      if (handler) handler({ data: msg });
    },
  };
  globalThis.window = fakeWindow;
  const fresh = await import(`../src/license.js?selfmatch=${Date.now()}`);
  const lic = fresh && fresh.QS ? fresh.QS.license : globalThis.QS.license;
  const p = lic.getStatus(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(inbox.length).toBe(1);
  expect(inbox[0].type).toBe("qs:license-status-request");
  let settled = false;
  p.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 10));
  expect(settled).toBe(false);
  handler({
    data: {
      type: "qs:license-status-response",
      requestId: inbox[0].requestId,
      result: { key: true, instance: "i1", validation: { valid: true, checkedAt: Date.now() } },
    },
  });
  const status = await p;
  expect(status.state).toBe("active");
  delete globalThis.window;
});

// ──────────────────────────────────────────────────────────────────────────
// Slice 7A — browser-family requests, stable reason mapping, dual seat-limit
// CTAs, active billing surface, accessibility, cache semantics.
// ──────────────────────────────────────────────────────────────────────────

// Rich DOM stubs (consistent with the project's stub-testing convention).
function makeEl(tag, doc) {
  let _id = "";
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    style: {},
    textContent: "",
    href: "",
    target: "",
    rel: "",
    disabled: false,
    type: "",
    value: "",
    placeholder: "",
    autocomplete: "",
    children: [],
    _attrs: {},
    _listeners: {},
    _focused: false,
    removed: false,
    parentElement: null,
    appendChild(c) {
      this.children.push(c);
      c.parentElement = this;
      return c;
    },
    replaceChildren() {
      this.children = [];
    },
    setAttribute(n, v) {
      this._attrs[n] = v;
    },
    getAttribute(n) {
      return this._attrs[n];
    },
    focus() {
      this._focused = true;
      if (doc) doc._lastFocused = this;
    },
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
    },
    dispatch(type, ev) {
      for (const fn of [...(this._listeners[type] || [])]) fn(ev || {});
    },
    remove() {
      this.removed = true;
      if (doc && doc._registry && this.id && doc._registry[this.id] === this) delete doc._registry[this.id];
    },
    querySelector() {
      return null;
    },
  };
  Object.defineProperty(el, "id", {
    get: () => _id,
    set: (v) => {
      _id = v;
      if (doc && doc._registry) doc._registry[v] = el;
    },
  });
  return el;
}

function makeDoc() {
  const registry = {};
  const doc = {
    _registry: registry,
    _listeners: {},
    _lastFocused: null,
    body: null,
    createElement: (tag) => makeEl(tag, doc),
    getElementById: (id) => registry[id] || null,
    querySelector: () => null,
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
    },
    dispatch(type, ev) {
      for (const fn of [...(this._listeners[type] || [])]) fn(ev || {});
    },
  };
  doc.body = makeEl("body", doc);
  doc.body.id = "body";
  return doc;
}

function collectAnchors(el) {
  const out = [];
  const walk = (node) => {
    if (!node) return;
    if (node.href && node.textContent) out.push(node);
    for (const c of node.children || []) walk(c);
  };
  walk(el);
  return out;
}

// ── 1. Central product config ──
test("product config centralizes price/seat wording/URLs (no scattered literals)", () => {
  const P = globalThis.QS.license.PRODUCT;
  expect(P.price).toBe("$7.99");
  expect(P.priceLabel).toBe("$7.99/month");
  expect(P.seatWording).toBe("another computer or browser profile");
  expect(globalThis.QS.license.CHECKOUT_URL).toBe(P.checkoutUrl);
  expect(globalThis.QS.license.PORTAL_URL).toBe(P.portalUrl);
  expect(globalThis.QS.license.RECOVERY_URL).toBe(P.recoveryUrl);
  expect(P.checkoutUrl.startsWith("https://")).toBe(true);
});

// ── 2. Build-time browser-family seam ──
test("buildRequest: explicit chrome and edge builds send their fixed family", () => {
  const c = globalThis.QS.license.buildRequest("chrome", { license_key: "k", instance_id: "i" });
  expect(c).toEqual({ license_key: "k", instance_id: "i", browser_family: "chrome" });
  const e = globalThis.QS.license.buildRequest("edge", { license_key: "k", instance_id: "i" });
  expect(e).toEqual({ license_key: "k", instance_id: "i", browser_family: "edge" });
});

test("family is never inferred from navigator.userAgent", async () => {
  const src = await Bun.file(new URL("../src/license.js", import.meta.url)).text();
  const bg = await Bun.file(new URL("../src/background.js", import.meta.url)).text();
  expect(src).not.toContain("userAgent");
  expect(bg).not.toContain("userAgent");
  for (let i = 0; i < 3; i++) {
    expect(globalThis.QS.license.buildRequest("chrome", { license_key: "k" }).browser_family).toBe("chrome");
    expect(globalThis.QS.license.buildRequest("edge", { license_key: "k" }).browser_family).toBe("edge");
  }
});

// ── 3. Stable reason → state/message mapping ──
test("mapReason: every frozen reason maps to a stable state", () => {
  const expectations = {
    "slot-occupied": "license-limit",
    "slot-mismatch": "license-limit",
    "family-undetermined": "invalid",
    "not-activated": "unlicensed",
    "license-canceled": "canceled",
    "license-past_due": "past-due",
    "license-paused": "paused",
    "license-incomplete": "incomplete",
    "license-canceling-at-period-end": "active",
  };
  for (const [reason, state] of Object.entries(expectations)) {
    const mapped = globalThis.QS.license.mapReason(reason);
    expect(mapped).not.toBeNull();
    expect(mapped.state).toBe(state);
    expect(mapped.message.length).toBeGreaterThan(0);
  }
  expect(globalThis.QS.license.mapReason("totally-unknown")).toBeNull();
});

test("deriveState maps server reason codes in validation into stable states", () => {
  const s = deriveState(
    { key: true, validation: { valid: false, reason: "slot-occupied", error: "slot occupied" } },
    NOW
  );
  expect(s.state).toBe("license-limit");
  expect(s.cta).toEqual(["manage", "buy"]);
});

// ── 4. Cache semantics: known revocation never enters grace ──
test("known revoked/blocked response NEVER enters grace even with a recent valid cache", () => {
  const s = deriveState(
    {
      key: true,
      validation: { valid: false, reason: "license-paused", error: "paused" },
      cache: { valid: true, checkedAt: NOW - 1000 },
    },
    NOW
  );
  expect(s.state).toBe("paused");
});

test("background: authoritative blocked response clears valid cache (no grace)", async () => {
  const stored = {
    qsKey: "QMP-KEY",
    qsInstance: "inst-1",
    qsCache: { valid: true, checkedAt: Date.now() - 30 * 3600 * 1000 }, // stale (>24h) → forces online check
    qsLicenseDebug: null,
  };
  const chrome = {
    runtime: { getManifest: () => ({ version: "test" }), onMessage: { addListener: () => {} }, lastError: null },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = stored[k];
          return out;
        },
        set: async (obj) => Object.assign(stored, obj),
      },
    },
  };
  globalThis.chrome = chrome;
  globalThis.fetch = async () => ({ json: async () => ({ valid: false, code: "license-canceled", error: "subscription canceled" }) });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?revoke=${Date.now()}`);
  const bg = globalThis.QS.background;
  const st = await bg.status();
  expect(st.blocked).toBe(true);
  expect(st.cache).toBeNull();
  expect(stored.qsCache).toBeNull();
  const derived = deriveState(st, Date.now());
  expect(derived.state).toBe("canceled");
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

test("network failure may use a recent-valid cache for offline grace; stale → unreachable", () => {
  const recent = deriveState(
    { key: true, validation: null, cache: { valid: true, checkedAt: NOW - 24 * 3600 * 1000 }, error: "fetch failed" },
    NOW
  );
  expect(recent.state).toBe("grace");
  const stale = deriveState(
    { key: true, validation: null, cache: { valid: true, checkedAt: NOW - 10 * 24 * 3600 * 1000 }, error: "fetch failed" },
    NOW
  );
  expect(stale.state).toBe("unreachable");
});

// ── 5. Dual seat-limit CTAs ──
test("slot CTAs use the exact frozen labels", () => {
  const ctas = globalThis.QS.license.slotCtas();
  expect(ctas.manage).toBe("Manage installations");
  expect(ctas.buy).toBe("Buy another seat — $7.99/month");
});

test("showGate: slot-occupied shows BOTH exact CTAs regardless of server actions", () => {
  const doc = makeDoc();
  globalThis.document = doc;
  const st = deriveState({ key: true, validation: { valid: false, reason: "slot-occupied" } }, NOW);
  const gate = globalThis.QS.license.showGate(st);
  expect(gate).not.toBeNull();
  const labels = collectAnchors(gate).map((a) => a.textContent);
  expect(labels).toContain("Manage installations");
  expect(labels).toContain("Buy another seat — $7.99/month");
  delete globalThis.document;
});

// ── 6. Active billing surface ──
test("billingLinks exposes the four active-subscriber actions", () => {
  const labels = globalThis.QS.license.billingLinks().map((l) => l.label);
  expect(labels).toEqual([
    "Manage subscription",
    "Recover license",
    "Manage Chrome/Edge installations",
    "Buy another seat — $7.99/month",
  ]);
});

test("showBillingSurface is a dialog with the four links; Esc dismisses it", () => {
  const doc = makeDoc();
  globalThis.document = doc;
  const surf = globalThis.QS.license.showBillingSurface();
  expect(surf).not.toBeNull();
  expect(surf._attrs.role).toBe("dialog");
  const listDiv = surf.children.find((c) => (c.style.cssText || "").includes("flex"));
  expect(listDiv).toBeTruthy();
  const labels = listDiv.children.filter((c) => c.href).map((c) => c.textContent);
  expect(labels).toContain("Manage subscription");
  expect(labels).toContain("Recover license");
  expect(labels).toContain("Manage Chrome/Edge installations");
  expect(labels).toContain("Buy another seat — $7.99/month");
  doc.dispatch("keydown", { key: "Escape" });
  expect(surf.removed).toBe(true);
  expect(doc.getElementById("qs-billing-surface")).toBeNull();
  delete globalThis.document;
});

test("attachAppUiControl adds an unobtrusive control to existing app UI (not a float)", () => {
  const doc = makeDoc();
  globalThis.document = doc;
  const band = makeEl("div", doc);
  const chip = makeEl("div", doc);
  chip.id = "qs-aggregate";
  band.appendChild(chip);
  doc.body.appendChild(band);
  doc._registry["qs-aggregate"] = chip;
  doc.querySelector = () => chip;
  const ctrl = globalThis.QS.license.attachAppUiControl();
  expect(ctrl).not.toBeNull();
  expect(ctrl.textContent).toBe("License & billing");
  expect(band.children).toContain(ctrl);
  expect(doc.body.children).not.toContain(ctrl);
  ctrl.dispatch("click", { preventDefault() {} });
  expect(doc.getElementById("qs-billing-surface")).toBeTruthy();
  delete globalThis.document;
});

// ── 7. Canceled / past-due / paused / incomplete / period-end copy ──
test("period-end copy shows while access stays active/trialing", () => {
  const st = deriveState(
    { key: true, validation: { valid: true, currentPeriodEnd: "2026-09-01T00:00:00Z", cancelAtPeriodEnd: true } },
    NOW
  );
  expect(st.state).toBe("active");
  expect(st.cancelAtPeriodEnd).toBe(true);
  expect(st.periodEnd).toBe("2026-09-01T00:00:00Z");
  const copy = globalThis.QS.license.periodEndCopy(st);
  expect(copy).toContain("Sep 1, 2026");
  expect(copy).toContain("active");
});

test("each non-active reason carries explanatory copy", () => {
  const cases = {
    "license-canceled": "canceled",
    "license-past_due": "past",
    "license-paused": "paused",
    "license-incomplete": "incomplete",
  };
  for (const [reason, needle] of Object.entries(cases)) {
    const st = deriveState({ key: true, validation: { valid: false, reason } }, NOW);
    expect(st.message.toLowerCase()).toContain(needle);
  }
});

// ── 8. Accessibility ──
test("showGate: dialog semantics, aria-live error region, focus into gate, Esc can't bypass", () => {
  const doc = makeDoc();
  globalThis.document = doc;
  const gate = globalThis.QS.license.showGate({ state: "unlicensed" });
  expect(gate).not.toBeNull();
  expect(gate._attrs.role).toBe("dialog");
  expect(gate._attrs["aria-modal"]).toBe("true");
  const err = gate.children.find((c) => c._attrs.role === "alert");
  expect(err).toBeTruthy();
  expect(err._attrs["aria-live"]).toBe("assertive");
  expect(gate.children.some((c) => c._focused)).toBe(true);
  doc.dispatch("keydown", { key: "Escape" });
  expect(gate.removed).toBeFalsy();
  expect(doc.getElementById("qs-license-gate")).toBe(gate);
  const withFocusCss = collectAnchors(gate).filter((a) => (a.style.cssText || "").includes("outline"));
  expect(withFocusCss.length).toBeGreaterThanOrEqual(2);
  delete globalThis.document;
});

test("key input is the only raw-key-bearing element in the gate DOM", () => {
  const doc = makeDoc();
  globalThis.document = doc;
  const gate = globalThis.QS.license.showGate({ state: "unlicensed" });
  const input = gate.children.find((c) => c.type === "text");
  expect(input).toBeTruthy();
  expect(input.autocomplete).toBe("off");
  expect(gate.children.filter((c) => c.type === "text").length).toBe(1);
  delete globalThis.document;
});

// ── 9. Remote logging discipline ──
test("no raw payload / key-like data is logged in license, background, or content", async () => {
  for (const f of ["../src/license.js", "../src/background.js", "../src/content.js"]) {
    const src = await Bun.file(new URL(f, import.meta.url)).text();
    expect(src).not.toContain("license raw payload");
    expect(src).not.toContain("JSON.stringify(raw)");
  }
  const lic = await Bun.file(new URL("../src/license.js", import.meta.url)).text();
  expect(lic).not.toContain("JSON.stringify(data.result)");
  expect(lic).not.toContain("raw payload");
});

// ── 10. Background request seam: family on activation AND validation ──
test("background: buildRequestBody pure seam (chrome + edge) and live activation/validation carry family", async () => {
  const stored = { qsKey: "QMP-KEY", qsInstance: "inst-1", qsCache: null, qsLicenseDebug: null };
  const fetchCalls = [];
  const chrome = {
    runtime: { getManifest: () => ({ version: "test" }), onMessage: { addListener: () => {} }, lastError: null },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = stored[k];
          return out;
        },
        set: async (obj) => Object.assign(stored, obj),
      },
    },
  };
  globalThis.chrome = chrome;
  globalThis.fetch = async (url, opts) => {
    fetchCalls.push({ url, body: JSON.parse(opts.body) });
    return url.endsWith("/api/license/activate")
      ? { json: async () => ({ activated: true, expiresAt: "2026-09-01T00:00:00Z" }) }
      : { json: async () => ({ valid: true, expiresAt: "2026-09-01T00:00:00Z" }) };
  };
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?bgbuild=${Date.now()}`);
  const bg = globalThis.QS.background;

  const c = bg.buildRequestBody({ license_key: "k", instance_id: "i" }, "chrome");
  expect(c.browser_family).toBe("chrome");
  const e = bg.buildRequestBody({ license_key: "k", instance_id: "i" }, "edge");
  expect(e.browser_family).toBe("edge");

  // live ACTIVATION sends browser_family
  fetchCalls.length = 0;
  await bg.setKey("QMP-KEY2");
  expect(fetchCalls.length).toBe(1);
  expect(fetchCalls[0].body.license_key).toBe("QMP-KEY2");
  expect(fetchCalls[0].body.browser_family).toBe("edge");

  // live VALIDATION sends browser_family
  fetchCalls.length = 0;
  stored.qsCache = null;
  const st = await bg.status();
  expect(fetchCalls.length).toBe(1);
  expect(fetchCalls[0].body.browser_family).toBe("edge");
  expect(st.validation.valid).toBe(true);

  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

// ──────────────────────────────────────────────────────────────────────────
// Slice 7A integration fixes (strict RED→GREEN, cross-lane probes)
// ──────────────────────────────────────────────────────────────────────────

// shared background mock (consistent with the tests above)
function makeBgChrome(stored) {
  return {
    runtime: { getManifest: () => ({ version: "test" }), onMessage: { addListener: () => {} }, lastError: null },
    storage: {
      local: {
        get: async (keys) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = stored[k];
          return out;
        },
        set: async (obj) => Object.assign(stored, obj),
      },
    },
  };
}

// ── 1. Idempotent activation success (cross-lane probe 1) ──
test("background: idempotent activation {valid:true, activated:false, code:'ok'} is SUCCESS (key+cache stored, no rejection)", async () => {
  const stored = { qsKey: null, qsInstance: "inst-1", qsCache: null, qsLicenseDebug: null };
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async () => ({
    json: async () => ({
      valid: true,
      activated: false,
      code: "ok",
      current_period_end: 1798761600,
      cancel_at_period_end: true,
      expiresAt: "2027-01-01T00:00:00Z",
    }),
  });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?idemok=${Date.now()}`);
  const bg = globalThis.QS.background;
  const res = await bg.setKey("QMP-IDEMP");
  expect(res.ok).toBe(true);
  expect(res.activated).toBe(false);
  expect(stored.qsKey).toBe("QMP-IDEMP"); // key stored
  expect(stored.qsCache).toBeTruthy();
  expect(stored.qsCache.valid).toBe(true);
  expect(stored.qsCache.currentPeriodEnd).toBe(1798761600); // period fields persisted
  expect(stored.qsCache.cancelAtPeriodEnd).toBe(true);
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

test("background: legacy {activated:true} activation still succeeds (compat preserved)", async () => {
  const stored = { qsKey: null, qsInstance: "inst-1", qsCache: null, qsLicenseDebug: null };
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async () => ({ json: async () => ({ activated: true, expiresAt: "2026-09-01T00:00:00Z" }) });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?legacy=${Date.now()}`);
  const bg = globalThis.QS.background;
  const res = await bg.setKey("QMP-LEGACY");
  expect(res.ok).toBe(true);
  expect(res.activated).toBe(true);
  expect(stored.qsKey).toBe("QMP-LEGACY");
  expect(stored.qsCache.valid).toBe(true);
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

// ── 2. Stripe Unix-seconds period timestamps (cross-lane probe 2) ──
test("fmtDate: Stripe Unix seconds (1798761600) render a real period date — never 1970", () => {
  const s = fmtDate(1798761600);
  expect(s).not.toBe("");
  expect(s).not.toContain("1970");
  expect(s).not.toContain("1969");
  expect(s.includes("2026") || s.includes("2027")).toBe(true);
  // a millisecond value for the SAME instant must agree with the seconds value
  expect(fmtDate(1798761600000)).toBe(fmtDate(1798761600));
});

test("periodEndCopy: numeric Stripe-seconds periodEnd renders a real year (no 1970)", () => {
  const st = deriveState({ key: true, validation: { valid: true, currentPeriodEnd: 1798761600, cancelAtPeriodEnd: true } }, NOW);
  expect(st.periodEnd).toBe(1798761600);
  const copy = globalThis.QS.license.periodEndCopy(st);
  expect(copy.length).toBeGreaterThan(0);
  expect(copy).not.toContain("1970");
  expect(copy).not.toContain("1969");
  expect(copy.includes("2026") || copy.includes("2027")).toBe(true);
});

// ── 3. content.js BROWSER_FAMILY fallback seam (cross-lane probe 3) ──
test("content.js: direct fallback uses a named BROWSER_FAMILY/API_BASE seam — no literal 'browser_family: edge'", async () => {
  const src = await Bun.file(new URL("../src/content.js", import.meta.url)).text();
  expect(src).toContain("BROWSER_FAMILY");
  expect(src).toContain("API_BASE");
  expect(src).not.toMatch(/browser_family\s*:\s*["']edge["']/);
  expect(src).toContain("browser_family: f"); // body family comes from the param/constant, not a literal
  expect(src).not.toContain("userAgent");

  const win = { addEventListener() {}, postMessage() {} };
  globalThis.window = win;
  globalThis.chrome = { runtime: { sendMessage: () => {} }, storage: { local: { get: async () => ({}), set: async () => {} } } };
  await import(`../src/content.js?seam=${Date.now()}`);
  const content = globalThis.QS.content;
  expect(content.buildDirectBody({ license_key: "k", instance_id: "i" }, "chrome").browser_family).toBe("chrome");
  expect(content.buildDirectBody({ license_key: "k", instance_id: "i" }, "edge").browser_family).toBe("edge");
  expect(content.buildDirectBody({ license_key: "k", instance_id: "i" }).browser_family).toBe(content.BROWSER_FAMILY);
  delete globalThis.window;
  delete globalThis.chrome;
});

test("content.js directFetch sends browser_family = BROWSER_FAMILY (build constant) in the live fallback body", async () => {
  const captured = [];
  const win = { addEventListener() {}, postMessage() {} };
  globalThis.window = win;
  globalThis.chrome = { runtime: { sendMessage: () => {} }, storage: { local: { get: async () => ({ qsInstance: "inst-1" }), set: async () => {} } } };
  globalThis.fetch = async (url, opts) => {
    captured.push({ url, body: JSON.parse(opts.body) });
    return { json: async () => ({ valid: true }) };
  };
  await import(`../src/content.js?direct=${Date.now()}`);
  const content = globalThis.QS.content;
  await content.directFetch("qs-license-set-key", { key: "K" });
  expect(captured.length).toBe(1);
  expect(captured[0].url).toBe("https://license.nimira-timer.com/api/license/activate");
  expect(captured[0].body.license_key).toBe("K");
  expect(captured[0].body.browser_family).toBe(content.BROWSER_FAMILY);
  delete globalThis.window;
  delete globalThis.chrome;
  delete globalThis.fetch;
});

// ── 4. Activation-time slot-occupied rebuilds the dual CTAs (non-blocking finding) ──
test("activation-time slot-occupied rebuilds the gate with BOTH exact seat-limit CTAs, key not stored", async () => {
  const doc = makeDoc();
  globalThis.document = doc;
  let handler = null;
  const fakeWindow = {
    addEventListener(type, fn) {
      if (type === "message") handler = fn;
    },
    postMessage(msg) {
      if (handler) handler({ data: msg }); // deliver the request to the module listener (self-match guarded)
    },
  };
  globalThis.window = fakeWindow;
  // respond to the activation request with slot-occupied (server actions absent)
  fakeWindow.postMessage = (msg) => {
    if (handler) handler({ data: msg });
    if (msg.type === "qs:license-set-key") {
      handler({
        data: {
          type: "qs:license-set-key-response",
          requestId: msg.requestId,
          result: { ok: false, reason: "slot-occupied", message: "slot occupied" },
        },
      });
    }
  };
  const fresh = await import(`../src/license.js?slotcta=${Date.now()}`);
  const lic = (fresh && fresh.QS && fresh.QS.license) || globalThis.QS.license;
  const gate = lic.showGate({ state: "unlicensed" });
  expect(gate).not.toBeNull();
  const btn = gate.children.find((c) => c.textContent === "Activate");
  expect(btn).toBeTruthy();
  // populate the key input so the click handler actually calls setKey
  const inputEl = gate.children.find((c) => c.type === "text");
  expect(inputEl).toBeTruthy();
  inputEl.value = "QMP-SECOND-DEVICE";
  btn.dispatch("click", {});
  // let the async click handler finish and rebuild the gate
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const newGate = doc.getElementById("qs-license-gate");
  expect(newGate).not.toBeNull();
  const labels = collectAnchors(newGate).map((a) => a.textContent);
  expect(labels).toContain("Manage installations");
  expect(labels).toContain("Buy another seat — $7.99/month");
  delete globalThis.window;
  delete globalThis.document;
});

// ── 5. attachAppUiControl is anchor-only — never floating/detached (non-blocking finding) ──
test("attachAppUiControl appends NOTHING and returns null when no app UI anchor exists (no body fallback)", () => {
  const doc = makeDoc();
  globalThis.document = doc;
  const ctrl = globalThis.QS.license.attachAppUiControl();
  expect(ctrl).toBeNull(); // returns null — nothing to attach to
  expect(doc.body.children.length).toBe(0); // nothing appended anywhere
  delete globalThis.document;
});

// ── 6. setKey hygiene: bounded fields only, no raw response forwarded (non-blocking finding) ──
test("background setKey failure surfaces bounded fields only — no raw response (detail) forwarded or logged", async () => {
  const stored = { qsKey: null, qsInstance: "inst-1", qsCache: null, qsLicenseDebug: null };
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async () => ({
    json: async () => ({
      valid: false,
      code: "slot-occupied",
      error: "slot occupied",
      actions: { manageInstallations: true, buyAnotherSeat: true },
      raw_secret: "SHOULD-NOT-LEAK",
      subscription: { id: "sub_x" },
    }),
  });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?hyg=${Date.now()}`);
  const bg = globalThis.QS.background;
  const res = await bg.setKey("QMP-FAIL");
  expect(res.ok).toBe(false);
  expect(res.reason).toBe("slot-occupied");
  expect(res.message).toBe("slot occupied");
  expect(res.actions).toEqual({ manageInstallations: true, buyAnotherSeat: true });
  expect(res).not.toHaveProperty("detail"); // no raw response object
  expect(res).not.toHaveProperty("raw_secret");
  expect(res).not.toHaveProperty("subscription");
  expect(stored.qsKey).toBeNull(); // failure must not store the key
  // source: background.js must not forward a `detail:` raw response field
  const bgSrc = await Bun.file(new URL("../src/background.js", import.meta.url)).text();
  expect(bgSrc).not.toMatch(/detail\s*:/);
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

// ──────────────────────────────────────────────────────────────────────────
// FINAL BOUNDED FAIL-CLOSED FIX — success predicates must fail closed.
// A malformed/attack payload that says `valid:true` while carrying a FROZEN
// FAILURE code (family-undetermined, license-canceled, ...) must NOT be
// accepted as active/success anywhere — yet the legacy (`valid:true`, no code)
// and frozen (`valid:true` + `code:'ok'`) success shapes must be preserved.
// ──────────────────────────────────────────────────────────────────────────

// ── Step 1: activation fails closed on a malformed failure code ──
test("background: malformed activation {valid:true, code:'family-undetermined'} FAILS CLOSED (no key, no valid cache stored)", async () => {
  const stored = { qsKey: null, qsInstance: "inst-1", qsCache: null, qsLicenseDebug: null };
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async () => ({
    json: async () => ({ valid: true, activated: false, code: "family-undetermined" }),
  });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?fcfamact=${Date.now()}`);
  const bg = globalThis.QS.background;
  const res = await bg.setKey("QMP-FAILCLOSED");
  expect(res.ok).toBe(false); // NOT a success
  expect(stored.qsKey).toBeNull(); // no active key stored
  expect(stored.qsCache).toBeNull(); // no valid cache stored
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

test("background: frozen idempotent activation {valid:true, code:'ok'} is STILL success (frozen success preserved)", async () => {
  const stored = { qsKey: null, qsInstance: "inst-1", qsCache: null, qsLicenseDebug: null };
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async () => ({
    json: async () => ({ valid: true, activated: false, code: "ok", expiresAt: "2027-01-01T00:00:00Z" }),
  });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?fcactok=${Date.now()}`);
  const bg = globalThis.QS.background;
  const res = await bg.setKey("QMP-IDEMP-OK");
  expect(res.ok).toBe(true);
  expect(stored.qsKey).toBe("QMP-IDEMP-OK");
  expect(stored.qsCache.valid).toBe(true);
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

// ── Step 3: validation status + deriveState fail closed on malformed failure codes ──
test("background: malformed validation {valid:true, code:'family-undetermined'} FAILS CLOSED (blocked, cache cleared, not active)", async () => {
  const stored = { qsKey: "QMP-KEY", qsInstance: "inst-1", qsCache: { valid: true, checkedAt: Date.now() - 30 * 3600 * 1000 }, qsLicenseDebug: null }; // stale >24h → forces online check
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async () => ({ json: async () => ({ valid: true, code: "family-undetermined" }) });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?fcvalfam=${Date.now()}`);
  const bg = globalThis.QS.background;
  const st = await bg.status();
  expect(st.blocked).toBe(true);
  expect(st.validation.valid).toBe(false);
  expect(st.cache).toBeNull();
  expect(stored.qsCache).toBeNull();
  const derived = deriveState(st, Date.now());
  expect(derived.state).not.toBe("active");
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

test("background: frozen validation {valid:true, code:'ok'} is STILL success (caches valid, not blocked)", async () => {
  const stored = { qsKey: "QMP-KEY", qsInstance: "inst-1", qsCache: { valid: true, checkedAt: Date.now() - 30 * 3600 * 1000 }, qsLicenseDebug: null };
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async () => ({ json: async () => ({ valid: true, code: "ok" }) });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?fcvalok=${Date.now()}`);
  const bg = globalThis.QS.background;
  const st = await bg.status();
  expect(st.blocked).toBeFalsy();
  expect(st.validation.valid).toBe(true);
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

test("deriveState: malformed {valid:true} + frozen failure code (family-undetermined) fails closed — invalid, NOT active", () => {
  const s = deriveState({ key: true, validation: { valid: true, code: "family-undetermined" } }, NOW);
  expect(s.state).not.toBe("active");
  expect(s.state).toBe("invalid");
});

test("deriveState: malformed {valid:true} + frozen failure code (license-canceled) fails closed — canceled, NOT active", () => {
  const s = deriveState({ key: true, validation: { valid: true, code: "license-canceled" } }, NOW);
  expect(s.state).toBe("canceled");
});

test("deriveState: legacy validation {valid:true} with NO code is STILL active (legacy success preserved)", () => {
  const s = deriveState({ key: true, validation: { valid: true, expiresAt: "2026-08-01T00:00:00Z", checkedAt: NOW } }, NOW);
  expect(s.state).toBe("active");
});

test("deriveState: frozen validation {valid:true, code:'ok'} is STILL active (frozen success preserved)", () => {
  const s = deriveState({ key: true, validation: { valid: true, code: "ok", checkedAt: NOW } }, NOW);
  expect(s.state).toBe("active");
});

test("deriveState: direct-fallback raw payload {valid:true, code:'family-undetermined'} derives failure, NOT active", () => {
  // shape = the raw response content.js directFetch posts back for the status path
  const s = deriveState({ key: true, validation: { valid: true, code: "family-undetermined", error: "family undetermined" } }, NOW);
  expect(s.state).toBe("invalid");
});

// ──────────────────────────────────────────────────────────────────────────
// FINAL MICRO-FIX — Slice 7A error-channel residual. Reasons can arrive in
// the `error` field as well as `code`. `{valid:true}` (or `activated:true`)
// must NOT be treated as success/active when a NONBLANK failure `error` is
// present — even when the code channel looks clean. Genuine success may
// carry `error:null`/`error:""` (legacy/frozen success preserved).
// ──────────────────────────────────────────────────────────────────────────

// ── activation: code ok + failure error must fail ──
test("background: malformed activation {valid:true, code:'ok', error:'family-undetermined'} FAILS CLOSED (no key, no valid cache stored)", async () => {
  const stored = { qsKey: null, qsInstance: "inst-1", qsCache: null, qsLicenseDebug: null };
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async () => ({ json: async () => ({ valid: true, code: "ok", error: "family-undetermined" }) });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?fcerractok=${Date.now()}`);
  const bg = globalThis.QS.background;
  const res = await bg.setKey("QMP-ERR-OK");
  expect(res.ok).toBe(false); // NOT a success
  expect(stored.qsKey).toBeNull();
  expect(stored.qsCache).toBeNull();
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

// ── activation: contradictory activated:true + failure error must fail ──
test("background: malformed activation {activated:true, error:'family-undetermined'} FAILS CLOSED (no key, no valid cache stored)", async () => {
  const stored = { qsKey: null, qsInstance: "inst-1", qsCache: null, qsLicenseDebug: null };
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async () => ({ json: async () => ({ activated: true, error: "family-undetermined" }) });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?fcerract=${Date.now()}`);
  const bg = globalThis.QS.background;
  const res = await bg.setKey("QMP-ERR-ACT");
  expect(res.ok).toBe(false); // NOT a success
  expect(stored.qsKey).toBeNull();
  expect(stored.qsCache).toBeNull();
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

// ── legacy activation with error:null is STILL success (error:null = no error) ──
test("background: legacy {activated:true, error:null} activation still succeeds (error:null/empty is not a failure)", async () => {
  const stored = { qsKey: null, qsInstance: "inst-1", qsCache: null, qsLicenseDebug: null };
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async () => ({ json: async () => ({ activated: true, error: null, expiresAt: "2026-09-01T00:00:00Z" }) });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?fcerrnull=${Date.now()}`);
  const bg = globalThis.QS.background;
  const res = await bg.setKey("QMP-NULL-ERR");
  expect(res.ok).toBe(true);
  expect(stored.qsKey).toBe("QMP-NULL-ERR");
  expect(stored.qsCache.valid).toBe(true);
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

// ── status/validation: error-channel family-undetermined must block+clear cache ──
test("background: malformed validation {valid:true, error:'family-undetermined'} (no code) FAILS CLOSED (blocked, cache cleared, not active)", async () => {
  const stored = { qsKey: "QMP-KEY", qsInstance: "inst-1", qsCache: { valid: true, checkedAt: Date.now() - 30 * 3600 * 1000 }, qsLicenseDebug: null }; // stale >24h → forces online check
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async () => ({ json: async () => ({ valid: true, error: "family-undetermined" }) });
  globalThis.crypto = { randomUUID: () => "uuid-1" };
  await import(`../src/background.js?fcerrfam=${Date.now()}`);
  const bg = globalThis.QS.background;
  const st = await bg.status();
  expect(st.blocked).toBe(true);
  expect(st.validation.valid).toBe(false);
  expect(st.cache).toBeNull();
  expect(stored.qsCache).toBeNull();
  const derived = deriveState(st, Date.now());
  expect(derived.state).not.toBe("active");
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

// ── deriveState: error-channel family-undetermined (no code) → invalid, not active ──
test("deriveState: malformed {valid:true} + failure ERROR (family-undetermined, no code) fails closed — invalid, NOT active", () => {
  const s = deriveState({ key: true, validation: { valid: true, error: "family-undetermined" } }, NOW);
  expect(s.state).not.toBe("active");
  expect(s.state).toBe("invalid");
});

// ── deriveState: error-channel license-canceled (no code) → canceled, not active ──
test("deriveState: malformed {valid:true} + failure ERROR (license-canceled, no code) fails closed — canceled, NOT active", () => {
  const s = deriveState({ key: true, validation: { valid: true, error: "license-canceled" } }, NOW);
  expect(s.state).toBe("canceled");
});

// ── deriveState: direct-fallback raw error (no code) family-undetermined is not active ──
test("deriveState: direct-fallback raw {valid:true, error:'family-undetermined'} (NO code) derives failure, NOT active", () => {
  // shape = raw response content.js directFetch posts back when the reason arrives in `error` only
  const s = deriveState({ key: true, validation: { valid: true, error: "family-undetermined" } }, NOW);
  expect(s.state).not.toBe("active");
  expect(s.state).toBe("invalid");
});

// ── legacy/frozen success with error:null / error:"" PRESERVED ──
test("deriveState: legacy {valid:true, error:null, no code} is STILL active (error:null = no error)", () => {
  const s = deriveState({ key: true, validation: { valid: true, error: null, checkedAt: NOW } }, NOW);
  expect(s.state).toBe("active");
});

test("deriveState: frozen {valid:true, code:'ok', error:''} is STILL active (empty error = no error)", () => {
  const s = deriveState({ key: true, validation: { valid: true, code: "ok", error: "", checkedAt: NOW } }, NOW);
  expect(s.state).toBe("active");
});

// ──────────────────────────────────────────────────────────────────────────
// Legacy browser-slot transition: validation stays read-only. When the
// server says a stored key has no family slot, the worker makes one separate
// activation request, then validates again. The raw key never leaves the
// worker/page bridge.
// ──────────────────────────────────────────────────────────────────────────

test("background transition: not-activated auto-activates the stored family slot once, then validates and caches success", async () => {
  const stored = {
    qsKey: "QMP-LEGACY-STORED",
    qsInstance: "legacy-inst-1",
    qsCache: null,
    qsLicenseDebug: null,
  };
  const calls = [];
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (calls.length === 1) {
      return { json: async () => ({ valid: false, code: "not-activated", error: "not-activated" }) };
    }
    if (calls.length === 2) {
      return { json: async () => ({ valid: true, activated: true, code: "ok", error: null }) };
    }
    return {
      json: async () => ({
        valid: true,
        code: "ok",
        error: null,
        current_period_end: 1900000000,
        cancel_at_period_end: false,
      }),
    };
  };
  globalThis.crypto = { randomUUID: () => "unused" };
  await import(`../src/background.js?legacytransition=${Date.now()}`);
  const st = await globalThis.QS.background.status();

  expect(calls.map((c) => c.url.split("/").pop())).toEqual(["validate", "activate", "validate"]);
  expect(calls.every((c) => c.body.license_key === stored.qsKey)).toBe(true);
  expect(calls.every((c) => c.body.instance_id === stored.qsInstance)).toBe(true);
  expect(calls.every((c) => c.body.browser_family === "edge")).toBe(true);
  expect(st.validation.valid).toBe(true);
  expect(st.blocked).toBeFalsy();
  expect(stored.qsCache.valid).toBe(true);
  expect(stored.qsCache.currentPeriodEnd).toBe(1900000000);

  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

test("background transition: slot-occupied activation fails closed and does not validate a third time", async () => {
  const stored = {
    qsKey: "QMP-LEGACY-OCCUPIED",
    qsInstance: "legacy-inst-2",
    qsCache: { valid: true, checkedAt: Date.now() - 30 * 3600 * 1000 },
    qsLicenseDebug: null,
  };
  const calls = [];
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (calls.length === 1) {
      return { json: async () => ({ valid: false, code: "not-activated", error: "not-activated" }) };
    }
    return {
      json: async () => ({
        valid: false,
        code: "slot-occupied",
        error: "slot-occupied",
        actions: { manageInstallations: true, buyAnotherSeat: true },
      }),
    };
  };
  globalThis.crypto = { randomUUID: () => "unused" };
  await import(`../src/background.js?legacyoccupied=${Date.now()}`);
  const st = await globalThis.QS.background.status();

  expect(calls.map((c) => c.url.split("/").pop())).toEqual(["validate", "activate"]);
  expect(st.blocked).toBe(true);
  expect(st.blockedReason).toBe("slot-occupied");
  expect(st.cache).toBeNull();
  expect(stored.qsCache).toBeNull();
  expect(deriveState(st, Date.now()).state).toBe("license-limit");

  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});

test("background transition: activation network failure after not-activated cannot restore offline grace", async () => {
  const staleCheckedAt = Date.now() - 30 * 3600 * 1000;
  const stored = {
    qsKey: "QMP-LEGACY-NETWORK",
    qsInstance: "legacy-inst-3",
    qsCache: { valid: true, checkedAt: staleCheckedAt },
    qsLicenseDebug: null,
  };
  const calls = [];
  globalThis.chrome = makeBgChrome(stored);
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    if (calls.length === 1) {
      return { json: async () => ({ valid: false, code: "not-activated", error: "not-activated" }) };
    }
    throw new Error("activation unavailable");
  };
  globalThis.crypto = { randomUUID: () => "unused" };
  await import(`../src/background.js?legacynetwork=${Date.now()}`);
  const st = await globalThis.QS.background.status();

  expect(calls.map((c) => c.url.split("/").pop())).toEqual(["validate", "activate"]);
  expect(st.blocked).toBe(true);
  expect(st.blockedReason).toBe("not-activated");
  expect(st.cache).toBeNull();
  expect(stored.qsCache).toBeNull();
  expect(deriveState(st, Date.now()).state).toBe("unlicensed");

  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.crypto;
});
