// server/test/license.test.js — pure license-DB logic (bun:sqlite, :memory:)
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb, generateKey, upsertLicense, setSubscriptionStatus, activateInstance, licensesForEmail, issueKeys } from "../db.js";

let db;

beforeAll(() => {
  db = openDb(":memory:");
});

/** Run fn with a fresh temp on-disk DB path; always delete it in cleanup. */
function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qmp-migration-"));
  const dbPath = join(dir, "test.db");
  try {
    fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Create a v1-shape (pre-migration) file DB exactly as the original openDb built it. */
function createOldShapeDb(dbPath) {
  const raw = new Database(dbPath);
  raw.exec(`
    CREATE TABLE licenses (
      key TEXT PRIMARY KEY,
      email TEXT,
      customer_id TEXT,
      subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE instances (
      license_key TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      activated_at INTEGER NOT NULL,
      PRIMARY KEY (license_key, instance_id)
    );
  `);
  return raw;
}

test("generateKey produces QMP-XXXX-XXXX-XXXX-XXXX without ambiguous chars", () => {
  const key = generateKey();
  expect(/^QMP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(key)).toBe(true);
  expect(key).not.toMatch(/[0O1IL]/);
  const other = generateKey();
  expect(other).not.toBe(key);
});

test("activateInstance: unknown key rejected", () => {
  const r = activateInstance(db, "QMP-AAAA-BBBB-CCCC-DDDD", "inst-1", 3);
  expect(r.valid).toBe(false);
  expect(r.reason).toBe("unknown-key");
});

test("upsert + activate: valid key binds the instance", () => {
  const key = generateKey();
  upsertLicense(db, { key, email: "a@b.c", customerId: "cus_1", subscriptionId: "sub_1", status: "active" });
  const r = activateInstance(db, key, "inst-1", 3);
  expect(r.valid).toBe(true);
  expect(r.activated).toBe(true);
  // same instance again: still valid, not re-activated
  const r2 = activateInstance(db, key, "inst-1", 3);
  expect(r2.valid).toBe(true);
  expect(r2.activated).toBe(false);
});

test("instance limit: 4th device rejected at 3 max", () => {
  const key = generateKey();
  upsertLicense(db, { key, email: "a@b.c", customerId: "cus_2", subscriptionId: "sub_2", status: "active" });
  for (const i of ["d1", "d2", "d3"]) {
    expect(activateInstance(db, key, i, 3).valid).toBe(true);
  }
  expect(activateInstance(db, key, "d4", 3).valid).toBe(false);
  expect(activateInstance(db, key, "d4", 3).reason).toBe("instance-limit");
});

test("canceled subscription revokes the license", () => {
  const key = generateKey();
  upsertLicense(db, { key, email: "a@b.c", customerId: "cus_3", subscriptionId: "sub_3", status: "active" });
  expect(activateInstance(db, key, "inst-x", 3).valid).toBe(true);
  setSubscriptionStatus(db, "sub_3", "canceled");
  const r = activateInstance(db, key, "inst-x", 3);
  expect(r.valid).toBe(false);
  expect(r.reason).toBe("license-canceled");
});

test("upsertLicense is idempotent per subscription (same key kept)", () => {
  const key = generateKey();
  upsertLicense(db, { key, email: "a@b.c", customerId: "cus_4", subscriptionId: "sub_4", status: "active" });
  upsertLicense(db, { key: generateKey(), email: "a@b.c", customerId: "cus_4", subscriptionId: "sub_4", status: "active" });
  const rows = db.query(`SELECT COUNT(*) AS n FROM licenses WHERE subscription_id = 'sub_4'`).get();
  expect(rows.n).toBe(1);
});

test("licensesForEmail returns the customer's keys", () => {
  const key = generateKey();
  upsertLicense(db, { key, email: "buyer@example.com", customerId: "cus_5", subscriptionId: "sub_5", status: "active" });
  const keys = licensesForEmail(db, "BUYER@example.com");
  expect(keys.length).toBe(1);
  expect(keys[0].key).toBe(key);
  expect(keys[0].status).toBe("active");
});

test("issueKeys mints N unique active keys (admin path)", () => {
  const keys = issueKeys(db, "Admin@Example.com", 3);
  expect(keys.length).toBe(3);
  expect(new Set(keys).size).toBe(3);
  for (const k of keys) {
    expect(/^QMP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(k)).toBe(true);
    // usable immediately
    expect(activateInstance(db, k, "inst-admin-1", 3).valid).toBe(true);
  }
  // normalized email → findable via the portal lookup
  const found = licensesForEmail(db, "admin@example.com");
  expect(found.length).toBe(3);
});

test("replay with a different candidate returns the original persisted key and one row", () => {
  const key = generateKey();
  const first = upsertLicense(db, { key, email: "a@b.c", customerId: "cus_6", subscriptionId: "sub_6", status: "active" });
  expect(first).toBe(key);
  const replayKey = generateKey();
  const second = upsertLicense(db, { key: replayKey, email: "a@b.c", customerId: "cus_6", subscriptionId: "sub_6", status: "active" });
  expect(second).toBe(key);
  expect(second).not.toBe(replayKey);
  const rows = db.query(`SELECT COUNT(*) AS n FROM licenses WHERE subscription_id = 'sub_6'`).get();
  expect(rows.n).toBe(1);
  const persisted = db.query(`SELECT key FROM licenses WHERE subscription_id = 'sub_6'`).get();
  expect(persisted.key).toBe(key);
});

test("upsertLicense normalizes email in the DB layer", () => {
  const key = generateKey();
  upsertLicense(db, { key, email: "  Billing@Example.COM ", customerId: "cus_7", subscriptionId: "sub_7", status: "active" });
  const row = db.query(`SELECT email FROM licenses WHERE key = ?`).get(key);
  expect(row.email).toBe("billing@example.com");
  // portal lookup finds it via any casing
  const found = licensesForEmail(db, "BILLING@example.com");
  expect(found.length).toBe(1);
  expect(found[0].key).toBe(key);
});

test("migration adds the billing columns to an old-shape DB and preserves its license row", () => {
  withTempDb((dbPath) => {
    const raw = createOldShapeDb(dbPath);
    const oldKey = generateKey();
    raw.query(
      `INSERT INTO licenses (key, email, customer_id, subscription_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(oldKey, "old@example.com", "cus_old", "sub_old", "active", 1000, 1000);
    raw.close();

    const db = openDb(dbPath); // must migrate the old-shape file DB
    const cols = db.query(`PRAGMA table_info(licenses)`).all().map((c) => c.name);
    for (const col of ["source", "current_period_end", "cancel_at_period_end", "last_stripe_event_created"]) {
      expect(cols).toContain(col);
    }
    const row = db.query(`SELECT * FROM licenses WHERE key = ?`).get(oldKey);
    expect(row).not.toBeNull();
    expect(row.email).toBe("old@example.com");
    expect(row.subscription_id).toBe("sub_old");
    // new columns carry safe defaults
    expect(row.source).toBe("stripe_paid");
    expect(row.cancel_at_period_end).toBe(0);
    expect(row.current_period_end).toBeNull();
    expect(row.last_stripe_event_created).toBeNull();
    db.close();
  });
});

test("opening the migrated DB again is idempotent and records each migration once", () => {
  withTempDb((dbPath) => {
    const first = openDb(dbPath);
    const key = generateKey();
    first.query(
      `INSERT INTO licenses (key, email, customer_id, subscription_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(key, "keep@example.com", "cus_k", "sub_k", 1000, 1000);
    first.close();

    const db = openDb(dbPath); // reopen: migrations must not re-run
    const applied = db.query(`SELECT version, name FROM schema_migrations ORDER BY version`).all();
    expect(applied.length).toBe(7);
    expect(applied[0].version).toBe(1);
    expect(applied[0].name).toBe("license-billing-fields");
    expect(applied[1].version).toBe(2);
    expect(applied[1].name).toBe("processed-stripe-events");
    expect(applied[2].version).toBe(3);
    expect(applied[2].name).toBe("stripe-subscription-states");
    expect(applied[3].version).toBe(4);
    expect(applied[3].name).toBe("durable-email-outbox");
    expect(applied[4].version).toBe(5);
    expect(applied[4].name).toBe("browser-family-slots");
    expect(applied[5].version).toBe(6);
    expect(applied[5].name).toBe("secure-recovery");
    expect(applied[6].version).toBe(7);
    expect(applied[6].name).toBe("family-invite-codes");
    // each column exists exactly once
    const sourceCols = db.query(`PRAGMA table_info(licenses)`).all().filter((c) => c.name === "source");
    expect(sourceCols.length).toBe(1);
    // data survives the idempotent reopen
    const row = db.query(`SELECT key, email FROM licenses WHERE subscription_id = 'sub_k'`).get();
    expect(row.email).toBe("keep@example.com");
    db.close();
  });
});
