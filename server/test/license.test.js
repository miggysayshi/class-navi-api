// server/test/license.test.js — pure license-DB logic (bun:sqlite, :memory:)
import { test, expect, beforeAll } from "bun:test";
import { openDb, generateKey, upsertLicense, setSubscriptionStatus, activateInstance, licensesForEmail } from "../db.js";

let db;

beforeAll(() => {
  db = openDb(":memory:");
});

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
