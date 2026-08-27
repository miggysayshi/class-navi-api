// server/test/email.test.js — Slice 2A: durable email outbox, atomic welcome
// enqueue, provider-neutral Resend adapter, bounded worker tick, suppression &
// provider-event core. Strict vertical RED→GREEN.
//
// Uses ONLY :memory:/temp DBs — never server/license.db. No network, no real
// keys, no commit.
import { test, expect } from "bun:test";
import { openDb } from "../db.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Temp on-disk DB for reopen/persistence tests (never server/license.db). */
function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qmp-email-"));
  const dbPath = join(dir, "email.db");
  try {
    fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Helpers under test are imported lazily so the module loads even before every
// export exists; each behavior is added in lockstep as it is implemented.
let enqueueEmail, claimOne, markSent, rescheduleRetry, markDead;
let addSuppression, isSuppressed, consumeResendEvent, countSentInUtcDay;
let buildWelcomeMessage, createResendAdapter, createEmailWorker, applyVerified;
let processStripeEvent, nextRetryDelayMs;

// ── Behavior 1: migration v4 ─────────────────────────────────────────────────
test("migration v4 durable-email-outbox creates the 3 email tables with exact frozen shape, idempotent across reopen", () => {
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
    expect(applied[3].version).toBe(4);
    expect(applied[3].name).toBe("durable-email-outbox");
    expect(applied[4].version).toBe(5);
    expect(applied[4].name).toBe("browser-family-slots");
    expect(applied[5].version).toBe(6);
    expect(applied[5].name).toBe("secure-recovery");
    expect(applied[6].version).toBe(7);
    expect(applied[6].name).toBe("family-invite-codes");

    const outbox = reopened.query(`PRAGMA table_info(email_outbox)`).all().map((c) => c.name);
    expect(outbox).toEqual([
      "id",
      "kind",
      "license_key",
      "recipient_email",
      "payload_json",
      "idempotency_key",
      "provider_message_id",
      "status",
      "attempts",
      "next_attempt_at",
      "last_error",
      "created_at",
      "sent_at",
      "lease_expires_at",
    ]);
    // idempotency_key is UNIQUE.
    const uniq = reopened.query(`PRAGMA index_list(email_outbox)`).all();
    expect(uniq.some((i) => i.unique === 1)).toBe(true);

    const supp = reopened.query(`PRAGMA table_info(email_suppressions)`).all().map((c) => c.name);
    expect(supp).toEqual(["email", "reason", "provider_event_id", "created_at"]);

    const evt = reopened.query(`PRAGMA table_info(resend_events)`).all().map((c) => c.name);
    expect(evt).toEqual(["provider_event_id", "event_type", "provider_message_id", "received_at"]);
  });
});

// ── Behavior 2: enqueueEmail ─────────────────────────────────────────────────
test("enqueueEmail inserts a pending outbox row with a normalized recipient and JSON payload bytes", async () => {
  ({ enqueueEmail } = await import("../db.js"));
  const db = openDb(":memory:");
  const message = { from: "X <a@b.com>", to: "Buyer@Example.COM ", subject: "S", html: "<p>H</p>" };
  const row = enqueueEmail(db, {
    kind: "welcome",
    licenseKey: "QMP-AAAA-BBBB-CCCC-DDDD",
    recipientEmail: "  Buyer@Example.COM  ",
    payload: message,
    idempotencyKey: "stripe-welcome:sub_x",
  });
  expect(row.id).toBe(1);
  expect(row.status).toBe("pending");
  expect(row.attempts).toBe(0);
  expect(row.recipient_email).toBe("buyer@example.com"); // normalized trim+lower
  expect(JSON.parse(row.payload_json).to).toBe("buyer@example.com");
  expect(row.idempotency_key).toBe("stripe-welcome:sub_x");
  expect(row.license_key).toBe("QMP-AAAA-BBBB-CCCC-DDDD");
  db.close();
});

test("enqueueEmail is idempotent: a duplicate idempotency key returns the persisted row without a second row", async () => {
  ({ enqueueEmail } = await import("../db.js"));
  const db = openDb(":memory:");
  enqueueEmail(db, {
    kind: "welcome",
    recipientEmail: "dup@example.com",
    payload: { subject: "1" },
    idempotencyKey: "stripe-welcome:sub_dup",
  });
  const dup = enqueueEmail(db, {
    kind: "welcome",
    recipientEmail: "other@example.com", // different email must NOT win
    payload: { subject: "2" },
    idempotencyKey: "stripe-welcome:sub_dup",
  });
  expect(dup.id).toBe(1);
  expect(dup.recipient_email).toBe("dup@example.com"); // persisted (authoritative) row
  expect(JSON.parse(dup.payload_json).subject).toBe("1");
  expect(db.query(`SELECT COUNT(*) AS n FROM email_outbox`).get().n).toBe(1);
  db.close();
});

// ── Behavior 3: claim / lease / mark / retry / dead / rollback ──────────────
test("a pending row survives a DB reopen (durable queue)", () => {
  withTempDb((dbPath) => {
    const db1 = openDb(dbPath);
    enqueueEmail(db1, {
      kind: "welcome", recipientEmail: "reopen@example.com", payload: { subject: "s" },
      idempotencyKey: "stripe-welcome:sub_reopen",
    });
    db1.close();
    const db2 = openDb(dbPath);
    const row = db2.query(`SELECT * FROM email_outbox WHERE idempotency_key=?`).get("stripe-welcome:sub_reopen");
    expect(row.status).toBe("pending");
    expect(row.recipient_email).toBe("reopen@example.com");
    db2.close();
  });
});

test("two claims on one due row yield a single winner; the second returns null", async () => {
  ({ claimOneDueEmail: claimOne } = await import("../db.js"));
  const db = openDb(":memory:");
  enqueueEmail(db, { kind: "welcome", recipientEmail: "c@example.com", payload: {}, idempotencyKey: "k1", createdAt: 0 });
  const first = claimOne(db, { now: 1000, leaseMs: 60000 });
  expect(first).not.toBeNull();
  expect(first.status).toBe("sending");
  expect(first.attempts).toBe(1);
  // Same row already leased+claimed → no second winner.
  const second = claimOne(db, { now: 1000, leaseMs: 60000 });
  expect(second).toBeNull();
  db.close();
});

test("an expired lease is reclaimed on the next claim", async () => {
  ({ claimOneDueEmail: claimOne } = await import("../db.js"));
  const db = openDb(":memory:");
  enqueueEmail(db, { kind: "welcome", recipientEmail: "l@example.com", payload: {}, idempotencyKey: "kL", createdAt: 0 });
  const first = claimOne(db, { now: 1000, leaseMs: 60000 });
  expect(first).not.toBeNull();
  // Lease still active (just before expiry) → not reclaimable.
  expect(claimOne(db, { now: 1000 + 60000 - 1, leaseMs: 60000 })).toBeNull();
  // Lease expired → reclaimed.
  const reclaim = claimOne(db, { now: 1000 + 60000, leaseMs: 60000 });
  expect(reclaim).not.toBeNull();
  expect(reclaim.id).toBe(first.id);
  expect(reclaim.attempts).toBe(2); // a fresh attempt
  db.close();
});

test("markEmailSent records provider message id + sent_at and clears the lease", async () => {
  ({ claimOneDueEmail: claimOne, markEmailSent: markSent } = await import("../db.js"));
  const db = openDb(":memory:");
  enqueueEmail(db, { kind: "welcome", recipientEmail: "mk@example.com", payload: {}, idempotencyKey: "kM", createdAt: 0 });
  const row = claimOne(db, { now: 1000, leaseMs: 60000 });
  const applied = markSent(db, row.id, { providerMessageId: "msg_abc", sentAt: 1200, leaseExpiresAt: row.lease_expires_at, attempts: row.attempts });
  expect(applied).toBe(1);
  const after = db.query(`SELECT * FROM email_outbox WHERE id=?`).get(row.id);
  expect(after.status).toBe("sent");
  expect(after.provider_message_id).toBe("msg_abc");
  expect(after.sent_at).toBe(1200);
  expect(after.lease_expires_at).toBeNull();
  db.close();
});

test("transient failure reschedules with bounded exponential backoff; permanent failure marks dead", async () => {
  ({ claimOneDueEmail: claimOne, rescheduleEmailRetry: rescheduleRetry, markEmailDead: markDead, nextRetryDelayMs } = await import("../db.js"));
  const db = openDb(":memory:");
  enqueueEmail(db, { kind: "welcome", recipientEmail: "tr@example.com", payload: {}, idempotencyKey: "kT", createdAt: 0 });
  const row = claimOne(db, { now: 1000, leaseMs: 60000 });
  const appliedRetry = rescheduleRetry(db, row.id, { attempts: row.attempts, category: "http_500", now: 1000, baseMs: 30000, maxMs: 60000, leaseExpiresAt: row.lease_expires_at });
  expect(appliedRetry).toBe(1);
  const r1 = db.query(`SELECT * FROM email_outbox WHERE id=?`).get(row.id);
  expect(r1.status).toBe("retry");
  expect(r1.attempts).toBe(1);
  expect(r1.last_error).toBe("http_500");
  expect(r1.next_attempt_at).toBe(1000 + 30000); // base=30s on attempt 1

  // Second failure: backoff grows (base*2) and stays bounded by max.
  expect(nextRetryDelayMs(1, 30000, 60000)).toBe(30000);
  expect(nextRetryDelayMs(2, 30000, 60000)).toBe(60000);
  expect(nextRetryDelayMs(9, 30000, 60000)).toBe(60000); // capped at max

  // Permanent 4xx: dead, no further scheduling.
  enqueueEmail(db, { kind: "welcome", recipientEmail: "pd@example.com", payload: {}, idempotencyKey: "kP", createdAt: 0 });
  const pRow = claimOne(db, { now: 1000, leaseMs: 60000 });
  const appliedDead = markDead(db, pRow.id, { category: "http_404", leaseExpiresAt: pRow.lease_expires_at, attempts: pRow.attempts });
  expect(appliedDead).toBe(1);
  const pd = db.query(`SELECT * FROM email_outbox WHERE id=?`).get(pRow.id);
  expect(pd.status).toBe("dead");
  expect(pd.last_error).toBe("http_404");
  // A dead row is never claimed again (claim at a time when only the dead row
  // would be a candidate — the transient retry row isn't due until 31000).
  expect(claimOne(db, { now: 30999, leaseMs: 60000 })).toBeNull();
  db.close();
});

test("an enqueued row that later fails inside processStripeEvent rolls back with no outbox residue", async () => {
  ({ processStripeEvent, enqueueEmail } = await import("../db.js"));
  const db = openDb(":memory:");
  expect(() =>
    processStripeEvent(db, { id: "evt_rb", type: "checkout.session.completed", created: 100 }, (d) => {
      enqueueEmail(d, { kind: "welcome", recipientEmail: "rb@example.com", payload: {}, idempotencyKey: "kRB" });
      throw new Error("boom after enqueue");
    })
  ).toThrow("boom after enqueue");
  expect(db.query(`SELECT COUNT(*) AS n FROM email_outbox`).get().n).toBe(0);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(0);
  db.close();
});

// ── Behavior 4: suppression + provider-event core ───────────────────────────
test("addSuppression normalizes the email and is idempotent; isSuppressed reflects it", async () => {
  ({ addSuppression, isSuppressed } = await import("../db.js"));
  const db = openDb(":memory:");
  expect(isSuppressed(db, "b@example.com")).toBe(false);
  const r = addSuppression(db, { email: "  B@Example.COM ", reason: "bounced", providerEventId: "evt_b" });
  expect(r.added).toBe(true);
  expect(r.email).toBe("b@example.com");
  expect(isSuppressed(db, "B@Example.COM")).toBe(true);
  // Idempotent: second add is a no-op.
  expect(addSuppression(db, { email: "b@example.com", reason: "bounced" }).added).toBe(false);
  db.close();
});

test("consumeResendEvent records a bounce and creates a suppression for that recipient", async () => {
  ({ consumeResendEvent, isSuppressed } = await import("../db.js"));
  const db = openDb(":memory:");
  const r = consumeResendEvent(db, {
    providerEventId: "evt_1", type: "email.bounced", providerMessageId: "msg_1", recipient: "bounce@example.com",
  });
  expect(r.recorded).toBe(true);
  expect(r.duplicate).toBe(false);
  expect(r.state).toBe("bounced");
  expect(r.suppressed).toBe(true);
  expect(isSuppressed(db, "bounce@example.com")).toBe(true);
  const row = db.query(`SELECT * FROM resend_events WHERE provider_event_id='evt_1'`).get();
  expect(row.event_type).toBe("email.bounced");
  expect(row.provider_message_id).toBe("msg_1");
  db.close();
});

test("a duplicate provider event is a no-op and does not double-suppress", async () => {
  ({ consumeResendEvent } = await import("../db.js"));
  const db = openDb(":memory:");
  const first = consumeResendEvent(db, { providerEventId: "evt_2", type: "email.bounced", recipient: "d@example.com" });
  expect(first.recorded).toBe(true);
  const dup = consumeResendEvent(db, { providerEventId: "evt_2", type: "email.bounced", recipient: "d@example.com" });
  expect(dup.recorded).toBe(false);
  expect(dup.duplicate).toBe(true);
  expect(dup.state).toBeNull();
  expect(dup.suppressed).toBe(false);
  expect(db.query(`SELECT COUNT(*) AS n FROM resend_events`).get().n).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM email_suppressions`).get().n).toBe(1);
  db.close();
});

test("delivered/delayed/failed events record state without suppressing the recipient", async () => {
  ({ consumeResendEvent, isSuppressed } = await import("../db.js"));
  const db = openDb(":memory:");
  const d = consumeResendEvent(db, { providerEventId: "evt_del", type: "email.delivered", recipient: "x@example.com" });
  expect(d.state).toBe("delivered");
  expect(d.suppressed).toBe(false);
  expect(isSuppressed(db, "x@example.com")).toBe(false);
  expect(consumeResendEvent(db, { providerEventId: "evt_dly", type: "email.delayed", recipient: "x@example.com" }).state).toBe("delayed");
  expect(consumeResendEvent(db, { providerEventId: "evt_f", type: "email.failed", recipient: "x@example.com" }).state).toBe("failed");
  expect(db.query(`SELECT COUNT(*) AS n FROM email_suppressions`).get().n).toBe(0);
  db.close();
});

// ── Behavior 5: free-plan daily limit ───────────────────────────────────────
test("countSentInUtcDay counts only sent rows within one UTC day", async () => {
  ({ countSentInUtcDay } = await import("../db.js"));
  const db = openDb(":memory:");
  const ins = (sentAt) =>
    db
      .query(
        `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at, sent_at)
         VALUES ('welcome', 'e@x.com', '{}', ?, 'sent', 1, 0, 0, ?)`
      )
      .run(`k_${sentAt}`, sentAt);
  ins(1000);
  ins(2000);
  ins(40000); // same UTC day (day 0: [0, 86400000))
  ins(86400000 + 1000); // next UTC day → excluded
  // a pending row is not a send → excluded
  db.query(
    `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at)
     VALUES ('welcome', 'p@x.com', '{}', 'kp', 'pending', 0, 0, 0)`
  ).run();
  expect(countSentInUtcDay(db, 1234)).toBe(3);
  db.close();
});

// ── Behavior 6: provider-neutral message construction + Resend adapter ──────
test("buildWelcomeMessage produces a provider-neutral message with a normalized recipient and the license key", async () => {
  ({ buildWelcomeMessage } = await import("../email.js"));
  const m = buildWelcomeMessage({ licenseKey: "QMP-KEY-1111-2222-3333", recipient: "  Wel@Example.COM " });
  expect(m.from).toContain("licenses@send.nimira-timer.com");
  expect(m.reply_to).toBe("support@nimira-timer.com");
  expect(m.to).toBe("wel@example.com");
  expect(m.subject).toContain("Class Navi Pro Tools");
  expect(m.subject).not.toContain("Quick Mark Pro");
  expect(m.html).toContain("Class Navi Pro Tools");
  expect(m.html).not.toContain("Quick Mark Pro");
  expect(m.html).toContain("QMP-KEY-1111-2222-3333");
});

test("Resend adapter posts to /emails with Bearer key, JSON payload, and Idempotency-Key header", async () => {
  ({ createResendAdapter } = await import("../email.js"));
  let captured;
  const fetchFn = async (url, opts) => {
    captured = { url, opts: { ...opts, body: JSON.parse(opts.body) } };
    return { status: 200, json: async () => ({ id: "msg_xyz" }) };
  };
  const adapter = createResendAdapter({ apiKey: "re_test_SUPER", fetchFn });
  const out = await adapter.send({
    idempotencyKey: "stripe-welcome:sub",
    message: { from: "F <f@x.com>", reply_to: "r@x.com", to: "t@x.com", subject: "S", html: "<p>h</p>" },
  });
  expect(out.ok).toBe(true);
  expect(out.providerMessageId).toBe("msg_xyz");
  expect(captured.url).toBe("https://api.resend.com/emails");
  expect(captured.opts.method).toBe("POST");
  expect(captured.opts.headers.Authorization).toBe("Bearer re_test_SUPER");
  expect(captured.opts.headers["Idempotency-Key"]).toBe("stripe-welcome:sub");
  expect(captured.opts.headers["Content-Type"]).toContain("application/json");
  expect(captured.opts.body).toEqual({
    from: "F <f@x.com>", reply_to: "r@x.com", to: "t@x.com", subject: "S", html: "<p>h</p>",
  });
});

test("Resend adapter classifies responses: 2xx ok / transient retryable / permanent dead / network retryable", async () => {
  ({ createResendAdapter } = await import("../email.js"));
  const mk = (status) => async () => ({ status, json: async () => ({}) });
  const msg = { from: "a", to: "t@x.com", subject: "s", html: "h" };
  const A0 = createResendAdapter({ apiKey: "k", fetchFn: mk(200) });
  expect((await A0.send({ idempotencyKey: "i", message: msg })).ok).toBe(true);
  for (const st of [408, 409, 425, 429, 500, 502, 503]) {
    const adapt = createResendAdapter({ apiKey: "k", fetchFn: mk(st) });
    const r = await adapt.send({ idempotencyKey: "i", message: msg });
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.permanent).toBe(false);
  }
  for (const st of [400, 401, 403, 404, 422]) {
    const adapt = createResendAdapter({ apiKey: "k", fetchFn: mk(st) });
    const r = await adapt.send({ idempotencyKey: "i", message: msg });
    expect(r.permanent).toBe(true);
    expect(r.retryable).toBe(false);
  }
  const net = createResendAdapter({ apiKey: "k", fetchFn: async () => { throw new Error("net down"); } });
  const rnet = await net.send({ idempotencyKey: "i", message: msg });
  expect(rnet.retryable).toBe(true);
  expect(rnet.permanent).toBe(false);
  expect(rnet.network).toBe(true);
});

// ── Behavior 7: bounded worker tick (deliverNext) ───────────────────────────
test("deliverNext claims one row, sends with the row's idempotency key, and marks it sent", async () => {
  ({ createEmailWorker } = await import("../email-worker.js"));
  ({ enqueueEmail } = await import("../db.js"));
  const db = openDb(":memory:");
  enqueueEmail(db, {
    kind: "welcome", recipientEmail: "s@example.com", payload: { subject: "s" },
    idempotencyKey: "stripe-welcome:sub_s", createdAt: 0,
  });
  const sent = [];
  const worker = createEmailWorker({
    db,
    sender: { send: async ({ idempotencyKey }) => { sent.push(idempotencyKey); return { ok: true, status: 200, providerMessageId: "m1" }; } },
    now: () => 1000, leaseMs: 60000,
  });
  const r = await worker();
  expect(r.state).toBe("sent");
  expect(r.sent).toBe(true);
  expect(sent).toEqual(["stripe-welcome:sub_s"]);
  const row = db.query(`SELECT * FROM email_outbox WHERE idempotency_key='stripe-welcome:sub_s'`).get();
  expect(row.status).toBe("sent");
  expect(row.provider_message_id).toBe("m1");
  expect(row.sent_at).toBe(1000);
  db.close();
});

test("an ambiguous/transient failure reuses the SAME idempotency key on the retry attempt", async () => {
  ({ createEmailWorker } = await import("../email-worker.js"));
  ({ enqueueEmail } = await import("../db.js"));
  const db = openDb(":memory:");
  enqueueEmail(db, {
    kind: "welcome", recipientEmail: "r@example.com", payload: { subject: "s" },
    idempotencyKey: "stripe-welcome:sub_r", createdAt: 0,
  });
  const keys = [];
  let call = 0;
  const sender = {
    send: async ({ idempotencyKey }) => {
      keys.push(idempotencyKey);
      call++;
      if (call === 1) return { ok: false, status: 0, retryable: true, network: true };
      return { ok: true, status: 200, providerMessageId: "m2" };
    },
  };
  const mkWorker = (t) => createEmailWorker({ db, sender, now: () => t, leaseMs: 60000, retryBaseMs: 30000, retryMaxMs: 60000 });
  const r1 = await mkWorker(1000)();
  expect(r1.state).toBe("retry");
  const row = db.query(`SELECT * FROM email_outbox WHERE idempotency_key='stripe-welcome:sub_r'`).get();
  expect(row.status).toBe("retry");
  expect(row.next_attempt_at).toBe(1000 + 30000);
  const r2 = await mkWorker(1000 + 30000)(); // retry is now due
  expect(r2.state).toBe("sent");
  expect(keys).toEqual(["stripe-welcome:sub_r", "stripe-welcome:sub_r"]); // same key
  db.close();
});

test("a permanent provider failure marks the row dead without further scheduling", async () => {
  ({ createEmailWorker } = await import("../email-worker.js"));
  ({ enqueueEmail } = await import("../db.js"));
  const db = openDb(":memory:");
  enqueueEmail(db, { kind: "welcome", recipientEmail: "p@example.com", payload: {}, idempotencyKey: "kP2", createdAt: 0 });
  const worker = createEmailWorker({
    db,
    sender: { send: async () => ({ ok: false, status: 404, permanent: true, retryable: false }) },
    now: () => 1000, leaseMs: 60000,
  });
  const r = await worker();
  expect(r.state).toBe("dead");
  const row = db.query(`SELECT * FROM email_outbox WHERE idempotency_key='kP2'`).get();
  expect(row.status).toBe("dead");
  expect(row.last_error).toBe("http_404");
  db.close();
});

test("a suppressed recipient never sends again and the row is marked dead", async () => {
  ({ createEmailWorker } = await import("../email-worker.js"));
  ({ enqueueEmail, addSuppression } = await import("../db.js"));
  const db = openDb(":memory:");
  addSuppression(db, { email: "sup@example.com", reason: "bounced" });
  enqueueEmail(db, { kind: "welcome", recipientEmail: "sup@example.com", payload: {}, idempotencyKey: "kSup", createdAt: 0 });
  let called = false;
  const worker = createEmailWorker({
    db,
    sender: { send: async () => { called = true; return { ok: true, status: 200, providerMessageId: "m" }; } },
    now: () => 1000, leaseMs: 60000,
  });
  const r = await worker();
  expect(r.state).toBe("suppressed");
  expect(called).toBe(false); // never reached the sender
  expect(db.query(`SELECT status FROM email_outbox WHERE idempotency_key='kSup'`).get().status).toBe("dead");
  db.close();
});

test("daily cap (100 sent in the UTC day) stops claiming/sending and leaves rows pending with a warning signal", async () => {
  ({ createEmailWorker } = await import("../email-worker.js"));
  ({ enqueueEmail } = await import("../db.js"));
  const db = openDb(":memory:");
  const nowVal = Date.now();
  for (let i = 0; i < 100; i++) {
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at, sent_at)
       VALUES ('welcome', 'e@x.com', '{}', ?, 'sent', 1, 0, 0, ?)`
    ).run(`cap_${i}`, nowVal);
  }
  enqueueEmail(db, { kind: "welcome", recipientEmail: "late@example.com", payload: {}, idempotencyKey: "kLate" });
  const worker = createEmailWorker({ db, sender: { send: async () => ({ ok: true, status: 200, providerMessageId: "m" }) } });
  const r = await worker();
  expect(r.state).toBe("daily-cap");
  expect(r.warning).toBe(true);
  expect(r.sent).toBe(false);
  // The late pending row was NOT dropped: it stays pending, unsent.
  expect(db.query(`SELECT status FROM email_outbox WHERE idempotency_key='kLate'`).get().status).toBe("pending");
  db.close();
});

test("at the 80-send warn threshold the worker still sends but returns a warning signal", async () => {
  ({ createEmailWorker } = await import("../email-worker.js"));
  ({ enqueueEmail } = await import("../db.js"));
  const db = openDb(":memory:");
  const nowVal = Date.now();
  for (let i = 0; i < 80; i++) {
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at, sent_at)
       VALUES ('welcome', 'e@x.com', '{}', ?, 'sent', 1, 0, 0, ?)`
    ).run(`warn_${i}`, nowVal);
  }
  enqueueEmail(db, { kind: "welcome", recipientEmail: "ok@example.com", payload: {}, idempotencyKey: "kWarn", createdAt: 0 });
  const worker = createEmailWorker({ db, sender: { send: async () => ({ ok: true, status: 200, providerMessageId: "m" }) } });
  const r = await worker();
  expect(r.warning).toBe(true);
  expect(r.sent).toBe(true);
  expect(db.query(`SELECT status FROM email_outbox WHERE idempotency_key='kWarn'`).get().status).toBe("sent");
  db.close();
});

// ── Behavior 7c: ATOMIC daily-cap reservation (cross-connection race) ────────
// Two worker ticks on TWO real DB connections, starting at 99 sent today, must
// not both claim+sender.send and finish at 101. A count-then-claim sequence is
// NOT a hard cap: each connection reads 99, each claims a different row, both
// send. The claim transaction itself must reserve against the cap.
test("two connections starting at 99 sent today can never both claim+send (atomic cap keeps it at 100, never 101)", async () => {
  ({ createEmailWorker } = await import("../email-worker.js"));
  ({ enqueueEmail, countSentInUtcDay } = await import("../db.js"));
  const dir = mkdtempSync(join(tmpdir(), "qmp-email-caprace-"));
  const dbPath = join(dir, "email.db");
  try {
    const connA = openDb(dbPath);
    const connB = openDb(dbPath);
    const nowVal = Date.now();
    for (let i = 0; i < 99; i++) {
      connA.query(
        `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at, sent_at)
         VALUES ('welcome', 'e@x.com', '{}', ?, 'sent', 1, 0, 0, ?)`
      ).run(`race_${i}`, nowVal);
    }
    enqueueEmail(connA, { kind: "welcome", recipientEmail: "raceA@example.com", payload: {}, idempotencyKey: "kRaceA", createdAt: 0 });
    enqueueEmail(connA, { kind: "welcome", recipientEmail: "raceB@example.com", payload: {}, idempotencyKey: "kRaceB", createdAt: 0 });

    // A sender barrier: both workers must be inside sender.send before either may
    // finish, forcing both to have counted 99 AND claimed before any row is marked
    // sent. Under a real atomic cap the second worker never reaches the sender, so
    // the barrier times out after a short grace instead of deadlocking.
    let arrived = 0;
    let release = null;
    const gate = new Promise((r) => { release = r; });
    const waitGate = () => Promise.race([gate, new Promise((r) => setTimeout(r, 200))]);
    const sentKeys = [];
    const sender = {
      async send({ idempotencyKey }) {
        sentKeys.push(idempotencyKey);
        arrived++;
        if (arrived === 2) release();
        await waitGate();
        return { ok: true, status: 200, providerMessageId: "m" };
      },
    };
    const wA = createEmailWorker({ db: connA, sender, now: () => nowVal, leaseMs: 60000, dailyCap: 100, warnAt: 80 });
    const wB = createEmailWorker({ db: connB, sender, now: () => nowVal, leaseMs: 60000, dailyCap: 100, warnAt: 80 });

    const [ra, rb] = await Promise.all([wA(), wB()]);
    // The hard cap must hold: exactly ONE additional send. 101 = the race bug.
    expect(countSentInUtcDay(connA, nowVal)).toBe(100);
    const sentTwice = [ra, rb].filter((r) => r.state === "sent").length;
    expect(sentTwice).toBe(1);
    expect(sentKeys.length).toBe(1); // only one row ever reached the sender
    // The unclaimed race row stays pending (never dropped on cap rejection).
    expect(connA.query(`SELECT COUNT(*) AS n FROM email_outbox WHERE status='pending'`).get().n).toBe(1);
    connA.close();
    connB.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Behavior 7d: LEASE-OWNED STATE TRANSITIONS (stale-owner no-ops) ─────────
// A completion (sent/retry/dead) must be conditional on the attempt's own claim
// identity (exact lease_expires_at + attempts from the claimed row). A late
// completion from an owner whose lease was reclaimed must be a no-op: it cannot
// overwrite a newer owner's terminal state.
test("a stale owner's late retry/dead is a no-op after a newer owner reclaimed and sent the row", async () => {
  ({ claimOneDueEmail: claimOne, markEmailSent: markSent, rescheduleEmailRetry: rescheduleRetry, markEmailDead: markDead, enqueueEmail } = await import("../db.js"));
  const db = openDb(":memory:");
  enqueueEmail(db, { kind: "welcome", recipientEmail: "stale@example.com", payload: {}, idempotencyKey: "kStale", createdAt: 0 });
  const ownerA = claimOne(db, { now: 1000, leaseMs: 60000 }); // lease 61000, attempts 1
  // Lease expires; owner B reclaims with a fresh lease + attempt count.
  const ownerB = claimOne(db, { now: 200000, leaseMs: 60000 });
  expect(ownerB).not.toBeNull();
  expect(ownerB.id).toBe(ownerA.id);
  const sentB = markSent(db, ownerB.id, { providerMessageId: "m_B", sentAt: 200001, leaseExpiresAt: ownerB.lease_expires_at, attempts: ownerB.attempts });
  expect(sentB).toBe(1);
  // A's late retry with A's (stale) identity must NOT flip the sent row back to retry.
  const retryA = rescheduleRetry(db, ownerA.id, { attempts: ownerA.attempts, category: "http_500", now: 200002, baseMs: 30000, maxMs: 60000, leaseExpiresAt: ownerA.lease_expires_at });
  expect(retryA).toBe(0);
  // A's late dead with A's stale identity must NOT mark the delivered row dead.
  const deadA = markDead(db, ownerA.id, { category: "http_500", leaseExpiresAt: ownerA.lease_expires_at, attempts: ownerA.attempts });
  expect(deadA).toBe(0);
  // Same-key idempotency already stopped a duplicate send; durable state stays sent.
  const after = db.query(`SELECT * FROM email_outbox WHERE id=?`).get(ownerA.id);
  expect(after.status).toBe("sent");
  expect(after.provider_message_id).toBe("m_B");
  expect(after.sent_at).toBe(200001);
  expect(after.lease_expires_at).toBeNull();
  db.close();
});

test("a stale owner's late completion cannot overwrite a reclaimed row still held by the new owner", async () => {
  ({ claimOneDueEmail: claimOne, markEmailSent: markSent, enqueueEmail } = await import("../db.js"));
  const db = openDb(":memory:");
  enqueueEmail(db, { kind: "welcome", recipientEmail: "rev@example.com", payload: {}, idempotencyKey: "kRev", createdAt: 0 });
  const ownerA = claimOne(db, { now: 1000, leaseMs: 60000 }); // lease 61000
  const ownerB = claimOne(db, { now: 200000, leaseMs: 60000 }); // reclaim, lease 260000, attempts 2
  // A's late send-completion is a no-op while B still holds the lease.
  const staleSent = markSent(db, ownerA.id, { providerMessageId: "m_A_late", sentAt: 200010, leaseExpiresAt: ownerA.lease_expires_at, attempts: ownerA.attempts });
  expect(staleSent).toBe(0);
  const row = db.query(`SELECT * FROM email_outbox WHERE id=?`).get(ownerA.id);
  expect(row.status).toBe("sending"); // still held by B, not 'sent'
  expect(row.provider_message_id).toBeNull(); // A did not smuggle in a provider id
  expect(row.lease_expires_at).toBe(ownerB.lease_expires_at); // B's lease intact
  // B then completes normally.
  const okB = markSent(db, ownerB.id, { providerMessageId: "m_B", sentAt: 200020, leaseExpiresAt: ownerB.lease_expires_at, attempts: ownerB.attempts });
  expect(okB).toBe(1);
  const done = db.query(`SELECT * FROM email_outbox WHERE id=?`).get(ownerA.id);
  expect(done.status).toBe("sent");
  expect(done.provider_message_id).toBe("m_B");
  db.close();
});

test("an exhausted worker's late completion cannot clobber a reclaimed row a newer worker already sent", async () => {
  ({ createEmailWorker } = await import("../email-worker.js"));
  ({ enqueueEmail } = await import("../db.js"));
  const db = openDb(":memory:");
  enqueueEmail(db, { kind: "welcome", recipientEmail: "w2@example.com", payload: {}, idempotencyKey: "kW2", createdAt: 0 });
  let resolveSend;
  const slowSender = { send: () => new Promise((r) => { resolveSend = r; }) };
  const workerA = createEmailWorker({ db, sender: slowSender, now: () => 1000, leaseMs: 60000, dailyCap: 100, warnAt: 80 });
  const pA = workerA(); // A claims (lease 61000) and now hangs awaiting the sender
  // After the lease expires, a second worker reclaims and completes.
  const workerB = createEmailWorker({
    db,
    sender: { send: async () => ({ ok: true, status: 200, providerMessageId: "m_B" }) },
    now: () => 200000, leaseMs: 60000, dailyCap: 100, warnAt: 80,
  });
  const rb = await workerB();
  expect(rb.state).toBe("sent");
  // A's provider finally returns; A's stale completion must be a no-op.
  resolveSend({ ok: true, status: 200, providerMessageId: "m_A" });
  const ra = await pA;
  expect(ra.state).toBe("stale"); // A could not claim credit for the send
  expect(ra.sent).toBe(false);
  const row = db.query(`SELECT * FROM email_outbox`).get();
  expect(row.status).toBe("sent");
  expect(row.provider_message_id).toBe("m_B"); // the newer owner's record wins
  expect(row.attempts).toBe(2);
  db.close();
});

// ── Behavior 7e: COMPLETION-time attribution (UTC-day + retry origin) ───────
// The worker previously captured `now()` BEFORE the provider call and used that
// claim time for sent_at and retry scheduling. A provider call that crosses a
// UTC midnight under-attributes the send to the prior day (undercounting the
// completion day and weakening the hard daily cap) and can schedule retries in
// the past. Both must use the COMPLETION timestamp read AFTER the provider
// returns.
test("a send that completes after UTC midnight is attributed to the completion (day-2), not the claim (day-1) day", async () => {
  ({ createEmailWorker } = await import("../email-worker.js"));
  ({ enqueueEmail, countSentInUtcDay } = await import("../db.js"));
  const db = openDb(":memory:");
  const DAY2_START = Date.UTC(2026, 7, 19); // 2026-08-19T00:00:00Z
  const PRE_MIDNIGHT = DAY2_START - 100; // claim: 2026-08-18T23:59:59.900Z
  const POST_MIDNIGHT = DAY2_START + 100; // completion: 2026-08-19T00:00:00.100Z
  enqueueEmail(db, {
    kind: "welcome", recipientEmail: "midnight@example.com", payload: {},
    idempotencyKey: "kMidnight", createdAt: 0,
  });
  // Shared fake clock: now() reads PRE_MIDNIGHT at claim; the injected sender
  // advances the clock past midnight before returning success.
  let clockNow = PRE_MIDNIGHT;
  const clock = () => clockNow;
  const sender = {
    send: async () => {
      clockNow = POST_MIDNIGHT; // provider takes just past UTC midnight to complete
      return { ok: true, status: 200, providerMessageId: "m_mid" };
    },
  };
  const worker = createEmailWorker({ db, sender, now: clock, leaseMs: 60000 });
  const r = await worker();
  expect(r.state).toBe("sent");
  const row = db.query(`SELECT * FROM email_outbox WHERE idempotency_key='kMidnight'`).get();
  expect(row.sent_at).toBe(POST_MIDNIGHT); // completion time, not claim time
  // UTC-day attribution: the completion day (day 2) owns the send.
  expect(countSentInUtcDay(db, POST_MIDNIGHT)).toBe(1); // completion day includes it
  expect(countSentInUtcDay(db, PRE_MIDNIGHT)).toBe(0); // claim day excludes it
  db.close();
});

test("a retryable failure schedules the retry from the completion time, never the (earlier) claim time", async () => {
  ({ createEmailWorker } = await import("../email-worker.js"));
  ({ enqueueEmail, nextRetryDelayMs } = await import("../db.js"));
  const db = openDb(":memory:");
  const DAY2_START = Date.UTC(2026, 7, 19);
  const PRE_MIDNIGHT = DAY2_START - 100;
  const POST_MIDNIGHT = DAY2_START + 100;
  enqueueEmail(db, {
    kind: "welcome", recipientEmail: "retrymid@example.com", payload: {},
    idempotencyKey: "kRetryMid", createdAt: 0,
  });
  let clockNow = PRE_MIDNIGHT;
  const clock = () => clockNow;
  const sender = {
    send: async () => {
      clockNow = POST_MIDNIGHT; // a long provider call completing past midnight
      return { ok: false, status: 503, retryable: true, permanent: false };
    },
  };
  const worker = createEmailWorker({
    db, sender, now: clock, leaseMs: 60000,
    retryBaseMs: 30000, retryMaxMs: 60000,
  });
  const r = await worker();
  expect(r.state).toBe("retry");
  const row = db.query(`SELECT * FROM email_outbox WHERE idempotency_key='kRetryMid'`).get();
  const delay = nextRetryDelayMs(row.attempts, 30000, 60000);
  // The retry must be scheduled AFTER completion, so a long provider call can
  // never schedule a retry in the past relative to actual completion.
  expect(row.next_attempt_at).toBe(POST_MIDNIGHT + delay);
  expect(row.next_attempt_at).toBeGreaterThan(PRE_MIDNIGHT + delay);
  db.close();
});

test("worker logs are sanitized: no recipient, license key, payload, or provider error body", async () => {
  ({ createEmailWorker } = await import("../email-worker.js"));
  ({ enqueueEmail, addSuppression } = await import("../db.js"));
  const db = openDb(":memory:");
  const RECIP = "NORAWDATA-REDACT@example.com";
  const KEY = "QMP-REDACT-0000-0000-0000";
  const logger = {
    entries: [],
    info: (...a) => logger.entries.push(["info", ...a]),
    warn: (...a) => logger.entries.push(["warn", ...a]),
    error: (...a) => logger.entries.push(["error", ...a]),
    log: (...a) => logger.entries.push(["log", ...a]),
  };
  // Suppressed recipient: the worker logs a fixed line and never the address.
  addSuppression(db, { email: RECIP, reason: "bounced" });
  enqueueEmail(db, { kind: "welcome", recipientEmail: RECIP, payload: { to: RECIP, html: `key ${KEY}` }, idempotencyKey: "kNL", createdAt: 0 });
  const worker = createEmailWorker({ db, sender: {}, now: () => 1000, leaseMs: 60000, logger });
  const r = await worker();
  expect(r.state).toBe("suppressed");
  const serialized = JSON.stringify(logger.entries);
  expect(serialized).not.toContain(RECIP);
  expect(serialized).not.toContain(KEY);
  expect(serialized.toLowerCase()).not.toContain("redact");
  db.close();
});

// ── Behavior 8: atomic welcome enqueue in the Stripe checkout callback ──────
test("checkout atomically commits one license + one ledger row + one welcome outbox row", async () => {
  ({ applyVerifiedStripeEvent: applyVerified } = await import("../stripe-webhook.js"));
  const db = openDb(":memory:");
  const event = {
    id: "evt_co_w", type: "checkout.session.completed", created: 100,
    data: { object: { subscription: "sub_w", customer: "cus_w", customer_details: { email: "Welcome@Example.COM " } } },
  };
  const res = applyVerified(db, event);
  expect(res.processed).toBe(true);
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM email_outbox`).get().n).toBe(1);
  const row = db.query(`SELECT * FROM email_outbox`).get();
  expect(row.kind).toBe("welcome");
  expect(row.recipient_email).toBe("welcome@example.com"); // normalized
  expect(row.idempotency_key).toBe("stripe-welcome:sub_w");
  const lic = db.query(`SELECT key FROM licenses WHERE subscription_id='sub_w'`).get();
  expect(row.license_key).toBe(lic.key); // the persisted key
  const payload = JSON.parse(row.payload_json);
  expect(payload.to).toBe("welcome@example.com");
  expect(payload.html).toContain(lic.key);
  db.close();
});

test("a different checkout event id for the same subscription yields ONE welcome row using the persisted key", async () => {
  ({ applyVerifiedStripeEvent: applyVerified } = await import("../stripe-webhook.js"));
  const db = openDb(":memory:");
  const ev1 = {
    id: "evt_c1", type: "checkout.session.completed", created: 100,
    data: { object: { subscription: "sub_w2", customer: "cus_w2", customer_details: { email: "first@example.com" } } },
  };
  const r1 = applyVerified(db, ev1);
  expect(r1.processed).toBe(true);
  const key = db.query(`SELECT key FROM licenses WHERE subscription_id='sub_w2'`).get().key;

  // Same subscription, DIFFERENT event id (e.g. a retried checkout).
  const ev2 = {
    id: "evt_c2", type: "checkout.session.completed", created: 200,
    data: { object: { subscription: "sub_w2", customer: "cus_w2", customer_details: { email: "first@example.com" } } },
  };
  const r2 = applyVerified(db, ev2);
  expect(r2.processed).toBe(true);
  expect(r2.duplicate).toBe(false);

  // Exactly one welcome, carrying the persisted (original) key.
  expect(db.query(`SELECT COUNT(*) AS n FROM email_outbox`).get().n).toBe(1);
  const row = db.query(`SELECT * FROM email_outbox`).get();
  expect(row.idempotency_key).toBe("stripe-welcome:sub_w2");
  expect(row.license_key).toBe(key);
  expect(row.recipient_email).toBe("first@example.com");
  db.close();
});

test("an exact duplicate checkout is a no-op that cannot create a second welcome", async () => {
  ({ applyVerifiedStripeEvent: applyVerified } = await import("../stripe-webhook.js"));
  const db = openDb(":memory:");
  const ev = {
    id: "evt_c3", type: "checkout.session.completed", created: 100,
    data: { object: { subscription: "sub_w3", customer: "cus_w3", customer_details: { email: "dup@example.com" } } },
  };
  applyVerified(db, ev);
  const dup = applyVerified(db, ev);
  expect(dup.duplicate).toBe(true);
  expect(db.query(`SELECT COUNT(*) AS n FROM email_outbox`).get().n).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(1);
  db.close();
});

test("a malformed checkout rolls back the license, ledger, AND welcome outbox together", async () => {
  ({ applyVerifiedStripeEvent: applyVerified } = await import("../stripe-webhook.js"));
  const db = openDb(":memory:");
  const bad = {
    id: "evt_bad", type: "checkout.session.completed", created: 100,
    data: { object: { customer: "cus_bad", customer_details: { email: "x@example.com" } } }, // no subscription
  };
  expect(() => applyVerified(db, bad)).toThrow();
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(0);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(0);
  expect(db.query(`SELECT COUNT(*) AS n FROM email_outbox`).get().n).toBe(0);
  db.close();
});
