// server/test/stripe-events.test.js — Slice 1B-1: migration startup hardening +
// atomic processed-Stripe-event ledger. Uses ONLY :memory: or temp on-disk DBs —
// never server/license.db.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb, migrate, processStripeEvent } from "../db.js";

/** Run fn with a fresh temp on-disk DB path; always delete it in cleanup. */
function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qmp-stripe-events-"));
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

test("openDb sets PRAGMA busy_timeout to 5000 before schema setup", () => {
  const db = openDb(":memory:");
  const row = db.query("PRAGMA busy_timeout").get();
  expect(row.timeout ?? row.busy_timeout).toBe(5000);
  db.close();
});

test("migration v2 processed-stripe-events is applied exactly once across repeated opens", () => {
  withTempDb((dbPath) => {
    const raw = createOldShapeDb(dbPath);
    raw.close();

    // Open/reopen repeatedly: migrations must run once each, exactly.
    const first = openDb(dbPath);
    first.close();
    const db = openDb(dbPath);
    db.close();
    const reopened = openDb(dbPath);

    const applied = reopened
      .query(`SELECT version, name FROM schema_migrations ORDER BY version`)
      .all();
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

    // Ledger table exists with exactly the frozen shape.
    const cols = reopened.query(`PRAGMA table_info(processed_stripe_events)`).all();
    expect(cols.map((c) => c.name)).toEqual([
      "event_id",
      "event_type",
      "event_created",
      "processed_at",
    ]);
    const pkCols = cols.filter((c) => c.pk === 1).map((c) => c.name);
    expect(pkCols).toEqual(["event_id"]);
    reopened.close();
  });
});

test("first processStripeEvent applies once, commits mutation + one ledger row, returns result", () => {
  const db = openDb(":memory:");
  db.exec(`CREATE TABLE scratch_notes (id INTEGER PRIMARY KEY, note TEXT NOT NULL)`);

  let calls = 0;
  const result = processStripeEvent(
    db,
    { id: "evt_1001", type: "checkout.session.completed", created: 1700000001 },
    (d) => {
      calls += 1;
      d.query(`INSERT INTO scratch_notes (id, note) VALUES (1, 'mutation-committed')`).run();
      return { ok: true, order: 42 };
    }
  );

  expect(calls).toBe(1);
  expect(result).toEqual({ processed: true, duplicate: false, result: { ok: true, order: 42 } });
  // apply's DB mutation really committed
  const note = db.query(`SELECT note FROM scratch_notes WHERE id = 1`).get();
  expect(note.note).toBe("mutation-committed");
  // exactly one ledger row with the event payload
  const rows = db.query(`SELECT * FROM processed_stripe_events`).all();
  expect(rows.length).toBe(1);
  expect(rows[0].event_id).toBe("evt_1001");
  expect(rows[0].event_type).toBe("checkout.session.completed");
  expect(rows[0].event_created).toBe(1700000001);
  expect(typeof rows[0].processed_at).toBe("number");
  db.close();
});

test("duplicate event does not apply again, adds no row, returns duplicate shape", () => {
  const db = openDb(":memory:");
  db.exec(`CREATE TABLE scratch_notes (id INTEGER PRIMARY KEY, note TEXT NOT NULL)`);

  let calls = 0;
  const first = processStripeEvent(
    db,
    { id: "evt_2001", type: "invoice.payment_succeeded", created: 1700000002 },
    (d) => {
      calls += 1;
      d.query(`INSERT INTO scratch_notes (id, note) VALUES (1, 'once')`).run();
      return "first-result";
    }
  );
  expect(first.processed).toBe(true);
  expect(calls).toBe(1);

  const dup = processStripeEvent(
    db,
    { id: "evt_2001", type: "invoice.payment_succeeded", created: 1700000002 },
    (d) => {
      calls += 1;
      d.query(`INSERT INTO scratch_notes (id, note) VALUES (2, 'must-not-run')`).run();
      return "dup-result";
    }
  );

  expect(calls).toBe(1); // apply not called again
  expect(dup).toEqual({ processed: false, duplicate: true, result: null });
  const rows = db.query(`SELECT * FROM processed_stripe_events`).all();
  expect(rows.length).toBe(1); // no extra ledger row
  expect(rows[0].event_id).toBe("evt_2001");
  // apply's second mutation never happened
  const second = db.query(`SELECT note FROM scratch_notes WHERE id = 2`).get();
  expect(second).toBeNull();
  db.close();
});

test("throwing apply rolls back mutation and ledger; same event retries successfully", () => {
  const db = openDb(":memory:");
  db.exec(`CREATE TABLE scratch_notes (id INTEGER PRIMARY KEY, note TEXT NOT NULL)`);

  const event = { id: "evt_3001", type: "customer.subscription.updated", created: 1700000003 };
  let calls = 0;
  expect(() =>
    processStripeEvent(db, event, (d) => {
      calls += 1;
      d.query(`INSERT INTO scratch_notes (id, note) VALUES (1, 'should-rollback')`).run();
      throw new Error("apply boom");
    })
  ).toThrow("apply boom");

  // Nothing persisted: apply's mutation rolled back AND no ledger row.
  expect(db.query(`SELECT note FROM scratch_notes WHERE id = 1`).get()).toBeNull();
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(0);

  // The same event can be retried cleanly after the rollback.
  const retry = processStripeEvent(db, event, (d) => {
    calls += 1;
    d.query(`INSERT INTO scratch_notes (id, note) VALUES (1, 'committed')`).run();
    return "retry-ok";
  });
  expect(calls).toBe(2);
  expect(retry).toEqual({ processed: true, duplicate: false, result: "retry-ok" });
  expect(db.query(`SELECT note FROM scratch_notes WHERE id = 1`).get().note).toBe("committed");
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(1);
  db.close();
});

test("Promise/thenable return from apply is rejected and rolled back", () => {
  const db = openDb(":memory:");
  db.exec(`CREATE TABLE scratch_notes (id INTEGER PRIMARY KEY, note TEXT NOT NULL)`);

  const event = { id: "evt_4001", type: "checkout.session.completed", created: 1700000004 };
  // Plain thenable (not a real Promise) — the strictest thenable shape.
  const thenable = { then() {} };
  let calls = 0;
  expect(() =>
    processStripeEvent(db, event, (d) => {
      calls += 1;
      d.query(`INSERT INTO scratch_notes (id, note) VALUES (1, 'async-leak')`).run();
      return thenable;
    })
  ).toThrow(/synchronous/);

  // Rolled back: no mutation, no ledger row, event still retryable.
  expect(db.query(`SELECT note FROM scratch_notes WHERE id = 1`).get()).toBeNull();
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(0);

  const retry = processStripeEvent(db, event, () => {
    calls += 1;
    return "sync-ok";
  });
  expect(calls).toBe(2);
  expect(retry.result).toBe("sync-ok");
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(1);

  // A real resolved Promise is rejected too.
  expect(() =>
    processStripeEvent(
      db,
      { id: "evt_4002", type: "invoice.payment_succeeded", created: 1700000005 },
      () => Promise.resolve("nope")
    )
  ).toThrow(/synchronous/);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(1);
  db.close();
});

test("invalid id/type/created/apply is rejected before any transaction or ledger row", () => {
  const db = openDb(":memory:");
  const ok = { id: "evt_5001", type: "checkout.session.completed", created: 1700000006 };
  const cases = [
    ["missing id", { ...ok, id: undefined }, () => "no"],
    ["blank id", { ...ok, id: "   " }, () => "no"],
    ["missing type", { ...ok, type: undefined }, () => "no"],
    ["blank type", { ...ok, type: "  " }, () => "no"],
    ["missing created", { ...ok, created: undefined }, () => "no"],
    ["non-finite created", { ...ok, created: NaN }, () => "no"],
    ["non-numeric created", { ...ok, created: "1700000006" }, () => "no"],
    ["missing apply", ok, undefined],
    ["non-function apply", ok, { not: "a function" }],
  ];

  const failures = [];
  for (const [label, ev, applyArg] of cases) {
    try {
      processStripeEvent(db, ev, applyArg);
      failures.push(`${label}: did not throw`);
    } catch (err) {
      if (!(err instanceof TypeError)) {
        failures.push(`${label}: threw non-TypeError (${err.constructor?.name}: ${err.message})`);
      }
    }
  }
  expect(failures).toEqual([]);

  // None of the invalid calls opened a transaction that wrote anything.
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(0);
  db.close();
});