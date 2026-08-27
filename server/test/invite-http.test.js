// server/test/invite-http.test.js — Slice 5B-1 FAMILY INVITE HTTP SERVICE.
//
// TDD: behavior tests written BEFORE the module under test is implemented.
// Uses ONLY :memory: bun:sqlite + synthetic Request objects. No Bun server,
// no real network, no real timers (real sleeps disabled via injected
// floor=0 except the deterministic fake-sleep timing tests), no commit.
//
// The module under test (invite-http.js) is imported LAZILY per test so the
// suite loads (RED) before the module exists and grows in lockstep with it.
// Accepted core this slice leans on: migration v7, invites.js,
// buildFamilyWelcomeMessage, recovery rate/hash helpers, auth.safeSecretEqual.
//
// Coverage targets the full Slice 5B-1 contract:
//   1) exact API surface + import side-effect freedom + configured flag /
//      independent 503 sub-configuration + factory validation.
//   2) redeemInviteRequest — POST-only 405 before body/DB, bounded 16 KiB
//      body, JSON-object only, fixed JSON headers, EXACT invariant 202
//      envelope across success/invalid/expired/used/revoked/malformed/
//      rate-limited, HMAC per-IP + per-code limits with hash-only subjects,
//      fail-closed 500 + fixed log, one core success queues family_welcome.
//   3) Admin auth — bearer-only (body token rejected), admin IP bucket
//      consumed BEFORE compare including invalid attempts, 403/429/503,
//      constant-time via safeSecretEqual.
//   4) mintInvites — codes returned exactly once, DB only hashes, fixed 400
//      on invalid input, fixed 500 + `[invite-admin] mint failed` log.
//   5) revokeFamily — 200 safety shape / 404-400 failure, family-only, fixed
//      500 + `[invite-admin] revoke failed` log.
//   6) invitePageResponse — per-response CSP nonce matching inline script,
//      no unsafe-inline script, frame deny, no-store/no-referrer/nosniff,
//      neutral textContent, clears code+email, no storage/innerHTML/auto.
//   7) DB sweep: invite reasons/audit/limits never contain
//      plaintext codes / emails / keys / admin token / rate secret / IPs.
//   8) Safe redacted logs: fixed strings only, never input/error details.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, normalizeEmail, generateKey } from "../db.js";
import { hashInviteCode, mintInviteCodes } from "../invites.js";
import { hashRequestSubject } from "../recovery.js";
import { buildFamilyWelcomeMessage } from "../email.js";

/* ───────────────────────────── Shared constants ───────────────────────── */

const RATE_SECRET = "0123456789abcdef0123456789abcdef"; // ≥16
const ADMIN_TOKEN = "a5b3c7e9-1111-4222-8333-9999abcd1234"; // ≥16 nonblank
const NEUTRAL_MSG = "If this invite is valid, we sent your license by email.";
const NEUTRAL_202 = JSON.stringify({ message: NEUTRAL_MSG });
/** Shared unknown-bucket subject fed to HMAC (never echoed). */
const UNKNOWN_BUCKET = "unknown";

/** TDD marker so a modify-in-bulk reviewer sees this file is RED→GREEN. */
export const TDD_PENDING = true;

beforeAll(() => {
  // Smoke shape of accepted core primitives this slice leans on.
  expect(typeof buildFamilyWelcomeMessage).toBe("function");
  expect(typeof hashInviteCode).toBe("function");
  expect(typeof mintInviteCodes).toBe("function");
  expect(RATE_SECRET.length).toBeGreaterThanOrEqual(16);
  expect(ADMIN_TOKEN.length).toBeGreaterThanOrEqual(16);
});

/* ───────────────────────────── Test helpers ───────────────────────────── */

/** Fresh :memory: DB per test (migrations applied), closed by caller. */
function freshDb() {
  return openDb(":memory:");
}

/** Fixed synthetic clock so rate windows are deterministic. */
function fixedClock(ts) {
  return () => ts;
}

/** Synthetic POST Request with JSON body (or raw body when provided). */
function jsonRequest(url, body, { method = "POST", headers = {} } = {}) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body == null ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Read a Response body once as text. */
async function textBody(res) {
  return await res.text();
}

/** Deterministic fake sleep that records requested ms (does NOT actually sleep). */
function fakeSleepLogger() {
  const calls = [];
  return {
    calls,
    sleepFn: (ms) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

/** Wrapper DB that throws on statements matching `shouldThrow(sql)`. */
function failingDb(realDb, shouldThrow) {
  const wrapQuery = (stmt, ...args) =>
    shouldThrow(stmt) ? Promise.reject(new Error("db down")) : realDb.query(stmt, ...args);
  return {
    query: (...a) => {
      const stmt = a[0];
      if (shouldThrow(stmt)) throw new Error("db down");
      return realDb.query(...a);
    },
    exec: (...a) => {
      const stmt = a[0];
      if (shouldThrow(stmt)) throw new Error("db down");
      return realDb.exec(...a);
    },
    close: () => {
      /* real db still owned by caller */
    },
  };
}

/** Capture logs from an injected logger object (only .warn/.error are used). */
function captureLoggerFor(fn) {
  const lines = [];
  const logger = {
    warn: (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")),
    error: (...a) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")),
    info: () => {},
    log: () => {},
  };
  const out = fn(logger);
  return { lines, out };
}

/** Standard service factory options with disabled real timing (floor=0). */
function svcOpts(db, overrides = {}) {
  return {
    db,
    rateSecret: RATE_SECRET,
    adminToken: ADMIN_TOKEN,
    now: fixedClock(1_700_000_000_000),
    minimumResponseMs: 0,
    logger: silenceLogger(),
    ...overrides,
  };
}

/** A logger that never writes anywhere (proves service uses it, not console). */
function silenceLogger() {
  return { warn: () => {}, error: () => {}, info: () => {}, log: () => {} };
}

/** Seed one valid invite row via the accepted core and return its plaintext. */
function seedInvite(db, { ts = 1_700_000_000_000, label = "family test", expiresAt = 1_700_000_000_000 + 86_400_000, count = 1 } = {}) {
  const minted = mintInviteCodes(db, { label, count, expiresAt, now: ts });
  return minted.codes[0];
}

/** Lazy importer (RED-safe while invite-http.js does not exist). */
async function loadInviteHttp() {
  return await import("../invite-http.js");
}

/* ═══════════ Section 1 — import safety / exact surface / config ═══════════ */

test("importing invite-http has NO side effects (no logs, no DB open) and the module exports a factory", async () => {
  const orig = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  const captured = [];
  for (const k of Object.keys(orig)) {
    console[k] = (...args) => captured.push(args.join(" "));
  }
  let mod;
  try {
    mod = await loadInviteHttp();
  } finally {
    for (const k of Object.keys(orig)) console[k] = orig[k];
  }
  expect(captured).toEqual([]);
  expect(typeof mod.createInviteHttpService).toBe("function");
});

test("createInviteHttpService returns the EXACT API surface {configured,redeemInviteRequest,mintInvites,revokeFamily,invitePageResponse}", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    expect(Object.keys(svc).sort()).toEqual([
      "configured",
      "invitePageResponse",
      "mintInvites",
      "redeemInviteRequest",
      "revokeFamily",
    ]);
  } finally {
    db.close();
  }
});

test("factory throws TypeError on invalid dependencies and limits; accepts valid config", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    expect(() => createInviteHttpService({})).toThrow(TypeError);
    expect(() => createInviteHttpService({ db: { noQuery: 1 }, rateSecret: RATE_SECRET })).toThrow(TypeError);
    expect(() => createInviteHttpService(svcOpts(db, { now: 42 }))).toThrow(TypeError);
    expect(() => createInviteHttpService(svcOpts(db, { monotonicNow: 42 }))).toThrow(TypeError);
    expect(() => createInviteHttpService(svcOpts(db, { sleepFn: "nope" }))).toThrow(TypeError);
    expect(() => createInviteHttpService(svcOpts(db, { logger: null }))).toThrow(TypeError);
    expect(() => createInviteHttpService(svcOpts(db, { windowMs: 0 }))).toThrow(TypeError);
    expect(() => createInviteHttpService(svcOpts(db, { windowMs: 1.5 }))).toThrow(TypeError);
    expect(() => createInviteHttpService(svcOpts(db, { inviteIpLimit: -1 }))).toThrow(TypeError);
    expect(() => createInviteHttpService(svcOpts(db, { inviteCodeLimit: 0 }))).toThrow(TypeError);
    expect(() => createInviteHttpService(svcOpts(db, { adminIpLimit: 2.5 }))).toThrow(TypeError);
    expect(() => createInviteHttpService(svcOpts(db, { minimumResponseMs: -1 }))).toThrow(TypeError);
    expect(() => createInviteHttpService(svcOpts(db, { minimumResponseMs: 1.5 }))).toThrow(TypeError);
    // valid config (with floor 0) does not throw.
    expect(() => createInviteHttpService(svcOpts(db))).not.toThrow();
  } finally {
    db.close();
  }
});

test("configured=true only when BOTH rateSecret (>=16) and adminToken (>=16) are present; configured=false otherwise", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    expect(createInviteHttpService(svcOpts(db)).configured).toBe(true);
    expect(
      createInviteHttpService(svcOpts(db, { rateSecret: "too-short" })).configured
    ).toBe(false);
    expect(
      createInviteHttpService(svcOpts(db, { rateSecret: "                    " })).configured
    ).toBe(false);
    expect(
      createInviteHttpService(svcOpts(db, { adminToken: "" })).configured
    ).toBe(false);
    expect(
      createInviteHttpService(svcOpts(db, { rateSecret: "x".repeat(16), adminToken: "y".repeat(16) })).configured
    ).toBe(true);
  } finally {
    db.close();
  }
});

test("missing/short rateSecret: redeem POST → fixed 503 with no values; admin actions still work when adminToken present", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db, { rateSecret: "short-secret" }));
    const res = await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: "FAM-AAAA-AAAA-AAAA-AAAA", email: "a@b.com" }), { clientIp: "1.2.3.4" });
    expect(res.status).toBe(503);
    const hit = JSON.parse(await textBody(res));
    expect(JSON.stringify(hit)).not.toContain("short-secret");
    expect(JSON.stringify(hit)).not.toContain(RATE_SECRET);
    expect(JSON.stringify(hit)).not.toContain(ADMIN_TOKEN);
    // Admin action unaffected (adminToken present).
    const mint = await svc.mintInvites(jsonRequest("http://t/api/invites/mint", { label: "g", count: 1, expires_at: 1_700_000_000_000 + 1000 }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), { clientIp: "1.2.3.4" });
    expect(mint.status).toBe(200);
  } finally {
    db.close();
  }
});

test("missing/short adminToken: mint + revoke → fixed 503 with no values; public redeem still works when rateSecret present", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db, { adminToken: "" }));
    const mint = await svc.mintInvites(jsonRequest("http://t/api/invites/mint", { label: "g", count: 1, expires_at: 1_700_000_000_000 + 1000 }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), { clientIp: "1.2.3.4" });
    expect(mint.status).toBe(503);
    const revoke = await svc.revokeFamily(jsonRequest("http://t/api/invites/revoke", { license_key: "X" }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), { clientIp: "1.2.3.4" });
    expect(revoke.status).toBe(503);
    const redeem = await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: "FAM-AAAA-AAAA-AAAA-AAAA", email: "a@b.com" }), { clientIp: "1.2.3.4" });
    expect(redeem.status).toBe(202);
  } finally {
    db.close();
  }
});

test("configured=false responses never disclose any config value (503 bodies fixed)", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db, { rateSecret: "", adminToken: "" }));
    for (const maker of [
      (s) => s.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: "FAM-AAAA-AAAA-AAAA-AAAA", email: "a@b.com" }), { clientIp: "9.9.9.9" }),
      (s) => s.mintInvites(jsonRequest("http://t/api/invites/mint", { label: "g", count: 1, expires_at: 1_700_000_000_000 + 1000 }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), { clientIp: "9.9.9.9" }),
      (s) => s.revokeFamily(jsonRequest("http://t/api/invites/revoke", { license_key: "QMP-AAAA-AAAA-AAAA-AAAA" }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), { clientIp: "9.9.9.9" }),
    ]) {
      const res = await maker(svc);
      const body = JSON.stringify(JSON.parse(await textBody(res)));
      expect(body).not.toContain(RATE_SECRET);
      expect(body).not.toContain(ADMIN_TOKEN);
      expect(body).not.toContain("short");
    }
  } finally {
    db.close();
  }
});

test("invitePageResponse stays available (200) even when both secrets are missing; never discloses any config", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db, { rateSecret: "", adminToken: "" }));
    const res = await svc.invitePageResponse();
    expect(res.status).toBe(200);
    const html = await textBody(res);
    expect(html).toContain("Class Navi Pro Tools");
    expect(html).not.toContain(RATE_SECRET);
    expect(html).not.toContain(ADMIN_TOKEN);
    expect(html).not.toContain("short-secret");
  } finally {
    db.close();
  }
});

/* ═══════════════════ Section 2 — redeemInviteRequest ═══════════════════ */

test("redeem: every normal path returns the EXACT invariant 202 envelope + safe JSON headers (success/invalid/missing/expired/used/revoked/malformed)", async () => {
  const db = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const code = seedInvite(db, { ts });
    const usedCode = seedInvite(db, { ts, label: "used" });
    const expiredCode = seedInvite(db, { ts, label: "expired", expiresAt: ts + 1000 });
    const revokedCode = seedInvite(db, { ts, label: "revoked" });
    // Mark one invite revoked directly (simulates quarantine before redeem).
    db.query(`UPDATE invite_codes SET revoked_at = ? WHERE code_hash = ?`).run(ts, hashInviteCode(revokedCode));

    // Success path AND used path share the normal service instance.
    const svc = createInviteHttpService(svcOpts(db));
    const firstUse = await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: usedCode, email: "us@er.com" }), { clientIp: "1.1.1.1" });
    expect(firstUse.status).toBe(202);
    expect(await textBody(firstUse)).toBe(NEUTRAL_202);

    // Expired path needs a service clocked past the invite's expires_at.
    const svcNow = createInviteHttpService(svcOpts(db, { now: () => ts + 5000 }));

    // (name, response) pairs across every scenario.
    const scenarios = [
      ["success", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code, email: "su@cc.com" }), { clientIp: "1.1.1.2" })],
      ["missing-body", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem"), { clientIp: "1.1.1.2" })],
      ["invalid-json", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", "not json"), { clientIp: "1.1.1.2" })],
      ["non-object", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", [1, 2]), { clientIp: "1.1.1.2" })],
      ["valid-shape-unknown", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: "FAM-AAAA-AAAA-AAAA-AAAA", email: "a@b.com" }), { clientIp: "1.1.1.2" })],
      ["missing-code", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { email: "a@b.com" }), { clientIp: "1.1.1.2" })],
      ["missing-email", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: "FAM-AAAA-AAAA-AAAA-AAAA" }), { clientIp: "1.1.1.2" })],
      ["bad-shape-code", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: "nope", email: "a@b.com" }), { clientIp: "1.1.1.2" })],
      ["bad-email", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code, email: "not-an-email" }), { clientIp: "1.1.1.2" })],
      ["unknown-code", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: "FAM-0000-0000-0000-0000", email: "a@b.com" }), { clientIp: "1.1.1.2" })],
      ["expired", await svcNow.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: expiredCode, email: "exp@ired.com" }), { clientIp: "1.1.1.2" })],
      ["used-again", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: usedCode, email: "other@other.com" }), { clientIp: "1.1.1.3" })],
      ["revoked", await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: revokedCode, email: "rev@oked.com" }), { clientIp: "1.1.1.3" })],
    ];

    for (const [name, res] of scenarios) {
      expect(res.status, name).toBe(202);
      expect(await textBody(res), name).toBe(NEUTRAL_202);
      expect(res.headers.get("cache-control"), name).toBe("no-store");
      expect(res.headers.get("x-content-type-options"), name).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), name).toBe("no-referrer");
    }
  } finally {
    db.close();
  }
});

test("redeem: POST-only — non-POST returns fixed 405 BEFORE any body read or DB write", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    const code = seedInvite(db, {});
    // GET with a perfectly valid body must still be 405 (no body/DB touched).
    const get = await svc.redeemInviteRequest(
      new Request("http://t/api/invites/redeem", { method: "GET", body: JSON.stringify({ code, email: "a@b.com" }) }),
      { clientIp: "1.2.3.4" }
    );
    expect(get.status).toBe(405);
    const put = await svc.redeemInviteRequest(new Request("http://t/api/invites/redeem", { method: "PUT" }), { clientIp: "1.2.3.4" });
    expect(put.status).toBe(405);
    const del = await svc.redeemInviteRequest(new Request("http://t/api/invites/redeem", { method: "DELETE" }), { clientIp: "1.2.3.4" });
    expect(del.status).toBe(405);
    expect(JSON.parse(await textBody(get)).error).toBeTruthy();
    // No license/outbox/audit written, and no rate bucket consumed.
    expect(db.query(`SELECT COUNT(*) AS c FROM licenses`).get().c).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS c FROM email_outbox`).get().c).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS c FROM request_limits`).get().c).toBe(0);
  } finally {
    db.close();
  }
});

test("redeem: bounded body — >16 KiB or inflated Content-Length → fixed 413; 405 wins over body errors", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    const big = JSON.stringify({ code: "FAM-AAAA-AAAA-AAAA-AAAA", email: "a@b.com", pad: "x".repeat(17 * 1024) });
    const tooBig = await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", big), { clientIp: "1.2.3.4" });
    expect(tooBig.status).toBe(413);
    expect(JSON.parse(await textBody(tooBig))).toEqual({ error: "request body too large" });
    // Expected Content-Length < claimed Content-Length → 413 without reading.
    const inflated = await svc.redeemInviteRequest(
      new Request("http://t/api/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "99999999" },
        body: JSON.stringify({ code: "x" }),
      }),
      { clientIp: "1.2.3.4" }
    );
    expect(inflated.status).toBe(413);
    // Non-POST with huge body is 405 (method guard precedes body guard).
    const methodFirst = await svc.redeemInviteRequest(
      new Request("http://t/api/invites/redeem", { method: "GET", body: big }),
      { clientIp: "1.2.3.4" }
    );
    expect(methodFirst.status).toBe(405);
    expect(db.query(`SELECT COUNT(*) AS c FROM request_limits`).get().c).toBe(0);
  } finally {
    db.close();
  }
});

test("redeem: per-IP HMAC limit capped at inviteIpLimit; rate-limited request still exact 202 and never increments past the cap", async () => {
  const db = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db, { inviteIpLimit: 3 }));
    // Three requests from the same IP (distinct codes) → 202 each, bucket fills.
    for (let i = 0; i < 3; i++) {
      const res = await svc.redeemInviteRequest(
        jsonRequest("http://t/api/invites/redeem", { code: `FAM-${String(i).padStart(16, "A")}`, email: `u${i}@x.com` }),
        { clientIp: "203.0.113.7" }
      );
      expect(res.status).toBe(202);
      expect(await textBody(res)).toBe(NEUTRAL_202);
    }
    // 4th request from the same IP → still the exact same 202 envelope.
    const limited = await svc.redeemInviteRequest(
      jsonRequest("http://t/api/invites/redeem", { code: "FAM-BBBB-BBBB-BBBB-BBBB", email: "u9@x.com" }),
      { clientIp: "203.0.113.7" }
    );
    expect(limited.status).toBe(202);
    expect(await textBody(limited)).toBe(NEUTRAL_202);
    // A different IP is NOT limited and still gets 202.
    const other = await svc.redeemInviteRequest(
      jsonRequest("http://t/api/invites/redeem", { code: "FAM-BBBB-BBBB-BBBB-BBBB", email: "u9@x.com" }),
      { clientIp: "203.0.113.8" }
    );
    expect(other.status).toBe(202);
    expect(await textBody(other)).toBe(NEUTRAL_202);
    // Bucket count froze at the limit (never incremented past it).
    const ipSubject = hashRequestSubject("203.0.113.7", RATE_SECRET);
    const row = db
      .query(`SELECT count FROM request_limits WHERE subject_key = ? AND action = 'invite_ip'`)
      .get(ipSubject);
    expect(Number(row.count)).toBe(3);
  } finally {
    db.close();
  }
});

test("redeem: per-code HMAC limit capped at inviteCodeLimit; all approval rows store only 64-hex subjects (raw IP/code never stored)", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db, { inviteCodeLimit: 2 }));
    const code = "FAM-REDE-CODE-1234-REDE";
    // 2 requests with the SAME code from DIFFERENT IPs → fills the code bucket.
    for (let i = 0; i < 2; i++) {
      const res = await svc.redeemInviteRequest(
        jsonRequest("http://t/api/invites/redeem", { code, email: `u${i}@x.com` }),
        { clientIp: `198.51.100.${i + 1}` }
      );
      expect(res.status).toBe(202);
    }
    // 3rd with same code (fresh IP) → 202 (code-limited), never past the cap.
    const limited = await svc.redeemInviteRequest(
      jsonRequest("http://t/api/invites/redeem", { code, email: "u9@x.com" }),
      { clientIp: "198.51.100.99" }
    );
    expect(limited.status).toBe(202);
    expect(await textBody(limited)).toBe(NEUTRAL_202);
    // A DIFFERENT code from that fresh IP still 202 (per-code bucket is separate).
    const other = await svc.redeemInviteRequest(
      jsonRequest("http://t/api/invites/redeem", { code: "FAM-OTHER-CODE-9999-OTHR", email: "u9@x.com" }),
      { clientIp: "198.51.100.99" }
    );
    expect(other.status).toBe(202);
    // Every stored subject is 64-lowercase-hex; raw code + raw IP absent.
    const rows = db.query(`SELECT subject_key, action, count FROM request_limits`).all();
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const r of rows) {
      expect(r.subject_key).toMatch(/^[0-9a-f]{64}$/);
      expect(r.subject_key).not.toContain(code);
      expect(r.subject_key).not.toContain("198.51.100.");
    }
    const codeSubject = hashRequestSubject(code, RATE_SECRET);
    const codeRow = db.query(`SELECT count FROM request_limits WHERE subject_key = ? AND action = 'invite_code'`).get(codeSubject);
    expect(Number(codeRow.count)).toBe(2);
  } finally {
    db.close();
  }
});

test("redeem: blank clientIp maps to one shared unknown bucket; missing opts is tolerated", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db, { inviteIpLimit: 2 }));
    // No clientIp → unknown bucket shared by every IP-less request.
    for (let i = 0; i < 2; i++) {
      const res = await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: `FAM-AAAA-AAAA-AAAA-AAA${i}`, email: `u${i}@x.com` }));
      expect(res.status).toBe(202);
    }
    const third = await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: "FAM-AAAA-AAAA-AAAA-AAAA", email: "u@x.com" }));
    expect(third.status).toBe(202);
    const unknownSubject = hashRequestSubject(UNKNOWN_BUCKET, RATE_SECRET);
    const row = db.query(`SELECT count FROM request_limits WHERE subject_key = ? AND action = 'invite_ip'`).get(unknownSubject);
    expect(Number(row.count)).toBe(2);
  } finally {
    db.close();
  }
});

test("redeem: one successful core call queues exactly one family_welcome outbox row + one family_free license + one audit, all atomically", async () => {
  const db = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    const code = seedInvite(db, { ts, label: "family seat" });
    const res = await svc.redeemInviteRequest(
      jsonRequest("http://t/api/invites/redeem", { code, email: "  FAMILY@Example.COM " }),
      { clientIp: "203.0.113.50" }
    );
    expect(res.status).toBe(202);
    const bodyText = await textBody(res);
    expect(bodyText).toBe(NEUTRAL_202);
    // Exactly one license, family_free, normalized email.
    const lic = db.query(`SELECT key, email, source, status FROM licenses`).get();
    expect(lic).toBeTruthy();
    expect(lic.email).toBe("family@example.com");
    expect(lic.source).toBe("family_free");
    expect(lic.status).toBe("active");
    expect(db.query(`SELECT COUNT(*) AS c FROM licenses`).get().c).toBe(1);
    // Exactly one family_welcome outbox row.
    const outbox = db.query(`SELECT kind, recipient_email, idempotency_key, payload_json FROM email_outbox`).get();
    expect(outbox).toBeTruthy();
    expect(outbox.kind).toBe("family_welcome");
    expect(outbox.recipient_email).toBe("family@example.com");
    const payload = JSON.parse(outbox.payload_json);
    expect(payload.to).toBe("family@example.com");
    expect(payload.subject).toMatch(/license/i);
    // Invite row marked redeemed with the license key + masked audit.
    const invite = db.query(`SELECT redeemed_at IS NOT NULL AS done, redeemed_email, license_key FROM invite_codes WHERE code_hash = ?`).get(hashInviteCode(code));
    expect(invite.done).toBe(1);
    expect(invite.redeemed_email).toBe("family@example.com");
    expect(invite.license_key).toBe(lic.key);
    const audit = db.query(`SELECT action, subject_masked, detail_json FROM admin_audit WHERE action = 'invite_redeemed'`).get();
    expect(audit).toBeTruthy();
    expect(audit.subject_masked).not.toContain("family@example.com");
    expect(audit.detail_json).not.toContain(lic.key);
    // Response never contains any redemption detail.
    expect(bodyText).not.toContain(lic.key);
    expect(bodyText).not.toContain("family@example.com");
    expect(bodyText).not.toContain(code);
  } finally {
    db.close();
  }
});

test("redeem: fail-closed — rate SQL throws → fixed 500 + fixed log '[invite] request failed', no writes, no padding", async () => {
  const realDb = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const badDb = failingDb(realDb, () => true);
    const { lines, out: { svc } } = captureLoggerFor((logger) => ({
      logger,
      svc: createInviteHttpService({
        db: badDb,
        rateSecret: RATE_SECRET,
        adminToken: ADMIN_TOKEN,
        now: fixedClock(1_700_000_000_000),
        minimumResponseMs: 0,
        logger,
      }),
    }));
    const res = await svc.redeemInviteRequest(
      jsonRequest("http://t/api/invites/redeem", { code: "FAM-AAAA-AAAA-AAAA-AAAA", email: "a@b.com" }),
      { clientIp: "203.0.113.9" }
    );
    expect(res.status).toBe(500);
    const body = JSON.parse(await textBody(res));
    expect(Object.keys(body)).toContain("error");
    expect(JSON.stringify(body)).toBe(JSON.stringify({ error: "invite request failed" }));
    expect(lines).toContain("[invite] request failed");
    expect(lines.join(" ")).not.toContain("FAM-AAAA-AAAA-AAAA-AAAA");
    expect(lines.join(" ")).not.toContain("a@b.com");
    expect(lines.join(" ")).not.toContain("203.0.113.9");
    expect(realDb.query(`SELECT COUNT(*) AS c FROM request_limits`).get().c).toBe(0);
    expect(realDb.query(`SELECT COUNT(*) AS c FROM licenses`).get().c).toBe(0);
  } finally {
    realDb.close();
  }
});

test("redeem: fail-closed — core redeem throws → fixed 500 + '[invite] request failed', rollback leaves zero writes", async () => {
  const realDb = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    // Rate limit works (request_limits inserts fine); core INSERT into licenses throws.
    const badDb = failingDb(realDb, (sql) => sql.includes("INSERT INTO licenses"));
    const { lines, out: { svc } } = captureLoggerFor((logger) => ({
      logger,
      svc: createInviteHttpService({
        db: badDb,
        rateSecret: RATE_SECRET,
        adminToken: ADMIN_TOKEN,
        now: fixedClock(1_700_000_000_000),
        minimumResponseMs: 0,
        logger,
      }),
    }));
    const code = seedInvite(realDb, {});
    const auditsAfterSeed = realDb.query(`SELECT COUNT(*) AS c FROM admin_audit`).get().c;
    const res = await svc.redeemInviteRequest(
      jsonRequest("http://t/api/invites/redeem", { code, email: "a@b.com" }),
      { clientIp: "203.0.113.10" }
    );
    expect(res.status).toBe(500);
    expect(lines).toContain("[invite] request failed");
    // Invite still unredeemed (transaction rolled back), no license/outbox;
    // the pre-existing invite_minted audit remains unchanged.
    const invite = realDb.query(`SELECT redeemed_at FROM invite_codes WHERE code_hash = ?`).get(hashInviteCode(code));
    expect(invite.redeemed_at).toBeNull();
    expect(realDb.query(`SELECT COUNT(*) AS c FROM licenses`).get().c).toBe(0);
    expect(realDb.query(`SELECT COUNT(*) AS c FROM email_outbox`).get().c).toBe(0);
    expect(realDb.query(`SELECT COUNT(*) AS c FROM admin_audit`).get().c).toBe(auditsAfterSeed);
  } finally {
    realDb.close();
  }
});

/* ════════════════════════ Section 3 — admin auth ════════════════════════ */

test("admin auth: bearer-only — token in body/query is REJECTED; only Authorization: Bearer works", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    const body = { label: "g", count: 1, expires_at: 1_700_000_000_000 + 1000 };
    // Token ONLY in body → 403 (never accepted).
    const bodyToken = await svc.mintInvites(jsonRequest("http://t/api/invites/mint", { ...body, token: ADMIN_TOKEN }), { clientIp: "1.2.3.4" });
    expect(bodyToken.status).toBe(403);
    // Token only in query string → 403.
    const queryToken = await svc.mintInvites(
      new Request(`http://t/api/invites/mint?token=${encodeURIComponent(ADMIN_TOKEN)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { clientIp: "1.2.3.4" }
    );
    expect(queryToken.status).toBe(403);
    // Token in body + valid header → 200 (body token is ignored, header wins).
    const both = await svc.mintInvites(
      jsonRequest("http://t/api/invites/mint", { ...body, token: "garbage-token" }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "1.2.3.4" }
    );
    expect(both.status).toBe(200);
    // No Authorization header at all → 403.
    const none = await svc.mintInvites(jsonRequest("http://t/api/invites/mint", body), { clientIp: "1.2.3.4" });
    expect(none.status).toBe(403);
    const rev = await svc.revokeFamily(jsonRequest("http://t/api/invites/revoke", { license_key: "QMP-AAAA-AAAA-AAAA-AAAA", token: ADMIN_TOKEN }), { clientIp: "1.2.3.4" });
    expect(rev.status).toBe(403);
  } finally {
    db.close();
  }
});

test("admin auth: missing/malformed/non-Bearer/wrong token → fixed safe 403 that never echoes the token", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    const body = { label: "g", count: 1, expires_at: 1_700_000_000_000 + 1000 };
    const attempts = [
      { name: "no-header", req: jsonRequest("http://t/api/invites/mint", body) },
      { name: "basic", req: jsonRequest("http://t/api/invites/mint", body, { headers: { authorization: "Basic dXNlcjpwYXNz" } }) },
      { name: "malformed", req: jsonRequest("http://t/api/invites/mint", body, { headers: { authorization: "Bearer" } }) },
      { name: "wrong", req: jsonRequest("http://t/api/invites/mint", body, { headers: { authorization: `Bearer ${"x".repeat(40)}` } }) },
      { name: "word-bearer", req: jsonRequest("http://t/api/invites/mint", body, { headers: { authorization: "Bearer extra extra" } }) },
    ];
    for (const { name, req } of attempts) {
      const res = await svc.mintInvites(req, { clientIp: "1.2.3.4" });
      expect(res.status, name).toBe(403);
      const txt = await textBody(res);
      expect(txt, name).not.toContain("x".repeat(40));
      expect(txt, name).not.toContain(ADMIN_TOKEN);
      expect(JSON.parse(txt).error, name).toBeTruthy();
    }
    // 403 body is fixed and reflects no credentials.
    const authz = await svc.mintInvites(
      jsonRequest("http://t/api/invites/mint", body, { headers: { authorization: "Bearer 0000" } }),
      { clientIp: "1.2.3.4" }
    );
    expect(await textBody(authz)).toBe(JSON.stringify({ error: "unauthorized" }));
    expect(db.query(`SELECT COUNT(*) AS c FROM invite_codes`).get().c).toBe(0);
  } finally {
    db.close();
  }
});

test("admin auth: invalid attempts consume the admin IP bucket BEFORE comparison; limited → fixed 429 even with a valid token", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db, { adminIpLimit: 3 }));
    const body = { label: "g", count: 1, expires_at: 1_700_000_000_000 + 1000 };
    const ip = "203.0.113.77";
    // Two invalid attempts (no header) consume the bucket.
    for (let i = 0; i < 2; i++) {
      const res = await svc.mintInvites(jsonRequest("http://t/api/invites/mint", body), { clientIp: ip });
      expect(res.status).toBe(403);
    }
    // Third attempt with a VALID token still succeeds (limit 3 → 3 allowed).
    const ok = await svc.mintInvites(jsonRequest("http://t/api/invites/mint", body, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), { clientIp: ip });
    expect(ok.status).toBe(200);
    // Fourth attempt (valid token again) → 429 because the bucket hit the cap BEFORE compare.
    const limited = await svc.mintInvites(jsonRequest("http://t/api/invites/mint", body, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), { clientIp: ip });
    expect(limited.status).toBe(429);
    const limitedText = await textBody(limited);
    expect(JSON.parse(limitedText)).toEqual({ error: "rate limit exceeded" });
    // A fresh IP with the valid token is NOT limited.
    const freshIp = await svc.mintInvites(jsonRequest("http://t/api/invites/mint", body, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), { clientIp: "203.0.113.78" });
    expect(freshIp.status).toBe(200);
    // Bucket count froze at the limit; all admin subjects are 64-hex.
    const adminSubject = hashRequestSubject(ip, ADMIN_TOKEN);
    const row = db.query(`SELECT count FROM request_limits WHERE subject_key = ? AND action = 'invite_admin_ip'`).get(adminSubject);
    expect(Number(row.count)).toBe(3);
    const rows = db.query(`SELECT subject_key FROM request_limits WHERE action = 'invite_admin_ip'`).all();
    for (const r of rows) expect(r.subject_key).toMatch(/^[0-9a-f]{64}$/);
    // 429/403 bodies never echo the token or IP.
    expect(limitedText).not.toContain(ADMIN_TOKEN);
  } finally {
    db.close();
  }
});

test("admin auth: blank/unknown clientIp uses the shared unknown bucket; admin auth rate-limit/hash throw fails closed with fixed 500 + '[invite-admin] auth failed'", async () => {
  const realDb = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    // Blank IP → unknown bucket.
    const svc0 = createInviteHttpService(svcOpts(realDb, { adminIpLimit: 1 }));
    const body = { label: "g", count: 1, expires_at: 1_700_000_000_000 + 1000 };
    const first = await svc0.mintInvites(jsonRequest("http://t/api/invites/mint", body, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }));
    expect(first.status).toBe(200);
    const second = await svc0.mintInvites(jsonRequest("http://t/api/invites/mint", body, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }));
    expect(second.status).toBe(429);
    const unknownSubject = hashRequestSubject(UNKNOWN_BUCKET, ADMIN_TOKEN);
    const row = realDb.query(`SELECT count FROM request_limits WHERE subject_key = ? AND action = 'invite_admin_ip'`).get(unknownSubject);
    expect(Number(row.count)).toBe(1);

    // Fail-closed: rate SQL throws during admin auth.
    const badDb = failingDb(realDb, () => true);
    const { lines, out: { svcBad } } = captureLoggerFor((logger) => ({
      logger,
      svcBad: createInviteHttpService({
        db: badDb,
        rateSecret: RATE_SECRET,
        adminToken: ADMIN_TOKEN,
        now: fixedClock(1_700_000_000_000),
        minimumResponseMs: 0,
        logger,
      }),
    }));
    const res = await svcBad.mintInvites(jsonRequest("http://t/api/invites/mint", body, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), { clientIp: "203.0.113.79" });
    expect(res.status).toBe(500);
    expect(JSON.parse(await textBody(res))).toEqual({ error: "invite admin auth failed" });
    expect(lines).toContain("[invite-admin] auth failed");
  } finally {
    realDb.close();
  }
});

/* ════════════════════════ Section 4 — mintInvites ════════════════════════ */

test("mint: authenticated admin receives EXACT {count,expiresAt,codes}; plaintext codes appear only in this response; DB stores only hashes", async () => {
  const db = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    const res = await svc.mintInvites(
      jsonRequest("http://t/api/invites/mint", { label: "Team Lunch", count: 3, expires_at: ts + 40_000 }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "203.0.113.30" }
    );
    expect(res.status).toBe(200);
    const out = JSON.parse(await textBody(res));
    expect(Object.keys(out).sort()).toEqual(["codes", "count", "expiresAt"]);
    expect(out.count).toBe(3);
    expect(out.expiresAt).toBe(ts + 40_000);
    expect(Array.isArray(out.codes)).toBe(true);
    expect(out.codes.length).toBe(3);
    for (const c of out.codes) expect(c).toMatch(/^FAM-[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
    // DB has exactly the hashes, never a plaintext code.
    const rows = db.query(`SELECT code_hash, label, expires_at FROM invite_codes`).all();
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.code_hash).toMatch(/^[0-9a-f]{64}$/);
      out.codes.forEach((c) => expect(r.code_hash).not.toContain(c));
      expect(r.label).toBe("Team Lunch");
      expect(r.expires_at).toBe(ts + 40_000);
    }
    // One audit row, safe detail only.
    const audit = db.query(`SELECT action, subject_masked, detail_json FROM admin_audit`).all();
    expect(audit.length).toBe(1);
    expect(audit[0].action).toBe("invite_minted");
    expect(audit[0].subject_masked).toBe("T********h");
    expect(audit[0].detail_json).not.toContain("Team Lunch");
    // Never persisted: plaintext is not reconstructible from the DB dump.
    const dump = JSON.stringify(rows) + JSON.stringify(audit);
    out.codes.forEach((c) => expect(dump).not.toContain(c));
  } finally {
    db.close();
  }
});

test("mint: invalid input → fixed safe 400 via core validation, zero rows written, no codes leaked, no log", async () => {
  const db = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const { lines, out: { svc } } = captureLoggerFor((logger) => ({
      logger,
      svc: createInviteHttpService({ ...svcOpts(db), logger }),
    }));
    const cases = [
      { label: "", count: 1, expires_at: ts + 1000 },
      { label: "long " + "x".repeat(101), count: 1, expires_at: ts + 1000 },
      { label: "ok", count: 0, expires_at: ts + 1000 },
      { label: "ok", count: 51, expires_at: ts + 1000 },
      { label: "ok", count: 1.5, expires_at: ts + 1000 },
      { label: "ok", count: "three", expires_at: ts + 1000 },
      { label: "ok", count: 1, expires_at: ts }, // must be strictly later
      { label: "ok", count: 1, expires_at: "later" },
    ];
    for (const c of cases) {
      const res = await svc.mintInvites(
        jsonRequest("http://t/api/invites/mint", c, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
        { clientIp: "203.0.113.31" }
      );
      expect(res.status).toBe(400);
      const body = JSON.parse(await textBody(res));
      expect(body.error).toBeTruthy();
      expect(JSON.stringify(body)).not.toMatch(/FAM-/);
    }
    expect(db.query(`SELECT COUNT(*) AS c FROM invite_codes`).get().c).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS c FROM admin_audit`).get().c).toBe(0);
    // 400 is fail-open for logging: no warn/error emitted.
    expect(lines.length).toBe(0);
  } finally {
    db.close();
  }
});

test("mint: system error (core throw) → fixed 500 + '[invite-admin] mint failed'; response carries no codes; none inserted", async () => {
  const realDb = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const badDb = failingDb(realDb, (sql) => sql.includes("INSERT INTO invite_codes"));
    const { lines, out: { svc } } = captureLoggerFor((logger) => ({
      logger,
      svc: createInviteHttpService({ db: badDb, rateSecret: RATE_SECRET, adminToken: ADMIN_TOKEN, now: fixedClock(ts), minimumResponseMs: 0, logger }),
    }));
    const res = await svc.mintInvites(
      jsonRequest("http://t/api/invites/mint", { label: "boom", count: 1, expires_at: ts + 1000 }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "203.0.113.32" }
    );
    expect(res.status).toBe(500);
    const body = JSON.parse(await textBody(res));
    expect(Object.keys(body)).toContain("error");
    expect(JSON.stringify(body)).toBe(JSON.stringify({ error: "invite mint failed" }));
    expect(lines).toContain("[invite-admin] mint failed");
    // No partial codes, no audit.
    expect(realDb.query(`SELECT COUNT(*) AS c FROM invite_codes`).get().c).toBe(0);
    expect(realDb.query(`SELECT COUNT(*) AS c FROM admin_audit`).get().c).toBe(0);
    // Logs carry no codes/errors.
    expect(lines.join(" ")).not.toMatch(/FAM-/);
    expect(lines.join(" ")).not.toMatch(/boom/i);
  } finally {
    realDb.close();
  }
});

test("mint: codes returned in a response are never echoed in later logs or other responses", async () => {
  const db = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const { lines, out: { svc } } = captureLoggerFor((logger) => ({
      logger,
      svc: createInviteHttpService({ ...svcOpts(db), logger }),
    }));
    const res = await svc.mintInvites(
      jsonRequest("http://t/api/invites/mint", { label: "one-off", count: 2, expires_at: ts + 1000 }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "203.0.113.33" }
    );
    const out = JSON.parse(await textBody(res));
    const [codeA, codeB] = out.codes;
    // A second mint does not reuse or echo the first batch.
    const res2 = await svc.mintInvites(
      jsonRequest("http://t/api/invites/mint", { label: "second", count: 1, expires_at: ts + 1000 }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "203.0.113.33" }
    );
    const out2 = JSON.parse(await textBody(res2));
    expect(out2.codes[0]).not.toBe(codeA);
    expect(out2.codes[0]).not.toBe(codeB);
    // Logs contain no plaintext codes.
    expect(lines.join(" ")).not.toContain(codeA);
    expect(lines.join(" ")).not.toContain(codeB);
  } finally {
    db.close();
  }
});

/* ════════════════════════ Section 5 — revokeFamily ════════════════════════ */

/** Insert a family_free active license row directly (bypasses webhooks). */
function seedFamilyLicense(db, { key = generateKey(), email = "fam@seat.com", ts = 1_700_000_000_000 } = {}) {
  db.query(
    `INSERT INTO licenses (key, email, customer_id, subscription_id, status, source, expires_at, current_period_end, cancel_at_period_end, last_stripe_event_created, created_at, updated_at)
     VALUES (?, ?, NULL, NULL, 'active', 'family_free', NULL, NULL, 0, NULL, ?, ?)`
  ).run(key, email, ts, ts);
  return { key, email };
}

test("revoke: authenticated admin revokes a family_free active seat → 200 safe shape; never returns full key/email; audit is masked", async () => {
  const db = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    const { key } = seedFamilyLicense(db, { email: "fam@seat.com", ts });
    const res = await svc.revokeFamily(
      jsonRequest("http://t/api/invites/revoke", { license_key: key }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "203.0.113.40" }
    );
    expect(res.status).toBe(200);
    const bodyTxt = await textBody(res);
    const out = JSON.parse(bodyTxt);
    expect(Object.keys(out).sort()).toEqual(["code", "licenseTail", "revoked"]);
    expect(out).toEqual({ revoked: true, code: "revoked", licenseTail: key.slice(-4) });
    expect(bodyTxt).not.toContain(key);
    expect(bodyTxt).not.toContain("fam@seat.com");
    // License status flipped; audit only carries the masked tail.
    const lic = db.query(`SELECT status, source FROM licenses WHERE key = ?`).get(key);
    expect(lic.status).toBe("revoked");
    expect(lic.source).toBe("family_free");
    const audit = db.query(`SELECT action, subject_masked, detail_json FROM admin_audit`).get();
    expect(audit).toBeTruthy();
    expect(audit.action).toBe("family_license_revoked");
    expect(String(audit.subject_masked)).not.toContain(key);
    expect(audit.detail_json).not.toContain(key);
    expect(JSON.parse(audit.detail_json)).toEqual({ licenseTail: key.slice(-4) });
  } finally {
    db.close();
  }
});

test("revoke: blank/missing license_key → 400; non-family or unknown key → 404 — always the same safe core shape, never the key/email", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    // Blank key → 400 fixed safe core shape.
    const blank = await svc.revokeFamily(
      jsonRequest("http://t/api/invites/revoke", { license_key: "   " }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "203.0.113.41" }
    );
    expect(blank.status).toBe(400);
    const blankText = await textBody(blank);
    expect(JSON.parse(blankText)).toEqual({ revoked: false, code: "not-found", licenseTail: null });
    // Unknown key → 404 same safe shape.
    const unknown = await svc.revokeFamily(
      jsonRequest("http://t/api/invites/revoke", { license_key: "QMP-NOTF-OUND-9999-XXXX" }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "203.0.113.41" }
    );
    expect(unknown.status).toBe(404);
    expect(JSON.parse(await textBody(unknown))).toEqual({ revoked: false, code: "not-found", licenseTail: null });
    // A paid (Stripe) license is NOT a revocable family seat → 404 same shape.
    db.query(
      `INSERT INTO licenses (key, email, customer_id, subscription_id, status, source, created_at, updated_at)
       VALUES (?, 'paid@x.com', 'cus_p', 'sub_p', 'active', 'stripe', ?, ?)`
    ).run("QMP-PAID-PAID-PAID-PAID0", 1_700_000_000_000, 1_700_000_000_000);
    const paid = await svc.revokeFamily(
      jsonRequest("http://t/api/invites/revoke", { license_key: "QMP-PAID-PAID-PAID-PAID0" }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "203.0.113.41" }
    );
    expect(paid.status).toBe(404);
    const paidBody = JSON.parse(await textBody(paid));
    expect(paidBody).toEqual({ revoked: false, code: "not-found", licenseTail: null });
    // Paid license left untouched.
    const paidRow = db.query(`SELECT status FROM licenses WHERE key = ?`).get("QMP-PAID-PAID-PAID-PAID0");
    expect(paidRow.status).toBe("active");
    expect(blankText).not.toContain("QMP-");
    // No audit rows for any failure.
    expect(db.query(`SELECT COUNT(*) AS c FROM admin_audit`).get().c).toBe(0);
  } finally {
    db.close();
  }
});

test("revoke: system error (core throw) → fixed 500 + '[invite-admin] revoke failed'; nothing changed; no key in response/logs", async () => {
  const realDb = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const { key } = seedFamilyLicense(realDb, { ts });
    const badDb = failingDb(realDb, (sql) => sql.includes("status = 'revoked'"));
    const { lines, out: { svc } } = captureLoggerFor((logger) => ({
      logger,
      svc: createInviteHttpService({ db: badDb, rateSecret: RATE_SECRET, adminToken: ADMIN_TOKEN, now: fixedClock(ts), minimumResponseMs: 0, logger }),
    }));
    const res = await svc.revokeFamily(
      jsonRequest("http://t/api/invites/revoke", { license_key: key }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "203.0.113.42" }
    );
    expect(res.status).toBe(500);
    expect(JSON.parse(await textBody(res))).toEqual({ error: "invite revoke failed" });
    expect(lines).toContain("[invite-admin] revoke failed");
    // Rollback left the license active, no audit.
    const lic = realDb.query(`SELECT status FROM licenses WHERE key = ?`).get(key);
    expect(lic.status).toBe("active");
    expect(realDb.query(`SELECT COUNT(*) AS c FROM admin_audit`).get().c).toBe(0);
    expect(lines.join(" ")).not.toContain(key);
    expect(lines.join(" ")).not.toContain("fam@seat.com");
  } finally {
    realDb.close();
  }
});

/* ═══════════════════════ Section 6 — invitePageResponse ═══════════════════════ */

/** Pull the nonce out of the CSP script-src directive. */
function cspNonce(csp) {
  const scriptSrc = csp
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("script-src"));
  const m = scriptSrc.match(/'nonce-([^']+)'/);
  return { scriptSrc, nonce: m && m[1] };
}

test("invitePageResponse: 200 HTML with per-response CSP nonce matching the inline script; frame deny; no unsafe-inline scripts; no-store/no-referrer/nosniff", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    const res1 = await svc.invitePageResponse();
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toContain("text/html");
    expect(res1.headers.get("cache-control")).toBe("no-store");
    expect(res1.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res1.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res1.headers.get("x-frame-options")).toBe("DENY");
    const csp = res1.headers.get("content-security-policy");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    const { scriptSrc, nonce } = cspNonce(csp);
    expect(nonce).toBeTruthy();
    expect(nonce.length).toBeGreaterThanOrEqual(22);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // The inline <script> carries the SAME nonce as the CSP.
    const html = await textBody(res1);
    const scriptTag = html.match(/<script[^>]*\snonce="([^"]+)"[^>]*>/);
    expect(scriptTag && scriptTag[1]).toBe(nonce);
    // Per-response: a second call yields a different nonce.
    const res2 = await svc.invitePageResponse();
    const csp2 = res2.headers.get("content-security-policy");
    const { nonce: nonce2 } = cspNonce(csp2);
    expect(nonce2).toBeTruthy();
    expect(nonce2).not.toBe(nonce);
  } finally {
    db.close();
  }
});

test("invitePageResponse: form JS POSTs JSON to /api/invites/redeem, shows a neutral message via textContent, clears code+email after building the body, and never stores/activates anything", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    const res = await svc.invitePageResponse();
    const html = await textBody(res);
    // Form + inputs present with the expected ids.
    expect(html).toContain('id="invite-form"');
    expect(html).toContain('id="code"');
    expect(html).toContain('id="email"');
    expect(html).toContain('id="invite-status"');
    // Script posts JSON to the redeem endpoint.
    expect(html).toContain('fetch("/api/invites/redeem"');
    expect(html).toContain('JSON.stringify');
    expect(html).toContain('"content-type": "application/json"');
    // Neutral invariant message appears in the page (same text as the API).
    expect(html).toContain(NEUTRAL_MSG);
    // textContent is the ONLY DOM-write mechanism for the status.
    expect(html).toContain(".textContent = ");
    // Inputs are cleared AFTER the body is built (payload uses captured values).
    const payloadIdx = html.indexOf("JSON.stringify");
    expect(html.indexOf("codeInput.value = \"\"", payloadIdx)).toBeGreaterThan(payloadIdx);
    expect(html.indexOf("emailInput.value = \"\"", payloadIdx)).toBeGreaterThan(payloadIdx);
    // No persistence / dangerous sinks / auto activation.
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("sessionStorage");
    expect(html).not.toContain("document.cookie");
    expect(html).not.toContain("innerHTML");
    expect(html).not.toContain(".submit()");
    expect(html).not.toContain("window.location");
    expect(html).toMatch(/addEventListener\("submit"/);
    // The page must not credit-card/auto-redirect or auto-send on load: exactly
    // one fetch call and it lives only inside the submit listener.
    const fetchCount = (html.match(/fetch\(/g) || []).length;
    expect(fetchCount).toBe(1);
  } finally {
    db.close();
  }
});

test("invitePageResponse source never leaks the admin token, rate secret, or any personal markers", async () => {
  const db = freshDb();
  try {
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db, { rateSecret: "rate-secret-abcdef", adminToken: "admin-token-abcdef" }));
    const html = await textBody(await svc.invitePageResponse());
    expect(html).not.toContain("rate-secret-abcdef");
    expect(html).not.toContain("admin-token-abcdef");
    expect(html).not.toContain("RATE_SECRET");
    expect(html).not.toContain("Authorization");
    expect(html).not.toContain("Bearer");
  } finally {
    db.close();
  }
});

/* ═══════════════════════ Section 7 — DB sweep ═══════════════════════ */

test("DB sweep: codes and rate/audit secrets are absent while required invite ownership fields remain", async () => {
  const db = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const svc = createInviteHttpService(svcOpts(db));
    // Mint two codes via HTTP.
    const minted = await svc.mintInvites(
      jsonRequest("http://t/api/invites/mint", { label: "Slice 5B Mint", count: 2, expires_at: ts + 40_000 }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "203.0.113.60" }
    );
    const { codes: [codeA, codeB] } = JSON.parse(await textBody(minted));
    // Redeem codeA (writes a family license + welcome email + audit).
    await svc.redeemInviteRequest(
      jsonRequest("http://t/api/invites/redeem", { code: codeA, email: "sweep@example.com" }),
      { clientIp: "203.0.113.61" }
    );
    // Revoke the resulting family seat.
    const lic = db.query(`SELECT key FROM licenses`).get();
    await svc.revokeFamily(
      jsonRequest("http://t/api/invites/revoke", { license_key: lic.key }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
      { clientIp: "203.0.113.62" }
    );
    // A couple of rate-limit rows (per-IP + per-code).
    await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: codeB, email: "other@example.com" }), { clientIp: "203.0.113.63" });

    // invite_codes intentionally stores redeemed_email + license_key to bind
    // one redeemed invite to one revocable license. Codes remain hash-only;
    // audit and rate tables must not contain raw email/key/IP/secrets.
    const codeRows = db.query(`SELECT * FROM invite_codes`).all();
    const auditRows = db.query(`SELECT * FROM admin_audit`).all();
    const limitRows = db.query(`SELECT * FROM request_limits`).all();
    const dump = JSON.stringify({
      codes: codeRows,
      audit: auditRows,
      limits: limitRows,
    });
    expect(dump).not.toContain(codeA);
    expect(dump).not.toContain(codeB);
    expect(dump).not.toContain(ADMIN_TOKEN);
    expect(dump).not.toContain(RATE_SECRET);
    expect(dump).not.toContain("203.0.113.6");
    expect(codeRows.some((row) => row.redeemed_email === "sweep@example.com")).toBe(true);
    expect(codeRows.some((row) => row.license_key === lic.key)).toBe(true);
    const auditDump = JSON.stringify(auditRows);
    expect(auditDump).not.toContain("sweep@example.com");
    expect(auditDump).not.toContain("other@example.com");
    expect(auditDump).not.toContain(lic.key);
    // request_limits subjects are all 64-hex.
    const limits = db.query(`SELECT subject_key FROM request_limits`).all();
    expect(limits.length).toBeGreaterThan(0);
    for (const r of limits) expect(r.subject_key).toMatch(/^[0-9a-f]{64}$/);
  } finally {
    db.close();
  }
});

/* ═══════════════════════ Section 8 — safe redacted logs ═══════════════════════ */

test("normal operation produces ZERO log lines; only failure paths emit their single fixed line", async () => {
  const db = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const { lines, out: { svc } } = captureLoggerFor((logger) => ({
      logger,
      svc: createInviteHttpService({ ...svcOpts(db), logger }),
    }));
    const code = seedInvite(db, { ts });
    // Success redeem, invalid redeem, mint, revoke-miss, unauthorized admin.
    await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code, email: "quiet@x.com" }), { clientIp: "203.0.113.70" });
    await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: "FAM-BADB-ADBA-DBAB-DBAD", email: "nope" }), { clientIp: "203.0.113.70" });
    const mint = await svc.mintInvites(jsonRequest("http://t/api/invites/mint", { label: "quiet", count: 1, expires_at: ts + 1000 }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), { clientIp: "203.0.113.70" });
    expect(mint.status).toBe(200);
    await svc.revokeFamily(jsonRequest("http://t/api/invites/revoke", { license_key: "QMP-NOPE-0000-0000-0000" }, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), { clientIp: "203.0.113.70" });
    await svc.mintInvites(jsonRequest("http://t/api/invites/mint", { label: "quiet", count: 1, expires_at: ts + 1000 }), { clientIp: "203.0.113.70" });
    expect(lines).toEqual([]);
  } finally {
    db.close();
  }
});

/* ═══════════════════════ Section 9 — timing floor ═══════════════════════ */

test("timing floor (350ms): every neutral 202 path sleeps to the same floor with a constant clock; 500/503 paths do not sleep", async () => {
  const db = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const sleepA = fakeSleepLogger();
    const svc = createInviteHttpService(
      svcOpts(db, { minimumResponseMs: 350, monotonicNow: () => 1000, sleepFn: sleepA.sleepFn })
    );
    const code = seedInvite(db, { ts });
    // success / malformed / invalid / rate-limited all take ≥ the floor.
    const paths = [];
    paths.push(await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code, email: "a@b.com" }), { clientIp: "203.0.113.80" }));
    paths.push(await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", "garbage"), { clientIp: "203.0.113.80" }));
    paths.push(await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: "FAM-AAAA-AAAA-AAAA-AAAA", email: "a@b.com" }), { clientIp: "203.0.113.80" }));
    for (let i = 0; i < 3; i++) {
      paths.push(await svc.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code: `FAM-BBBB-BBBB-BBBB-BBB${i}`, email: "a@b.com" }), { clientIp: "203.0.113.81" }));
    }
    expect(paths.length).toBe(6);
    // Every 202 sleep call hit the floor exactly (constant clock → full 350).
    expect(sleepA.calls.length).toBe(6);
    for (const ms of sleepA.calls) expect(ms).toBe(350);
    // Every response is the identical 202 envelope.
    for (const p of paths) {
      expect(p.status).toBe(202);
      expect(await textBody(p)).toBe(NEUTRAL_202);
    }
    // The 500 path (rate SQL throws) must NOT sleep.
    const sleepB = fakeSleepLogger();
    const badDb = failingDb(db, () => true);
    const { out: { svcBad } } = captureLoggerFor((logger) => ({
      logger,
      svcBad: createInviteHttpService({ db: badDb, rateSecret: RATE_SECRET, adminToken: ADMIN_TOKEN, now: fixedClock(ts), minimumResponseMs: 350, monotonicNow: () => 1000, sleepFn: sleepB.sleepFn, logger }),
    }));
    const failed = await svcBad.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code, email: "a@b.com" }), { clientIp: "203.0.113.82" });
    expect(failed.status).toBe(500);
    expect(sleepB.calls.length).toBe(0);
    // Unconfigured 503 must NOT sleep either.
    const sleepC = fakeSleepLogger();
    const svcUnconf = createInviteHttpService({
      db, rateSecret: "short", adminToken: "", now: fixedClock(ts), minimumResponseMs: 350, monotonicNow: () => 1000, sleepFn: sleepC.sleepFn, logger: silenceLogger(),
    });
    const notConf = await svcUnconf.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code, email: "a@b.com" }), { clientIp: "203.0.113.83" });
    expect(notConf.status).toBe(503);
    expect(sleepC.calls.length).toBe(0);
  } finally {
    db.close();
  }
});

test("timing floor is deterministic and cannot be overridden by the request: partial sleep when below floor, zero sleep when above floor", async () => {
  const db = freshDb();
  try {
    const ts = 1_700_000_000_000;
    const { createInviteHttpService } = await loadInviteHttp();
    const code = seedInvite(db, { ts });

    // Elapsed 100ms of the 350ms floor → sleep exactly the remaining 250ms.
    let t1 = 0;
    const sleep1 = fakeSleepLogger();
    const svc1 = createInviteHttpService(svcOpts(db, { minimumResponseMs: 350, monotonicNow: () => (t1 += 100), sleepFn: sleep1.sleepFn }));
    const r1 = await svc1.redeemInviteRequest(
      new Request("http://t/api/invites/redeem?floor=0&pad=1", {
        method: "POST",
        headers: { "content-type": "application/json", "x-min-ms": "0" },
        body: JSON.stringify({ code, email: "a@b.com" }),
      }),
      { clientIp: "203.0.113.90" }
    );
    expect(r1.status).toBe(202);
    expect(sleep1.calls).toEqual([250]);
    expect(await textBody(r1)).toBe(NEUTRAL_202);

    // Elapsed 400ms (already above the 350ms floor) → zero sleep.
    let t2 = 0;
    const sleep2 = fakeSleepLogger();
    const svc2 = createInviteHttpService(svcOpts(db, { minimumResponseMs: 350, monotonicNow: () => (t2 += 400), sleepFn: sleep2.sleepFn }));
    const r2 = await svc2.redeemInviteRequest(
      new Request("http://t/api/invites/redeem?floor=0", {
        method: "POST",
        headers: { "content-type": "application/json", "x-min-ms": "1" },
        body: JSON.stringify({ code, email: "a@b.com" }),
      }),
      { clientIp: "203.0.113.90" }
    );
    expect(r2.status).toBe(202);
    expect(sleep2.calls).toEqual([]);
    expect(await textBody(r2)).toBe(NEUTRAL_202);

    // floor=0 (default in svcOpts) → no sleeps at all.
    const sleep3 = fakeSleepLogger();
    const svc3 = createInviteHttpService(svcOpts(db, { sleepFn: sleep3.sleepFn }));
    const r3 = await svc3.redeemInviteRequest(jsonRequest("http://t/api/invites/redeem", { code, email: "a@b.com" }), { clientIp: "203.0.113.90" });
    expect(r3.status).toBe(202);
    expect(sleep3.calls).toEqual([]);
    expect(await textBody(r3)).toBe(NEUTRAL_202);
  } finally {
    db.close();
  }
});

