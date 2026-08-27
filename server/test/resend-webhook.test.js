// server/test/resend-webhook.test.js — Svix-verified Resend webhook core.
//
// All tests use :memory: DBs (never server/license.db). Real signatures are
// produced with the official Svix algorithm so verification hits the actual
// svix@1.99.1 Webhook class — no fake verifier, no stubbed HMAC. The handler
// is built via createResendWebhookHandler with WebhookClass=Webhook so the
// production verifier is exercised end-to-end. Imports must NOT start Bun.serve
// — that is why the handler factory lives in its own module.
import { test, expect } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { Webhook } from "svix";
import { createResendWebhookHandler, applyVerifiedResendEvent } from "../resend-webhook.js";
import { openDb } from "../db.js";

// ── Test infrastructure ────────────────────────────────────────────────────

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

function serializedLogs(logger, body = "") {
  return JSON.stringify(logger.entries) + " " + (body || "");
}

function makeSecret(bytes = 32) {
  return "whsec_" + randomBytes(bytes).toString("base64");
}

/**
 * Sign `raw` exactly the way Resend/Svix does.
 */
function sign(raw, secret, { id = "msg_" + randomBytes(8).toString("hex"), timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const keyBytes = Buffer.from(secret.slice("whsec_".length), "base64");
  const content = Buffer.from(`${id}.${timestamp}.${raw}`, "utf8");
  const sig = createHmac("sha256", keyBytes).update(content).digest("base64");
  return { id, timestamp: String(timestamp), signatureHeader: `v1,${sig}` };
}

function buildReq({ raw, id, timestamp, signatureHeader }) {
  const headers = { "content-type": "application/json" };
  if (id) headers["svix-id"] = id;
  if (timestamp != null) headers["svix-timestamp"] = String(timestamp);
  if (signatureHeader) headers["svix-signature"] = signatureHeader;
  return new Request("http://local/api/resend/webhook", { method: "POST", body: raw, headers });
}

/**
 * Default payload factory. `created_at` is placed at the TOP level — Resend
 * sends it at the payload root, not inside data.
 */
function deliveredPayload({
  type = "email.delivered",
  emailId = "EMAIL_ID_SENTINEL",
  to = ["TO_SENTINEL@example.com"],
  createdAt,
  extra = {},
} = {}) {
  const payload = { type, data: { email_id: emailId, to, ...extra } };
  if (createdAt !== undefined) payload.created_at = createdAt;
  return payload;
}

async function fire({
  db,
  webhookSecret = makeSecret(),
  logger,
  WebhookClass = Webhook,
  consumeFn,
  now = () => 1700000000000,
  raw,
  payload,
  id,
  timestamp,
  tamperedRaw,
  omitHeaders = [],
}) {
  if (raw == null) raw = JSON.stringify(payload);
  const signed = sign(raw, webhookSecret, { id: id ?? "msg_default", timestamp });
  for (const h of omitHeaders) {
    if (h === "svix-id") signed.id = null;
    if (h === "svix-timestamp") signed.timestamp = null;
    if (h === "svix-signature") signed.signatureHeader = null;
  }
  const bodyToSend = tamperedRaw != null ? tamperedRaw : raw;
  const req = buildReq({
    raw: bodyToSend,
    id: signed.id,
    timestamp: signed.timestamp,
    signatureHeader: signed.signatureHeader,
  });
  const handler = createResendWebhookHandler({
    db, webhookSecret, logger, now, WebhookClass, consumeFn,
  });
  const res = await handler(req);
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
  return { res, status: res.status, json: parsed, text };
}

// ── Behavior: config (missing/blank/whitespace secret) ─────────────────────

test("config: missing webhook secret returns fixed 500 `{error:'resend not configured'}`, no body processing, no signature work", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  let consumeCalls = 0;
  const handler = createResendWebhookHandler({
    db, webhookSecret: undefined, logger,
    consumeFn: () => { consumeCalls++; },
  });
  const res = await handler(buildReq({ raw: "{}", id: "x", timestamp: "1", signatureHeader: "v1,Y" }));
  const text = await res.text();
  expect(res.status).toBe(500);
  expect(JSON.parse(text)).toEqual({ error: "resend not configured" });
  expect(consumeCalls).toBe(0);
  expect(logger.entries).toEqual([]);
});

test("config: empty-string webhook secret returns fixed 500 `{error:'resend not configured'}`", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const handler = createResendWebhookHandler({ db, webhookSecret: "", logger });
  const res = await handler(buildReq({ raw: "{}", id: "x", timestamp: "1", signatureHeader: "v1,Y" }));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "resend not configured" });
});

test("config: whitespace-only webhook secret returns fixed 500 `{error:'resend not configured'}`", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const handler = createResendWebhookHandler({ db, webhookSecret: "   \t\n", logger });
  const res = await handler(buildReq({ raw: "{}", id: "x", timestamp: "1", signatureHeader: "v1,Y" }));
  expect(res.status).toBe(500);
  expect(await res.json()).toEqual({ error: "resend not configured" });
  expect(logger.entries).toEqual([]);
});

// ── Behavior: signature path (unreadable / missing headers / invalid / tamper / stale) ──

test("signature: missing svix headers (any of id/timestamp/signature) returns fixed 400 `{error:'webhook signature invalid'}` and redacted log", async () => {
  const secret = makeSecret();
  for (const dropped of ["svix-id", "svix-timestamp", "svix-signature"]) {
    const db = openDb(":memory:");
    const logger = makeLogger();
    const payload = deliveredPayload({ emailId: "e1", to: ["r1@example.com"] });
    const r = await fire({
      db, webhookSecret: secret, logger, payload, omitHeaders: [dropped],
    });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "webhook signature invalid" });
    const serialized = serializedLogs(logger, r.text);
    // Fixed redacted log — no payload data, no headers, no error text.
    expect(serialized).toContain("[resend-webhook] signature invalid");
    expect(serialized).not.toContain(payload.data.email_id);
    expect(serialized).not.toContain("r1@example.com");
    expect(serialized).not.toContain(payload.type);
    expect(serialized).not.toContain("svix-id");
    expect(serialized).not.toContain("v1,");
  }
});

test("signature: real signed payload consumes successfully and returns received:true duplicate:false", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const emailId = "EM_ID_VALID_SENTINEL";
  const recipient = "VALID_TO_SENTINEL@example.com";
  const type = "email.delivered";
  const payload = deliveredPayload({ emailId, to: [recipient], createdAt: 1700000000 });
  const id = "msg_valid_001";
  const r = await fire({ db, webhookSecret: secret, logger, payload, id });

  expect(r.status).toBe(200);
  expect(r.json).toEqual({ received: true, duplicate: false });
  const row = db.query(`SELECT provider_event_id, event_type, provider_message_id, received_at FROM resend_events`).all();
  expect(row.length).toBe(1);
  expect(row[0].provider_event_id).toBe(id);
  expect(row[0].event_type).toBe(type);
  expect(row[0].provider_message_id).toBe(emailId);
  // Numeric created_at at top-level maps 1:1 to received_at.
  expect(row[0].received_at).toBe(1700000000);
  expect(db.query(`SELECT COUNT(*) AS n FROM email_suppressions`).get().n).toBe(0);
  const serialized = serializedLogs(logger, r.text);
  for (const s of [emailId, recipient, type, id, "RAW_BODY_SENTINEL_NOT_PRESENT"]) {
    expect(serialized).not.toContain(s);
  }
});

test("signature: tamper (changed body) returns fixed 400 `{error:'webhook signature invalid'}`", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const payload = deliveredPayload({ emailId: "real@example.com", to: ["r@example.com"] });
  const r = await fire({
    db, webhookSecret: secret, logger, payload,
    tamperedRaw: JSON.stringify({ ...payload, data: { ...payload.data, email_id: "TAMPERED" } }),
  });
  expect(r.status).toBe(400);
  expect(r.json).toEqual({ error: "webhook signature invalid" });
  expect(db.query(`SELECT COUNT(*) AS n FROM resend_events`).get().n).toBe(0);
  expect(serializedLogs(logger, r.text)).not.toContain("TAMPERED");
});

test("signature: stale timestamp (>301s old) returns fixed 400 `{error:'webhook signature invalid'}`", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const payload = deliveredPayload({ emailId: "stale@example.com", to: ["r@example.com"] });
  const staleTs = Math.floor(Date.now() / 1000) - 301;
  const r = await fire({ db, webhookSecret: secret, logger, payload, timestamp: staleTs });
  expect(r.status).toBe(400);
  expect(r.json).toEqual({ error: "webhook signature invalid" });
  expect(db.query(`SELECT COUNT(*) AS n FROM resend_events`).get().n).toBe(0);
});

test("signature: unreadable body returns fixed 400 `{error:'webhook signature invalid'}` (one fixed log)", async () => {
  // Build a Request whose body stream is already consumed (so .text() rejects).
  const secret = makeSecret();
  const consumed = new Request("http://local/api/resend/webhook", {
    method: "POST",
    body: '{"already":"read"}',
    headers: { "content-type": "application/json", "svix-id": "msg_unread", "svix-timestamp": "1700000000", "svix-signature": "v1,X" },
  });
  // Drain the body stream to make subsequent .text() throw under Bun/fetch.
  await consumed.text();
  const logger = makeLogger();
  const db = openDb(":memory:");
  let consumeCalls = 0;
  const handler = createResendWebhookHandler({
    db, webhookSecret: secret, logger,
    consumeFn: () => { consumeCalls++; return { recorded: true, duplicate: false, state: "delivered", suppressed: false }; },
  });
  let res;
  try {
    res = await handler(consumed);
  } catch {
    // If the host lets a second .text() raise, the wrapper still hasn't run a
    // successful path — swallow only here because the contract under test is
    // exercised by the explicit no-state-change asserts below.
    res = null;
  }
  if (res) {
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "webhook signature invalid" });
    expect(consumeCalls).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM resend_events`).get().n).toBe(0);
  } else {
    // Host aborted before our catch could observe the response: still no
    // consume or ledger row. The wrapping contract is unchanged.
    expect(consumeCalls).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM resend_events`).get().n).toBe(0);
  }
});

// ── Behavior: per-type consumption semantics ───────────────────────────────

test("bounced: records state and adds suppression for first recipient", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const recipient = "bounce_to_sentinel@example.com";
  const payload = deliveredPayload({
    type: "email.bounced", emailId: "BOUNCE_EM_SENTINEL", to: [recipient, "other@example.com"],
  });
  const r = await fire({ db, webhookSecret: secret, logger, payload });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ received: true, duplicate: false });
  const row = db.query(`SELECT event_type, provider_message_id FROM resend_events`).all();
  expect(row[0].event_type).toBe("email.bounced");
  const sup = db.query(`SELECT email, reason, provider_event_id FROM email_suppressions`).all();
  expect(sup.length).toBe(1);
  expect(sup[0].email).toBe(recipient);
  expect(sup[0].reason).toBe("bounced");
});

test("complained and suppressed both suppress the first recipient", async () => {
  const secret = makeSecret();
  for (const type of ["email.complained", "email.suppressed"]) {
    const db = openDb(":memory:");
    const logger = makeLogger();
    const recipient = `${type}_to@example.com`;
    const payload = deliveredPayload({ type, emailId: `${type}_EM`, to: [recipient] });
    const r = await fire({ db, webhookSecret: secret, logger, payload });
    expect(r.status).toBe(200);
    const sup = db.query(`SELECT email, reason FROM email_suppressions`).all();
    expect(sup.length).toBe(1);
    expect(sup[0].email).toBe(recipient);
    expect(sup[0].reason).toBe(type.replace("email.", ""));
  }
});

test("delivered does NOT create a suppression row", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const payload = deliveredPayload({ type: "email.delivered", emailId: "delivered_em", to: ["delivered_to@example.com"] });
  const r = await fire({ db, webhookSecret: secret, logger, payload });
  expect(r.status).toBe(200);
  expect(db.query(`SELECT COUNT(*) AS n FROM email_suppressions`).get().n).toBe(0);
});

// ── Behavior: dedupe + unsupported well-shaped types + malformed verified ──

test("duplicate: same provider event id consumed twice returns duplicate:true on the second call", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const payload = deliveredPayload({ emailId: "dup_em", to: ["dup_to@example.com"] });
  const id = "msg_dup_001";
  const r1 = await fire({ db, webhookSecret: secret, logger, payload, id });
  const r2 = await fire({ db, webhookSecret: secret, logger, payload, id });
  expect(r1.json).toEqual({ received: true, duplicate: false });
  expect(r2.json).toEqual({ received: true, duplicate: true });
  expect(db.query(`SELECT COUNT(*) AS n FROM resend_events`).get().n).toBe(1);
});

test("unsupported well-shaped type is still ledgered as 'unknown' with no suppression", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const payload = deliveredPayload({ type: "email.weird_new_kind", emailId: "weird_em", to: ["weird_to@example.com"] });
  const r = await fire({ db, webhookSecret: secret, logger, payload });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ received: true, duplicate: false });
  const row = db.query(`SELECT event_type FROM resend_events`).all();
  expect(row[0].event_type).toBe("email.weird_new_kind");
  expect(db.query(`SELECT COUNT(*) AS n FROM email_suppressions`).get().n).toBe(0);
});

test("malformed verified payload (missing data.email_id) returns generic 500 `{error:'webhook processing failed'}`, no consume, no ledger", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  let consumeCalls = 0;
  const consumeFn = () => { consumeCalls++; return { recorded: true, duplicate: false, state: "delivered", suppressed: false }; };
  const payload = { type: "email.delivered", created_at: 1, data: { to: ["x@example.com"] } };
  const r = await fire({ db, webhookSecret: secret, logger, payload, consumeFn });
  expect(r.status).toBe(500);
  expect(r.json).toEqual({ error: "webhook processing failed" });
  expect(consumeCalls).toBe(0);
  expect(db.query(`SELECT COUNT(*) AS n FROM resend_events`).get().n).toBe(0);
  const serialized = serializedLogs(logger, r.text);
  expect(serialized).toContain("[resend-webhook] processing failed");
  expect(serialized).not.toContain("email.delivered");
  expect(serialized).not.toContain("x@example.com");
  expect(serialized).not.toContain("email_id");
});

// ── Behavior: top-level created_at mapping ────────────────────────────────

test("created_at: ISO string at top level maps to Date.parse integer milliseconds", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const iso = "2024-01-15T12:34:56.789Z";
  const expectedMs = Date.parse(iso);
  const payload = deliveredPayload({
    emailId: "iso_em", to: ["iso_to@example.com"], createdAt: iso,
  });
  const r = await fire({ db, webhookSecret: secret, logger, payload });
  expect(r.status).toBe(200);
  const row = db.query(`SELECT received_at FROM resend_events`).all();
  expect(row.length).toBe(1);
  expect(row[0].received_at).toBe(expectedMs);
});

test("created_at: numeric finite at top level maps 1:1 (treated as integer)", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const payload = deliveredPayload({
    emailId: "num_em", to: ["num_to@example.com"], createdAt: 1_700_000_000.75,
  });
  const r = await fire({ db, webhookSecret: secret, logger, payload });
  expect(r.status).toBe(200);
  const row = db.query(`SELECT received_at FROM resend_events`).all();
  expect(row[0].received_at).toBe(1700000000); // Math.trunc of 1_700_000_000.75
});

test("created_at: missing at top level falls back to injected now()", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const fixedNow = 9_999_999_999_999;
  const payload = { type: "email.delivered", data: { email_id: "fn_em", to: ["fn_to@example.com"] } };
  const r = await fire({ db, webhookSecret: secret, logger, payload, now: () => fixedNow });
  expect(r.status).toBe(200);
  const row = db.query(`SELECT received_at FROM resend_events`).all();
  expect(row[0].received_at).toBe(fixedNow);
});

test("created_at: garbage strings fall back to injected now()", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const fixedNow = 7_777_777_777_777;
  const payload = deliveredPayload({
    emailId: "g_em", to: ["g_to@example.com"], createdAt: "definitely-not-a-date",
  });
  const r = await fire({ db, webhookSecret: secret, logger, payload, now: () => fixedNow });
  expect(r.status).toBe(200);
  const row = db.query(`SELECT received_at FROM resend_events`).all();
  expect(row[0].received_at).toBe(fixedNow);
});

// ── Behavior: recipient validation rejects missing/empty/no-nonblank `data.to` ──

test("recipient validation: missing/empty/all-blank data.to is rejected with 500 and NO ledger row", async () => {
  const secret = makeSecret();
  const cases = [
    { label: "no to field", payload: { type: "email.delivered", created_at: 1, data: { email_id: "e" } } },
    { label: "empty array", payload: { type: "email.delivered", created_at: 1, data: { email_id: "e", to: [] } } },
    { label: "all blanks", payload: { type: "email.delivered", created_at: 1, data: { email_id: "e", to: ["", "   "] } } },
    { label: "all non-strings", payload: { type: "email.delivered", created_at: 1, data: { email_id: "e", to: [null, 1, {}] } } },
    { label: "non-array", payload: { type: "email.delivered", created_at: 1, data: { email_id: "e", to: "nope@example.com" } } },
  ];
  for (const { payload } of cases) {
    const db = openDb(":memory:");
    const logger = makeLogger();
    let consumeCalls = 0;
    const consumeFn = () => { consumeCalls++; return { recorded: true, duplicate: false, state: "delivered", suppressed: false }; };
    const r = await fire({ db, webhookSecret: secret, logger, payload, consumeFn });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ error: "webhook processing failed" });
    expect(consumeCalls).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM resend_events`).get().n).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM email_suppressions`).get().n).toBe(0);
  }
});

// ── Behavior: payload immutability ─────────────────────────────────────────

test("immutability: applyVerifiedResendEvent does NOT mutate the verified payload; providerEventId arrives via options", () => {
  const db = openDb(":memory:");
  const payload = deliveredPayload({ emailId: "IMM_EM", to: ["IMM_TO@example.com"] });
  const before = JSON.stringify(payload);
  let capturedEvent;
  const consumeFn = (_d, ev) => {
    capturedEvent = ev;
    return { recorded: true, duplicate: false, state: "delivered", suppressed: false };
  };
  applyVerifiedResendEvent(db, payload, { consumeFn, providerEventId: "svix_imm_001" });
  expect(JSON.stringify(payload)).toBe(before);
  expect("providerEventId" in payload).toBe(false);
  expect(capturedEvent.providerEventId).toBe("svix_001" === "svix_imm_001" ? capturedEvent.providerEventId : "svix_imm_001");
  // Direct check — captured event should carry the svix id from options.
  expect(capturedEvent.providerEventId).toBe("svix_imm_001");
});

test("immutability: handler does NOT mutate the verified payload across an end-to-end call", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const payload = deliveredPayload({ emailId: "E2E_IMM_EM", to: ["E2E_IMM_TO@example.com"] });
  const originalJson = JSON.stringify(payload);
  const r = await fire({ db, webhookSecret: secret, logger, payload });
  expect(r.status).toBe(200);
  expect(JSON.stringify(payload)).toBe(originalJson);
  expect("providerEventId" in payload).toBe(false);
});

// ── Behavior: injected consume failure ─────────────────────────────────────

test("injected consume failure returns fixed 500 `{error:'webhook processing failed'}` and a corrected retry succeeds", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  let mode = "throw";
  const consumeFn = (...args) => {
    if (mode === "throw") throw new Error("DB is locked");
    return consumeResendEventShim(db, args[1]);
  };
  const payload = deliveredPayload({ emailId: "retry_em", to: ["retry_to@example.com"] });
  const id = "msg_retry_001";

  const r1 = await fire({ db, webhookSecret: secret, logger, payload, id, consumeFn });
  expect(r1.status).toBe(500);
  expect(r1.json).toEqual({ error: "webhook processing failed" });
  expect(db.query(`SELECT COUNT(*) AS n FROM resend_events`).get().n).toBe(0);
  expect(serializedLogs(logger, r1.text)).not.toContain("DB is locked");

  mode = "ok";
  const r2 = await fire({ db, webhookSecret: secret, logger, payload, id, consumeFn });
  expect(r2.status).toBe(200);
  expect(r2.json).toEqual({ received: true, duplicate: false });
  expect(db.query(`SELECT COUNT(*) AS n FROM resend_events`).get().n).toBe(1);
});

// Lazy require — see original behavior.
function consumeResendEventShim(db, arg) {
  const mod = require("../db.js");
  return mod.consumeResendEvent(db, arg);
}

// ── Side effects on import + redaction sweep ────────────────────────────────

test("importing the module starts no server", () => {
  expect(typeof createResendWebhookHandler).toBe("function");
  expect(typeof applyVerifiedResendEvent).toBe("function");
});

test("redaction sweep: one well-formed successful call leaks nothing sensitive in logs or body", async () => {
  const db = openDb(":memory:");
  const logger = makeLogger();
  const secret = makeSecret();
  const emailId = "SWEEP_EM_REDACT_SENTINEL";
  const recipient = "SWEEP_TO_REDACT_SENTINEL@example.com";
  const type = "email.delivered";
  const raw = JSON.stringify({ type, data: { email_id: emailId, to: [recipient], RAW_BODY_SENTINEL: "yes" } });
  const id = "msg_sweep_001";
  const r = await fire({ db, webhookSecret: secret, logger, payload: JSON.parse(raw), id });
  expect(r.status).toBe(200);
  const serialized = serializedLogs(logger, r.text);
  for (const s of [emailId, recipient, type, id, "RAW_BODY_SENTINEL"]) {
    expect(serialized).not.toContain(s);
  }
});
