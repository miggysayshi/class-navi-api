// server/test/subscription-state.test.js — Slice 1B-2a: persistent latest Stripe
// subscription state + monotonic license-state propagation. Uses ONLY :memory:
// or temp on-disk DBs — never server/license.db.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb, normalizeStripeSubscriptionStatus, recordStripeSubscriptionState, getStripeSubscriptionState, upsertLicense, generateKey, processStripeEvent } from "../db.js";

/** Run fn with a fresh temp on-disk DB path; always delete it in cleanup. */
function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qmp-sub-state-"));
  const dbPath = join(dir, "test.db");
  try {
    fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("migration v3 stripe-subscription-states exists once with exact table/column/default/PK shape after repeated opens", () => {
  withTempDb((dbPath) => {
    const first = openDb(dbPath);
    first.close();
    const db = openDb(dbPath);
    db.close();
    const reopened = openDb(dbPath);

    const applied = reopened
      .query(`SELECT version, name FROM schema_migrations ORDER BY version`)
      .all();
    expect(applied.length).toBe(7);
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

    // Frozen column shape, in order.
    const cols = reopened.query(`PRAGMA table_info(stripe_subscription_states)`).all();
    expect(cols.map((c) => c.name)).toEqual([
      "subscription_id",
      "status",
      "current_period_end",
      "cancel_at_period_end",
      "last_event_created",
      "updated_at",
    ]);
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    // PK on subscription_id alone
    expect(cols.filter((c) => c.pk === 1).map((c) => c.name)).toEqual(["subscription_id"]);
    expect(cols.filter((c) => c.pk !== 0 && c.pk !== 1).length).toBe(0);
    // NOT NULL constraints
    expect(byName.subscription_id.notnull).toBe(0); // PK implies not-null
    expect(byName.status.notnull).toBe(1);
    expect(byName.current_period_end.notnull).toBe(0);
    expect(byName.cancel_at_period_end.notnull).toBe(1);
    expect(byName.last_event_created.notnull).toBe(1);
    expect(byName.updated_at.notnull).toBe(1);
    // DEFAULT 0 on cancel_at_period_end only
    expect(String(byName.cancel_at_period_end.dflt_value)).toBe("0");
    expect(byName.status.dflt_value).toBeNull();
    expect(byName.last_event_created.dflt_value).toBeNull();
    expect(byName.updated_at.dflt_value).toBeNull();

    // Other slices' tables must NOT exist yet (email tables are v4, added by
    // durable-email-outbox; browser_slots is now created by migration v5
    // browser-family-slots; the rest belong to later slices).
    const tables = reopened
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((t) => t.name);
    for (const forbidden of ["seats"]) {
      expect(tables).not.toContain(forbidden);
    }
    // browser_slots exists (v5) with the exact frozen shape.
    expect(tables).toContain("browser_slots");
    expect(tables).toContain("invite_codes");
    reopened.close();
  });
});

test("normalizeStripeSubscriptionStatus maps the full matrix and fails closed on unknown/missing", () => {
  expect(normalizeStripeSubscriptionStatus("active")).toBe("active");
  expect(normalizeStripeSubscriptionStatus("trialing")).toBe("trialing");
  expect(normalizeStripeSubscriptionStatus("past_due")).toBe("past_due");
  expect(normalizeStripeSubscriptionStatus("unpaid")).toBe("past_due");
  expect(normalizeStripeSubscriptionStatus("canceled")).toBe("canceled");
  expect(normalizeStripeSubscriptionStatus("incomplete_expired")).toBe("canceled");
  expect(normalizeStripeSubscriptionStatus("incomplete")).toBe("incomplete");
  expect(normalizeStripeSubscriptionStatus("paused")).toBe("paused");
  // Unknown or missing values fail closed to canceled (never a fake grant).
  expect(normalizeStripeSubscriptionStatus("future_unknown_state")).toBe("canceled");
  expect(normalizeStripeSubscriptionStatus("")).toBe("canceled");
  expect(normalizeStripeSubscriptionStatus(undefined)).toBe("canceled");
  expect(normalizeStripeSubscriptionStatus(null)).toBe("canceled");
});

test("first state event stores and returns normalized state; no license is required", () => {
  const db = openDb(":memory:");
  const result = recordStripeSubscriptionState(db, {
    subscriptionId: "sub_first",
    status: "active",
    eventCreated: 1700000100,
  });
  expect(result.applied).toBe(true);
  expect(result.licenseUpdated).toBe(false);
  expect(result.state).toEqual({
    subscriptionId: "sub_first",
    status: "active",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: 0,
    lastEventCreated: 1700000100,
  });
  // Persisted, and readable via the getter with the same camelCase shape.
  expect(getStripeSubscriptionState(db, "sub_first")).toEqual({
    subscriptionId: "sub_first",
    status: "active",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: 0,
    lastEventCreated: 1700000100,
  });
  // Unknown subscription → null, not a fake row.
  expect(getStripeSubscriptionState(db, "sub_absent")).toBeNull();
  db.close();
});

test("state received before a license persists; a newer event later updates that same key and all billing fields", () => {
  const db = openDb(":memory:");
  const key = generateKey();

  // Subscription event arrives BEFORE the license row exists (out-of-order delivery).
  const early = recordStripeSubscriptionState(db, {
    subscriptionId: "sub_late",
    status: "trialing",
    currentPeriodEnd: 1700000900,
    cancelAtPeriodEnd: false,
    eventCreated: 1700000101,
  });
  expect(early.applied).toBe(true);
  expect(early.licenseUpdated).toBe(false);
  expect(getStripeSubscriptionState(db, "sub_late").status).toBe("trialing");
  // No license exists yet → nothing propagated.
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses WHERE subscription_id = 'sub_late'`).get().n).toBe(0);

  // Checkout completes: the license row now appears with the SAME subscription_id.
  upsertLicense(db, { key, email: "buyer@x.com", customerId: "cus_late", subscriptionId: "sub_late", status: "active" });

  // A newer subscription event propagates to the existing license.
  const later = recordStripeSubscriptionState(db, {
    subscriptionId: "sub_late",
    status: "active",
    currentPeriodEnd: 1700999999,
    cancelAtPeriodEnd: false,
    eventCreated: 1700000200,
  });
  expect(later.applied).toBe(true);
  expect(later.licenseUpdated).toBe(true);

  const lic = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_late'`).get();
  expect(lic.key).toBe(key); // key untouched
  expect(lic.email).toBe("buyer@x.com"); // email untouched
  expect(lic.customer_id).toBe("cus_late"); // customer untouched
  expect(lic.subscription_id).toBe("sub_late"); // subscription untouched
  expect(lic.source).toBe("stripe_paid"); // source untouched
  expect(lic.status).toBe("active"); // status propagated
  expect(lic.current_period_end).toBe(1700999999); // period end propagated
  expect(lic.cancel_at_period_end).toBe(0); // flag propagated
  expect(lic.last_stripe_event_created).toBe(1700000200); // watermark propagated
  db.close();
});

test("a newer canceled state applied to the license cannot be overwritten by an older or equal active event", () => {
  const db = openDb(":memory:");
  const key = generateKey();
  upsertLicense(db, { key, email: "stale@x.com", customerId: "cus_stale", subscriptionId: "sub_stale", status: "active" });

  const cancel = recordStripeSubscriptionState(db, {
    subscriptionId: "sub_stale",
    status: "canceled",
    eventCreated: 200,
  });
  expect(cancel.applied).toBe(true);
  expect(cancel.licenseUpdated).toBe(true);
  let lic = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_stale'`).get();
  expect(lic.status).toBe("canceled");
  expect(lic.last_stripe_event_created).toBe(200);

  // OLDER active event (100 < 200) is stale: state untouched, license untouched.
  const older = recordStripeSubscriptionState(db, {
    subscriptionId: "sub_stale",
    status: "active",
    eventCreated: 100,
  });
  expect(older.applied).toBe(false);
  expect(older.licenseUpdated).toBe(false);
  expect(older.state.status).toBe("canceled");

  // EQUAL eventCreated is stale too (strictly greater required).
  const equal = recordStripeSubscriptionState(db, {
    subscriptionId: "sub_stale",
    status: "active",
    eventCreated: 200,
  });
  expect(equal.applied).toBe(false);
  expect(equal.licenseUpdated).toBe(false);
  expect(equal.state.status).toBe("canceled");

  lic = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_stale'`).get();
  expect(lic.status).toBe("canceled");
  expect(lic.last_stripe_event_created).toBe(200);
  expect(lic.current_period_end).toBeNull();
  db.close();
});

test("cancel_at_period_end and current_period_end are stored and propagated; a newer resume event clears the flag without replacing the key", () => {
  const db = openDb(":memory:");
  const key = generateKey();
  upsertLicense(db, { key, email: "resume@x.com", customerId: "cus_resume", subscriptionId: "sub_resume", status: "active" });

  // Cancellation requested at period end: license stays active with the flag set.
  const cancelling = recordStripeSubscriptionState(db, {
    subscriptionId: "sub_resume",
    status: "active",
    currentPeriodEnd: 1701000000,
    cancelAtPeriodEnd: true,
    eventCreated: 300,
  });
  expect(cancelling.applied).toBe(true);
  expect(cancelling.licenseUpdated).toBe(true);
  expect(cancelling.state.cancelAtPeriodEnd).toBe(1);
  expect(cancelling.state.currentPeriodEnd).toBe(1701000000);
  let lic = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_resume'`).get();
  expect(lic.status).toBe("active");
  expect(lic.current_period_end).toBe(1701000000);
  expect(lic.cancel_at_period_end).toBe(1);
  expect(lic.key).toBe(key);

  // Newer resume event clears the flag without replacing the key or identity.
  const resumed = recordStripeSubscriptionState(db, {
    subscriptionId: "sub_resume",
    status: "active",
    currentPeriodEnd: 1702000000,
    cancelAtPeriodEnd: false,
    eventCreated: 400,
  });
  expect(resumed.applied).toBe(true);
  expect(resumed.licenseUpdated).toBe(true);
  expect(resumed.state.cancelAtPeriodEnd).toBe(0);
  lic = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_resume'`).get();
  expect(lic.cancel_at_period_end).toBe(0);
  expect(lic.current_period_end).toBe(1702000000);
  expect(lic.key).toBe(key); // key never replaced by resume
  expect(lic.subscription_id).toBe("sub_resume");
  db.close();
});

test("two different subscriptions are isolated from each other", () => {
  const db = openDb(":memory:");
  const keyA = generateKey();
  const keyB = generateKey();
  upsertLicense(db, { key: keyA, email: "a@x.com", customerId: "cus_a", subscriptionId: "sub_iso_a", status: "active" });
  upsertLicense(db, { key: keyB, email: "b@x.com", customerId: "cus_b", subscriptionId: "sub_iso_b", status: "active" });

  recordStripeSubscriptionState(db, { subscriptionId: "sub_iso_a", status: "active", eventCreated: 500 });
  const resB = recordStripeSubscriptionState(db, { subscriptionId: "sub_iso_b", status: "canceled", eventCreated: 501 });

  expect(resB.applied).toBe(true);
  expect(resB.licenseUpdated).toBe(true);

  // Each subscription keeps its own state.
  expect(getStripeSubscriptionState(db, "sub_iso_a").status).toBe("active");
  expect(getStripeSubscriptionState(db, "sub_iso_b").status).toBe("canceled");

  // Each license reflects only its own subscription's state.
  const licA = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_iso_a'`).get();
  expect(licA.status).toBe("active");
  expect(licA.last_stripe_event_created).toBe(500);
  expect(licA.key).toBe(keyA);
  const licB = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_iso_b'`).get();
  expect(licB.status).toBe("canceled");
  expect(licB.last_stripe_event_created).toBe(501);
  expect(licB.key).toBe(keyB);
  // Canceled B did not touch A.
  expect(db.query(`SELECT COUNT(*) AS n FROM stripe_subscription_states`).get().n).toBe(2);
  db.close();
});

test("invalid input throws TypeError before any subscription-state or license mutation", () => {
  const db = openDb(":memory:");
  const key = generateKey();
  upsertLicense(db, { key, email: "invalid@x.com", customerId: "cus_invalid", subscriptionId: "sub_invalid", status: "active" });
  const licBefore = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_invalid'`).get();
  const statesBefore = db.query(`SELECT COUNT(*) AS n FROM stripe_subscription_states`).get().n;

  const ok = { subscriptionId: "sub_invalid", status: "active", eventCreated: 600 };
  const cases = [
    ["missing subscriptionId", { ...ok, subscriptionId: undefined }],
    ["blank subscriptionId", { ...ok, subscriptionId: "   " }],
    ["missing eventCreated", { ...ok, eventCreated: undefined }],
    ["non-finite eventCreated", { ...ok, eventCreated: NaN }],
    ["non-numeric eventCreated", { ...ok, eventCreated: "600" }],
    ["non-numeric currentPeriodEnd", { ...ok, currentPeriodEnd: "soon" }],
    ["non-finite currentPeriodEnd", { ...ok, currentPeriodEnd: Infinity }],
  ];
  const failures = [];
  for (const [label, input] of cases) {
    try {
      recordStripeSubscriptionState(db, input);
      failures.push(`${label}: did not throw`);
    } catch (err) {
      if (!(err instanceof TypeError)) failures.push(`${label}: threw non-TypeError`);
    }
  }
  expect(failures).toEqual([]);

  // No state row was created, and the license was not mutated by any invalid call.
  expect(db.query(`SELECT COUNT(*) AS n FROM stripe_subscription_states`).get().n).toBe(statesBefore);
  const licAfter = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_invalid'`).get();
  expect(licAfter.status).toBe(licBefore.status);
  expect(licAfter.current_period_end).toBe(licBefore.current_period_end);
  expect(licAfter.cancel_at_period_end).toBe(licBefore.cancel_at_period_end);
  expect(licAfter.last_stripe_event_created).toBe(licBefore.last_stripe_event_created);
  expect(licAfter.updated_at).toBe(licBefore.updated_at);

  // The getter validates its argument too.
  expect(() => getStripeSubscriptionState(db, "")).toThrow(TypeError);
  expect(() => getStripeSubscriptionState(db, undefined)).toThrow(TypeError);
  expect(() => getStripeSubscriptionState(db, "  ")).toThrow(TypeError);
  db.close();
});

test("recordStripeSubscriptionState is safe inside processStripeEvent: a later throw rolls back state and license together", () => {
  const db = openDb(":memory:");
  const key = generateKey();
  upsertLicense(db, { key, email: "txn@x.com", customerId: "cus_txn", subscriptionId: "sub_txn", status: "active" });

  const event = { id: "evt_1b2a_1", type: "customer.subscription.updated", created: 1700000300 };
  expect(() =>
    processStripeEvent(db, event, (d) => {
      recordStripeSubscriptionState(d, {
        subscriptionId: "sub_txn",
        status: "canceled",
        eventCreated: 700,
      });
      // A later statement inside the same synchronous apply throws → the whole
      // apply (state write + license write + ledger) must roll back atomically.
      d.query(`INSERT INTO processed_stripe_events_should_not_exist (x) VALUES (1)`).run();
    })
  ).toThrow();

  // Full rollback: no state row, no license mutation, no ledger row.
  expect(db.query(`SELECT COUNT(*) AS n FROM stripe_subscription_states`).get().n).toBe(0);
  const lic = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_txn'`).get();
  expect(lic.status).toBe("active");
  expect(lic.current_period_end).toBeNull();
  expect(lic.cancel_at_period_end).toBe(0);
  expect(lic.last_stripe_event_created).toBeNull();
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(0);

  // The same event can be retried cleanly after the rollback.
  const retry = processStripeEvent(db, event, (d) =>
    recordStripeSubscriptionState(d, {
      subscriptionId: "sub_txn",
      status: "canceled",
      eventCreated: 700,
    })
  );
  expect(retry.processed).toBe(true);
  expect(retry.result.applied).toBe(true);
  expect(retry.result.licenseUpdated).toBe(true);
  // State + license + ledger now all committed together.
  expect(db.query(`SELECT COUNT(*) AS n FROM stripe_subscription_states`).get().n).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(1);
  const committed = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_txn'`).get();
  expect(committed.status).toBe("canceled");
  expect(committed.last_stripe_event_created).toBe(700);
  db.close();
});