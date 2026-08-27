// server/test/browser-slots-integration.test.js — Browser Slots Integration Slice.
//
// Scope: (a) production migration v5 "browser-family-slots" creates the exact
// frozen browser_slots table while keeping the legacy `instances` table and
// data unchanged; (b) real HTTP route wiring of the activation + read-only
// validation endpoints in server/index.js against a temp DB and an unused
// local port, with NO Stripe config / real secrets.
//
// Uses ONLY temp on-disk DBs and a child server on a free local port — never
// server/license.db, never production, never a commit.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { openDb, upsertLicense, generateKey } from "../db.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INDEX_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qmp-browser-slots-integration-"));
  const dbPath = join(dir, "test.db");
  try {
    fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reserve a free local TCP port. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ── Migration v5 ─────────────────────────────────────────────────────────────
test("migration v5 browser-family-slots creates the exact frozen browser_slots table, idempotent across reopen, legacy instances untouched", () => {
  withTempDb((dbPath) => {
    const first = openDb(dbPath);
    first.close();
    const db = openDb(dbPath);
    db.close();
    const reopened = openDb(dbPath);

    // Versions 1..7 applied exactly once, in order. This test still checks
    // the exact v5 browser-slot migration in its fixed ledger position.
    const applied = reopened
      .query(`SELECT version, name FROM schema_migrations ORDER BY version`)
      .all();
    expect(applied.length).toBe(7);
    expect(applied.map((m) => m.name)).toEqual([
      "license-billing-fields",
      "processed-stripe-events",
      "stripe-subscription-states",
      "durable-email-outbox",
      "browser-family-slots",
      "secure-recovery",
      "family-invite-codes",
    ]);
    expect(applied[4].version).toBe(5);
    expect(applied[4].name).toBe("browser-family-slots");
    expect(applied[5].version).toBe(6);
    expect(applied[5].name).toBe("secure-recovery");
    expect(applied[6].version).toBe(7);
    expect(applied[6].name).toBe("family-invite-codes");

    // Exact frozen table shape.
    const [tbl] = reopened
      .query(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name='browser_slots'`)
      .all();
    expect(tbl.name).toBe("browser_slots");
    const sql = tbl.sql;
    expect(sql).toContain("license_key TEXT NOT NULL");
    expect(sql).toContain("browser_family TEXT NOT NULL");
    expect(sql).toContain("instance_id TEXT NOT NULL");
    expect(sql).toContain("activated_at INTEGER NOT NULL");
    expect(sql).toContain("last_seen_at INTEGER NOT NULL");
    expect(sql).toContain("PRIMARY KEY (license_key, browser_family)");
    expect(sql).toContain("UNIQUE (instance_id)");

    // Legacy instances table survives untouched (routes no longer use it, but
    // we never delete/drop it and never backfill unknown browser families).
    const instances = reopened
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='instances'`)
      .all();
    expect(instances.length).toBe(1);

    reopened.close();
  });
});

// ── Real HTTP routes (activation + read-only validation) ─────────────────────
let child, baseUrl, httpDir, httpDbPath;
const KEY = generateKey();
const SUB = "sub_browser_integration";
const CHROME_INST = "chrome-inst-integration-1";
const EDGE_INST = "edge-inst-integration-1";
const KEY_EMPTY = generateKey(); // fresh license with no slots

afterAll(() => {
  if (child && child.pid) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  if (httpDir) rmSync(httpDir, { recursive: true, force: true });
});

beforeAll(async () => {
  const port = await getFreePort();
  httpDir = mkdtempSync(join(tmpdir(), "qmp-browser-http-"));
  httpDbPath = join(httpDir, "http.db");

  // Seed licenses via the DB helper (active, with billing fields set).
  const db = openDb(httpDbPath);
  const periodEnd = 2000000000;
  upsertLicense(db, { key: KEY, email: "test@example.com", customerId: "cus_it", subscriptionId: SUB, status: "active" });
  db.query(`UPDATE licenses SET expires_at = ?, current_period_end = ?, cancel_at_period_end = 0 WHERE key = ?`).run(periodEnd, periodEnd, KEY);
  upsertLicense(db, { key: KEY_EMPTY, email: "empty@example.com", customerId: "cus_empty", subscriptionId: "sub_empty_it", status: "active" });
  db.close();

  child = spawn(process.execPath, [INDEX_PATH], {
    env: {
      ...process.env,
      DB_PATH: httpDbPath,
      PORT: String(port),
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      BASE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  baseUrl = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) { up = true; break; }
    } catch {}
    await sleep(100);
  }
  if (!up) {
    // surface the server's startup error for diagnosis
    let err = "";
    child.stderr && child.stderr.on("data", (d) => { err += d; });
    throw new Error("server did not come up: " + err);
  }
});

async function postActivate(body) {
  const res = await fetch(`${baseUrl}/api/license/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
async function postValidate(body) {
  const res = await fetch(`${baseUrl}/api/license/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}
function slotsSnapshot() {
  const db = new Database(httpDbPath);
  try {
    return JSON.stringify(
      db.query(`SELECT license_key, browser_family, instance_id, activated_at, last_seen_at FROM browser_slots ORDER BY license_key, browser_family`).all()
    );
  } finally {
    db.close();
  }
}

test("real HTTP activation: Chrome binds a slot, returns frozen ok shape + billing fields, no raw data", async () => {
  const before = slotsSnapshot();
  const r = await postActivate({ license_key: KEY, instance_id: CHROME_INST, browser_family: "chrome" });
  expect(r.status).toBe(200);
  expect(r.json.valid).toBe(true);
  expect(r.json.activated).toBe(true);
  expect(r.json.code).toBe("ok");
  expect(r.json.browserFamily).toBe("chrome");
  expect(r.json.error).toBeNull();
  expect(r.json.expiresAt).toBeDefined();
  expect(r.json.current_period_end).toBe(2000000000);
  expect(r.json.cancel_at_period_end).toBe(false);
  // no raw key / instance / email / customer / subscription leaked
  const s = JSON.stringify(r.json);
  expect(s).not.toContain(KEY);
  expect(s).not.toContain(CHROME_INST);
  expect(s).not.toContain("test@example.com");
  expect(s).not.toContain("cus_it");
  expect(s).not.toContain(SUB);
  // a slot row was actually written
  expect(slotsSnapshot()).not.toBe(before);
});

test("real HTTP activation: same Chrome instance is idempotent (activated:false), still ok", async () => {
  const r = await postActivate({ license_key: KEY, instance_id: CHROME_INST, browser_family: "chrome" });
  expect(r.status).toBe(200);
  expect(r.json.valid).toBe(true);
  expect(r.json.activated).toBe(false);
  expect(r.json.code).toBe("ok");
});

test("real HTTP activation: Edge occupies a separate slot on the same license", async () => {
  const r = await postActivate({ license_key: KEY, instance_id: EDGE_INST, browser_family: "edge" });
  expect(r.status).toBe(200);
  expect(r.json.valid).toBe(true);
  expect(r.json.activated).toBe(true);
  expect(r.json.browserFamily).toBe("edge");
});

test("real HTTP activation: a second Chrome instance is 403 slot-occupied with both actions, no write", async () => {
  const before = slotsSnapshot();
  const r = await postActivate({ license_key: KEY, instance_id: "chrome-inst-OTHER", browser_family: "chrome" });
  expect(r.status).toBe(403);
  expect(r.json.valid).toBe(false);
  expect(r.json.code).toBe("slot-occupied");
  expect(r.json.browserFamily).toBe("chrome");
  expect(r.json.error).toBe("slot-occupied");
  expect(r.json.actions).toEqual({ manageInstallations: true, buyAnotherSeat: true });
  expect(slotsSnapshot()).toBe(before); // nothing written
});

test("real HTTP activation: unknown browser family is 400 family-undetermined, no write", async () => {
  const before = slotsSnapshot();
  const r = await postActivate({ license_key: KEY_EMPTY, instance_id: "inst-x", browser_family: "safari" });
  expect(r.status).toBe(400);
  expect(r.json.valid).toBe(false);
  expect(r.json.code).toBe("family-undetermined");
  expect(r.json.actions).toBeNull();
  expect(slotsSnapshot()).toBe(before);
});

test("real HTTP activation: missing fields are 400 invalid-input", async () => {
  const r = await postActivate({ license_key: KEY, instance_id: "x" }); // no browser_family
  expect(r.status).toBe(400);
  expect(r.json.valid).toBe(false);
  expect(r.json.code).toBe("invalid-input");
  expect(r.json.error).toBe("invalid-input");
});

test("real HTTP validation: empty slot is not-activated, reads nothing", async () => {
  const before = slotsSnapshot();
  const r = await postValidate({ license_key: KEY_EMPTY, instance_id: "inst-h", browser_family: "chrome" });
  expect(r.status).toBe(403);
  expect(r.json.valid).toBe(false);
  expect(r.json.code).toBe("not-activated");
  expect(r.json.error).toBe("not-activated");
  expect(slotsSnapshot()).toBe(before); // validation never writes
});

test("real HTTP validation: exact Chrome slot is valid, returns billing fields, NO activated field", async () => {
  const before = slotsSnapshot();
  const r = await postValidate({ license_key: KEY, instance_id: CHROME_INST, browser_family: "chrome" });
  expect(r.status).toBe(200);
  expect(r.json.valid).toBe(true);
  expect(r.json.code).toBe("ok");
  expect(r.json.browserFamily).toBe("chrome");
  expect(r.json.error).toBeNull();
  expect(r.json.expiresAt).toBeDefined();
  expect(r.json.current_period_end).toBe(2000000000);
  expect(r.json.cancel_at_period_end).toBe(false);
  expect(r.json).not.toHaveProperty("activated"); // validation has no activated field
  expect(slotsSnapshot()).toBe(before); // read-only: no write, no last_seen bump
});

test("real HTTP validation: mismatched instance is slot-mismatch, no write", async () => {
  const before = slotsSnapshot();
  const r = await postValidate({ license_key: KEY, instance_id: "chrome-inst-WRONG", browser_family: "chrome" });
  expect(r.status).toBe(403);
  expect(r.json.valid).toBe(false);
  expect(r.json.code).toBe("slot-mismatch");
  expect(r.json.error).toBe("slot-mismatch");
  expect(r.json.browserFamily).toBe("chrome");
  expect(slotsSnapshot()).toBe(before);
});

test("render-safe: neither activation nor validation responses leak key/instance/email/customer/subscription", async () => {
  const bodies = [];
  bodies.push((await postActivate({ license_key: KEY, instance_id: CHROME_INST, browser_family: "chrome" })).json);
  bodies.push((await postValidate({ license_key: KEY, instance_id: CHROME_INST, browser_family: "chrome" })).json);
  bodies.push((await postValidate({ license_key: KEY_EMPTY, instance_id: "h", browser_family: "chrome" })).json);
  for (const j of bodies) {
    const s = JSON.stringify(j);
    expect(s).not.toContain(KEY);
    expect(s).not.toContain(CHROME_INST);
    expect(s).not.toContain(EDGE_INST);
    expect(s).not.toContain("@example.com");
    expect(s).not.toContain("cus_");
    expect(s).not.toContain("sub_");
  }
});

test("legacy instances rows neither authorize nor get deleted; validation never writes browser_slots", async () => {
  // Seed a fresh license that has NO browser slot but DOES have a legacy
  // `instances` binding. The legacy row must NOT authorize the install.
  const legacyKey = generateKey();
  const legacyInst = "legacy-device-999";
  const seed = new Database(httpDbPath);
  try {
    seed.query(
      `INSERT INTO licenses (key, email, customer_id, subscription_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`
    ).run(legacyKey, "legacy@example.com", "cus_leg", "sub_legacy", Date.now(), Date.now());
    seed.query(`INSERT INTO instances (license_key, instance_id, activated_at) VALUES (?, ?, ?)`).run(legacyKey, legacyInst, Date.now());
  } finally {
    seed.close();
  }
  const before = slotsSnapshot();
  // The legacy row must NOT authorize this instance — no browser_slots binding exists.
  const r = await postValidate({ license_key: legacyKey, instance_id: legacyInst, browser_family: "chrome" });
  expect(r.status).toBe(403);
  expect(r.json.code).toBe("not-activated");

  // The legacy instances row is still present (never deleted by our routes).
  const check = new Database(httpDbPath);
  try {
    const rows = check.query(`SELECT * FROM instances WHERE license_key = ? AND instance_id = ?`).all(legacyKey, legacyInst);
    expect(rows.length).toBe(1);
  } finally {
    check.close();
  }
  expect(slotsSnapshot()).toBe(before); // validation wrote nothing
});

test("a canceled license invalidates existing slots (standalone), valid from outside", async () => {
  const updater = new Database(httpDbPath);
  updater.query(`UPDATE licenses SET status = 'canceled' WHERE key = ?`).run(KEY);
  updater.close();
  // Existing slots are now invalid: validation fails closed.
  const r = await postValidate({ license_key: KEY, instance_id: CHROME_INST, browser_family: "chrome" });
  expect(r.status).toBe(403);
  expect(r.json.valid).toBe(false);
  expect(r.json.code).toBe("license-canceled");
  // Another license unaffected.
  const e = await postValidate({ license_key: KEY_EMPTY, instance_id: "inst-h", browser_family: "chrome" });
  expect(e.json.code).toBe("not-activated");
});

test("a valid active cancellation-at-period-end license stays valid and returns its date/flag", async () => {
  const updater = new Database(httpDbPath);
  updater.query(`UPDATE licenses SET status = 'active', current_period_end = ?, cancel_at_period_end = 1 WHERE key = ?`).run(1900000000, KEY_EMPTY);
  updater.close();
  // Activate then validate KEY_EMPTY; it must remain valid with cancel flag set.
  const a = await postActivate({ license_key: KEY_EMPTY, instance_id: "inst-h", browser_family: "chrome" });
  expect(a.status).toBe(200);
  expect(a.json.valid).toBe(true);
  expect(a.json.cancel_at_period_end).toBe(true);
  expect(a.json.current_period_end).toBe(1900000000);
  const v = await postValidate({ license_key: KEY_EMPTY, instance_id: "inst-h", browser_family: "chrome" });
  expect(v.status).toBe(200);
  expect(v.json.valid).toBe(true);
  expect(v.json.cancel_at_period_end).toBe(true);
  expect(v.json.current_period_end).toBe(1900000000);
});
