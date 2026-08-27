// server/test/browser-slots.test.js — Slice 4A browser-family slot service.
//
// Frozen contract for one Chrome + one Edge slot per license. This test file is
// module-only: it never touches db.js migrations or index.js routes.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Database } from "bun:sqlite";
import {
  createBrowserSlotsSchema,
  activateBrowserSlot,
  validateBrowserSlot,
  resetBrowserSlots,
} from "../browser-slots.js";

const execFileAsync = promisify(execFile);
const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Minimal licenses table so the slot service has rows to check (module-only). */
function createLicensesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      key TEXT PRIMARY KEY,
      email TEXT,
      customer_id TEXT,
      subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function seedLicense(db, key, status = "active") {
  const now = Date.now();
  db.query(`INSERT INTO licenses (key, status, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    key, status, now, now
  );
}

function allSlots(db) {
  return db.query(`SELECT license_key, browser_family, instance_id, activated_at, last_seen_at FROM browser_slots ORDER BY license_key, browser_family`).all();
}

function withDb(fn) {
  const db = new Database(":memory:");
  createLicensesTable(db);
  createBrowserSlotsSchema(db);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

const K1 = "QMP-SLOT-TEST-AAAA";
const K2 = "QMP-SLOT-TEST-BBBB";

beforeAll(() => {
  // Ensure the module actually parses/imports before tests run.
  expect(typeof createBrowserSlotsSchema).toBe("function");
  expect(typeof activateBrowserSlot).toBe("function");
  expect(typeof validateBrowserSlot).toBe("function");
  expect(typeof resetBrowserSlots).toBe("function");
});

// ---------------------------------------------------------------- exact schema
test("createBrowserSlotsSchema creates exactly the frozen browser_slots table", () => {
  const db = new Database(":memory:");
  try {
    createBrowserSlotsSchema(db);
    const tables = db
      .query(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all();
    expect(tables.length).toBe(1);
    expect(tables[0].name).toBe("browser_slots");
    const sql = tables[0].sql;
    expect(sql).toContain("license_key TEXT NOT NULL");
    expect(sql).toContain("browser_family TEXT NOT NULL");
    expect(sql).toContain("instance_id TEXT NOT NULL");
    expect(sql).toContain("activated_at INTEGER NOT NULL");
    expect(sql).toContain("last_seen_at INTEGER NOT NULL");
    expect(sql).toContain("PRIMARY KEY (license_key, browser_family)");
    expect(sql).toContain("UNIQUE (instance_id)");
  } finally {
    db.close();
  }
});

test("createBrowserSlotsSchema is idempotent and creates no migrations", () => {
  const db = new Database(":memory:");
  try {
    createBrowserSlotsSchema(db);
    // No schema_migrations table may be created (we are module-only).
    const mig = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`).all();
    expect(mig.length).toBe(0);
    createBrowserSlotsSchema(db); // second call must not throw
    const tables = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all();
    expect(tables.length).toBe(1);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------- activation
test("Chrome activation is idempotent and refreshes last_seen_at only", () => {
  withDb((db) => {
    seedLicense(db, K1, "active");
    const first = activateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "chrome-inst-1" }, { now: 100 });
    expect(first).toEqual({ valid: true, activated: true, code: "ok", browserFamily: "chrome" });
    const second = activateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "chrome-inst-1" }, { now: 200 });
    expect(second).toEqual({ valid: true, activated: false, code: "ok", browserFamily: "chrome" });
    const [row] = allSlots(db);
    expect(row.instance_id).toBe("chrome-inst-1");
    expect(row.activated_at).toBe(100); // activated_at frozen at first claim
    expect(row.last_seen_at).toBe(200); // last_seen_at refreshed
  });
});

test("Edge occupies a separate slot from Chrome on the same license", () => {
  withDb((db) => {
    seedLicense(db, K1, "active");
    const c = activateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "chrome-inst-1" }, { now: 1 });
    expect(c.valid).toBe(true);
    const e = activateBrowserSlot(db, { licenseKey: K1, browserFamily: "edge", instanceId: "edge-inst-1" }, { now: 2 });
    expect(e).toEqual({ valid: true, activated: true, code: "ok", browserFamily: "edge" });
    const rows = allSlots(db);
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.browser_family === "chrome" && r.instance_id === "chrome-inst-1")).toBe(true);
    expect(rows.some((r) => r.browser_family === "edge" && r.instance_id === "edge-inst-1")).toBe(true);
  });
});

test("second Chrome instance for a family is slot-occupied with both actions, no write", () => {
  withDb((db) => {
    seedLicense(db, K1, "active");
    activateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "chrome-inst-1" }, { now: 1 });
    const r = activateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "chrome-inst-2" }, { now: 2 });
    expect(r.valid).toBe(false);
    expect(r.code).toBe("slot-occupied");
    expect(r.browserFamily).toBe("chrome");
    expect(r.actions).toEqual({ manageInstallations: true, buyAnotherSeat: true });
    // No raw key/instance leaked and no row written for the contender.
    expect(r.licenseKey).toBeUndefined();
    expect(r.instanceId).toBeUndefined();
    const rows = allSlots(db);
    expect(rows.length).toBe(1);
    expect(rows[0].instance_id).toBe("chrome-inst-1");
  });
});

test("unique instance conflict on another family is slot-occupied with both actions, fails closed", () => {
  withDb((db) => {
    seedLicense(db, K1, "active");
    activateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "shared-inst" }, { now: 1 });
    // Same instance tries to occupy the Edge slot -> elsewhere/UNIQUE(instance_id) clash.
    const r = activateBrowserSlot(db, { licenseKey: K1, browserFamily: "edge", instanceId: "shared-inst" }, { now: 2 });
    expect(r.valid).toBe(false);
    expect(r.code).toBe("slot-occupied");
    expect(r.browserFamily).toBe("edge");
    expect(r.actions).toEqual({ manageInstallations: true, buyAnotherSeat: true });
    // No raw key/instance leaked.
    expect(r.licenseKey).toBeUndefined();
    expect(r.instanceId).toBeUndefined();
    // No replacement / no extra row; the original binding survives untouched.
    const rows = allSlots(db);
    expect(rows.length).toBe(1);
    expect(rows[0].license_key).toBe(K1);
    expect(rows[0].browser_family).toBe("chrome");
    expect(rows[0].instance_id).toBe("shared-inst");
  });
});

test("unique instance conflict on another license is slot-occupied with both actions, fails closed", () => {
  withDb((db) => {
    seedLicense(db, K1, "active");
    seedLicense(db, K2, "active");
    activateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "shared-inst" }, { now: 1 });
    // Same instance tries to occupy a slot under a DIFFERENT license -> elsewhere clash.
    const r = activateBrowserSlot(db, { licenseKey: K2, browserFamily: "chrome", instanceId: "shared-inst" }, { now: 2 });
    expect(r.valid).toBe(false);
    expect(r.code).toBe("slot-occupied");
    expect(r.browserFamily).toBe("chrome");
    expect(r.actions).toEqual({ manageInstallations: true, buyAnotherSeat: true });
    // No write under K2 and no replacement of K1's binding.
    const rows = allSlots(db);
    expect(rows.length).toBe(1);
    expect(rows[0].license_key).toBe(K1);
    expect(rows[0].browser_family).toBe("chrome");
    expect(rows[0].instance_id).toBe("shared-inst");
  });
});

test("activation: unknown key and all blocked statuses are rejected without writes", () => {
  withDb((db) => {
    const unknown = activateBrowserSlot(db, { licenseKey: "QMP-NOPE-NOPE-0000", browserFamily: "chrome", instanceId: "x" });
    expect(unknown.valid).toBe(false);
    expect(unknown.code).toBe("unknown-key");

    const blocked = ["past_due", "canceled", "incomplete", "paused", "incomplete_expired"];
    for (const st of blocked) {
      const key = `QMP-BLOCK-${st}`;
      seedLicense(db, key, st);
      const r = activateBrowserSlot(db, { licenseKey: key, browserFamily: "chrome", instanceId: "i" });
      expect(r.valid).toBe(false);
      expect(r.code).toBe(`license-${st}`);
    }
    expect(allSlots(db).length).toBe(0);
  });
});

test("activation: blank ids are invalid-input and unknown family is family-undetermined, never writes", () => {
  withDb((db) => {
    seedLicense(db, K1, "active");
    const blankInst = activateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "   " });
    expect(blankInst).toEqual({ valid: false, code: "invalid-input", browserFamily: null, actions: null });
    const blankKey = activateBrowserSlot(db, { licenseKey: "", browserFamily: "chrome", instanceId: "abc" });
    expect(blankKey.code).toBe("invalid-input");
    const fam = activateBrowserSlot(db, { licenseKey: K1, browserFamily: "safari", instanceId: "abc" });
    expect(fam).toEqual({ valid: false, code: "family-undetermined", browserFamily: null, actions: null });
    expect(allSlots(db).length).toBe(0);
  });
});

// ---------------------------------------------------------------- validation
test("validation is strictly read-only (before/after snapshot identical, no last_seen_at write)", () => {
  withDb((db) => {
    seedLicense(db, K1, "active");
    activateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "chrome-inst-1" }, { now: 1 });
    const before = JSON.stringify(allSlots(db));

    // Valid slot, not-activated slot, and mismatch validate against the SAME db.
    expect(validateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "chrome-inst-1" }, { now: 999 }))
      .toEqual({ valid: true, code: "ok", browserFamily: "chrome" });
    expect(validateBrowserSlot(db, { licenseKey: K1, browserFamily: "edge", instanceId: "edge-inst-1" }, { now: 999 }))
      .toEqual({ valid: false, code: "not-activated", browserFamily: "edge", actions: null });
    expect(validateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "other-inst" }, { now: 999 }))
      .toEqual({ valid: false, code: "slot-mismatch", browserFamily: "chrome", actions: null });

    const after = JSON.stringify(allSlots(db));
    expect(after).toBe(before); // no insert, no last_seen_at update despite now=999
    expect(JSON.parse(after).length).toBe(1);
  });
});

test("validation: unknown key, blocked statuses, unknown family", () => {
  withDb((db) => {
    expect(validateBrowserSlot(db, { licenseKey: "QMP-NOPE-NOPE-0000", browserFamily: "chrome", instanceId: "x" }).code).toBe("unknown-key");
    const blocked = ["past_due", "canceled", "incomplete", "paused"];
    for (const st of blocked) {
      const key = `QMP-VBLOCK-${st}`;
      seedLicense(db, key, st);
      const r = validateBrowserSlot(db, { licenseKey: key, browserFamily: "chrome", instanceId: "i" });
      expect(r.valid).toBe(false);
      expect(r.code).toBe(`license-${st}`);
      expect(r.actions).toBeNull();
    }
    const fam = validateBrowserSlot(db, { licenseKey: K1, browserFamily: "safari", instanceId: "i" });
    expect(fam).toEqual({ valid: false, code: "family-undetermined", browserFamily: null, actions: null });
    expect(allSlots(db).length).toBe(0);
  });
});

// ---------------------------------------------------------------- reset
test("Chrome reset removes only the Chrome slot, leaving Edge intact", () => {
  withDb((db) => {
    seedLicense(db, K1, "active");
    activateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "chrome-inst-1" });
    activateBrowserSlot(db, { licenseKey: K1, browserFamily: "edge", instanceId: "edge-inst-1" });
    const r = resetBrowserSlots(db, { licenseKey: K1, browserFamily: "chrome" });
    expect(r.code).toBe("ok");
    expect(r.removed).toBe(1);
    const rows = allSlots(db);
    expect(rows.length).toBe(1);
    expect(rows[0].browser_family).toBe("edge");
    expect(rows[0].instance_id).toBe("edge-inst-1");
  });
});

test("all reset removes both slots for that license only", () => {
  withDb((db) => {
    seedLicense(db, K1, "active");
    seedLicense(db, K2, "active");
    for (const fam of ["chrome", "edge"]) {
      activateBrowserSlot(db, { licenseKey: K1, browserFamily: fam, instanceId: `k1-${fam}` });
      activateBrowserSlot(db, { licenseKey: K2, browserFamily: fam, instanceId: `k2-${fam}` });
    }
    const r = resetBrowserSlots(db, { licenseKey: K1, browserFamily: "all" });
    expect(r.code).toBe("ok");
    expect(r.removed).toBe(2);
    // K2 untouched, K1 fully cleared.
    const rows = allSlots(db);
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.license_key === K2)).toBe(true);
  });
});

test("reset: unknown family or blank key fails without writing", () => {
  withDb((db) => {
    seedLicense(db, K1, "active");
    activateBrowserSlot(db, { licenseKey: K1, browserFamily: "chrome", instanceId: "c" });
    const bad = resetBrowserSlots(db, { licenseKey: K1, browserFamily: "safari" });
    expect(bad.code).toBe("family-undetermined");
    expect(bad.removed).toBe(0);
    const blur = resetBrowserSlots(db, { licenseKey: "  ", browserFamily: "all" });
    expect(blur.code).toBe("invalid-input");
    expect(blur.removed).toBe(0);
    expect(allSlots(db).length).toBe(1); // untouched
  });
});

// ---------------------------------------------------------------- concurrency
test("race: two independent connections contend and exactly one wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qmp-slots-race-"));
  const dbPath = join(dir, "race.db");
  try {
    // Seed the shared file DB (licenses) and close so two processes can contend.
    const setup = new Database(dbPath);
    setup.exec("PRAGMA busy_timeout = 5000");
    createLicensesTable(setup);
    seedLicense(setup, K1, "active");
    setup.close();

    const child = `
import { Database } from "bun:sqlite";
import { createBrowserSlotsSchema, activateBrowserSlot } from ${JSON.stringify("./browser-slots.js")};
try {
  const db = new Database(process.env.SLOT_DB);
  db.exec("PRAGMA busy_timeout = 5000");
  createBrowserSlotsSchema(db);
  const r = activateBrowserSlot(db, { licenseKey: process.env.SLOT_KEY, browserFamily: "chrome", instanceId: process.env.SLOT_INST });
  console.log(JSON.stringify(r));
  db.close();
} catch (e) {
  console.log(JSON.stringify({ ERR: String((e && e.stack) || e) }));
}
`;
    const env = { ...process.env, SLOT_DB: dbPath, SLOT_KEY: K1 };
    const [a, b] = await Promise.all([
      execFileAsync(process.execPath, ["-e", child], { env: { ...env, SLOT_INST: "race-a" }, cwd: SERVER_DIR }),
      execFileAsync(process.execPath, ["-e", child], { env: { ...env, SLOT_INST: "race-b" }, cwd: SERVER_DIR }),
    ]);

    const results = [a.stdout, b.stdout].map((o) => {
      const parsed = JSON.parse(o.trim());
      if (parsed.ERR) throw new Error(`child failed: ${parsed.ERR}`);
      return parsed;
    });
    const winners = results.filter((r) => r.valid === true && r.activated === true).length;
    const losers = results.filter((r) => r.valid === false && r.code === "slot-occupied").length;
    expect(winners).toBe(1);
    expect(winners + losers).toBe(2);
    // Every concurrent loser must still carry the frozen slot-occupied actions
    // (family-held, elsewhere, or UNIQUE-insert catch all share the same CTA).
    for (const r of results) {
      if (r.valid === false && r.code === "slot-occupied") {
        expect(r.actions).toEqual({ manageInstallations: true, buyAnotherSeat: true });
      }
    }

    const check = new Database(dbPath);
    check.exec("PRAGMA busy_timeout = 5000");
    const rows = check.query(`SELECT instance_id FROM browser_slots`).all();
    expect(rows.length).toBe(1);
    expect(["race-a", "race-b"]).toContain(rows[0].instance_id);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
