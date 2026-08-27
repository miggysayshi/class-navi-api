// server/test/stripe-webhook.test.js — Slice 1B-2b: final shared webhook
// foundation. Idempotent event processing, monotonic subscription authority,
// pre-Checkout state application, and fully redacted observability — all driven
// through stored Stripe JSON events (no real keys, no network).
//
// Uses ONLY :memory: DBs — never server/license.db. Stripe is stubbed; the
// module under test is server/stripe-webhook.js (importing it must NOT start
// Bun.serve — that is why the handler factory lives in its own module).
import { test, expect } from "bun:test";
import {
  createStripeWebhookHandler,
  applyVerifiedStripeEvent,
} from "../stripe-webhook.js";
import { openDb, generateKey, findLicense } from "../db.js";

/** Capture logger: records every call so tests can assert redaction. */
function makeLogger() {
  const entries = [];
  return {
    entries,
    info: (...a) => entries.push(["info", ...a]),
    error: (...a) => entries.push(["error", ...a]),
    warn: (...a) => entries.push(["warn", ...a]),
    log: (...a) => entries.push(["log", ...a]),
  };
}

/** Serialized view of EVERYTHING the logger saw, plus a response body if given. */
function serializedLogs(logger, body = "") {
  return JSON.stringify(logger.entries) + " " + (body || "");
}

/** Fake Stripe verifier. Captures the raw/sig/secret triple. Optionally rejects. */
function makeStripe(event, { reject = false, rejectMsg = "bad signature" } = {}) {
  const calls = [];
  return {
    calls,
    webhooks: {
      constructEventAsync: async (raw, sig, secret) => {
        calls.push({ raw, sig, secret });
        if (reject) throw new Error(rejectMsg);
        return event;
      },
    },
  };
}

/** Click the webhook handler with a request carrying raw/sig; returns parsed result. */
async function fire({
  db,
  stripe,
  webhookSecret = "whsec_v2_test",
  logger,
  event,
  rawBody,
  sig = "t=1720000000,v1=REDACT_SIG_SENTINEL",
}) {
  const handler = createStripeWebhookHandler({
    db,
    stripe: stripe === undefined ? makeStripe(event) : stripe,
    webhookSecret,
    logger,
  });
  const req = new Request("http://local/api/stripe/webhook", {
    method: "POST",
    body: rawBody ?? JSON.stringify(event),
    headers: { "stripe-signature": sig },
  });
  const res = await handler(req);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { res, status: res.status, json, text };
}

function checkoutEvent({
  id = "evt_co",
  created = 1700000000,
  subId = "sub_a",
  email = "buyer@example.com",
  customer = "cus_a",
  subscription = undefined,
} = {}) {
  return {
    id,
    type: "checkout.session.completed",
    created,
    data: {
      object: {
        subscription: subscription ?? subId,
        customer,
        customer_details: { email },
      },
    },
  };
}

function subEvent({
  id = "evt_sub",
  created = 1700000000,
  subId = "sub_a",
  status = "active",
  periodEnd = null,
  cancel = false,
  type = "customer.subscription.updated",
} = {}) {
  return {
    id,
    type,
    created,
    data: {
      object: { id: subId, status, current_period_end: periodEnd, cancel_at_period_end: cancel },
    },
  };
}

// ── Behavior A ─────────────────────────────────────────────────────────────
test("A: valid checkout creates one license + one ledger row; response and logs contain no sensitive sentinels", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const email = "A-EMAIL-REDACT-SENTINEL@example.com";
  const subId = "sub_A_REDACT_SENTINEL";
  const cust = "cus_A_REDACT_SENTINEL";
  const event = checkoutEvent({ id: "evt_A", subId, email, customer: cust });
  // Raw body carries extra sentinel fields that must never reappear in logs.
  const rawBody = JSON.stringify({ ...event, meta: { RAW_BODY_SENTINEL: "yes" } });
  const sig = "t=1720000000,v1=A_REDACT_SIG_SENTINEL";
  const stripe = makeStripe(event);

  const { res, status, json, text } = await fire({
    db,
    stripe,
    logger,
    event,
    rawBody,
    sig,
  });

  expect(status).toBe(200);
  expect(json).toEqual({ received: true, duplicate: false });
  expect(await res?.clone?.text?.()).toBe(undefined); // body already consumed; ignore

  // One license for this subscription, one ledger row.
  const lic = db.query(`SELECT * FROM licenses WHERE subscription_id = ?`).get(subId);
  expect(lic).not.toBeNull();
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(1);
  // Email normalized (trim + lowercase) by the DB upsert.
  expect(lic.email).toBe("a-email-redact-sentinel@example.com");

  // constructEventAsync received the exact raw body / signature / secret.
  expect(stripe.calls).toHaveLength(1);
  expect(stripe.calls[0].raw).toBe(rawBody);
  expect(stripe.calls[0].sig).toBe(sig);
  expect(stripe.calls[0].secret).toBe("whsec_v2_test");

  // Redaction: none of the sentinels or the persisted key appears in logs or the body.
  const key = lic.key;
  const serialized = serializedLogs(logger, text);
  for (const s of [email, subId, cust, "RAW_BODY_SENTINEL", "A_REDACT_SIG_SENTINEL", key]) {
    expect(serialized).not.toContain(s);
  }
  db.close();
});

// ── Behavior B ─────────────────────────────────────────────────────────────
test("B1: exact duplicate event returns 200 duplicate=true with one license + one ledger row", async () => {
  const db = openDb(":memory:");
  const event = checkoutEvent({ id: "evt_B1", subId: "sub_B", email: "b@example.com" });

  const first = await fire({ db, event });
  expect(first.status).toBe(200);
  expect(first.json).toEqual({ received: true, duplicate: false });
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(1);

  const second = await fire({ db, event });
  expect(second.status).toBe(200);
  expect(second.json).toEqual({ received: true, duplicate: true });
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(1);
  db.close();
});

test("B2: duplicate event does NOT re-run the key generator or the apply", () => {
  const db = openDb(":memory:");
  const event = checkoutEvent({ id: "evt_B2", subId: "sub_B2", email: "b2@example.com" });
  let genCalls = 0;
  const gen = () => {
    genCalls += 1;
    return "QMP-DUP-0000-0000-0000";
  };

  const first = applyVerifiedStripeEvent(db, event, { generateKeyFn: gen });
  expect(first.processed).toBe(true);
  expect(genCalls).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(1);

  const second = applyVerifiedStripeEvent(db, event, { generateKeyFn: gen });
  expect(second.duplicate).toBe(true);
  expect(second.processed).toBe(false);
  expect(genCalls).toBe(1); // generator NOT re-run on duplicate
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(1);
  db.close();
});

// ── Behavior C ─────────────────────────────────────────────────────────────
test("C: different checkout event ID for the same subscription preserves the persisted key and existing canceled status", () => {
  const db = openDb(":memory:");
  const evtCo1 = checkoutEvent({ id: "evt_C_co1", created: 100, subId: "sub_C", email: "c@example.com" });
  applyVerifiedStripeEvent(db, evtCo1);
  const key1 = db.query(`SELECT key FROM licenses WHERE subscription_id = 'sub_C'`).get().key;

  const evtDel = subEvent({ id: "evt_C_del", created: 200, subId: "sub_C", type: "customer.subscription.deleted" });
  applyVerifiedStripeEvent(db, evtDel);

  // A DIFFERENT checkout event ID for the same subscription (e.g. a retried checkout).
  const evtCo2 = checkoutEvent({ id: "evt_C_co2", created: 300, subId: "sub_C", email: "c@example.com" });
  const res = applyVerifiedStripeEvent(db, evtCo2);
  expect(res.processed).toBe(true);
  expect(res.duplicate).toBe(false);

  const lic = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_C'`).get();
  expect(lic.key).toBe(key1); // persisted key preserved
  expect(lic.status).toBe("canceled"); // NOT re-activated by checkout default active
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(3);
  db.close();
});

// ── Behavior D ─────────────────────────────────────────────────────────────
test("D: subscription canceled BEFORE checkout persists; checkout atomically creates an already-canceled license with stored period/cancel fields", () => {
  const db = openDb(":memory:");
  const evtDel = subEvent({
    id: "evt_D_del", created: 100, subId: "sub_D", status: "canceled",
    type: "customer.subscription.deleted", periodEnd: 1600000000, cancel: true,
  });
  // Subscription event arrives when no license exists yet (out-of-order delivery).
  const st = applyVerifiedStripeEvent(db, evtDel);
  expect(st.result.action).toBe("subscription-deleted");
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(0);

  const evtCo = checkoutEvent({ id: "evt_D_co", created: 200, subId: "sub_D", email: "d@example.com" });
  const res = applyVerifiedStripeEvent(db, evtCo);
  expect(res.processed).toBe(true);

  // License created ALREADY canceled with the authoritative stored fields.
  const lic = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_D'`).get();
  expect(lic.status).toBe("canceled");
  expect(lic.current_period_end).toBe(1600000000);
  expect(lic.cancel_at_period_end).toBe(1);
  expect(lic.last_stripe_event_created).toBe(100); // authoritative watermark, not checkout's
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(2);
  db.close();
});

// ── Behavior E ─────────────────────────────────────────────────────────────
test("E: newer lifecycle event wins; an older different-ID active event is ledgered but cannot regrant", () => {
  const db = openDb(":memory:");
  applyVerifiedStripeEvent(db, checkoutEvent({ id: "evt_E_co", created: 100, subId: "sub_E", email: "e@example.com" }));
  // Newer event (created 300) cancels.
  applyVerifiedStripeEvent(db, subEvent({ id: "evt_E_cancel", created: 300, subId: "sub_E", type: "customer.subscription.deleted" }));
  expect(db.query(`SELECT status FROM licenses WHERE subscription_id = 'sub_E'`).get().status).toBe("canceled");

  // OLDER (created 200 < 300) active event, different event ID: ledgered but cannot regrant.
  const older = applyVerifiedStripeEvent(db, subEvent({ id: "evt_E_older", created: 200, subId: "sub_E", status: "active" }));
  expect(older.processed).toBe(true); // ledgered (a real event was seen)
  expect(older.duplicate).toBe(false);

  const lic = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_E'`).get();
  expect(lic.status).toBe("canceled"); // stale active could not regrant
  expect(lic.last_stripe_event_created).toBe(300);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(3);
  db.close();
});

// ── Behavior F ─────────────────────────────────────────────────────────────
test("F: customer.subscription.deleted forces canceled regardless of payload status", () => {
  const db = openDb(":memory:");
  applyVerifiedStripeEvent(db, checkoutEvent({ id: "evt_F_co", created: 100, subId: "sub_F", email: "f@example.com" }));
  // Payload claims active, but deleted must force canceled.
  const del = subEvent({ id: "evt_F_del", created: 200, subId: "sub_F", status: "active", type: "customer.subscription.deleted" });
  applyVerifiedStripeEvent(db, del);

  const lic = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_F'`).get();
  expect(lic.status).toBe("canceled");
  const licKey = lic.key;
  // License key preserved through the deleted lifecycle transition.
  expect(licKey).toMatch(/^QMP-/);
  db.close();
});

// ── Behavior G ─────────────────────────────────────────────────────────────
test("G: invoice.payment_succeeded and unsupported events are ledger-only no-ops that still return 200", async () => {
  const db = openDb(":memory:");
  applyVerifiedStripeEvent(db, checkoutEvent({ id: "evt_G_co", created: 100, subId: "sub_G", email: "g@example.com" }));
  applyVerifiedStripeEvent(db, subEvent({ id: "evt_G_del", created: 200, subId: "sub_G", type: "customer.subscription.deleted" }));
  expect(db.query(`SELECT status FROM licenses WHERE subscription_id = 'sub_G'`).get().status).toBe("canceled");

  const invoiceEvt = {
    id: "evt_G_inv", type: "invoice.payment_succeeded", created: 300,
    data: { object: { subscription: "sub_G", lines: { data: [{ price: { id: "price_x" } }] } } },
  };
  const inv = await fire({ db, event: invoiceEvt });
  expect(inv.status).toBe(200);
  expect(inv.json).toEqual({ received: true, duplicate: false });
  // invoice must NOT revive a canceled license or touch subscription state.
  expect(db.query(`SELECT status FROM licenses WHERE subscription_id = 'sub_G'`).get().status).toBe("canceled");
  expect(db.query(`SELECT COUNT(*) AS n FROM stripe_subscription_states`).get().n).toBe(1); // unchanged

  const unsupportedEvt = { id: "evt_G_uns", type: "charge.succeeded", created: 400, data: { object: { id: "ch_x" } } };
  const uns = await fire({ db, event: unsupportedEvt });
  expect(uns.status).toBe(200);
  expect(uns.json).toEqual({ received: true, duplicate: false });

  // Both ledged as safe no-ops (2 prior + 2 new = 4 ledger rows, 1 license, 1 state).
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(4);
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM stripe_subscription_states`).get().n).toBe(1);
  db.close();
});

// ── Behavior H ─────────────────────────────────────────────────────────────
test("H1: malformed checkout (missing subscription) returns generic 500, logs redacted, rolls back; corrected retry of the SAME id succeeds", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const email = "H-EMAIL-REDACT-SENTINEL@example.com";
  // Supported event but malformed: no subscription → must NOT mint an undeliverable key.
  const badEvent = {
    id: "evt_H", type: "checkout.session.completed", created: 100,
    data: { object: { customer: "cus_h", customer_details: { email } } },
  };
  const res = await fire({ db, logger, event: badEvent });
  expect(res.status).toBe(500);
  expect(res.json).toEqual({ error: "webhook processing failed" });

  // No license minted, no ledger row (atomic rollback), key never created.
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(0);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(0);

  // Failure log: fixed text + event id/type only; the email sentinel must not appear.
  const serialized = serializedLogs(logger, res.text);
  expect(serialized).not.toContain(email);
  expect(serialized).not.toContain("cus_h");

  // Corrected retry with the SAME event id now succeeds (rollback freed the id).
  const goodEvent = checkoutEvent({ id: "evt_H", created: 100, subId: "sub_H", email });
  const retry = await fire({ db, event: goodEvent });
  expect(retry.status).toBe(200);
  expect(retry.json).toEqual({ received: true, duplicate: false });
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(1);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(1);
  db.close();
});

test("H2: injected sync failure (bad subscription period) returns generic 500, rolls back; corrected retry of the SAME id succeeds", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  // Non-finite current_period_end makes the synchronous apply throw inside the ledger txn.
  const badSub = subEvent({ id: "evt_H2", created: 100, subId: "sub_H2", status: "active", periodEnd: "not-a-number" });
  const res = await fire({ db, logger, event: badSub });
  expect(res.status).toBe(500);
  expect(res.json).toEqual({ error: "webhook processing failed" });
  expect(db.query(`SELECT COUNT(*) AS n FROM stripe_subscription_states`).get().n).toBe(0);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(0);

  const goodSub = subEvent({ id: "evt_H2", created: 100, subId: "sub_H2", status: "active", periodEnd: 1700000400 });
  const retry = await fire({ db, event: goodSub });
  expect(retry.status).toBe(200);
  const state = db.query(`SELECT status, current_period_end FROM stripe_subscription_states WHERE subscription_id='sub_H2'`).get();
  expect(state.status).toBe("active");
  expect(state.current_period_end).toBe(1700000400);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(1);
  db.close();
});

// ── Behavior I ─────────────────────────────────────────────────────────────
test("I: constructEventAsync receives exact raw/sig/secret; signature failure => fixed 400 with fixed redacted log", async () => {
  const db = openDb(":memory:");
  const event = checkoutEvent({ id: "evt_I", subId: "sub_I", email: "i@example.com" });
  const rawBody = JSON.stringify(event);
  const sig = "t=1721111111,v1=I_REDACT_SIG_SENTINEL";
  const secret = "whsec_v2_custom";
  const stripe = makeStripe(event);
  const { status, json } = await fire({ db, stripe, webhookSecret: secret, event, rawBody, sig });
  expect(status).toBe(200);
  expect(stripe.calls[0]).toEqual({ raw: rawBody, sig, secret });

  // Signature failure: reject with a message that carries a sensitive sentinel.
  const logger = makeLogger();
  const rejectMsg = "SIG-ERR-REDACT-SENTINEL-zzz super-secret detail";
  const failStripe = { calls: [], webhooks: { constructEventAsync: async () => { throw new Error(rejectMsg); } } };
  const failed = await fire({ db, stripe: failStripe, logger, event, rawBody, sig });
  expect(failed.status).toBe(400);
  expect(failed.json).toEqual({ error: "webhook signature invalid" });

  const serialized = serializedLogs(logger, failed.text);
  expect(serialized).toContain("signature rejected"); // fixed, redacted rejection text
  expect(serialized).not.toContain("SIG-ERR-REDACT-SENTINEL"); // never the error message
  expect(serialized).not.toContain(sig); // never the signature
  db.close();
});

// ── Behavior J ─────────────────────────────────────────────────────────────
test("J: missing Stripe configuration returns the fixed 500", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const event = checkoutEvent({ id: "evt_J", subId: "sub_J", email: "j@example.com" });

  // No stripe at all.
  const noStripe = await fire({ db, stripe: null, logger, event });
  expect(noStripe.status).toBe(500);
  expect(noStripe.json).toEqual({ error: "stripe not configured" });

  // Stripe present but webhook secret missing.
  const emptySecret = await fire({ db, stripe: makeStripe(event), webhookSecret: "", logger, event });
  expect(emptySecret.status).toBe(500);
  expect(emptySecret.json).toEqual({ error: "stripe not configured" });

  // Nothing was processed in either case.
  expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(0);
  expect(db.query(`SELECT COUNT(*) AS n FROM processed_stripe_events`).get().n).toBe(0);
  db.close();
});

// ── Behavior K ─────────────────────────────────────────────────────────────
test("K: expanded subscription / customer objects are accepted alongside plain strings", () => {
  const db = openDb(":memory:");
  const expanded = checkoutEvent({
    id: "evt_K_co",
    created: 100,
    subscription: { id: "sub_expanded", customer: "cus_exp" },
    customer: { id: "cus_expanded" },
    email: "k@example.com",
  });
  // Override subId so data.object.subscription = the expanded object.
  expanded.data.object.subscription = { id: "sub_expanded" };
  expanded.data.object.customer = { id: "cus_expanded" };
  const res = applyVerifiedStripeEvent(db, expanded);
  expect(res.processed).toBe(true);
  const lic = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_expanded'`).get();
  expect(lic).not.toBeNull();
  expect(lic.status).toBe("active");

  // Expanded subscription object accepted in a lifecycle event too.
  const upd = subEvent({ id: "evt_K_upd", created: 200, subId: "sub_expanded", status: "past_due", periodEnd: 1700000500 });
  upd.data.object = { id: "sub_expanded", status: "past_due", current_period_end: 1700000500, cancel_at_period_end: false };
  const res2 = applyVerifiedStripeEvent(db, upd);
  expect(res2.processed).toBe(true);
  const lic2 = db.query(`SELECT * FROM licenses WHERE subscription_id = 'sub_expanded'`).get();
  expect(lic2.status).toBe("past_due");
  expect(lic2.current_period_end).toBe(1700000500);
  db.close();
});

// ── Integration: sync-callback contract ────────────────────────────────────
test("applyVerifiedStripeEvent returns a plain synchronous result (no Promise/thenable leaks to the ledger)", () => {
  const db = openDb(":memory:");
  const event = checkoutEvent({ id: "evt_sync", subId: "sub_sync", email: "sync@example.com" });
  const r = applyVerifiedStripeEvent(db, event);
  // processStripeEvent would THROW "must be synchronous" if our apply were async;
  // reaching here with a plain object proves the callback is sync.
  expect(r).toEqual({ processed: true, duplicate: false, result: { action: "checkout" } });
  expect(typeof r.then).toBe("undefined");
  db.close();
});

test("findLicense round-trip: checkouts store a real QMP key readable via db helper", () => {
  const db = openDb(":memory:");
  applyVerifiedStripeEvent(db, checkoutEvent({ id: "evt_key", subId: "sub_key", email: "key@example.com" }));
  const lic = db.query(`SELECT key FROM licenses WHERE subscription_id = 'sub_key'`).get();
  expect(lic.key).toMatch(/^QMP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(findLicense(db, lic.key).email).toBe("key@example.com");
  db.close();
});
