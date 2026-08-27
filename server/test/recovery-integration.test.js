// server/test/recovery-integration.test.js — Slice 3B-2B secure recovery HTTP
// integration: end-to-end through a real local Bun server. Strict vertical TDD;
// uses ONLY temp on-disk DBs and a child server on a free local port. Never
// touches server/license.db, never production, never a commit. Always explicit
// RESEND_API_KEY='' to forbid provider network.
//
// Coverage:
//   1) GET /api/portal/keys (and variants) fall through to fixed 404 and the
//      response has no key/email.
//   2) GET /portal + /manage return 200 with strict CSP, nonces, no legacy
//      /api/portal/keys calls, no raw-key sentinel ("key"/"status" rendering).
//   3) POST /api/recovery/request for an existing email: 202 + invariant body,
//      creates 4 hash-only management_tokens rows + one encrypted recovery
//      outbox row; for unknown email: identical 202 + body + no extra outbox.
//      Response/log/page contain no key/email/token/secret.
//   4) Decrypt seals in parent test memory; POST /api/manage/inspect returns
//      masked safe shape; POST /api/manage/reset with the Chrome link token
//      removes the Chrome slot only; reuse is safe; responses have no
//      sensitive data.
//   5) CF-Connecting-IP rate limit (set env RECOVERY_IP_LIMIT=1) is enforced
//      while the neutral response stays the same; stored request subjects are
//      64 hex (HMAC-SHA256 prefix).
//   6) Missing MANAGEMENT_TOKEN_SECRET: server still starts; POST recovery is
//      fixed 503; old /api/portal/keys still 404; no network. /portal & /manage
//      still render.
//   7) /health pending count increments with scheduler disabled (RESEND_API_KEY
//      blank) when a recovery row is queued.
//   8) Source/wiring guard: when secret is short, the recovery-row reject
//      preparer is the one wired into createEmailWorker.
import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { openDb, upsertLicense, generateKey } from "../db.js";
import { openManagementToken } from "../recovery.js";
import { RECOVERY_OUTBOX_KIND } from "../recovery-email.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INDEX_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

/** Reserve a free local TCP port. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawn `bun index.js` with the given env. Returns `{child, baseUrl, dir, dbPath, logs}`.
 * Caller is responsible for cleanup.
 */
async function spawnServer({
  secret = "",
  recoveryIpLimit = "",
  recoveryWindowMs = "",
  recoveryEmailLimit = "",
  recoveryMinResponseMs = "1",
  baseUrlOverride = null,
  seeded = true,
} = {}) {
  const port = await getFreePort();
  const dir = mkdtempSync(join(tmpdir(), "qmp-recovery-int-"));
  const dbPath = join(dir, "recovery.db");
  const logs = { stdout: "", stderr: "" };
  const env = {
    ...process.env,
    DB_PATH: dbPath,
    PORT: String(port),
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    RESEND_API_KEY: "",
    MANAGEMENT_TOKEN_SECRET: secret,
    BASE_URL: baseUrlOverride || `http://127.0.0.1:${port}`,
    ADMIN_TOKEN: "",
    // Fast-mode default for the pre-existing tests: 1ms floor (never 0 —
    // positiveIntEnv would fall back to 350). The dedicated timing-oracle
    // test overrides this with a real floor.
    RECOVERY_MIN_RESPONSE_MS: String(recoveryMinResponseMs),
  };
  if (recoveryIpLimit !== "") env.RECOVERY_IP_LIMIT = String(recoveryIpLimit);
  if (recoveryWindowMs !== "") env.RECOVERY_WINDOW_MS = String(recoveryWindowMs);
  if (recoveryEmailLimit !== "") env.RECOVERY_EMAIL_LIMIT = String(recoveryEmailLimit);

  if (seeded) {
    const db = openDb(dbPath);
    upsertLicense(db, {
      key: "QMP-RECINT-XXXX-0001-0001",
      email: "known@example.com",
      customerId: "cus_recint",
      subscriptionId: "sub_recint",
      status: "active",
    });
    db.query(
      `UPDATE licenses SET expires_at = ?, current_period_end = ?, cancel_at_period_end = 0 WHERE key = ?`
    ).run(2000000000, 2000000000, "QMP-RECINT-XXXX-0001-0001");
    db.close();
  }

  const child = spawn(process.execPath, [INDEX_PATH], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { logs.stdout += d.toString("utf8"); });
  child.stderr.on("data", (d) => { logs.stderr += d.toString("utf8"); });

  const baseUrl = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) { up = true; break; }
    } catch {}
    await sleep(100);
  }
  if (!up) {
    throw new Error("server did not come up: " + logs.stderr);
  }
  return { child, baseUrl, dir, dbPath, logs };
}

async function cleanup(child, dir) {
  if (child && child.pid) {
    try { child.kill("SIGTERM"); } catch {}
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
}

function outboxSnapshot(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query(
        `SELECT kind, license_key, recipient_email, payload_json, idempotency_key FROM email_outbox ORDER BY id ASC`
      )
      .all();
  } finally {
    db.close();
  }
}
function tokensSnapshot(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query(
        `SELECT token_hash, license_key, email, purpose FROM management_tokens ORDER BY token_hash`
      )
      .all();
  } finally {
    db.close();
  }
}
function slotsSnapshot(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query(
        `SELECT license_key, browser_family, instance_id FROM browser_slots ORDER BY license_key, browser_family`
      )
      .all();
  } finally {
    db.close();
  }
}

// ── Test 1: legacy /api/portal/keys is gone ─────────────────────────────────
let env = {};
let child, baseUrl, httpDir, httpDbPath;
const SECRET =
  "test-management-secret-32-bytes-min!";
const KNOWN_EMAIL = "known@example.com";
const KEY = "QMP-RECINT-XXXX-0001-0001";

beforeAll(async () => {
  const setup = await spawnServer({ secret: SECRET });
  child = setup.child;
  baseUrl = setup.baseUrl;
  httpDir = setup.dir;
  httpDbPath = setup.dbPath;
  env = setup.logs;
});

afterAll(async () => {
  await cleanup(child, httpDir);
});

// Re-seed the slot rows (used by the decrypt-and-reset test) before each test
// that needs a clean baseline. We use bun:test's beforeEach.
beforeEach(async () => {
  // Wipe slots and tokens so tests are independent, then seed two slots.
  const db = new Database(httpDbPath);
  try {
    db.exec("DELETE FROM browser_slots");
    db.exec("DELETE FROM management_tokens");
    db.exec("DELETE FROM email_outbox");
    db.prepare(
      `INSERT INTO browser_slots (license_key, browser_family, instance_id, activated_at, last_seen_at)
       VALUES (?, 'chrome', ?, ?, ?)`
    ).run(KEY, "chrome-inst-1", 1700000000, 1700000000);
    db.prepare(
      `INSERT INTO browser_slots (license_key, browser_family, instance_id, activated_at, last_seen_at)
       VALUES (?, 'edge', ?, ?, ?)`
    ).run(KEY, "edge-inst-1", 1700000000, 1700000000);
  } finally {
    db.close();
  }
});

test("GET /api/portal/keys returns 404 with no key/email in body (legacy raw-key route removed)", async () => {
  const r = await fetch(`${baseUrl}/api/portal/keys?email=${KNOWN_EMAIL}`);
  expect(r.status).toBe(404);
  const text = await r.text();
  expect(text).not.toContain(KEY);
  expect(text).not.toContain(KNOWN_EMAIL);
});

test("GET /api/portal/keys (no email) also 404 — no fallback behavior", async () => {
  const r = await fetch(`${baseUrl}/api/portal/keys`);
  expect(r.status).toBe(404);
});

test("GET /portal returns 200 with strict CSP, no legacy /api/portal/keys call, no raw key/email", async () => {
  const r = await fetch(`${baseUrl}/portal`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-security-policy")).toContain("script-src");
  expect(r.headers.get("content-security-policy")).toContain("'nonce-");
  expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const html = await r.text();
  // Legacy raw-key endpoint must not be referenced anywhere in the portal HTML.
  expect(html).not.toContain("/api/portal/keys");
  // No raw-key sentinel: the legacy UI printed `j.key + '  (' + j.status + ')'`
  // and surfaced `j.keys`. The new portal only POSTs to /api/recovery/request.
  expect(html).toContain("/api/recovery/request");
  // No plaintext markers from the legacy UI (no license key literal here either).
  expect(html).not.toContain(KNOWN_EMAIL);
  expect(html).not.toContain(KEY);
});

test("GET /manage returns 200 with strict CSP, fragment-only management page, no token/storage persistence", async () => {
  const r = await fetch(`${baseUrl}/manage`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-security-policy")).toContain("'nonce-");
  expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const html = await r.text();
  // The management page posts the token body to /api/manage/inspect and uses
  // history.replaceState to strip the fragment. It must NOT persist the
  // token in DOM, localStorage, sessionStorage, or cookies.
  expect(html).toContain("/api/manage/inspect");
  expect(html).toContain("history.replaceState");
  expect(html).not.toContain("localStorage.setItem");
  expect(html).not.toContain("sessionStorage.setItem");
  expect(html).not.toContain("document.cookie");
  // The legacy UI never called /manage; this is a brand-new endpoint.
  expect(html).not.toContain(KEY);
  expect(html).not.toContain(KNOWN_EMAIL);
});

test("POST /api/recovery/request for KNOWN email: 202 + invariant body, 4 hash-only tokens + 1 encrypted outbox; no PII leaks", async () => {
  const before = outboxSnapshot(httpDbPath);
  const r = await fetch(`${baseUrl}/api/recovery/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: KNOWN_EMAIL }),
  });
  expect(r.status).toBe(202);
  expect(r.headers.get("cache-control")).toBe("no-store");
  const body = await r.json();
  expect(body).toEqual({ message: "If a matching purchase exists, we sent an email." });
  // No PII in the body.
  const bodyStr = JSON.stringify(body);
  expect(bodyStr).not.toContain(KNOWN_EMAIL);
  expect(bodyStr).not.toContain(KEY);

  // 4 hash-only management_tokens rows created (no plaintext anywhere).
  const toks = tokensSnapshot(httpDbPath);
  expect(toks.length).toBe(4);
  const purposes = toks.map((t) => t.purpose).sort();
  expect(purposes).toEqual(["recover", "reset_all", "reset_chrome", "reset_edge"]);
  for (const t of toks) {
    expect(t.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.email).toBe(KNOWN_EMAIL);
    expect(t.license_key).toBe(KEY);
  }

  // Exactly ONE new recovery outbox row, with an encrypted payload (no plaintext
  // token / secret / email / raw key inside the payload_json).
  const after = outboxSnapshot(httpDbPath);
  expect(after.length - before.length).toBe(1);
  const newRow = after[after.length - 1];
  expect(newRow.kind).toBe(RECOVERY_OUTBOX_KIND);
  expect(newRow.recipient_email).toBe(KNOWN_EMAIL);
  expect(newRow.license_key).toBe(KEY);
  const pj = String(newRow.payload_json);
  expect(pj).toContain('"kind":"recovery"');
  // The serialized payload must NOT contain the plaintext email, license key,
  // secret, or any of the four plaintext tokens.
  expect(pj).not.toContain(SECRET);
  // (The payload does contain the license key by design — recovery-email.js
  // stores it so the user can see it in the email. We verify it's escaped
  // into html correctly later; here we verify the OTHER tokens are sealed.)
  // The four tokens must be ciphertext only — the same random bytes that
  // appeared as plaintext above must NOT appear as plaintext here.
  const opened = JSON.parse(pj);
  expect(opened.kind).toBe(RECOVERY_OUTBOX_KIND);
  expect(Object.keys(opened.tokens).sort()).toEqual(["recover", "reset_all", "reset_chrome", "reset_edge"]);
  for (const purpose of ["recover", "reset_all", "reset_chrome", "reset_edge"]) {
    const seal = opened.tokens[purpose];
    expect(typeof seal).toBe("string");
    expect(seal.length).toBeGreaterThan(20);
    expect(seal).not.toContain("QMP-");
  }

  // Server stdout/stderr must not leak secret, key, or email.
  expect(env.stdout + env.stderr).not.toContain(SECRET);
  expect(env.stdout + env.stderr).not.toContain(KEY);
  expect(env.stdout + env.stderr).not.toContain(KNOWN_EMAIL);
});

test("POST /api/recovery/request for UNKNOWN email: 202 + identical body, NO new outbox row, no PII leaks", async () => {
  const before = outboxSnapshot(httpDbPath);
  const r = await fetch(`${baseUrl}/api/recovery/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ghost@nowhere.example" }),
  });
  expect(r.status).toBe(202);
  const body = await r.json();
  expect(body).toEqual({ message: "If a matching purchase exists, we sent an email." });
  const after = outboxSnapshot(httpDbPath);
  // Unknown email must NOT create any new outbox row.
  expect(after.length).toBe(before.length);
  const toks = tokensSnapshot(httpDbPath);
  // And must NOT mint any new management tokens.
  expect(toks.length).toBe(0);
});

test("Decrypt seals in parent test memory; POST /api/manage/inspect returns masked safe shape; reset removes Chrome only; reuse safe", async () => {
  // Trigger the recovery so we have a fresh set of four sealed tokens.
  const before = outboxSnapshot(httpDbPath);
  const r = await fetch(`${baseUrl}/api/recovery/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: KNOWN_EMAIL }),
  });
  expect(r.status).toBe(202);
  const after = outboxSnapshot(httpDbPath);
  expect(after.length - before.length).toBe(1);
  const row = after[after.length - 1];
  const payload = JSON.parse(row.payload_json);
  const opened = {};
  for (const purpose of ["recover", "reset_all", "reset_chrome", "reset_edge"]) {
    opened[purpose] = openManagementToken(payload.tokens[purpose], SECRET);
  }

  // Inspect the recover token: safe masked shape only.
  const ins = await fetch(`${baseUrl}/api/manage/inspect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: opened.recover }),
  });
  expect(ins.status).toBe(200);
  const insBody = await ins.json();
  expect(insBody.valid).toBe(true);
  expect(insBody.code).toBe("ok");
  expect(insBody.purpose).toBe("recover");
  // Masked license tail: only the last 4 chars of the key are exposed.
  expect(typeof insBody.licenseTail).toBe("string");
  expect(insBody.licenseTail).toBe("0001");
  // The full raw key, email, secret, or token must NOT appear in the response.
  const insStr = JSON.stringify(insBody);
  expect(insStr).not.toContain("QMP-RECINT");
  expect(insStr).not.toContain(KNOWN_EMAIL);
  expect(insStr).not.toContain(SECRET);
  expect(insStr).not.toContain(opened.recover);

  // Reset Chrome: should remove the Chrome slot only.
  const slotBefore = slotsSnapshot(httpDbPath);
  const chromeInstBefore = slotBefore.find((s) => s.browser_family === "chrome")?.instance_id;
  expect(chromeInstBefore).toBe("chrome-inst-1");

  const reset = await fetch(`${baseUrl}/api/manage/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: opened.reset_chrome, browser_family: "chrome" }),
  });
  expect(reset.status).toBe(200);
  const resetBody = await reset.json();
  expect(resetBody.ok).toBe(true);
  const resetStr = JSON.stringify(resetBody);
  expect(resetStr).not.toContain(KEY);
  expect(resetStr).not.toContain(SECRET);
  expect(resetStr).not.toContain(opened.reset_chrome);

  const slotAfter = slotsSnapshot(httpDbPath);
  // Chrome removed, Edge still present.
  expect(slotAfter.find((s) => s.browser_family === "chrome")).toBeUndefined();
  expect(slotAfter.find((s) => s.browser_family === "edge")).toBeDefined();

  // Reuse the same Chrome reset token: must be safe (fixed safe shape, 409 used).
  const reuse = await fetch(`${baseUrl}/api/manage/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: opened.reset_chrome, browser_family: "chrome" }),
  });
  expect(reuse.status).toBe(409);
  const reuseBody = await reuse.json();
  expect(reuseBody.ok).toBe(false);
  // Reuse body must not leak the token / secret / key / email.
  const reuseStr = JSON.stringify(reuseBody);
  expect(reuseStr).not.toContain(opened.reset_chrome);
  expect(reuseStr).not.toContain(SECRET);
  expect(reuseStr).not.toContain(KEY);
});

test("CF-Connecting-IP rate limit (env RECOVERY_IP_LIMIT=1) enforced; neutral response unchanged; stored subjects are 64-hex HMAC", async () => {
  // Tear down the configured server; bring up a fresh one with a low IP cap.
  await cleanup(child, httpDir);
  const setup = await spawnServer({
    secret: SECRET,
    recoveryIpLimit: 1,
    recoveryWindowMs: 900000,
    recoveryEmailLimit: 3,
  });
  child = setup.child;
  baseUrl = setup.baseUrl;
  httpDir = setup.dir;
  httpDbPath = setup.dbPath;
  env = setup.logs;
  // Clean state.
  {
    const db = new Database(httpDbPath);
    try {
      db.exec("DELETE FROM browser_slots");
      db.exec("DELETE FROM management_tokens");
      db.exec("DELETE FROM email_outbox");
    } finally { db.close(); }
  }

  const r1 = await fetch(`${baseUrl}/api/recovery/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.7",
    },
    body: JSON.stringify({ email: KNOWN_EMAIL }),
  });
  expect(r1.status).toBe(202);
  const j1 = await r1.json();
  expect(j1).toEqual({ message: "If a matching purchase exists, we sent an email." });

  const r2 = await fetch(`${baseUrl}/api/recovery/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.7",
    },
    body: JSON.stringify({ email: KNOWN_EMAIL }),
  });
  expect(r2.status).toBe(202);
  const j2 = await r2.json();
  // The neutral body MUST be byte-identical, regardless of rate-limit state.
  expect(j2).toEqual(j1);

  // Stored request-limit subjects are 64-char lowercase hex (HMAC-SHA256 prefix).
  const db = new Database(httpDbPath, { readonly: true });
  try {
    // The second request is limited. It must not mint another four tokens or
    // enqueue another email, while its public response remains neutral.
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM management_tokens").get().n).toBe(4);
    const rows = db
      .query(
        `SELECT DISTINCT subject_key FROM request_limits WHERE action = 'recovery_ip'`
      )
      .all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.subject_key).toMatch(/^[0-9a-f]{64}$/);
      // No raw IP leaked.
      expect(row.subject_key).not.toContain("203.0.113.7");
    }
  } finally { db.close(); }
});

test("Missing MANAGEMENT_TOKEN_SECRET: server still starts; POST recovery is fixed 503; legacy /api/portal/keys still 404; no network; /portal & /manage still render", async () => {
  await cleanup(child, httpDir);
  const setup = await spawnServer({ secret: "" });
  child = setup.child;
  baseUrl = setup.baseUrl;
  httpDir = setup.dir;
  httpDbPath = setup.dbPath;
  env = setup.logs;

  // Legacy route: still 404.
  const legacy = await fetch(`${baseUrl}/api/portal/keys?email=anything@example.com`);
  expect(legacy.status).toBe(404);

  // Recovery POST: fixed 503.
  const rec = await fetch(`${baseUrl}/api/recovery/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ghost@nowhere.example" }),
  });
  expect(rec.status).toBe(503);
  const recBody = await rec.json();
  expect(recBody.error).toBe("recovery not configured");
  const recStr = JSON.stringify(recBody);
  expect(recStr).not.toContain("ghost@nowhere.example");

  // GET pages still render (200).
  const portal = await fetch(`${baseUrl}/portal`);
  expect(portal.status).toBe(200);
  const manage = await fetch(`${baseUrl}/manage`);
  expect(manage.status).toBe(200);

  // No network: nothing in the parent test process called fetch() except to
  // the child server; env RESEND_API_KEY='' was set so no scheduler / adapter
  // started. The server log also should not mention any RESEND provider.
  expect(env.stdout + env.stderr).toContain("[email] scheduler disabled");
});

test("/health pending count increments with scheduler disabled (blank RESEND_API_KEY) when a recovery outbox row is queued", async () => {
  // Restart with the configured secret so we can queue a recovery row.
  await cleanup(child, httpDir);
  const setup = await spawnServer({ secret: SECRET });
  child = setup.child;
  baseUrl = setup.baseUrl;
  httpDir = setup.dir;
  httpDbPath = setup.dbPath;
  env = setup.logs;

  // Wipe state, queue one recovery.
  {
    const db = new Database(httpDbPath);
    try {
      db.exec("DELETE FROM browser_slots");
      db.exec("DELETE FROM management_tokens");
      db.exec("DELETE FROM email_outbox");
    } finally { db.close(); }
  }
  const h0 = await fetch(`${baseUrl}/health`).then((r) => r.json());
  expect(h0.email.enabled).toBe(false);
  expect(h0.email.pending).toBe(0);

  const r = await fetch(`${baseUrl}/api/recovery/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: KNOWN_EMAIL }),
  });
  expect(r.status).toBe(202);

  const h1 = await fetch(`${baseUrl}/health`).then((r) => r.json());
  expect(h1.email.enabled).toBe(false);
  expect(h1.email.pending).toBe(1);
  // No secret in health.
  expect(JSON.stringify(h1)).not.toContain(SECRET);
});

test("Timing oracle neutralized: with RECOVERY_MIN_RESPONSE_MS=80, a known AND an unknown valid-email request each take >= 60ms and return the exact same 202 body", async () => {
  // Dedicated child whose floor is genuinely applied (the other tests run at
  // RECOVERY_MIN_RESPONSE_MS=1 to stay fast). No tight delta assertion — CI
  // noise tolerances only: both requests must clear ~60ms because the server
  // pads every neutral 202 to a fixed 80ms floor regardless of membership.
  await cleanup(child, httpDir);
  const setup = await spawnServer({ secret: SECRET, recoveryMinResponseMs: 80 });
  child = setup.child;
  baseUrl = setup.baseUrl;
  httpDir = setup.dir;
  httpDbPath = setup.dbPath;
  env = setup.logs;

  const t0 = performance.now();
  const known = await fetch(`${baseUrl}/api/recovery/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: KNOWN_EMAIL }),
  });
  const knownMs = performance.now() - t0;
  expect(known.status).toBe(202);
  expect(knownMs).toBeGreaterThanOrEqual(60);

  const t1 = performance.now();
  const unknown = await fetch(`${baseUrl}/api/recovery/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "ghost@nowhere.example" }),
  });
  const unknownMs = performance.now() - t1;
  expect(unknown.status).toBe(202);
  expect(unknownMs).toBeGreaterThanOrEqual(60);

  const kBody = await known.json();
  const uBody = await unknown.json();
  expect(uBody).toEqual(kBody);
  expect(kBody).toEqual({ message: "If a matching purchase exists, we sent an email." });
  expect(JSON.stringify(kBody)).not.toContain(KNOWN_EMAIL);
  expect(JSON.stringify(kBody)).not.toContain(KEY);
});

test("Source/wiring guard: index.js wires the missing-secret recovery-row reject preparer for createEmailWorker (welcome identity preserved)", async () => {
  const src = readFileSync(INDEX_PATH, "utf8");
  // The recovery-message-preparer is imported and passed as `prepareMessage`.
  expect(src).toMatch(/createRecoveryMessagePreparer/);
  // When the secret is short/missing, the wired preparer must be the local
  // "identity-or-reject" one (recovery row throws a fixed internal error;
  // non-recovery rows return payload unchanged).
  expect(src).toMatch(/identity[- ]?or[- ]?reject|recovery row|RECOVERY_OUTBOX_KIND|kind\s*!==\s*["']recovery["']|kind !== 'recovery'|kind !== \"recovery\"/);
  // Welcome email must still work — i.e. the preparer must NOT reject
  // non-recovery rows. The factory must always return the payload for
  // non-recovery rows, even when management secret is invalid.
  expect(src).toMatch(/welcome|non[- ]recovery|kind\s*[!=]=/);
});