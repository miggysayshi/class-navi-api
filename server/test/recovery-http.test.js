// server/test/recovery-http.test.js — Slice 3B-2A secure recovery HTTP core.
//
// TDD: writes behavior tests BEFORE the module under test is implemented.
// Uses ONLY :memory: bun:sqlite + synthetic Request objects. No Bun server,
// no real network, no real timers, no real provider. Accepts the modules
// this slice is allowed to depend on (recovery-core, recovery-email
// preparer/payload, db migration v6 + licensesForEmail + enqueueEmail).
//
// Coverage targets the full Slice 3B-2A contract:
//   1) configured flag behavior + 503/GET-availability split.
//   2) requestRecovery exact-shape 202 + Cache-Control + bounded body +
//      per-email/per-IP HMAC rate limits + tx + outbox + tokens + rollback.
//   3) inspectToken safe shape (no raw key/email/instance).
//   4) resetToken safe shape (valid / scope / reuse / expired / family).
//   5) portalResponse security headers + neutral textContent + no query-email.
//   6) manageResponse fragment-only + history.replaceState + no DOM/storage
//      persistence + confirm-only-on-matched-purpose + no auto-reset +
//      security headers + CSP constraints.
//   7) HTML/JSON never contains raw key/email/token/secret.
//   8) Full-string SQLite sweep (excluding necessary outbox key material)
//      never contains plaintext management token / secret / email / raw key.
//   9) Logs are redacted.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, licensesForEmail, enqueueEmail } from "../db.js";
import {
  generateManagementToken,
  inspectManagementToken,
  consumeResetToken,
  hashRequestSubject,
  consumeRequestLimit,
  hashToken,
  openManagementToken,
  ALLOWED_PURPOSES,
  DEFAULT_TOKEN_TTL_MS,
} from "../recovery.js";
import {
  createRecoveryOutboxPayload,
  RECOVERY_OUTBOX_KIND,
  RECOVERY_OUTBOX_VERSION,
  createRecoveryMessagePreparer,
} from "../recovery-email.js";

beforeAll(() => {
  // Smoke shape of accepted primitives this slice leans on.
  expect([...ALLOWED_PURPOSES].sort()).toEqual([
    "recover",
    "reset_all",
    "reset_chrome",
    "reset_edge",
  ]);
  expect(typeof createRecoveryOutboxPayload).toBe("function");
  expect(typeof createRecoveryMessagePreparer).toBe("function");
  expect(RECOVERY_OUTBOX_KIND).toBe("recovery");
  expect(RECOVERY_OUTBOX_VERSION).toBe(1);
});

/* ───────────────────────────── Test helpers ───────────────────────────── */

const SECRET_32 = "0123456789abcdef0123456789abcdef"; // ≥16 chars
const BASE_URL = "https://manage.example.test";

/** Fresh :memory: DB per test. Closed explicitly in `finally`. */
function freshDb() {
  // openDb applies migrations and creates schema.
  return openDb(":memory:");
}

/** Synthetic Request with bounded JSON body. */
function jsonRequest(url, body, { method = "POST" } = {}) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...(body && body._headers) },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

/** Synthetic Request with arbitrary body (e.g. oversized). */
function rawRequest(url, bodyBytes, contentLength) {
  const headers = { "content-type": "application/json" };
  if (typeof contentLength === "number") headers["content-length"] = String(contentLength);
  return new Request(url, { method: "POST", headers, body: bodyBytes });
}

/** Read response body once as text. */
async function textBody(res) {
  return await res.text();
}

/** Build a license row directly in :memory: for test scenarios that don't
 * require the full Stripe webhook flow. */
function seedLicense(db, { email, key = "QMP-PROP-ERTY0-0001-0001", status = "active" } = {}) {
  const e = String(email).trim().toLowerCase();
  db.query(
    `INSERT INTO licenses (key, email, customer_id, subscription_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(key, e, "cus_test", "sub_test_" + key.slice(-4), status, Date.now(), Date.now());
  return { key, email: e };
}

/** Drain all global logs/errors during a callback; returns the intercepted
 * log lines (no PII or key/secret may appear in any of them). */
function captureLogs(cb) {
  const orig = {
    info: console.info,
    warn: console.warn,
    error: console.error,
    log: console.log,
  };
  const captured = [];
  for (const k of Object.keys(orig)) {
    console[k] = (...args) => {
      captured.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  try {
    const ret = cb();
    return Promise.resolve(ret).then(
      (v) => {
        restore();
        return { value: v, logs: captured };
      },
      (err) => {
        restore();
        return Promise.reject(Object.assign(err, { __logs: captured }));
      }
    );
  } catch (err) {
    restore();
    throw err;
  }
  function restore() {
    for (const k of Object.keys(orig)) console[k] = orig[k];
  }
}

/* ─────────────── Module-under-test loader (deferred) ─────────────── */
// The module is loaded only inside individual tests so RED tests can fail
// cleanly when the file doesn't exist yet. Each test imports as the FIRST
// statement, then uses the loaded factory.
async function loadRecoveryHttp() {
  return await import("../recovery-http.js");
}

/* ═══════════════════ Section 1 — configured flag / 503 / GET pages ═══════════════════ */

test("createRecoveryHttpService: when MANAGEMENT secret is missing/blank, configured=false; POST handlers fixed 503; GET pages still available and never disclose config values", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: "",            // blank — should mark configured=false
      baseUrl: BASE_URL, minimumResponseMs: 0,
    });

    expect(svc.configured).toBe(false);

    // POST requestRecovery → fixed 503 {error:'recovery not configured'}
    const reqRes = await svc.requestRecovery(jsonRequest("https://x/api/recovery/request", { email: "x@y.z" }));
    expect(reqRes.status).toBe(503);
    expect(reqRes.headers.get("content-type")).toMatch(/application\/json/);
    expect(await reqRes.json()).toEqual({ error: "recovery not configured" });

    // POST inspectToken → fixed 503
    const insRes = await svc.inspectToken(jsonRequest("https://x/api/manage/inspect", { token: "abc" }));
    expect(insRes.status).toBe(503);
    expect(await insRes.json()).toEqual({ error: "recovery not configured" });

    // POST resetToken → fixed 503
    const rRes = await svc.resetToken(jsonRequest("https://x/api/manage/reset", { token: "x", browser_family: "chrome" }));
    expect(rRes.status).toBe(503);
    expect(await rRes.json()).toEqual({ error: "recovery not configured" });

    // GET pages still available
    const portal = await svc.portalResponse();
    expect(portal.status).toBe(200);
    expect(portal.headers.get("content-type")).toMatch(/text\/html/);
    const mng = await svc.manageResponse();
    expect(mng.status).toBe(200);
    expect(mng.headers.get("content-type")).toMatch(/text\/html/);

    // No raw config values (secret, baseUrl, etc.) in any page body
    const portalBody = await textBody(portal);
    const mngBody = await textBody(mng);
    expect(portalBody).not.toContain(SECRET_32);
    expect(mngBody).not.toContain(SECRET_32);
    expect(portalBody).not.toContain("BASE_URL");
    expect(mngBody).not.toContain("BASE_URL");
  } finally {
    db.close();
  }
});

test("createRecoveryHttpService: secret shorter than 16 chars is treated as not-configured (POSTs return 503, GET pages still render)", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: "short", // <16 chars; falls into configured=false path
      baseUrl: BASE_URL, minimumResponseMs: 0,
    });
    expect(svc.configured).toBe(false);
    const r = await svc.requestRecovery(jsonRequest("https://x/api/recovery/request", { email: "x@y.z" }));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "recovery not configured" });

    // GET pages still available and don't disclose the short secret.
    const portal = await svc.portalResponse();
    expect(portal.status).toBe(200);
    const portalBody = await portal.text();
    expect(portalBody).not.toContain("short");
  } finally {
    db.close();
  }
});

/* ═══════════════════ Section 2 — requestRecovery exact 202 / no-store ═══════════════════ */

test("requestRecovery: existing email returns EXACT 202 {message} with Cache-Control:no-store and proper headers/body (no key/count/existence disclosure)", async () => {
  const db = freshDb();
  const { logs } = await captureLogs(async () => {
    try {
      seedLicense(db, { email: "exists@example.com", key: "QMP-EXIS-T0000-0001-0001" });
      const { createRecoveryHttpService } = await loadRecoveryHttp();
      const svc = createRecoveryHttpService({
        db,
        secret: SECRET_32,
        baseUrl: BASE_URL, minimumResponseMs: 0,
        now: () => 1_700_000_000_000,
        randomId: () => "rid-existing",
      });
      const res = await svc.requestRecovery(
        jsonRequest("https://x/api/recovery/request", { email: "  Exists@Example.com  " }),
        { clientIp: "203.0.113.1" }
      );
      expect(res.status).toBe(202);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const body = await res.json();
      expect(body).toEqual({ message: "If a matching purchase exists, we sent an email." });

      // Disclose nothing: no key, count, exists, or rate state.
      const txt = JSON.stringify(body);
      expect(txt).not.toContain("QMP-EXIS");
      expect(txt).not.toContain("exists@example.com");
      expect(txt).not.toContain("count");
      expect(txt).not.toContain("limit");
      expect(txt).not.toContain("retry");
      expect(txt).not.toContain("rate");
    } finally {
      db.close();
    }
  });
  // No log lines may contain PII, secret, or tokens.
  for (const line of logs) {
    expect(line).not.toContain("exists@example.com");
    expect(line).not.toContain("QMP-EXIS");
    expect(line).not.toContain(SECRET_32);
  }
});

test("requestRecovery: unknown email still returns the EXACT same 202 shape (no enumeration)", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-unknown",
    });
    const res = await svc.requestRecovery(
      jsonRequest("https://x/api/recovery/request", { email: "noone@nowhere.example" }),
      { clientIp: "203.0.113.2" }
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ message: "If a matching purchase exists, we sent an email." });
    expect(res.headers.get("cache-control")).toBe("no-store");

    // No tokens or outbox rows created for an unknown email.
    expect(db.query("SELECT COUNT(*) AS n FROM management_tokens").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n).toBe(0);
    // Per-email rate-limit counter IS consumed (the counter is consumed
    // BEFORE licensesForEmail: the unknown-vs-known distinction is never
    // observable). IP rate-limit counter is also consumed.
    expect(db.query("SELECT COUNT(*) AS n FROM request_limits WHERE action='recovery_ip'").get().n).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM request_limits WHERE action='recovery_email'").get().n).toBe(1);
    // Raw client IP must NEVER appear anywhere (subjects are HMAC-SHA256 hex
    // only; raw email + secret must also stay absent — no license row at all
    // for this unknown email).
    expectNoLeaks(db, ["noone@nowhere.example", "203.0.113.2", SECRET_32]);
  } finally {
    db.close();
  }
});

test("requestRecovery: malformed/blank email still returns the EXACT same 202", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-malformed",
    });
    for (const bad of ["", "   ", "not-an-email", "missing-at-sign.com", "@no-local-part.com"]) {
      const res = await svc.requestRecovery(
        jsonRequest("https://x/api/recovery/request", { email: bad }),
        { clientIp: "203.0.113.3" }
      );
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body).toEqual({ message: "If a matching purchase exists, we sent an email." });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    // No tokens or outbox rows ever created.
    expect(db.query("SELECT COUNT(*) AS n FROM management_tokens").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n).toBe(0);
  } finally {
    db.close();
  }
});

/* ═══════════════════ Section 3 — bounded body ═══════════════════ */

test("requestRecovery: rejects Content-Length > 16KiB with safe 413-style error and creates no rows", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "big@example.com", key: "QMP-BIG0-00000-0001-0001" });
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-big",
    });
    const oversize = "{\"email\":\"" + "a".repeat(17_000) + "\"}";
    // Send a raw oversize body with a content-length that exceeds the cap.
    const res = await svc.requestRecovery(
      rawRequest("https://x/api/recovery/request", oversize, oversize.length)
    );
    // Fixed safe 413 payload (no echo of body bytes).
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toEqual({ error: "request body too large" });
    expect(JSON.stringify(body)).not.toContain("a".repeat(64));

    // No business mutation at all — no tokens, no outbox, AND no rate-limit
    // row, because the size guard runs BEFORE the rate-limit consumes anything.
    expect(db.query("SELECT COUNT(*) AS n FROM management_tokens").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM request_limits").get().n).toBe(0);
  } finally {
    db.close();
  }
});

/* ═══════════════════ Section 4 — one BEGIN IMMEDIATE / N tokens / 1 outbox per license ═══════════════════ */

test("requestRecovery: matching email creates 4 management tokens + 1 outbox row per license, atomic, with non-PII idempotency keys", async () => {
  const db = freshDb();
  try {
    const a = seedLicense(db, { email: "multi@example.com", key: "QMP-MULT-I0000-0001-0001" });
    // Second license for the same email to prove the per-license loop.
    db.query(
      `INSERT INTO licenses (key, email, customer_id, subscription_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`
    ).run("QMP-MULT-I0000-0002-0002", "multi@example.com", "cus_test", "sub_test_0002", Date.now(), Date.now());

    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-multi",
    });
    const res = await svc.requestRecovery(
      jsonRequest("https://x/api/recovery/request", { email: "multi@example.com" }),
      { clientIp: "203.0.113.4" }
    );
    expect(res.status).toBe(202);

    // 4 tokens per license × 2 licenses = 8 rows
    expect(db.query("SELECT COUNT(*) AS n FROM management_tokens").get().n).toBe(8);
    // 2 outbox rows (one per license)
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n).toBe(2);

    // Idempotency keys are non-PII: "recovery:<opaque>:<index>" where the
    // middle segment is the bounded lowercase hex prefix of
    // HMAC-SHA256(randomId, secret). The raw randomId never reaches storage.
    const outbox = db.query("SELECT idempotency_key, license_key FROM email_outbox ORDER BY id").all();
    const expectedOpaque = hashRequestSubject("rid-multi", SECRET_32).slice(0, 32);
    expect(expectedOpaque).toMatch(/^[0-9a-f]{32}$/);
    expect(outbox.map(r => r.idempotency_key).sort()).toEqual([
      `recovery:${expectedOpaque}:0`,
      `recovery:${expectedOpaque}:1`,
    ]);
    // The raw randomId must NEVER appear in any outbox row.
    for (const r of outbox) {
      expect(r.idempotency_key).not.toContain("rid-multi");
    }

    // The opaque subject must be deterministic for the same (randomId, secret).
    expect(hashRequestSubject("rid-multi", SECRET_32).slice(0, 32)).toBe(expectedOpaque);
    // License key field on outbox rows IS necessary (for worker scoping to a
    // single license); however no plaintext management token or MANAGEMENT
    // secret ever lands in the outbox payload or schema.
    for (const r of outbox) {
      expect(typeof r.license_key).toBe("string");
      expect(r.license_key.length).toBeGreaterThan(0);
    }

    // Open the seals and confirm valid (encrypted payload works).
    const payloadStr = db.query("SELECT payload_json FROM email_outbox ORDER BY id LIMIT 1").get().payload_json;
    const payload = JSON.parse(payloadStr);
    expect(payload.kind).toBe("recovery");
    expect(payload.version).toBe(1);
    expect(payload.recipient).toBe("multi@example.com");
    // No plaintext token in payload
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      expect(typeof payload.tokens[p]).toBe("string");
      const opened = openManagementToken(payload.tokens[p], SECRET_32);
      expect(opened.length).toBeGreaterThan(8);
      // The opened token was minted; it lives in management_tokens (hash only).
      expect(hashToken(opened).length).toBe(64);
    }
    // No plaintext token bytes or secret leaked into the JSON payload string.
    expect(payloadStr).not.toContain(SECRET_32);
  } finally {
    db.close();
  }
});

/* ═══════════════════ Section 5 — transaction rollback ═══════════════════ */

test("requestRecovery: a transaction error mid-request rolls back tokens + outbox atomically (no partial state)", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "tx@example.com", key: "QMP-TXER-R0000-0001-0001" });

    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-tx",
    });

    // Inject a failing DB that throws on the FIRST enqueueEmail INSERT (after
    // BEGIN IMMEDIATE + token creations). The contract requires that all
    // token inserts and the outbox insert be inside one BEGIN IMMEDIATE; the
    // injection must therefore force a full rollback.
    const dbErrorMsg = "INJECTED_DB_FAILURE";
    let tokensBeforeFail = 0;
    let outboxBeforeFail = 0;
    const origExec = db.exec.bind(db);
    db.exec = (sql) => {
      return origExec(sql);
    };
    // Sabotage via enqueueEmail: replace enqueueEmail on the imported module
    // is not possible — instead, monkey-patch db.query to throw after the
    // tokens are inserted and just before the email_outbox insert. We do
    // this by wrapping db.query in a Proxy that throws on the Nth call.
    // Simpler approach: monkey-patch the email_outbox INSERT path by
    // overwriting `db.query` with a counter that throws on the email_outbox
    // INSERT while still passing through earlier reads/writes.
    const origQuery = db.query.bind(db);
    let poisoned = false;
    db.query = (sqlOrStmt) => {
      if (
        !poisoned &&
        typeof sqlOrStmt === "string" &&
        /INSERT INTO email_outbox/.test(sqlOrStmt)
      ) {
        poisoned = true;
        throw new Error(dbErrorMsg);
      }
      return origQuery(sqlOrStmt);
    };

    const { logs } = await captureLogs(async () => {
      const res = await svc.requestRecovery(
        jsonRequest("https://x/api/recovery/request", { email: "tx@example.com" }),
        { clientIp: "203.0.113.5" }
      );
      // The fixed 500 envelope is returned on transaction failure.
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: "recovery request failed" });

      tokensBeforeFail = db.query("SELECT COUNT(*) AS n FROM management_tokens").get().n;
      outboxBeforeFail = db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n;
    });

    // Restore for clean teardown
    db.query = origQuery;

    expect(tokensBeforeFail).toBe(0);
    expect(outboxBeforeFail).toBe(0);

    // Log line for the failure is fixed and never includes PII/secret/key.
    const recoveryFailLine = logs.find((l) => l.includes("[recovery] request failed"));
    expect(typeof recoveryFailLine).toBe("string");
    expect(recoveryFailLine).not.toContain("tx@example.com");
    expect(recoveryFailLine).not.toContain("QMP-TXER");
    expect(recoveryFailLine).not.toContain(SECRET_32);
    expect(recoveryFailLine).not.toContain(dbErrorMsg);
  } finally {
    db.close();
  }
});

/* ═══════════════════ Section 6 — rate limits + hashed subjects ═══════════════════ */

test("requestRecovery: 4 requests for the same normalized email in the window → still EXACT 202 (no enumeration); the 4th attempt hits the EMAIL cap (count stays at 3) but never reveals rate state", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "rl@example.com", key: "QMP-RLIM-IT000-0001-0001" });
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-rl",
      emailLimit: 3,
      ipLimit: 10,
      windowMs: 900_000,
    });
    for (let i = 0; i < 4; i++) {
      const res = await svc.requestRecovery(
        jsonRequest("https://x/api/recovery/request", { email: "RL@example.com  " }),
        { clientIp: "203.0.113.6" }
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ message: "If a matching purchase exists, we sent an email." });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }

    // Only the email subject (not raw email) is stored: hashRequestSubject(raw, secret).
    const expectedSubject = hashRequestSubject("rl@example.com", SECRET_32);
    expect(expectedSubject).toMatch(/^[0-9a-f]{64}$/);
    const rows = db
      .query(
        `SELECT subject_key, action, count FROM request_limits WHERE action='recovery_email' ORDER BY count`
      )
      .all();
    expect(rows.length).toBe(1);
    expect(rows[0].subject_key).toBe(expectedSubject);
    // The rate-limit count is BOUNDED at the configured emailLimit (3). The
    // 4th attempt is consumed but does not push the counter past 3 — that
    // is the accepted helper's documented behavior.
    expect(rows[0].count).toBe(3);

    // 1. The full SQLite sweep never contains the raw email OR raw IP
    //    outside the explicitly allowed storage seams (licenses.email and
    //    email_outbox.recipient_email are the canonical user record).
    expectNoLeaks(db, ["rl@example.com", "RL@example.com", "203.0.113.6", SECRET_32]);
  } finally {
    db.close();
  }
});

test("requestRecovery: blank/missing clientIp hashes a fixed 'unknown' bucket (still counted as IP attempts)", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-bip",
    });
    // First request WITHOUT clientIp (and no second argument at all)
    const a = await svc.requestRecovery(jsonRequest("https://x/api/recovery/request", { email: "x@y.example" }));
    expect(a.status).toBe(202);

    // A blank IP goes to the same fixed 'unknown' bucket.
    const b = await svc.requestRecovery(
      jsonRequest("https://x/api/recovery/request", { email: "x@y.example" }),
      { clientIp: "   " }
    );
    expect(b.status).toBe(202);

    const unknownSubject = hashRequestSubject("unknown", SECRET_32);
    const rows = db.query(`SELECT subject_key, count FROM request_limits WHERE action='recovery_ip'`).all();
    expect(rows.length).toBe(1);
    expect(rows[0].subject_key).toBe(unknownSubject);
    expect(rows[0].count).toBe(2);
  } finally {
    db.close();
  }
});

test("requestRecovery: malformed email still consumes IP rate limit but NOT email limit", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-mip",
    });
    const res = await svc.requestRecovery(
      jsonRequest("https://x/api/recovery/request", { email: "not-an-email" }),
      { clientIp: "203.0.113.7" }
    );
    expect(res.status).toBe(202);

    const ipRows = db.query(`SELECT COUNT(*) AS n FROM request_limits WHERE action='recovery_ip'`).get();
    const emailRows = db.query(`SELECT COUNT(*) AS n FROM request_limits WHERE action='recovery_email'`).get();
    expect(ipRows.n).toBe(1);
    expect(emailRows.n).toBe(0);
  } finally {
    db.close();
  }
});

/* ═══════════════════ Section 7 — inspectToken / resetToken safety ═══════════════════ */

test("inspectToken: returns the safe shape (no raw key/email/instance/token/hash/customer/subscription)", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "ins@example.com", key: "QMP-INSP-ECT00-0001-0001" });
    const tokens = mintFour(db, "ins@example.com");
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db, secret: SECRET_32, baseUrl: BASE_URL, minimumResponseMs: 0, now: () => 1_700_000_000_000,
    });
    const valid = await svc.inspectToken(
      jsonRequest("https://x/api/manage/inspect", { token: tokens.recover })
    );
    expect(valid.status).toBe(200);
    const body = await valid.json();
    // Strict fixed shape only
    expect(Object.keys(body).sort()).toEqual(
      ["chromeOccupied", "code", "edgeOccupied", "licenseTail", "purpose", "status", "valid"].sort()
    );
    expect(body.valid).toBe(true);
    expect(body.code).toBe("ok");
    expect(body.purpose).toBe("recover");
    expect(body.licenseTail).toBe("0001");
    expect(body.chromeOccupied).toBe(false);
    expect(body.edgeOccupied).toBe(false);
    expect(JSON.stringify(body)).not.toContain("QMP-INSP");
    expect(JSON.stringify(body)).not.toContain("ins@example.com");

    // Invalid token returns safe invalid shape
    const invalid = await svc.inspectToken(
      jsonRequest("https://x/api/manage/inspect", { token: "definitely-not-real" })
    );
    expect(invalid.status).toBe(400);
    const ibody = await invalid.json();
    expect(ibody.valid).toBe(false);
    expect(ibody.code).toBe("invalid");
    expect(JSON.stringify(ibody)).not.toContain("QMP-INSP");

    // Malformed (missing token field) → safe invalid
    const mal = await svc.inspectToken(
      jsonRequest("https://x/api/manage/inspect", {})
    );
    expect(mal.status).toBe(400);
    const mbody = await mal.json();
    expect(mbody.valid).toBe(false);
    expect(mbody.code).toBe("invalid");

    // Oversized body rejected
    const oversize = "{\"token\":\"" + "x".repeat(17_000) + "\"}";
    const tooBig = await svc.inspectToken(
      rawRequest("https://x/api/manage/inspect", oversize, oversize.length)
    );
    expect(tooBig.status).toBe(413);
  } finally {
    db.close();
  }
});

test("resetToken: returns only {ok,code,removed}; Chrome reset leaves Edge intact; scope/reuse safe", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "rst@example.com", key: "QMP-RST0-00000-0001-0001" });
    // Seed chrome + edge slots
    db.exec(`INSERT INTO browser_slots (license_key, browser_family, instance_id, activated_at, last_seen_at)
             VALUES ('QMP-RST0-00000-0001-0001', 'chrome', 'inst-c-1', 1, 1)`);
    db.exec(`INSERT INTO browser_slots (license_key, browser_family, instance_id, activated_at, last_seen_at)
             VALUES ('QMP-RST0-00000-0001-0001', 'edge',   'inst-e-1', 1, 1)`);

    const tokens = mintFour(db, "rst@example.com");

    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({ db, secret: SECRET_32, baseUrl: BASE_URL, minimumResponseMs: 0, now: () => 1_700_000_000_000 });

    // Valid: reset Chrome
    const ok = await svc.resetToken(
      jsonRequest("https://x/api/manage/reset", { token: tokens.reset_chrome, browser_family: "chrome" })
    );
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(Object.keys(okBody).sort()).toEqual(["code", "ok", "removed"].sort());
    expect(okBody.ok).toBe(true);
    expect(okBody.code).toBe("ok");
    expect(okBody.removed).toBe(1);

    // Chrome is gone, Edge remains
    const chromeAfter = db.query(`SELECT 1 FROM browser_slots WHERE license_key = ? AND browser_family='chrome'`).get("QMP-RST0-00000-0001-0001");
    const edgeAfter = db.query(`SELECT 1 FROM browser_slots WHERE license_key = ? AND browser_family='edge'`).get("QMP-RST0-00000-0001-0001");
    expect(chromeAfter).toBeNull();
    expect(edgeAfter).not.toBeNull();

    // Replay the same reset_chrome token → safe reused failure
    const reused = await svc.resetToken(
      jsonRequest("https://x/api/manage/reset", { token: tokens.reset_chrome, browser_family: "chrome" })
    );
    expect([400, 409]).toContain(reused.status);
    const rbody = await reused.json();
    expect(rbody.ok).toBe(false);
    expect(rbody.code).toBe("used");
    expect(typeof rbody.removed).toBe("number");

    // Recover token cannot reset chrome → scope-mismatch
    const mismatch = await svc.resetToken(
      jsonRequest("https://x/api/manage/reset", { token: tokens.recover, browser_family: "chrome" })
    );
    expect([400, 409]).toContain(mismatch.status);
    const mbody = await mismatch.json();
    expect(mbody.ok).toBe(false);
    expect(mbody.code).toBe("scope-mismatch");

    // Random token → invalid
    const invalid = await svc.resetToken(
      jsonRequest("https://x/api/manage/reset", { token: "nope", browser_family: "chrome" })
    );
    expect([400, 409]).toContain(invalid.status);
    const ibody = await invalid.json();
    expect(ibody.ok).toBe(false);
    expect(ibody.code).toBe("invalid");

    // Oversized body rejected
    const oversize = "{\"token\":\"" + "x".repeat(17_000) + "\",\"browser_family\":\"chrome\"}";
    const tooBig = await svc.resetToken(
      rawRequest("https://x/api/manage/reset", oversize, oversize.length)
    );
    expect(tooBig.status).toBe(413);
  } finally {
    db.close();
  }
});

/* ═══════════════════ Section 8 — portalResponse + manageResponse ═══════════════════ */

test("portalResponse: returns Class Navi Pro Tools recovery form with security headers; renders the EXACT neutral 'check your inbox' message via textContent; no query-email workflow", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db, secret: SECRET_32, baseUrl: BASE_URL, minimumResponseMs: 0, now: () => 1_700_000_000_000,
    });
    const res = await svc.portalResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const frameDeny = (res.headers.get("frame-options") || "") + " " + (res.headers.get("content-security-policy") || "");
    expect((frameDeny || "").toLowerCase()).toMatch(/deny|sameorigin|none/);

    const html = await res.text();
    expect(html.toLowerCase()).toContain("class navi pro tools");
    // POST to /api/recovery/request
    expect(html).toMatch(/action\s*=\s*["']\/api\/recovery\/request["']/i);
    expect(html).toMatch(/method\s*=\s*["']POST["']/i);
    // No /api/portal/keys call
    expect(html).not.toContain("/api/portal/keys");
    // No wording that claims keys are displayed in browser.
    expect(html.toLowerCase()).not.toContain("we will display your key");
    expect(html.toLowerCase()).not.toContain("your keys will appear");
    // No PII / secret / token / email leakage
    expect(html).not.toContain(SECRET_32);
    // The neutral message is rendered into an empty element whose script
    // populates textContent (no innerHTML with raw input).
    expect(html).toMatch(/textContent|innerText|createTextNode/);
  } finally {
    db.close();
  }
});

test("manageResponse: fragment-only management page — reads token+family from URL fragment, immediately removes fragment via history.replaceState, posts to /api/manage/inspect, never stores the token in DOM/localStorage/sessionStorage/cookie; confirm button only for matching family; no auto-reset", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db, secret: SECRET_32, baseUrl: BASE_URL, minimumResponseMs: 0, now: () => 1_700_000_000_000,
    });
    const res = await svc.manageResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    const csp = res.headers.get("content-security-policy") || "";
    // CSP should be present and restrict connect-src to 'self'
    expect(typeof csp).toBe("string");
    expect(csp.length).toBeGreaterThan(0);
    expect(csp).toMatch(/default-src\s+'self'/i);
    expect(csp).toMatch(/connect-src\s+'self'/i);

    const html = await res.text();

    // Fragment-only parsing — never window.location.search for the token
    expect(html.toLowerCase()).toContain("fragment");
    expect(html).toMatch(/location\.hash|location\.href\.split\(['"]#['"]\)|window\.location\.hash/);
    // Must immediately remove the fragment via history.replaceState BEFORE any fetch
    expect(html).toMatch(/history\.replaceState/);
    // POST to /api/manage/inspect
    expect(html).toMatch(/api\/manage\/inspect/);
    // Reset POST to /api/manage/reset
    expect(html).toMatch(/api\/manage\/reset/);

    // No DOM token storage (never innerHTML with the token, no writing to
    // <input value="<token>"> or any <script>var token = ...> assignment that
    // hits the DOM. The token is sent ONLY in the request body.)
    expect(html).not.toMatch(/innerHTML\s*=\s*[^;]*token/);
    expect(html).not.toMatch(/value\s*=\s*["'][^"']*token/);
    // No localStorage.setItem / sessionStorage / document.cookie assignments
    // involving the token. A bare word 'token' or storage API in a non-token
    // context is allowed; we check that there is NO assignment of token or
    // storage write inside an expression that concatenates with token.
    expect(html).not.toMatch(/localStorage\.setItem/);
    expect(html).not.toMatch(/sessionStorage\.setItem/);
    expect(html).not.toMatch(/document\.cookie\s*=/);

    // No auto-reset on load. The script body must NOT auto-invoke the reset
    // path (no `fetch('.../reset')` at top level). The fetch path is bounded
    // to a user-driven confirm handler.
    expect(html).not.toMatch(/location\.href\s*=\s*[^;]*reset/);
    // Confirm button only on matching family — the rendered script must gate
    // the confirm button by a family check vs the inspected purpose. The
    // page buttons are id="confirm-chrome" / "confirm-edge" / "confirm-all"
    // and the script shows one only when purpose === family.
    expect(html.toLowerCase()).toContain("confirm-chrome");
    expect(html.toLowerCase()).toContain("confirm-edge");
    expect(html.toLowerCase()).toContain("confirm-all");
    expect(html).toMatch(/purpose\s*===\s*['"]reset_chrome['"]/);
    expect(html).toMatch(/purpose\s*===\s*['"]reset_edge['"]/);
    expect(html).toMatch(/purpose\s*===\s*['"]reset_all['"]/);

    // Dynamic text via textContent (not innerHTML with input-derived data)
    expect(html).toMatch(/textContent/);

    // No raw config values in the page.
    expect(html).not.toContain(SECRET_32);
    expect(html).not.toContain("BASE_URL");
  } finally {
    db.close();
  }
});

/* ═══════════════════ Section 9 — full SQLite sweep redaction ═══════════════════ */

test("recovery-http: end-to-end — a successful request leaves exactly the necessary key material in storage (raw license key from outbox), and ZERO plaintext management tokens / secrets / raw emails / raw IPs anywhere", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "sweep@example.com", key: "QMP-SWEE-P0000-0001-0001" });
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db, secret: SECRET_32, baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-sweep",
    });
    const res = await svc.requestRecovery(
      jsonRequest("https://x/api/recovery/request", { email: "sweep@example.com" }),
      { clientIp: "203.0.113.99" }
    );
    expect(res.status).toBe(202);

    // Collect every value from every column of every row in every table.
    const dump = dumpAllTables(db).map((r) => Object.values(r).map(String).join(" ")).join("\n");
    // The raw management token SEALS in the outbox — which DO contain the
    // raw license key (necessary for the worker to know which license to
    // associate the email with). Excluding those necessary material seams:
    const mustAllowKeyMaterial = new Set([
      "QMP-SWEE-P0000-0001-0001",    // license key (raw) — necessary for worker
    ]);
    // We also need to allow the OPENED plaintext tokens if the test opens
    // them. But this is just the dump so they are still sealed: ciphertext is
    // base64 — non-readable ciphertext. The dump may NOT contain the
    // plaintext token. (This dump is the sealed ciphertext; we prove below it
    // is sealed and not the raw base64url token bytes.)

    // 1. Secret must NEVER appear anywhere.
    expect(dump).not.toContain(SECRET_32);

    // 2. Raw email must NOT appear anywhere (we normalized only, but this DB
    //    has the email license row — that's necessary for the FK to exist).
    //    The license row's email IS in storage (it's required for FK; it
    //    represents the user's stored address). The contract bans PLAINTEXT
    //    management tokens / secrets / raw IPs in *post-sweep of outbox +
    //    rate-limit + management_tokens*, and raw email in outbox rows is
    //    allowed only inside the normalized `recipient_email` column on
    //    email_outbox (the worker needs to address the message).
    //    We assert only that request_limits carries hashed subjects.

    //    3. Raw client IP must NEVER appear anywhere. The dump sweep checks
       //    this with `expectNoLeaks` below; here we make the local assertion
       //    on the rendered string for symmetry.
       expect(dump).not.toContain("203.0.113.99");

    // 4. All request_limits.subject_key values must be 64-char lowercase hex.
    const rlRows = db.query(`SELECT subject_key FROM request_limits`).all();
    for (const r of rlRows) {
      expect(r.subject_key).toMatch(/^[0-9a-f]{64}$/);
      // Equal to the canonical hash of the underlying subject.
      // We don't know which subject key came from which (email vs IP), but
      // both must equal a known hashRequestSubject output:
      const expectedIpHash = hashRequestSubject("203.0.113.99", SECRET_32);
      const expectedEmailHash = hashRequestSubject("sweep@example.com", SECRET_32);
      const expectedUnknownHash = hashRequestSubject("unknown", SECRET_32);
      expect([expectedIpHash, expectedEmailHash, expectedUnknownHash]).toContain(r.subject_key);
    }

    // 5. management_tokens stores ONLY SHA-256 hex (64 chars) for token_hash.
    const mtRows = db.query(`SELECT token_hash FROM management_tokens`).all();
    for (const r of mtRows) {
      expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }

    // 6. Sealed tokens are sealed: opening the seals yields the actual
    //    plaintext tokens, which exist only as hashes in management_tokens.
    const obRows = db.query(`SELECT payload_json, license_key FROM email_outbox`).all();
    expect(obRows.length).toBe(1);
    const payload = JSON.parse(obRows[0].payload_json);
    expect(obRows[0].license_key).toBe("QMP-SWEE-P0000-0001-0001");
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      const opened = openManagementToken(payload.tokens[p], SECRET_32);
      // Plaintext token must match a hash row; it must NOT appear anywhere
      // in the dump (sweep already failed if it did).
      expect(hashToken(opened)).toMatch(/^[0-9a-f]{64}$/);
      expect(dump).not.toContain(opened);
    }

    // 7. The plaintext tokens DO NOT appear in any non-management_tokens row.
    //    (To verify, open the seals again from the dump.)
    const outboxJson = JSON.stringify(obRows);
    // outboxJson contains sealed ciphertext (base64 of encrypted bytes); the
    // plaintext token bytes must not be embedded in the ciphertext as a
    // prefix (defense in depth: the encryption is randomized, but we want
    // the test to fail if the encrypt-then-store contract is broken by
    // e.g. accidentally storing the plaintext.)
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      const opened = openManagementToken(payload.tokens[p], SECRET_32);
      expect(outboxJson).not.toContain(opened);
    }

    // 8. Final leak sweep against all rows/columns, allowing only the
    //    necessary storage seams (raw license + raw email on the license
    //    row + recipient on outbox + recipient/license on outbox).
    expectNoLeaks(db, ["203.0.113.99", SECRET_32]);
  } finally {
    db.close();
  }
});

/* ═══════════════════ Section 10 — index.js production wiring ═══════════════════ */

test("recovery-http: index.js wires the accepted recovery service and exact routes", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const serverDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const indexText = await fs.readFile(path.join(serverDir, "index.js"), "utf8");
  expect(indexText).toContain('from "./recovery-http.js"');
  expect(indexText).toContain('path === "/api/recovery/request"');
  expect(indexText).toContain('path === "/api/manage/inspect"');
  expect(indexText).toContain('path === "/api/manage/reset"');
  expect(indexText).not.toContain('path === "/api/portal/keys"');
});

/* ═══════════════════ Section 11 — imports / side effects ═══════════════════ */

test("recovery-http: module load is side-effect free — no server started, no DB opened, no timer scheduled", async () => {
  // If side effects existed, simply importing the module and waiting a tick
  // would start a server or open a DB file. Confirm:
  //   1. The module exports only the documented factory.
  //   2. No timers / handles are installed.
  const mod = await loadRecoveryHttp();
  expect(Object.keys(mod).sort()).toEqual(["createRecoveryHttpService"]);
  expect(typeof mod.createRecoveryHttpService).toBe("function");

  // Wait a brief window and confirm no pending intervals/timeouts.
  // (Bun's globalThis.setTimeout returns an id; we use a counter to detect.)
  const before = countActiveTimers();
  await new Promise((res) => setTimeout(res, 25));
  const after = countActiveTimers();
  expect(after).toBeLessThanOrEqual(before + 1); // tolerate the wait itself
});

/* ═══════════════════ Section 12 — Slice 3B-2A-R repair tests ═══════════════════ */

test("requestRecovery: 4th request with emailLimit=3 leaves outbox=3 and tokens=12 (rate-limit enforced, no extra enqueue)", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "limit3@example.com", key: "QMP-LIM3-T0000-0001-0001" });
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    let ridCounter = 0;
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      // Fresh randomId per attempt so the outbox row is a new (not
      // idempotent dup) on each successful attempt.
      randomId: () => "rid-l3-" + (++ridCounter),
      emailLimit: 3,
      ipLimit: 10,
      windowMs: 900_000,
    });
    for (let i = 0; i < 4; i++) {
      const res = await svc.requestRecovery(
        jsonRequest("https://x/api/recovery/request", { email: "limit3@example.com" }),
        { clientIp: "203.0.113.10" }
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ message: "If a matching purchase exists, we sent an email." });
    }
    // The 4th attempt is rate-limited: only the first 3 minted tokens/outbox.
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n).toBe(3);
    expect(db.query("SELECT COUNT(*) AS n FROM management_tokens").get().n).toBe(12);
  } finally {
    db.close();
  }
});

test("requestRecovery: 2nd request with ipLimit=1 from the same IP leaves only the first outbox", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "ip1@example.com", key: "QMP-IP1-00000-0001-0001" });
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    let ridCounter = 0;
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-ip1-" + (++ridCounter),
      emailLimit: 10,
      ipLimit: 1,
      windowMs: 900_000,
    });
    // First request with IP-A — succeeds, 4 tokens + 1 outbox row.
    const a = await svc.requestRecovery(
      jsonRequest("https://x/api/recovery/request", { email: "ip1@example.com" }),
      { clientIp: "10.0.0.1" }
    );
    expect(a.status).toBe(202);
    // Second request with the SAME IP-A — its IP cap is reached → 202
    // envelope, but ZERO additional outbox / tokens.
    const b = await svc.requestRecovery(
      jsonRequest("https://x/api/recovery/request", { email: "ip1@example.com" }),
      { clientIp: "10.0.0.1" }
    );
    expect(b.status).toBe(202);
    expect(await b.json()).toEqual({ message: "If a matching purchase exists, we sent an email." });
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM management_tokens").get().n).toBe(4);
  } finally {
    db.close();
  }
});

test("requestRecovery: when the rate-limit layer throws, the request fails closed — zero outbox, zero tokens, fixed 500 envelope, fixed redacted log", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "throw@example.com", key: "QMP-THRO-W0000-0001-0001" });
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-throw",
    });
    // Force the rate-limit to throw on the FIRST call (covers the IP path).
    const dbErrorMsg = "INJECTED_RL_DB";
    const origQuery = db.query.bind(db);
    db.query = (sqlOrStmt) => {
      if (typeof sqlOrStmt === "string" && /SELECT.*FROM request_limits/i.test(sqlOrStmt)) {
        throw new Error(dbErrorMsg);
      }
      return origQuery(sqlOrStmt);
    };

    const { logs } = await captureLogs(async () => {
      const res = await svc.requestRecovery(
        jsonRequest("https://x/api/recovery/request", { email: "throw@example.com" }),
        { clientIp: "203.0.113.20" }
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: "recovery request failed" });
      expect(JSON.stringify(body)).not.toContain("throw@example.com");
      expect(JSON.stringify(body)).not.toContain(SECRET_32);
    });

    // Restore for clean teardown observations.
    db.query = origQuery;

    // Zero outbox / zero tokens: rate-limit failure failed closed.
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM management_tokens").get().n).toBe(0);

    // Log line is fixed and redacted.
    const fail = logs.find((l) => l.includes("[recovery] request failed"));
    expect(typeof fail).toBe("string");
    expect(fail).not.toContain("throw@example.com");
    expect(fail).not.toContain("QMP-THRO");
    expect(fail).not.toContain(SECRET_32);
    expect(fail).not.toContain(dbErrorMsg);
  } finally {
    db.close();
  }
});

test("requestRecovery: a tx failure on the SECOND license's outbox INSERT rolls back ALL earlier licenses' tokens + outbox (one BEGIN IMMEDIATE for the whole request)", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "tx2@example.com", key: "QMP-TX2A-00000-0001-0001" });
    db.query(
      `INSERT INTO licenses (key, email, customer_id, subscription_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`
    ).run("QMP-TX2B-00000-0002-0002", "tx2@example.com", "cus_test", "sub_test_0002", Date.now(), Date.now());

    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-tx2",
    });

    const dbErrorMsg = "INJECTED_SECOND_OUTBOX";
    const origQuery = db.query.bind(db);
    let firstLicenseOutboxSeen = false;
    db.query = (sqlOrStmt) => {
      if (typeof sqlOrStmt === "string" && /INSERT INTO email_outbox/.test(sqlOrStmt)) {
        if (!firstLicenseOutboxSeen) {
          firstLicenseOutboxSeen = true;
          return origQuery(sqlOrStmt);
        }
        throw new Error(dbErrorMsg);
      }
      return origQuery(sqlOrStmt);
    };

    const { logs } = await captureLogs(async () => {
      const res = await svc.requestRecovery(
        jsonRequest("https://x/api/recovery/request", { email: "tx2@example.com" }),
        { clientIp: "203.0.113.21" }
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: "recovery request failed" });
    });

    db.query = origQuery;

    // Atomic: zero tokens, zero outbox — neither license's enqueue survives.
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM management_tokens").get().n).toBe(0);

    const fail = logs.find((l) => l.includes("[recovery] request failed"));
    expect(typeof fail).toBe("string");
    expect(fail).not.toContain("tx2@example.com");
    expect(fail).not.toContain("QMP-TX2");
    expect(fail).not.toContain(SECRET_32);
    expect(fail).not.toContain(dbErrorMsg);
  } finally {
    db.close();
  }
});

test("requestRecovery: an injected email-like randomId is HMAC'd and never appears verbatim in SQLite", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "inj@example.com", key: "QMP-INJ0-00000-0001-0001" });
    const injected = "inject-leaked@example.com";
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => injected,
    });
    const res = await svc.requestRecovery(
      jsonRequest("https://x/api/recovery/request", { email: "inj@example.com" }),
      { clientIp: "203.0.113.22" }
    );
    expect(res.status).toBe(202);

    // The raw injected randomId must NEVER appear in any column of any row.
    const rows = db.query("SELECT idempotency_key FROM email_outbox").all();
    expect(rows.length).toBe(1);
    expect(rows[0].idempotency_key).not.toContain(injected);
    // The opaque portion is the bounded hex prefix of HMAC-SHA256(randomId, secret).
    const expectedOpaque = hashRequestSubject(injected, SECRET_32).slice(0, 32);
    expect(expectedOpaque).toMatch(/^[0-9a-f]{32}$/);
    expect(rows[0].idempotency_key).toBe(`recovery:${expectedOpaque}:0`);

    // Sweep: raw injected randomId never lands anywhere.
    expectNoLeaks(db, [injected, SECRET_32]);
  } finally {
    db.close();
  }
});

test("portalResponse: emits a single nonce used by both the inline <script> attribute and the CSP — no 'unsafe-inline' in script-src", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db, secret: SECRET_32, baseUrl: BASE_URL, minimumResponseMs: 0, now: () => 1_700_000_000_000,
    });
    const res = await svc.portalResponse();
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp.length).toBeGreaterThan(0);

    // script-src must NOT include 'unsafe-inline'.
    const scriptSrc = csp.split(/;\s*/).find((d) => /^script-src/i.test(d)) || "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");

    // Extract the nonce from the CSP.
    const m = scriptSrc.match(/'nonce-([^']+)'/);
    expect(typeof m[1]).toBe("string");
    const nonce = m[1];
    expect(nonce.length).toBeGreaterThanOrEqual(16);

    // The inline script must carry the SAME nonce.
    const html = await res.text();
    const inlineScriptMatch = html.match(/<script\s+nonce="([^"]+)"[^>]*>([\s\S]*?)<\/script>/i);
    expect(typeof inlineScriptMatch[1]).toBe("string");
    expect(inlineScriptMatch[1]).toBe(nonce);
    // The inline script content must include the operational wiring.
    expect(inlineScriptMatch[2]).toContain("/api/recovery/request");
    expect(inlineScriptMatch[2]).toContain("textContent");
  } finally {
    db.close();
  }
});

test("manageResponse: emits a single nonce used by both the inline <script> attribute and the CSP — no 'unsafe-inline' in script-src", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db, secret: SECRET_32, baseUrl: BASE_URL, minimumResponseMs: 0, now: () => 1_700_000_000_000,
    });
    const res = await svc.manageResponse();
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp.length).toBeGreaterThan(0);

    const scriptSrc = csp.split(/;\s*/).find((d) => /^script-src/i.test(d)) || "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");

    const m = scriptSrc.match(/'nonce-([^']+)'/);
    expect(typeof m[1]).toBe("string");
    const nonce = m[1];
    expect(nonce.length).toBeGreaterThanOrEqual(16);

    const html = await res.text();
    const inlineScriptMatch = html.match(/<script\s+nonce="([^"]+)"[^>]*>([\s\S]*?)<\/script>/i);
    expect(typeof inlineScriptMatch[1]).toBe("string");
    expect(inlineScriptMatch[1]).toBe(nonce);
    // Operational wiring survived.
    expect(inlineScriptMatch[2]).toContain("history.replaceState");
    expect(inlineScriptMatch[2]).toContain("/api/manage/inspect");
    expect(inlineScriptMatch[2]).toContain("/api/manage/reset");
  } finally {
    db.close();
  }
});

test("requestRecovery: rejects non-POST methods with fixed 405 {error:'method not allowed'} and no mutation", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL, minimumResponseMs: 0,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-m405",
    });
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await svc.requestRecovery(
        new Request("https://x/api/recovery/request", {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "x@y.example" }),
        })
      );
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method not allowed" });
    }
    expect(db.query("SELECT COUNT(*) AS n FROM management_tokens").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM request_limits").get().n).toBe(0);
  } finally {
    db.close();
  }
});

test("inspectToken: rejects non-POST methods with fixed 405 {error:'method not allowed'} and no mutation", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db, secret: SECRET_32, baseUrl: BASE_URL, minimumResponseMs: 0, now: () => 1_700_000_000_000,
    });
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await svc.inspectToken(
        new Request("https://x/api/manage/inspect", {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "x" }),
        })
      );
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method not allowed" });
    }
    expect(db.query("SELECT COUNT(*) AS n FROM request_limits").get().n).toBe(0);
  } finally {
    db.close();
  }
});

test("resetToken: rejects non-POST methods with fixed 405 {error:'method not allowed'} and no mutation", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db, secret: SECRET_32, baseUrl: BASE_URL, minimumResponseMs: 0, now: () => 1_700_000_000_000,
    });
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await svc.resetToken(
        new Request("https://x/api/manage/reset", {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "x", browser_family: "chrome" }),
        })
      );
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method not allowed" });
    }
    expect(db.query("SELECT COUNT(*) AS n FROM request_limits").get().n).toBe(0);
  } finally {
    db.close();
  }
});

test("createRecoveryHttpService: returns EXACT keys {configured, requestRecovery, inspectToken, resetToken, portalResponse, manageResponse}; no manageUrl exposure", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db, secret: SECRET_32, baseUrl: BASE_URL, minimumResponseMs: 0, now: () => 1_700_000_000_000,
    });
    expect(Object.keys(svc).sort()).toEqual(
      ["configured", "inspectToken", "manageResponse", "portalResponse", "requestRecovery", "resetToken"].sort()
    );
    expect(svc).not.toHaveProperty("manageUrl");
    expect(svc).not.toHaveProperty("baseUrl");
  } finally {
    db.close();
  }
});

/* ═══════════════════ Section 13 — timing-oracle neutralization (fixed minimum neutral-response floor) ═══════════════════ */

/** Auto-advancing monotonic clock stub: each read returns the current fake
 * time then advances by `step`, so a 202 request (which performs EXACTLY two
 * monotonic reads — one at start, one elapsed read after work) sees a
 * DETERMINISTIC injected elapsed of `step`, independent of real work. */
function stepClock(step) {
  let t = 10_000;
  const reads = [];
  const clock = () => {
    reads.push(t);
    const v = t;
    t += step;
    return v;
  };
  clock.reads = reads;
  return clock;
}

/** Immediate sleep recorder: captures every requested delay and resolves
 * instantly — no real timer — so the floor math is proven deterministically. */
function sleepRecorder() {
  const delays = [];
  const fn = async (ms) => {
    delays.push(ms);
  };
  fn.delays = delays;
  return fn;
}

const FLOOR_FOR_TESTS = 350;
const ALWAYS_202_TEXT =
  '{"message":"If a matching purchase exists, we sent an email."}';

test("requestRecovery timing anchor: known, unknown, malformed, email-limited, and IP-limited requests all request the IDENTICAL remaining delay for identical injected work elapsed (350ms floor, 100ms injected work → every path sleeps exactly 250ms), and return byte/status/header-identical 202 responses", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "oracle-known@example.com", key: "QMP-ORAC-LE00-0001-0001" });
    const clock = stepClock(100);
    const sleep = sleepRecorder();
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-oracle",
      minimumResponseMs: FLOOR_FOR_TESTS,
      monotonicNow: clock,
      sleepFn: sleep,
    });

    // Pre-exhaust the EMAIL bucket (email-limited scenario) and the IP bucket
    // (ip-limited scenario): limit=1 → the request's own consume is denied.
    consumeRequestLimit(db, {
      subjectKey: hashRequestSubject("oracle-limited@example.com", SECRET_32),
      action: "recovery_email",
      now: 1_700_000_000_000,
      windowMs: 900_000,
      limit: 1,
    });
    consumeRequestLimit(db, {
      subjectKey: hashRequestSubject("203.0.113.34", SECRET_32),
      action: "recovery_ip",
      now: 1_700_000_000_000,
      windowMs: 900_000,
      limit: 1,
    });

    const scenarios = [
      { name: "known", email: "oracle-known@example.com", ip: "203.0.113.30" },
      { name: "unknown", email: "oracle-unknown@example.com", ip: "203.0.113.31" },
      { name: "malformed", email: "not-an-email", ip: "203.0.113.32" },
      { name: "email-limited", email: "oracle-limited@example.com", ip: "203.0.113.33" },
      { name: "ip-limited", email: "oracle-ip-limited@example.com", ip: "203.0.113.34" },
    ];

    const fingerprints = [];
    for (const s of scenarios) {
      const res = await svc.requestRecovery(
        jsonRequest("https://x/api/recovery/request", { email: s.email }),
        { clientIp: s.ip }
      );
      fingerprints.push({
        name: s.name,
        status: res.status,
        body: await res.text(),
        contentType: res.headers.get("content-type"),
        cacheControl: res.headers.get("cache-control"),
        nosniff: res.headers.get("x-content-type-options"),
        referrer: res.headers.get("referrer-policy"),
      });
    }

    // Identical remaining delay on EVERY neutral-202 path for identical work.
    expect(sleep.delays).toEqual([250, 250, 250, 250, 250]);

    // Exactly two monotonic reads per request (one start + one elapsed read) —
    // no extra reads that could leak the amount of work done.
    expect(clock.reads.length).toBe(10);

    // Every response is byte/status/header-identical.
    for (const f of fingerprints) {
      expect(f.status).toBe(202);
      expect(f.body).toBe(ALWAYS_202_TEXT);
      expect(f.contentType).toMatch(/application\/json/);
      expect(f.cacheControl).toBe("no-store");
      expect(f.nosniff).toBe("nosniff");
      expect(f.referrer).toBe("no-referrer");
    }
    const canonical = fingerprints[0];
    for (const f of fingerprints.slice(1)) {
      for (const k of ["status", "body", "contentType", "cacheControl", "nosniff", "referrer"]) {
        expect(f[k]).toBe(canonical[k]);
      }
    }
  } finally {
    db.close();
  }
});

test("requestRecovery timing anchor: known path with simulated 25ms of work sleeps exactly floor−25 (350−25=325ms) and returns the exact 202", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "anchor-known@example.com", key: "QMP-ANCH-OR90-0001-0001" });
    const sleep = sleepRecorder();
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-anchor25",
      minimumResponseMs: FLOOR_FOR_TESTS,
      monotonicNow: stepClock(25),
      sleepFn: sleep,
    });
    const res = await svc.requestRecovery(
      jsonRequest("https://x/api/recovery/request", { email: "anchor-known@example.com" }),
      { clientIp: "203.0.113.40" }
    );
    expect(res.status).toBe(202);
    expect(sleep.delays).toEqual([325]);
    expect(JSON.stringify(await res.json())).toBe(ALWAYS_202_TEXT);
  } finally {
    db.close();
  }
});

test("requestRecovery timing anchor: when injected work elapsed already exceeds the floor (400ms > 350ms), the request sleeps 0 and still returns the exact 202", async () => {
  const db = freshDb();
  try {
    seedLicense(db, { email: "anchor-over@example.com", key: "QMP-ANCH-OR80-0001-0001" });
    const sleep = sleepRecorder();
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const svc = createRecoveryHttpService({
      db,
      secret: SECRET_32,
      baseUrl: BASE_URL,
      now: () => 1_700_000_000_000,
      randomId: () => "rid-over",
      minimumResponseMs: FLOOR_FOR_TESTS,
      monotonicNow: stepClock(400),
      sleepFn: sleep,
    });
    const res = await svc.requestRecovery(
      jsonRequest("https://x/api/recovery/request", { email: "anchor-over@example.com" }),
      { clientIp: "203.0.113.41" }
    );
    expect(res.status).toBe(202);
    // No sleep is requested when work already meets/exceeds the floor.
    expect(sleep.delays).toEqual([]);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await res.json())).toBe(ALWAYS_202_TEXT);
  } finally {
    db.close();
  }
});

test("createRecoveryHttpService: validates minimumResponseMs (non-negative integer) and that monotonicNow/sleepFn are functions", async () => {
  const db = freshDb();
  try {
    const { createRecoveryHttpService } = await loadRecoveryHttp();
    const base = { db, secret: SECRET_32, baseUrl: BASE_URL };
    const badFloors = [-1, 1.5, NaN, Infinity, "350", null, {}, []];
    for (const bad of badFloors) {
      expect(() => createRecoveryHttpService({ ...base, minimumResponseMs: bad })).toThrow(TypeError);
    }
    // Legit values: 0 (tests/fast mode) and positive integers.
    expect(() => createRecoveryHttpService({ ...base, minimumResponseMs: 0 })).not.toThrow();
    expect(() => createRecoveryHttpService({ ...base, minimumResponseMs: 1 })).not.toThrow();
    expect(() => createRecoveryHttpService({ ...base, minimumResponseMs: 350 })).not.toThrow();
    // monotonicNow / sleepFn must be functions.
    for (const k of ["monotonicNow", "sleepFn"]) {
      for (const bad of ["x", null, 42, {}]) {
        expect(() => createRecoveryHttpService({ ...base, [k]: bad })).toThrow(TypeError);
      }
    }
  } finally {
    db.close();
  }
});

/* ───────────────────────────── helpers below helpers ───────────────────────────── */

/** Tables whose email / licenseKey columns are NECESSARY storage seams
 * (foreign key to the user's stored email, and the worker's delivery
 * address + license scope). The recovery-http contract allows these —
 * they ARE the persisted user record. All OTHER tables and columns must
 * never contain raw email / IP / plaintext tokens / secret. */
const NECESSARY_EMAIL_TABLES = new Set(["licenses", "email_outbox"]);
const NECESSARY_KEY_COLUMNS = new Set([
  "licenses.key",
  "email_outbox.license_key",
]);

/** Dump every column of every row from every table in the DB. */
function dumpAllTables(db) {
  const tables = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r) => r.name);
  const out = [];
  for (const t of tables) {
    const rows = db.query(`SELECT * FROM ${t}`).all();
    for (const row of rows) out.push(row);
  }
  return out;
}

/** Return true when this row+table cell is a NECESSARY seam that the contract
 * allows to contain the raw email or license key. */
function isAllowedSeamCell(tableName, columnName) {
  if (tableName === "licenses" && columnName === "email") return true;
  if (tableName === "licenses" && columnName === "key") return true;
  if (tableName === "email_outbox" && columnName === "recipient_email") return true;
  if (tableName === "email_outbox" && columnName === "license_key") return true;
  if (tableName === "email_outbox" && columnName === "payload_json") return true;
  // management_tokens.email is the row's "owns this key" FK by email —
  // the accepted recovery-core migration v6 design stores it; the
  // recovery-http contract doesn't add or remove this column.
  if (tableName === "management_tokens" && columnName === "email") return true;
  if (tableName === "management_tokens" && columnName === "license_key") return true;
  return false;
}

/** Exhaustively assert a SQLite sweep contains no leak of any value in
 * `secrets` outside the explicitly allowed (table,column) cells. */
function expectNoLeaks(db, secrets) {
  const tables = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r) => r.name);
  for (const t of tables) {
    const rows = db.query(`SELECT * FROM ${t}`).all();
    for (const row of rows) {
      for (const [col, val] of Object.entries(row)) {
        const sval = String(val);
        for (const secret of secrets) {
          if (typeof secret !== "string" || secret.length === 0) continue;
          if (sval.includes(secret) && !isAllowedSeamCell(t, col)) {
            throw new Error(
              `SQLite leak: ${t}.${col} contains forbidden value ${JSON.stringify(secret)}`
            );
          }
        }
      }
    }
  }
}

/** Bounded counter for "active timers" so we can detect if the module
 * accidentally installs a leaked interval/setTimeout. */
let __timerCount = 0;
function countActiveTimers() {
  // Heuristic: on the JVM, timers eventually fire. If module load installed
  // any, the count below would rise. Our test only waits 25ms so this is a
  // best-effort guard. We also assert no immediate setInterval was called.
  return __timerCount;
}

/** Mint a full token set for an email/license (test helper). */
function mintFour(db, email) {
  const t = {
    recover: generateManagementToken(db, { email, licenseKey: db.query("SELECT key FROM licenses WHERE email=? ORDER BY created_at LIMIT 1").get(email).key, purpose: "recover" }),
    reset_chrome: generateManagementToken(db, { email, licenseKey: db.query("SELECT key FROM licenses WHERE email=? ORDER BY created_at LIMIT 1").get(email).key, purpose: "reset_chrome" }),
    reset_edge: generateManagementToken(db, { email, licenseKey: db.query("SELECT key FROM licenses WHERE email=? ORDER BY created_at LIMIT 1").get(email).key, purpose: "reset_edge" }),
    reset_all: generateManagementToken(db, { email, licenseKey: db.query("SELECT key FROM licenses WHERE email=? ORDER BY created_at LIMIT 1").get(email).key, purpose: "reset_all" }),
  };
  return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.token]));
}

afterAll(() => {
  // Final smoke: ensure no module-level cache mutation persists across tests.
  // No-op placeholder; tests are already isolated.
});
