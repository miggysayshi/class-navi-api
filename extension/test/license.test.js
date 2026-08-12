// test/license.test.js — pure license-status logic (Quick Mark Pro)
import { test, expect } from "bun:test";
await import("../src/license.js");
const { deriveState, graceDays, fmtDate, GRACE_MS } = globalThis.QS.license;

const NOW = Date.UTC(2026, 6, 1, 12, 0, 0); // 2026-07-01 12:00 UTC

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

test("deriveState: debug override wins (on → active, off → unlicensed)", () => {
  expect(deriveState({ key: false, debug: "on" }, NOW).state).toBe("active");
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
  // harness: a fake window whose postMessage feeds the module's own listener
  let handler = null;
  const inbox = [];
  const fakeWindow = {
    addEventListener: (type, fn) => {
      if (type === "message") handler = fn;
    },
    postMessage: (msg) => {
      inbox.push(msg);
      // simulate same-window delivery: the listener sees its own messages
      if (handler) handler({ data: msg });
    },
  };
  globalThis.window = fakeWindow;
  // re-evaluate the module with the fake window in place (fresh listener)
  const fresh = await import(`../src/license.js?selfmatch=${Date.now()}`);
  const lic = fresh && fresh.QS ? fresh.QS.license : globalThis.QS.license;
  const p = lic.getStatus(true); // force → skips cache → bridge request
  await new Promise((r) => setTimeout(r, 0));
  // the REQUEST message was delivered to the module's own listener — with
  // the type gate it must NOT resolve the pending entry
  expect(inbox.length).toBe(1);
  expect(inbox[0].type).toBe("qs:license-status-request");
  let settled = false;
  p.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 10));
  expect(settled).toBe(false); // NOT resolved by its own request
  // now deliver the real response
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
