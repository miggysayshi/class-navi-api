// server/test/email-integration.test.js — Final email wiring integration.
//
// Verifies the accepted scheduler + Resend webhook cores are wired into the
// Bun server with:
//   * PII-free health (`/health` email field is a fixed primitive set)
//   * Disabled-safe configuration (blank RESEND_API_KEY → no adapter, no
//     scheduler, but Stripe still queues + DB counts surface in /health)
//   * svix-verified /api/resend/webhook (real signatures, missing/tampered
//     → fixed 400; signed → records/suppresses + 200)
//
// All DBs are :memory: or temp dirs. All env uses sentinel values that must
// never appear in server logs or /health responses. The server child is
// spawned on a free local port (assigned by the OS) and torn down in `finally`.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { openDb, emailQueueHealth } from "../db.js";
import { Webhook } from "svix";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSecret(bytes = 32) {
  return "whsec_" + randomBytes(bytes).toString("base64");
}

function sign(raw, secret, { id = "msg_" + randomBytes(8).toString("hex"), timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const keyBytes = Buffer.from(secret.slice("whsec_".length), "base64");
  const content = Buffer.from(`${id}.${timestamp}.${raw}`, "utf8");
  const sig = createHmac("sha256", keyBytes).update(content).digest("base64");
  return { id, timestamp: String(timestamp), signatureHeader: `v1,${sig}` };
}

function deliveredPayload({ type = "email.delivered", emailId = "EMAIL_ID_SENT", to = ["RECIPIENT_SENT@example.com"], createdAt } = {}) {
  const payload = { type, data: { email_id: emailId, to } };
  if (createdAt !== undefined) payload.created_at = createdAt;
  return JSON.stringify(payload);
}

// Sentinel values used to seed and then assert non-leakage. None of these
// may appear in /health JSON, server logs, or any production-shaped output.
const RECIPIENT_SENT = "RECIPIENT_SENT@example.com";
const LICENSE_SENT = "LICENSE_SENTINEL_KEY";
const SECRETS_SENT = {
  apiKey: "RESEND_API_KEY_SENTINEL_VALUE",
  webhookSecret: "RESEND_WEBHOOK_SECRET_SENTINEL_VALUE",
};

// ── Phase 1: emailQueueHealth unit tests (RED-first against the spec) ────────

describe("emailQueueHealth(db, now=Date.now())", () => {
  test("validates a finite numeric timestamp argument", () => {
    const db = openDb(":memory:");
    expect(() => emailQueueHealth(db, NaN)).toThrow(TypeError);
    expect(() => emailQueueHealth(db, Infinity)).toThrow(TypeError);
    expect(() => emailQueueHealth(db, -Infinity)).toThrow(TypeError);
    expect(() => emailQueueHealth(db, "1000")).toThrow(TypeError);
    expect(() => emailQueueHealth(db, null)).toThrow(TypeError);
    db.close();
  });

  test("returns ONLY the documented primitive/null fields (no PII / no ids)", () => {
    const db = openDb(":memory:");
    const h = emailQueueHealth(db, 1700000000000);
    // Exact field set, order-independent:
    const keys = Object.keys(h).sort();
    expect(keys).toEqual(
      ["dead", "oldestDueAgeMs", "pending", "retry", "sending", "sentToday", "suppressed"]
    );
    expect(h.pending).toBe(0);
    expect(h.retry).toBe(0);
    expect(h.sending).toBe(0);
    expect(h.dead).toBe(0);
    expect(h.sentToday).toBe(0);
    expect(h.suppressed).toBe(0);
    expect(h.oldestDueAgeMs).toBeNull();
    // JSON-safe: round-trip without throwing, and no functions/dates leak.
    const round = JSON.parse(JSON.stringify(h));
    expect(round.pending).toBe(0);
    db.close();
  });

  test("counts outbox statuses correctly", () => {
    const db = openDb(":memory:");
    const now = 1700000000000;
    // Pending row.
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at)
       VALUES ('welcome', 'a@x.test', '{}', 'k-pending', 'pending', ?, ?)`
    ).run(now, now - 10_000);
    // Retry row.
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at)
       VALUES ('welcome', 'b@x.test', '{}', 'k-retry', 'retry', ?, ?)`
    ).run(now - 1_000, now - 30_000);
    // Sending row with an unexpired lease.
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at, lease_expires_at)
       VALUES ('welcome', 'c@x.test', '{}', 'k-sending', 'sending', 1, ?, ?, ?)`
    ).run(now, now - 5_000, now + 30_000);
    // Dead row.
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at)
       VALUES ('welcome', 'd@x.test', '{}', 'k-dead', 'dead', ?, ?)`
    ).run(now, now - 60_000);
    // Sent row today.
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at, sent_at)
       VALUES ('welcome', 'e@x.test', '{}', 'k-sent', 'sent', ?, ?, ?)`
    ).run(now, now - 1000, now - 500);
    // Suppression.
    db.query(
      `INSERT INTO email_suppressions (email, reason, created_at) VALUES ('f@x.test', 'bounced', ?)`
    ).run(now);

    const h = emailQueueHealth(db, now);
    expect(h.pending).toBe(1);
    expect(h.retry).toBe(1);
    expect(h.sending).toBe(1);
    expect(h.dead).toBe(1);
    expect(h.sentToday).toBe(1);
    expect(h.suppressed).toBe(1);
    db.close();
  });

  test("oldestDueAgeMs = max(0, now - MIN(created_at)) across pending/retry + expired sending; null when none due", () => {
    const db = openDb(":memory:");
    const now = 1700000000000;
    // None due → null.
    expect(emailQueueHealth(db, now).oldestDueAgeMs).toBeNull();

    // A pending row due 10s ago, a retry row due 30s ago → age should be 30000ms.
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at)
       VALUES ('welcome', 'a@x.test', '{}', 'k1', 'pending', ?, ?)`
    ).run(now - 10_000, now - 10_000);
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at)
       VALUES ('welcome', 'b@x.test', '{}', 'k2', 'retry', ?, ?)`
    ).run(now - 30_000, now - 30_000);
    expect(emailQueueHealth(db, now).oldestDueAgeMs).toBe(30_000);

    // Future-due row → not "due" so must be ignored.
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at)
       VALUES ('welcome', 'c@x.test', '{}', 'k3', 'pending', ?, ?)`
    ).run(now + 60_000, now + 60_000);
    // Still 30_000 because future-due rows are excluded.
    expect(emailQueueHealth(db, now).oldestDueAgeMs).toBe(30_000);

    // Adding a sending row whose lease has EXPIRED (so it's due) makes the
    // MIN(created_at) advance if that row is older.
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at, lease_expires_at)
       VALUES ('welcome', 'd@x.test', '{}', 'k4', 'sending', 1, ?, ?, ?)`
    ).run(now, now - 90_000, now - 1_000);
    expect(emailQueueHealth(db, now).oldestDueAgeMs).toBe(90_000);

    // A sending row whose lease is still unexpired is NOT due → ignored.
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at, lease_expires_at)
       VALUES ('welcome', 'e@x.test', '{}', 'k5', 'sending', 1, ?, ?, ?)`
    ).run(now, now - 5_000, now + 30_000);
    // still 90_000 (oldest still wins).
    expect(emailQueueHealth(db, now).oldestDueAgeMs).toBe(90_000);

    // Adding a pending row whose created_at is in the future (e.g. enqueued
    // with a backdated next_attempt_at of `now`) does NOT shift the oldest
    // when older due rows exist. Age is still bounded by the oldest MIN.
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at)
       VALUES ('welcome', 'f@x.test', '{}', 'k6', 'pending', ?, ?)`
    ).run(now, now + 5_000);
    // Still 90_000 — future created_at cannot make MIN less than 90_000 ago.
    expect(emailQueueHealth(db, now).oldestDueAgeMs).toBe(90_000);

    db.close();
  });

  test("sentToday is the UTC day of `now` (boundary-stable)", () => {
    const db = openDb(":memory:");
    // 1700000000000 = 2023-11-14 22:13:20 UTC.
    const noonUtc = 1700000000000;
    const dayStart = Date.UTC(2023, 10, 14); // Nov is 0-indexed → 10
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at, sent_at)
       VALUES ('welcome', 'a@x.test', '{}', 'k1', 'sent', ?, ?, ?)`
    ).run(noonUtc, dayStart, dayStart + 1_000); // exactly inside UTC day
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at, sent_at)
       VALUES ('welcome', 'b@x.test', '{}', 'k2', 'sent', ?, ?, ?)`
    ).run(noonUtc, dayStart - 1_000, dayStart - 1); // day BEFORE
    db.query(
      `INSERT INTO email_outbox (kind, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at, sent_at)
       VALUES ('welcome', 'c@x.test', '{}', 'k3', 'sent', ?, ?, ?)`
    ).run(noonUtc, dayStart, dayStart + 86_400_000 - 1); // last instant of day

    // A `now` inside the UTC day sees exactly 2 rows.
    expect(emailQueueHealth(db, noonUtc).sentToday).toBe(2);
    // A `now` from the previous day sees just the 1 inside that day.
    expect(emailQueueHealth(db, dayStart - 1_000).sentToday).toBe(1);
    db.close();
  });

  test("never includes sensitive keys (recipient, license, payload, error text)", () => {
    const db = openDb(":memory:");
    const now = 1700000000000;
    db.query(
      `INSERT INTO email_outbox (kind, license_key, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at, last_error)
       VALUES ('welcome', ?, ?, ?, 'k-sens', 'retry', ?, ?, ?)`
    ).run(
      LICENSE_SENT,
      RECIPIENT_SENT,
      JSON.stringify({ to: RECIPIENT_SENT, secret: "PAYLOAD_SECRET" }),
      now,
      now,
      "ERROR_TEXT_SENTINEL"
    );
    const h = emailQueueHealth(db, now);
    const blob = JSON.stringify(h);
    expect(blob).not.toContain(LICENSE_SENT);
    expect(blob).not.toContain(RECIPIENT_SENT);
    expect(blob).not.toContain("PAYLOAD_SECRET");
    expect(blob).not.toContain("ERROR_TEXT_SENTINEL");
    db.close();
  });
});

// ── Phase 2: server wiring (disabled-safe, signed webhook, PII-free health) ─

describe("server wiring — disabled-safe + signed webhook + PII-free /health", () => {
  let tmpDir;
  let dbPath;
  let port;
  let child;
  let stdoutBuf;
  let stderrBuf;

  function attach(childHandle) {
    stdoutBuf = "";
    stderrBuf = "";
    childHandle.stdout.on("data", (b) => {
      stdoutBuf += b.toString();
    });
    childHandle.stderr.on("data", (b) => {
      stderrBuf += b.toString();
    });
  }

  function findFreePort() {
    return new Promise((resolve, reject) => {
      const net = require("node:net");
      const s = net.createServer();
      s.listen(0, () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
      s.on("error", reject);
    });
  }

  function startServer(env) {
    // Spawn a real bun child running server/index.js with the env overlay.
    // A short pause after spawn gives Bun time to bind the port; we poll
    // /health until it answers 200.
    const proc = spawn("bun", [join(import.meta.dir, "..", "index.js")], {
      env: { ...process.env, ...env },
      cwd: join(import.meta.dir, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    attach(proc);
    return proc;
  }

  async function waitForHealth(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${port}/health`;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url);
        if (r.status === 200) return true;
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  async function killChild() {
    if (!child || child.killed) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 50));
    if (!child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  function seedOutboxPending() {
    // Seed the temp DB directly so the running server's /health can count it.
    const db = openDb(dbPath);
    const now = Date.now();
    db.query(
      `INSERT INTO email_outbox (kind, license_key, recipient_email, payload_json, idempotency_key, status, next_attempt_at, created_at)
       VALUES ('welcome', ?, ?, ?, 'seed-pending-1', 'pending', ?, ?)`
    ).run(LICENSE_SENT, RECIPIENT_SENT, "{}", now, now - 5_000);
    db.close();
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "qmp-email-int-"));
    dbPath = join(tmpDir, "license.db");
    port = await findFreePort();
  });

  afterEach(async () => {
    await killChild();
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test("blank RESEND_API_KEY → server starts; /health shows email disabled + no sentinels; no scheduler network", async () => {
    child = startServer({
      PORT: String(port),
      DB_PATH: dbPath,
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      // Exact public config names: valid custom values must be reflected.
      EMAIL_POLL_INTERVAL_MS: "1234",
      EMAIL_DRAIN_MAX_ITER: "7",
      EMAIL_LEASE_MS: "1.7",
      EMAIL_DAILY_CAP: "3",
      EMAIL_DAILY_WARN: "2",
      EMAIL_RETRY_BASE_MS: "abc",
      EMAIL_RETRY_MAX_MS: "",
      RESEND_API_KEY: "",
      RESEND_WEBHOOK_SECRET: SECRETS_SENT.webhookSecret,
      EMAIL_FROM: "FROM_SENT@example.com",
      EMAIL_REPLY_TO: "REPLY_SENT@example.com",
    });
    const ready = await waitForHealth();
    expect(ready).toBe(true);

    // Seed a pending row, then GET /health and assert email field.
    seedOutboxPending();

    const r = await fetch(`http://127.0.0.1:${port}/health`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.email).toBeDefined();
    expect(j.email.enabled).toBe(false);
    expect(j.email.running).toBe(false);
    expect(j.email.inFlight).toBe(false);
    expect(j.email.lastTickState).toBeNull();
    expect(j.email.lastTickAt).toBeNull();
    expect(j.email.healthErrors).toBe(0);
    // Runtime/config fields use the frozen environment names. Invalid
    // unrelated tunables still fall back without crashing.
    expect(j.email.intervalMs).toBe(1234);
    expect(j.email.drainMax).toBe(7);
    expect(j.email.dailyCap).toBe(3);
    expect(j.email.warnAt).toBe(2);
    expect(j.email.warnTriggered).toBe(false);
    // DB counts come through even when disabled.
    expect(j.email.pending).toBe(1);
    expect(j.email.retry).toBe(0);
    expect(j.email.sending).toBe(0);
    expect(j.email.dead).toBe(0);
    expect(j.email.suppressed).toBe(0);
    expect(typeof j.email.sentToday).toBe("number");
    expect(typeof j.email.oldestDueAgeMs).toBe("number");

    // No sentinels or secrets in the response.
    const blob = JSON.stringify(j);
    expect(blob).not.toContain(LICENSE_SENT);
    expect(blob).not.toContain(RECIPIENT_SENT);
    expect(blob).not.toContain(SECRETS_SENT.apiKey);
    expect(blob).not.toContain(SECRETS_SENT.webhookSecret);
    expect(blob).not.toContain("FROM_SENT@example.com");
    expect(blob).not.toContain("REPLY_SENT@example.com");

    // Server log lacks sentinels and any env value echoes.
    const logs = stdoutBuf + stderrBuf;
    expect(logs).not.toContain(SECRETS_SENT.apiKey);
    expect(logs).not.toContain(SECRETS_SENT.webhookSecret);
    expect(logs).not.toContain(LICENSE_SENT);
    expect(logs).not.toContain(RECIPIENT_SENT);
    expect(logs).toContain("[email] scheduler disabled");

    // The warning flag is derived from the queue count even while the
    // scheduler is disabled. Insert two sent rows in the current UTC day,
    // reaching warnAt=2 but staying below dailyCap=3.
    const warningDb = openDb(dbPath);
    const sentAt = Date.now();
    for (let i = 0; i < 2; i += 1) {
      warningDb.query(
        `INSERT INTO email_outbox
           (kind, recipient_email, payload_json, idempotency_key, status, attempts, next_attempt_at, created_at, sent_at)
         VALUES ('welcome', 'warn@example.com', '{}', ?, 'sent', 1, ?, ?, ?)`
      ).run(`warn-${i}`, sentAt, sentAt, sentAt);
    }
    warningDb.close();

    const warned = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(warned.email.sentToday).toBe(2);
    expect(warned.email.warnTriggered).toBe(true);
  });

  test("signed POST /api/resend/webhook records + suppresses + returns 200; missing/tampered → 400", async () => {
    const secret = makeSecret();
    child = startServer({
      PORT: String(port),
      DB_PATH: dbPath,
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      RESEND_API_KEY: SECRETS_SENT.apiKey,
      RESEND_WEBHOOK_SECRET: secret,
      EMAIL_FROM: "From <licenses@send.nimira-timer.com>",
      EMAIL_REPLY_TO: "support@nimira-timer.com",
    });
    const ready = await waitForHealth();
    expect(ready).toBe(true);

    const baseUrl = `http://127.0.0.1:${port}/api/resend/webhook`;

    // 1) Missing svix headers → 400.
    const missing = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: deliveredPayload({ type: "email.bounced" }),
    });
    expect(missing.status).toBe(400);
    const missingJson = await missing.json();
    expect(missingJson.error).toBe("webhook signature invalid");

    // 2) Signed bounce event → 200 + suppression recorded.
    const bounceRaw = deliveredPayload({ type: "email.bounced", emailId: "BOUNCED_PROVIDER_ID", to: [RECIPIENT_SENT] });
    const bounceSig = sign(bounceRaw, secret);
    const ok = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": bounceSig.id,
        "svix-timestamp": bounceSig.timestamp,
        "svix-signature": bounceSig.signatureHeader,
      },
      body: bounceRaw,
    });
    expect(ok.status).toBe(200);
    const okJson = await ok.json();
    expect(okJson).toEqual({ received: true, duplicate: false });

    // 3) Tampered body → 400.
    const deliveredRaw = deliveredPayload({ type: "email.delivered" });
    const sig = sign(deliveredRaw, secret);
    const tampered = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": sig.id,
        "svix-timestamp": sig.timestamp,
        "svix-signature": sig.signatureHeader,
      },
      body: deliveredRaw + " ", // mutated after signing
    });
    expect(tampered.status).toBe(400);

    // Suppression must be visible in the next /health call.
    const h = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    expect(h.email.suppressed).toBeGreaterThanOrEqual(1);

    // The running scheduler must NOT have made any network call (RESEND_API_KEY
    // is set but the scheduler is constructed with a disabled sender because
    // no real outbound should happen from this test). We assert the log line.
    const logs = stdoutBuf + stderrBuf;
    expect(logs).not.toContain("api.resend.com");
  });
});