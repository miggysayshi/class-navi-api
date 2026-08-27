// server/test/recovery-email.test.js — Slice 3B-1: encrypted recovery email
// payload hydration at send time + safe message preparation injected into the
// durable email worker.
//
// This file builds behavior-by-behavior under strict vertical TDD: every
// expected failure is fixed and redacted (never the plaintext token, secret,
// license key, or email leaks into throws, logs, or the serialized payload).
import { test, expect } from "bun:test";
import { openDb } from "../db.js";
import {
  generateManagementToken,
  sealManagementToken,
  openManagementToken,
  hashToken,
  DEFAULT_TOKEN_TTL_MS,
  refreshManagementTokenExpiry,
} from "../recovery.js";

// ── Recovery outbox payload hydration ────────────────────────────────────────

test("createRecoveryOutboxPayload: returns a JSON-safe outbox payload containing ciphertext but no plaintext token or secret", async () => {
  const { createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const db = openDb(":memory:");
  try {
    const SECRET = "0123456789abcdef0123456789abcdef";
    const now = 1_000_000;
    // Seed license + four real management tokens.
    db.query(
      `INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`
    ).run("QMP-OUTB-OXPAY-0001-0001", "outbox@example.com", now, now);
    const purposes = ["recover", "reset_chrome", "reset_edge", "reset_all"];
    const tokens = {};
    const tokenMap = {};
    for (const p of purposes) {
      const { token } = generateManagementToken(db, {
        email: "outbox@example.com",
        licenseKey: "QMP-OUTB-OXPAY-0001-0001",
        purpose: p,
        now,
      });
      tokenMap[p] = token;
      tokens[p] = token;
    }

    const payload = createRecoveryOutboxPayload({
      recipient: "  Outbox@Example.COM ",
      licenseKey: "QMP-OUTB-OXPAY-0001-0001",
      tokens,
      secret: SECRET,
    });

    // The payload must contain the sealed token map (openable back to the same plaintext).
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(tokenMap.recover);
    expect(serialized).not.toContain(tokenMap.reset_chrome);
    expect(serialized).not.toContain(tokenMap.reset_edge);
    expect(serialized).not.toContain(tokenMap.reset_all);
    expect(serialized).not.toContain(SECRET);

    // The DB still holds only SHA-256 hex for every token.
    const rows = db.query(`SELECT token_hash FROM management_tokens`).all();
    expect(rows.length).toBe(4);
    const storedHashes = new Set(rows.map((r) => r.token_hash));
    for (const r of rows) {
      expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Every stored hash corresponds to exactly one of the four plaintexts.
    for (const p of purposes) {
      expect(storedHashes.has(hashToken(tokenMap[p]))).toBe(true);
    }

    // Each sealed blob is real: openManagementToken recovers the original plaintext.
    for (const p of purposes) {
      const opened = openManagementToken(payload.tokens[p], SECRET);
      expect(opened).toBe(tokenMap[p]);
    }
  } finally {
    db.close();
  }
});

// ── refreshManagementTokenExpiry ────────────────────────────────────────────

test("refreshManagementTokenExpiry: refreshes an unused, still-rowed token's expiry and never returns hash/email/key", async () => {
  const db = openDb(":memory:");
  try {
    const now = 1_000_000;
    db.query(
      `INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`
    ).run("QMP-REF-RESH0-0001-0001", "r@example.com", now, now);
    const { token } = generateManagementToken(db, {
      email: "r@example.com",
      licenseKey: "QMP-REF-RESH0-0001-0001",
      purpose: "recover",
      now,
    });
    // Pre-expired: the prior TTL has already passed. The helper must still
    // refresh the row (a token that was queued but not yet issued gets revived).
    const future = now + 10 * 60 * 1000;
    const res = refreshManagementTokenExpiry(db, { token, now: future, ttlMs: DEFAULT_TOKEN_TTL_MS });
    // Return shape: { refreshed, expiresAt } and NOTHING else.
    expect(Object.keys(res).sort()).toEqual(["expiresAt", "refreshed"]);
    expect(res.refreshed).toBe(true);
    expect(res.expiresAt).toBe(future + DEFAULT_TOKEN_TTL_MS);
    // Safe return: must not leak hash/email/key.
    const s = JSON.stringify(res);
    expect(s).not.toContain("QMP-REF-RESH0-0001-0001");
    expect(s).not.toContain("r@example.com");
    expect(s).not.toContain(token);
    // DB state actually refreshed.
    const row = db.query(`SELECT expires_at FROM management_tokens WHERE token_hash=?`).get(hashToken(token));
    expect(row.expires_at).toBe(future + DEFAULT_TOKEN_TTL_MS);
  } finally {
    db.close();
  }
});

test("refreshManagementTokenExpiry: missing or used token returns {refreshed:false, expiresAt:null}", async () => {
  const db = openDb(":memory:");
  try {
    const now = 1_000_000;
    db.query(
      `INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`
    ).run("QMP-REF-RFSHM-0001-0001", "rm@example.com", now, now);
    // Missing: never minted.
    const miss = refreshManagementTokenExpiry(db, { token: "never-minted", now, ttlMs: DEFAULT_TOKEN_TTL_MS });
    expect(miss).toEqual({ refreshed: false, expiresAt: null });

    // Used: a token whose row is already spent must NEVER be refreshed.
    const { token: usedTok } = generateManagementToken(db, {
      email: "rm@example.com",
      licenseKey: "QMP-REF-RFSHM-0001-0001",
      purpose: "recover",
      now,
    });
    db.query(`UPDATE management_tokens SET used_at = ? WHERE token_hash = ?`).run(now + 1, hashToken(usedTok));
    const used = refreshManagementTokenExpiry(db, { token: usedTok, now: now + 5, ttlMs: DEFAULT_TOKEN_TTL_MS });
    expect(used).toEqual({ refreshed: false, expiresAt: null });
  } finally {
    db.close();
  }
});

// ── createRecoveryMessagePreparer — happy path ─────────────────────────────

test("createRecoveryMessagePreparer: produces a transient message with the raw key and four fragment links; tokens never in query/path", async () => {
  const { createRecoveryMessagePreparer, createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const now = 1_000_000;
    db.query(
      `INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`
    ).run("QMP-PREP-HAPPY-0001-0001", "prep@example.com", now, now);
    const purposes = ["recover", "reset_chrome", "reset_edge", "reset_all"];
    const tokens = {};
    const tokenMap = {};
    for (const p of purposes) {
      const { token } = generateManagementToken(db, {
        email: "prep@example.com",
        licenseKey: "QMP-PREP-HAPPY-0001-0001",
        purpose: p,
        now,
      });
      tokens[p] = token;
      tokenMap[p] = token;
    }
    const payload = createRecoveryOutboxPayload({
      recipient: "prep@example.com",
      licenseKey: "QMP-PREP-HAPPY-0001-0001",
      tokens,
      secret: SECRET,
    });

    // Mint time for the row: prior expires_at was now+20m (DEFAULT_TOKEN_TTL_MS).
    const prepClock = () => now + 60 * 60 * 1000; // well after the mint TTL
    const prepare = createRecoveryMessagePreparer({
      db, secret: SECRET, baseUrl: "https://manage.example.com", now: prepClock,
    });

    const outboxRow = {
      kind: "recovery",
      recipient_email: "prep@example.com",
      payload_json: JSON.stringify(payload),
    };
    const prepared = await prepare({ row: outboxRow, payload });

    // The transient message carries the raw key in the body (email-only).
        expect(prepared.html).toContain("QMP-PREP-HAPPY-0001-0001");
        // The visible brand is the current one, not the legacy name.
        expect(prepared.subject).toContain("Class Navi Pro Tools");
        expect(prepared.subject).not.toContain("Quick Mark Pro");
        // The four link families are present in the body: the combined view link
        // plus the three reset links. There is no separate "recover" family link.
        for (const family of ["view", "reset_chrome", "reset_edge", "reset_all"]) {
          expect(prepared.html).toContain(family);
        }
        // The plaintext tokens are ONLY in fragment (#token=...&family=...),
        // never in the query string or path. parse+inspect each link to prove it.
        // href attribute values are HTML-escaped (`&` -> `&amp;`); decode back
        // before URL parsing so the fragment is the real one a browser sees.
        const decodedHtml = prepared.html.replace(/&amp;/g, "&");
        const linkRegex = /https:\/\/[^"'\s#]+(?:#[^"'\s]*)?/g;
        const links = (decodedHtml.match(linkRegex) || []).filter((u) => u.includes("manage.example.com/manage"));
        // Exactly four links: one combined view, plus three reset links.
        expect(links.length).toBe(4);
        // Every link targets the canonical `/manage` path (no /manage/<family>
        // suffix) and carries token+family only in the fragment.
        const seenFamilies = new Set();
        for (const url of links) {
          const u = new URL(url);
          expect(u.search).toBe("");
          expect(u.pathname).toBe("/manage");
          expect(u.hash.startsWith("#token=")).toBe(true);
          const params = new URLSearchParams(u.hash.slice(1));
          const t = params.get("token");
          const family = params.get("family");
          expect(typeof t).toBe("string");
          expect(t.length).toBeGreaterThan(0);
          expect(["recover", "reset_chrome", "reset_edge", "reset_all"]).toContain(family);
          // The fragment's token matches the sealed token for that purpose.
          expect(t).toBe(tokenMap[family]);
          seenFamilies.add(family);
        }
    expect([...seenFamilies].sort()).toEqual(["recover", "reset_all", "reset_chrome", "reset_edge"]);
    // No token in any path or query anywhere.
    for (const url of links) {
      const u = new URL(url);
      for (const tok of Object.values(tokenMap)) {
        expect(decodeURIComponent(u.pathname)).not.toContain(tok);
        expect(decodeURIComponent(u.search)).not.toContain(tok);
      }
    }
  } finally {
    db.close();
  }
});

test("createRecoveryMessagePreparer: refreshes every management_tokens row to exactly send-time +20m, including rows whose prior expiry had passed while queued; used token is never refreshed/prepared", async () => {
  const { createRecoveryMessagePreparer, createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const mintAt = 1_000_000;
    const sendAt = mintAt + 30 * 60 * 1000; // 30m after mint, 10m past the original 20m TTL
    db.query(
      `INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`
    ).run("QMP-PREP-RFSH-0001-0001", "rfsh@example.com", mintAt, mintAt);
    const purposes = ["recover", "reset_chrome", "reset_edge", "reset_all"];
    const tokens = {};
    for (const p of purposes) {
      const { token } = generateManagementToken(db, {
        email: "rfsh@example.com",
        licenseKey: "QMP-PREP-RFSH-0001-0001",
        purpose: p,
        now: mintAt,
      });
      tokens[p] = token;
    }
    const payload = createRecoveryOutboxPayload({
      recipient: "rfsh@example.com",
      licenseKey: "QMP-PREP-RFSH-0001-0001",
      tokens, secret: SECRET,
    });
    // Mark the 'recover' row USED before send. The preparer must fail
    // (no link, no refresh) because the row is spent.
    const recoverHash = hashToken(tokens.recover);
    db.query(`UPDATE management_tokens SET used_at = ? WHERE token_hash = ?`).run(sendAt - 1000, recoverHash);

    const prepare = createRecoveryMessagePreparer({
      db, secret: SECRET, baseUrl: "https://manage.example.com", now: () => sendAt,
    });
    const outboxRow = {
      kind: "recovery",
      recipient_email: "rfsh@example.com",
      payload_json: JSON.stringify(payload),
    };
    let threw = null;
    try {
      await prepare({ row: outboxRow, payload });
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    // The 'recover' row's used_at was set BEFORE prepare, so refresh should be a
    // no-op (no overwrite of used_at). The other three rows must NOT have been
    // refreshed either: the preparer must be all-or-nothing.
    for (const p of purposes) {
      const row = db.query(`SELECT expires_at, used_at FROM management_tokens WHERE token_hash = ?`).get(hashToken(tokens[p]));
      // expires_at must equal its mint value (mintAt + 20m). No row was refreshed.
      expect(row.expires_at).toBe(mintAt + DEFAULT_TOKEN_TTL_MS);
    }
    // The 'recover' row's used_at must be unchanged.
    const r = db.query(`SELECT used_at FROM management_tokens WHERE token_hash = ?`).get(recoverHash);
    expect(r.used_at).toBe(sendAt - 1000);
  } finally {
    db.close();
  }
});

test("createRecoveryMessagePreparer: token rows all refreshed to exact send-time +20m including rows that had expired while queued; used token is never refreshed/prepared", async () => {
  const { createRecoveryMessagePreparer, createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const mintAt = 1_000_000;
    const sendAt = mintAt + 30 * 60 * 1000; // 30m after mint (10m past original 20m TTL)
    db.query(
      `INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`
    ).run("QMP-PREP-LIVE-0001-0001", "live@example.com", mintAt, mintAt);
    const purposes = ["recover", "reset_chrome", "reset_edge", "reset_all"];
    const tokens = {};
    for (const p of purposes) {
      const { token } = generateManagementToken(db, {
        email: "live@example.com",
        licenseKey: "QMP-PREP-LIVE-0001-0001",
        purpose: p,
        now: mintAt,
      });
      tokens[p] = token;
    }
    const payload = createRecoveryOutboxPayload({
      recipient: "live@example.com",
      licenseKey: "QMP-PREP-LIVE-0001-0001",
      tokens, secret: SECRET,
    });
    const prepare = createRecoveryMessagePreparer({
      db, secret: SECRET, baseUrl: "https://manage.example.com", now: () => sendAt,
    });
    const outboxRow = {
      kind: "recovery",
      recipient_email: "live@example.com",
      payload_json: JSON.stringify(payload),
    };
    await prepare({ row: outboxRow, payload });
    // Every row's expires_at must be exactly sendAt + 20m.
    for (const p of purposes) {
      const row = db.query(`SELECT expires_at FROM management_tokens WHERE token_hash = ?`).get(hashToken(tokens[p]));
      expect(row.expires_at).toBe(sendAt + 20 * 60 * 1000);
    }
  } finally {
    db.close();
  }
});

// ── createRecoveryMessagePreparer — failure modes (redacted) ───────────────

test("createRecoveryMessagePreparer: tamper, wrong secret, hash/purpose/license/email mismatch, used, missing — all fail with the SAME fixed redacted message", async () => {
  const { createRecoveryMessagePreparer, createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const WRONG = "different-secret-but-long-enough-to-pass-length";
  const db = openDb(":memory:");
  try {
    const now = 1_000_000;
    db.query(
      `INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`
    ).run("QMP-FAIL-URES0-0001-0001", "fail@example.com", now, now);
    const purposes = ["recover", "reset_chrome", "reset_edge", "reset_all"];
    const tokens = {};
    for (const p of purposes) {
      tokens[p] = generateManagementToken(db, {
        email: "fail@example.com",
        licenseKey: "QMP-FAIL-URES0-0001-0001",
        purpose: p,
        now,
      }).token;
    }
    const basePayload = createRecoveryOutboxPayload({
      recipient: "fail@example.com",
      licenseKey: "QMP-FAIL-URES0-0001-0001",
      tokens, secret: SECRET,
    });
    const baseRow = {
      kind: "recovery",
      recipient_email: "fail@example.com",
      payload_json: JSON.stringify(basePayload),
    };

    async function expectFixedThrew(p, s, row) {
      let err = null;
      try { await p({ row, payload: basePayload }); } catch (e) { err = e; }
      expect(err).not.toBeNull();
      // Same fixed redacted message regardless of cause.
      expect(String(err.message)).toBe("recovery-preparation-failed");
      // The error must NOT echo key, email, secret, or any token.
      const m = String(err.message);
      expect(m).not.toContain("QMP-FAIL-URES0-0001-0001");
      expect(m).not.toContain("fail@example.com");
      expect(m).not.toContain(SECRET);
      expect(m).not.toContain(WRONG);
      for (const tok of Object.values(tokens)) {
        expect(m).not.toContain(tok);
      }
    }

    // 1) wrong secret
    const prepWrong = createRecoveryMessagePreparer({ db, secret: WRONG, baseUrl: "https://manage.example.com", now: () => now });
    await expectFixedThrew(prepWrong, SECRET, baseRow);

    // 2) tampered seal — flip a byte in one ciphertext.
    const tamperedPayload = JSON.parse(JSON.stringify(basePayload));
    const obj = JSON.parse(tamperedPayload.tokens.recover);
    obj.ciphertext = "AAAA" + obj.ciphertext.slice(4);
    tamperedPayload.tokens.recover = JSON.stringify(obj);
    const prepRight = createRecoveryMessagePreparer({ db, secret: SECRET, baseUrl: "https://manage.example.com", now: () => now });
    let errTamper = null;
    try { await prepRight({ row: baseRow, payload: tamperedPayload }); } catch (e) { errTamper = e; }
    expect(String(errTamper.message)).toBe("recovery-preparation-failed");

    // 3) wrong purpose on the row — the row says 'reset_chrome' but the
    //    sealed token was minted as 'recover' (or vice versa).
    const db2 = openDb(":memory:");
    try {
      const now2 = now;
      db2.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
        .run("QMP-FAIL-URES0-0001-0001", "fail@example.com", now2, now2);
      // Build a payload whose 'recover' seal actually holds a 'reset_chrome' token.
      const tokMap = {};
      for (const p of purposes) {
        tokMap[p] = generateManagementToken(db2, {
          email: "fail@example.com", licenseKey: "QMP-FAIL-URES0-0001-0001", purpose: p, now: now2,
        }).token;
      }
      const swapped = createRecoveryOutboxPayload({
        recipient: "fail@example.com", licenseKey: "QMP-FAIL-URES0-0001-0001",
        tokens: { ...tokMap, recover: tokMap.reset_chrome }, secret: SECRET,
      });
      const prep2 = createRecoveryMessagePreparer({ db: db2, secret: SECRET, baseUrl: "https://manage.example.com", now: () => now2 });
      let errSwap = null;
      try { await prep2({ row: { kind: "recovery", recipient_email: "fail@example.com", payload_json: JSON.stringify(swapped) }, payload: swapped }); }
      catch (e) { errSwap = e; }
      expect(String(errSwap.message)).toBe("recovery-preparation-failed");
    } finally {
      db2.close();
    }

    // 4) used row: mark 'recover' as used; the preparer must fail closed and
    //    not have touched any expires_at.
    const db3 = openDb(":memory:");
    try {
      db3.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
        .run("QMP-FAIL-URES0-0001-0001", "fail@example.com", now, now);
      const t = {};
      for (const p of purposes) {
        t[p] = generateManagementToken(db3, {
          email: "fail@example.com", licenseKey: "QMP-FAIL-URES0-0001-0001", purpose: p, now,
        }).token;
      }
      db3.query(`UPDATE management_tokens SET used_at = ? WHERE token_hash = ?`).run(now + 1, hashToken(t.recover));
      const p3 = createRecoveryOutboxPayload({ recipient: "fail@example.com", licenseKey: "QMP-FAIL-URES0-0001-0001", tokens: t, secret: SECRET });
      const prep3 = createRecoveryMessagePreparer({ db: db3, secret: SECRET, baseUrl: "https://manage.example.com", now: () => now });
      let errUsed = null;
      try { await prep3({ row: { kind: "recovery", recipient_email: "fail@example.com", payload_json: JSON.stringify(p3) }, payload: p3 }); }
      catch (e) { errUsed = e; }
      expect(String(errUsed.message)).toBe("recovery-preparation-failed");
      // No row was refreshed.
      for (const purp of purposes) {
        const r = db3.query(`SELECT expires_at FROM management_tokens WHERE token_hash = ?`).get(hashToken(t[purp]));
        expect(r.expires_at).toBe(now + DEFAULT_TOKEN_TTL_MS);
      }
    } finally {
      db3.close();
    }

    // 5) email mismatch: row says recipient = other@x.com but payload.licenseKey belongs to fail@example.com.
    const db4 = openDb(":memory:");
    try {
      const now4 = now;
      db4.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
        .run("QMP-FAIL-URES0-0001-0001", "fail@example.com", now4, now4);
      const t4 = {};
      for (const p of purposes) {
        t4[p] = generateManagementToken(db4, {
          email: "fail@example.com", licenseKey: "QMP-FAIL-URES0-0001-0001", purpose: p, now: now4,
        }).token;
      }
      const p4 = createRecoveryOutboxPayload({ recipient: "fail@example.com", licenseKey: "QMP-FAIL-URES0-0001-0001", tokens: t4, secret: SECRET });
      const prep4 = createRecoveryMessagePreparer({ db: db4, secret: SECRET, baseUrl: "https://manage.example.com", now: () => now4 });
      const badRow = { kind: "recovery", recipient_email: "other@example.com", payload_json: JSON.stringify(p4) };
      let errEm = null;
      try { await prep4({ row: badRow, payload: p4 }); } catch (e) { errEm = e; }
      expect(String(errEm.message)).toBe("recovery-preparation-failed");
    } finally {
      db4.close();
    }

    // 6) missing fields — payload has no tokens at all.
    const empty = { kind: "recovery", version: 1, recipient: "fail@example.com", licenseKey: "QMP-FAIL-URES0-0001-0001", tokens: {} };
    let errEmpty = null;
    try { await prepRight({ row: { kind: "recovery", recipient_email: "fail@example.com", payload_json: "{}" }, payload: empty }); }
    catch (e) { errEmpty = e; }
    expect(String(errEmpty.message)).toBe("recovery-preparation-failed");

    // 7) wrong version.
    const wrongVer = { ...basePayload, version: 999 };
    let errVer = null;
    try { await prepRight({ row: { kind: "recovery", recipient_email: "fail@example.com", payload_json: "{}" }, payload: wrongVer }); }
    catch (e) { errVer = e; }
    expect(String(errVer.message)).toBe("recovery-preparation-failed");
  } finally {
    db.close();
  }
});

// ── identity for non-recovery rows + HTML escape hostile values ─────────────

test("createRecoveryMessagePreparer: non-recovery row is identity (returns payload unchanged)", async () => {
  const { createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const db = openDb(":memory:");
  try {
    const prepare = createRecoveryMessagePreparer({ db, secret: "s".repeat(32), baseUrl: "https://manage.example.com", now: () => 0 });
    const row = { kind: "welcome", recipient_email: "w@example.com", payload_json: "{}" };
    const welcomePayload = { from: "F", reply_to: "R", to: "w@example.com", subject: "S", html: "<p>hello</p>" };
    const out = await prepare({ row, payload: welcomePayload });
    expect(out).toBe(welcomePayload); // exact identity
  } finally {
    db.close();
  }
});

test("createRecoveryMessagePreparer: HTML escaping neutralizes hostile but test-only values in the raw key without weakening production ownership checks", async () => {
  const { createRecoveryMessagePreparer, createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const now = 1_000_000;
    // Hostile test-only key value: it would break out of the <p>...</p> if not
    // escaped. We deliberately use a string that does NOT match a real
    // license (the production generateKey alphabet excludes 0/O/1/I/L, and
    // this string contains '0' and '<'). This proves only the email-time
    // escaper; the license ownership check in recovery.js is unchanged.
    const HOSTILE = "QMP-<script>alert(1)</script>";
    db.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run(HOSTILE, "host@example.com", now, now);
    const tokens = {};
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      tokens[p] = generateManagementToken(db, {
        email: "host@example.com", licenseKey: HOSTILE, purpose: p, now,
      }).token;
    }
    const payload = createRecoveryOutboxPayload({
      recipient: "host@example.com", licenseKey: HOSTILE, tokens, secret: SECRET,
    });
    const prepare = createRecoveryMessagePreparer({
      db, secret: SECRET, baseUrl: "https://manage.example.com", now: () => now + 60_000,
    });
    const out = await prepare({
      row: { kind: "recovery", recipient_email: "host@example.com", payload_json: JSON.stringify(payload) },
      payload,
    });
    // The literal <script> tag must NOT appear unescaped in the HTML body.
    expect(out.html).not.toContain("<script>alert(1)</script>");
    // The escaped form is in the body.
    expect(out.html).toContain("&lt;script&gt;");
  } finally {
    db.close();
  }
});

// ── worker integration: prepareMessage injection, success and preparation failure ──

test("worker wires prepareMessage: a successful recovery row is sent with the SAME idempotency key and the prepared message", async () => {
  const { createEmailWorker } = await import("../email-worker.js");
  const { enqueueEmail } = await import("../db.js");
  const { createRecoveryOutboxPayload, createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const { generateManagementToken, openManagementToken } = await import("../recovery.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const now = 1_000_000;
    db.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run("QMP-WKR-OK000-0001-0001", "wok@example.com", now, now);
    const tokens = {};
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      tokens[p] = generateManagementToken(db, {
        email: "wok@example.com", licenseKey: "QMP-WKR-OK000-0001-0001", purpose: p, now,
      }).token;
    }
    const payload = createRecoveryOutboxPayload({
      recipient: "wok@example.com", licenseKey: "QMP-WKR-OK000-0001-0001", tokens, secret: SECRET,
    });
    enqueueEmail(db, {
      kind: "recovery",
      recipientEmail: "wok@example.com",
      payload,
      idempotencyKey: "rec:wok",
      createdAt: 0,
      licenseKey: "QMP-WKR-OK000-0001-0001",
    });
    // The recipient is normalized inside enqueueEmail; enqueue uses the row
    // kind to populate kind. Re-stamp the row kind=recovery (enqueue defaults
    // to 'welcome' on omit). Force the kind in the DB to match.
    db.query(`UPDATE email_outbox SET kind = 'recovery' WHERE idempotency_key = 'rec:wok'`);

    let captured = null;
    const sent = [];
    const sender = {
      send: async ({ idempotencyKey, message }) => {
        sent.push({ idempotencyKey, message });
        return { ok: true, status: 200, providerMessageId: "m_wok" };
      },
    };
    const prepare = createRecoveryMessagePreparer({
      db, secret: SECRET, baseUrl: "https://manage.example.com", now: () => now + 60_000,
    });
    const worker = createEmailWorker({ db, sender, now: () => now + 60_000, prepareMessage: prepare });
    const r = await worker();
    expect(r.state).toBe("sent");
    expect(sent.length).toBe(1);
    expect(sent[0].idempotencyKey).toBe("rec:wok");
    // The provider saw the PREPARED message (with the raw key + fragment links), not the JSON outbox payload.
    expect(sent[0].message.html).toContain("QMP-WKR-OK000-0001-0001");
    expect(sent[0].message.html).toContain("manage.example.com/manage");
    // Subject uses the current brand.
    expect(sent[0].message.subject).toContain("Class Navi Pro Tools");
    expect(sent[0].message.subject).not.toContain("Quick Mark Pro");
    // No plaintext token in any of the four link paths/queries.
    const decoded = sent[0].message.html.replace(/&amp;/g, "&");
    const linkRegex = /https:\/\/[^"'\s#]+(?:#[^"'\s]*)?/g;
    const links = (decoded.match(linkRegex) || []).filter((u) => u.includes("manage.example.com/manage"));
    // Exactly four links.
    expect(links.length).toBe(4);
    for (const url of links) {
      const u = new URL(url);
      expect(u.pathname).toBe("/manage");
      expect(u.search).toBe("");
      for (const tok of Object.values(tokens)) {
        expect(decodeURIComponent(u.pathname)).not.toContain(tok);
      }
    }
    // The row is sent.
    const row = db.query(`SELECT * FROM email_outbox WHERE idempotency_key='rec:wok'`).get();
    expect(row.status).toBe("sent");
    expect(row.provider_message_id).toBe("m_wok");
  } finally {
    db.close();
  }
});

test("worker: a preparation failure marks the row dead with category=preparation, never calls sender.send, and logs only a fixed redacted line", async () => {
  const { createEmailWorker } = await import("../email-worker.js");
  const { enqueueEmail } = await import("../db.js");
  const { createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const { generateManagementToken } = await import("../recovery.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const now = 1_000_000;
    db.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run("QMP-WKR-BAD0-0001-0001", "wbad@example.com", now, now);
    const tokens = {};
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      tokens[p] = generateManagementToken(db, {
        email: "wbad@example.com", licenseKey: "QMP-WKR-BAD0-0001-0001", purpose: p, now,
      }).token;
    }
    const payload = createRecoveryOutboxPayload({
      recipient: "wbad@example.com", licenseKey: "QMP-WKR-BAD0-0001-0001", tokens, secret: SECRET,
    });
    enqueueEmail(db, {
      kind: "recovery",
      recipientEmail: "wbad@example.com",
      payload,
      idempotencyKey: "rec:wbad",
      createdAt: 0,
      licenseKey: "QMP-WKR-BAD0-0001-0001",
    });
    db.query(`UPDATE email_outbox SET kind = 'recovery' WHERE idempotency_key = 'rec:wbad'`);

    // Preparer that ALWAYS throws (simulating a tamper discovered at send time).
    const prepEntries = [];
    const prepare = async ({ row, payload: p }) => {
      prepEntries.push({ row: row && row.idempotency_key, payload: p });
      throw new Error("SIMULATED: tamper detected");
    };
    let senderCalled = false;
    const sender = { send: async () => { senderCalled = true; return { ok: true, status: 200, providerMessageId: "m" }; } };
    const logger = {
      entries: [],
      info: (...a) => logger.entries.push(["info", ...a]),
      warn: (...a) => logger.entries.push(["warn", ...a]),
      error: (...a) => logger.entries.push(["error", ...a]),
      log: (...a) => logger.entries.push(["log", ...a]),
    };
    const worker = createEmailWorker({ db, sender, now: () => now + 60_000, prepareMessage: prepare, logger });
    const r = await worker();
    expect(r.state).toBe("dead");
    expect(senderCalled).toBe(false);
    // Row is dead with category=preparation.
    const row = db.query(`SELECT * FROM email_outbox WHERE idempotency_key='rec:wbad'`).get();
    expect(row.status).toBe("dead");
    expect(row.last_error).toBe("preparation");
    // Logs contain ONLY the fixed redacted line; never the error object,
    // never the recipient, never the key, never any token, never a sealed blob.
    const serialized = JSON.stringify(logger.entries);
    expect(serialized).toContain("[email] message preparation failed");
    expect(serialized).not.toContain("SIMULATED: tamper detected");
    expect(serialized).not.toContain("wbad@example.com");
    expect(serialized).not.toContain("QMP-WKR-BAD0-0001-0001");
    expect(serialized).not.toContain(SECRET);
    for (const tok of Object.values(tokens)) {
      expect(serialized).not.toContain(tok);
    }
    // The preparer was actually called.
    expect(prepEntries.length).toBe(1);
  } finally {
    db.close();
  }
});

test("worker: non-recovery welcome path is unchanged when prepareMessage is NOT supplied (default identity)", async () => {
  const { createEmailWorker } = await import("../email-worker.js");
  const { enqueueEmail } = await import("../db.js");
  const db = openDb(":memory:");
  try {
    enqueueEmail(db, {
      kind: "welcome", recipientEmail: "w@example.com",
      payload: { from: "F", reply_to: "R", to: "w@example.com", subject: "S", html: "<p>hi</p>" },
      idempotencyKey: "k:welcome", createdAt: 0,
    });
    let captured = null;
    const sender = { send: async ({ idempotencyKey, message }) => { captured = { idempotencyKey, message }; return { ok: true, status: 200, providerMessageId: "m" }; } };
    const worker = createEmailWorker({ db, sender, now: () => 1000, leaseMs: 60000 });
    const r = await worker();
    expect(r.state).toBe("sent");
    expect(captured.idempotencyKey).toBe("k:welcome");
    // The provider received the EXACT JSON outbox payload (identity).
    expect(captured.message).toEqual({ from: "F", reply_to: "R", to: "w@example.com", subject: "S", html: "<p>hi</p>" });
  } finally {
    db.close();
  }
});

// ── Slice 3B-1R: exact token map (own keys, no inherited/extra) ────────────

test("createRecoveryOutboxPayload: REJECTS tokens map with EXTRANEOUS keys (fixed redacted error)", async () => {
  const { createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  let err = null;
  try {
    createRecoveryOutboxPayload({
      recipient: "x@example.com",
      licenseKey: "QMP-EXTR-NEOUS-0001-0001",
      tokens: {
        recover: "a".repeat(40),
        reset_chrome: "b".repeat(40),
        reset_edge: "c".repeat(40),
        reset_all: "d".repeat(40),
        extra: "should-not-be-here",
      },
      secret: SECRET,
    });
  } catch (e) { err = e; }
  expect(err).not.toBeNull();
  // Fixed redacted message — never echo key, email, secret, or any token.
  expect(String(err.message)).toBe("createRecoveryOutboxPayload: invalid tokens map");
  const s = String(err.message);
  expect(s).not.toContain("QMP-EXTR-NEOUS-0001-0001");
  expect(s).not.toContain("x@example.com");
  expect(s).not.toContain(SECRET);
  expect(s).not.toContain("extra");
  expect(s).not.toContain("should-not-be-here");
  expect(s).not.toContain("a".repeat(40));
});

test("createRecoveryOutboxPayload: REJECTS tokens map with MISSING required purpose (fixed redacted error)", async () => {
  const { createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  let err = null;
  try {
    createRecoveryOutboxPayload({
      recipient: "x@example.com",
      licenseKey: "QMP-MISS-INGPP-0001-0001",
      tokens: {
        recover: "a".repeat(40),
        reset_chrome: "b".repeat(40),
        // reset_edge missing
        reset_all: "d".repeat(40),
      },
      secret: SECRET,
    });
  } catch (e) { err = e; }
  expect(err).not.toBeNull();
  expect(String(err.message)).toBe("createRecoveryOutboxPayload: invalid tokens map");
});

test("createRecoveryOutboxPayload: REJECTS tokens with INHERITED keys from Object.prototype (fixed redacted error)", async () => {
  const { createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  // 'recover' is inherited (NOT own) — only reset_* are own. hasOwnProperty
  // must be the gate; Object.keys alone would not catch this because
  // Object.keys() excludes inherited keys, but tokens.recover still returns
  // the inherited string. The check must verify OWN presence for every
  // required key.
  const proto = { recover: "from-proto" };
  const tokens = Object.create(proto);
  tokens.reset_chrome = "b".repeat(40);
  tokens.reset_edge = "c".repeat(40);
  tokens.reset_all = "d".repeat(40);
  let err = null;
  try {
    createRecoveryOutboxPayload({
      recipient: "x@example.com",
      licenseKey: "QMP-INHR-PROTO-0001-0001",
      tokens,
      secret: SECRET,
    });
  } catch (e) { err = e; }
  expect(err).not.toBeNull();
  expect(String(err.message)).toBe("createRecoveryOutboxPayload: invalid tokens map");
});

test("createRecoveryMessagePreparer: REJECTS payload.tokens with EXTRANEOUS keys BEFORE any seal open", async () => {
  const { createRecoveryOutboxPayload, createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const now = 1_000_000;
    db.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run("QMP-EXTR-PREP0-0001-0001", "extrap@example.com", now, now);
    const tokens = {};
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      tokens[p] = generateManagementToken(db, { email: "extrap@example.com", licenseKey: "QMP-EXTR-PREP0-0001-0001", purpose: p, now }).token;
    }
    // Build payload with the four required, then ADD an extra. The preparer
    // must reject the WHOLE payload with the fixed redacted message; it must
    // not have opened any seal or queried the DB.
    const payload = createRecoveryOutboxPayload({
      recipient: "extrap@example.com", licenseKey: "QMP-EXTR-PREP0-0001-0001", tokens, secret: SECRET,
    });
    const tampered = { ...payload, tokens: { ...payload.tokens, extra: "x" } };
    const prep = createRecoveryMessagePreparer({ db, secret: SECRET, baseUrl: "https://manage.example.com", now: () => now });
    let err = null;
    try {
      await prep({ row: { kind: "recovery", recipient_email: "extrap@example.com", payload_json: "{}" }, payload: tampered });
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(String(err.message)).toBe("recovery-preparation-failed");
    // DB untouched.
    const rows = db.query(`SELECT COUNT(*) AS n FROM management_tokens`).get();
    expect(rows.n).toBe(4);
  } finally {
    db.close();
  }
});

test("createRecoveryMessagePreparer: REJECTS payload.tokens MISSING a required purpose", async () => {
  const { createRecoveryOutboxPayload, createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const now = 1_000_000;
    db.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run("QMP-MISS-PREP0-0001-0001", "missp@example.com", now, now);
    const tokens = {};
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      tokens[p] = generateManagementToken(db, { email: "missp@example.com", licenseKey: "QMP-MISS-PREP0-0001-0001", purpose: p, now }).token;
    }
    const payload = createRecoveryOutboxPayload({
      recipient: "missp@example.com", licenseKey: "QMP-MISS-PREP0-0001-0001", tokens, secret: SECRET,
    });
    const tampered = { ...payload, tokens: { ...payload.tokens } };
    delete tampered.tokens.reset_edge;
    const prep = createRecoveryMessagePreparer({ db, secret: SECRET, baseUrl: "https://manage.example.com", now: () => now });
    let err = null;
    try {
      await prep({ row: { kind: "recovery", recipient_email: "missp@example.com", payload_json: "{}" }, payload: tampered });
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(String(err.message)).toBe("recovery-preparation-failed");
  } finally {
    db.close();
  }
});

// ── Slice 3B-1R: HTTPS base URL safety at constructor + single /manage target ─

test("createRecoveryMessagePreparer: REJECTS http:// (non-localhost) at constructor with fixed redacted error", async () => {
  const { createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const db = openDb(":memory:");
  try {
    let err = null;
    try {
      createRecoveryMessagePreparer({ db, secret: "x".repeat(32), baseUrl: "http://example.com" });
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(String(err.message)).toBe("createRecoveryMessagePreparer: baseUrl must be an https URL (http only permitted for localhost)");
    // Never echo the input URL.
    expect(String(err.message)).not.toContain("http://example.com");
    expect(String(err.message)).not.toContain("example.com");
  } finally {
    db.close();
  }
});

test("createRecoveryMessagePreparer: REJECTS non-http(s) protocols", async () => {
  const { createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const db = openDb(":memory:");
  try {
    for (const bad of ["ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "//example.com"]) {
      let err = null;
      try {
        createRecoveryMessagePreparer({ db, secret: "x".repeat(32), baseUrl: bad });
      } catch (e) { err = e; }
      expect(err).not.toBeNull();
      expect(String(err.message)).toBe("createRecoveryMessagePreparer: baseUrl must be an https URL (http only permitted for localhost)");
      expect(String(err.message)).not.toContain(bad);
    }
  } finally {
    db.close();
  }
});

test("createRecoveryMessagePreparer: REJECTS malformed baseUrl", async () => {
  const { createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const db = openDb(":memory:");
  try {
    for (const bad of ["", "   ", "not-a-url", "http:/foo", "://nohost"]) {
      let err = null;
      try {
        createRecoveryMessagePreparer({ db, secret: "x".repeat(32), baseUrl: bad });
      } catch (e) { err = e; }
      expect(err).not.toBeNull();
      expect(String(err.message)).toBe("createRecoveryMessagePreparer: baseUrl must be an https URL (http only permitted for localhost)");
      // The fixed safe error never echoes non-empty caller input.
      // (Empty/whitespace inputs are excluded: `not.toContain("")` is
      // vacuously true for any string, so it can't prove absence.)
      if (bad.trim() !== "") {
        expect(String(err.message)).not.toContain(bad);
      }
    }
  } finally {
    db.close();
  }
});

test("createRecoveryMessagePreparer: REJECTS baseUrl with credentials, query, or fragment", async () => {
  const { createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const db = openDb(":memory:");
  try {
    for (const bad of [
      "https://user:pass@example.com",
      "https://example.com/?token=abc",
      "https://example.com/#frag",
    ]) {
      let err = null;
      try {
        createRecoveryMessagePreparer({ db, secret: "x".repeat(32), baseUrl: bad });
      } catch (e) { err = e; }
      expect(err).not.toBeNull();
      expect(String(err.message)).toBe("createRecoveryMessagePreparer: baseUrl must be an https URL (http only permitted for localhost)");
      expect(String(err.message)).not.toContain(bad);
    }
  } finally {
    db.close();
  }
});

test("createRecoveryMessagePreparer: PERMITS http://localhost / http://127.0.0.1 / http://[::1] (dev loopback)", async () => {
  const { createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const db = openDb(":memory:");
  try {
    for (const ok of ["http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:3000"]) {
      expect(() =>
        createRecoveryMessagePreparer({ db, secret: "x".repeat(32), baseUrl: ok })
      ).not.toThrow();
    }
    // But localhost variants with credentials/query/fragment still rejected.
    for (const bad of [
      "http://user:pass@localhost:3000",
      "http://localhost:3000/?x=1",
      "http://localhost:3000/#x",
    ]) {
      let err = null;
      try {
        createRecoveryMessagePreparer({ db, secret: "x".repeat(32), baseUrl: bad });
      } catch (e) { err = e; }
      expect(err).not.toBeNull();
      expect(String(err.message)).toBe("createRecoveryMessagePreparer: baseUrl must be an https URL (http only permitted for localhost)");
    }
  } finally {
    db.close();
  }
});

test("createRecoveryMessagePreparer: ALL four links target the canonical ${origin}/manage path (no /manage/<family>)", async () => {
  const { createRecoveryMessagePreparer, createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const now = 1_000_000;
    db.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run("QMP-MGTA-RGET-0001-0001", "mgt@example.com", now, now);
    const tokens = {};
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      tokens[p] = generateManagementToken(db, { email: "mgt@example.com", licenseKey: "QMP-MGTA-RGET-0001-0001", purpose: p, now }).token;
    }
    const payload = createRecoveryOutboxPayload({
      recipient: "mgt@example.com", licenseKey: "QMP-MGTA-RGET-0001-0001", tokens, secret: SECRET,
    });
    const prepare = createRecoveryMessagePreparer({ db, secret: SECRET, baseUrl: "https://manage.example.com", now: () => now + 60_000 });
    const out = await prepare({ row: { kind: "recovery", recipient_email: "mgt@example.com", payload_json: "{}" }, payload });
    const decoded = out.html.replace(/&amp;/g, "&");
    const linkRegex = /https:\/\/[^\s"'#]+(?:#[^\s"']*)?/g;
    const links = (decoded.match(linkRegex) || []).filter((u) => u.includes("manage.example.com/manage"));
    // Exactly four.
    expect(links.length).toBe(4);
    for (const url of links) {
      const u = new URL(url);
      expect(u.pathname).toBe("/manage");
      expect(u.search).toBe("");
      expect(u.hash.startsWith("#token=")).toBe(true);
    }
  } finally {
    db.close();
  }
});

// ── Slice 3B-1R: exactly FOUR links in transient HTML + brand subject ───────

test("createRecoveryMessagePreparer: transient HTML has EXACTLY four links (no duplicate recover) and subject is Class Navi Pro Tools", async () => {
  const { createRecoveryMessagePreparer, createRecoveryOutboxPayload } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const now = 1_000_000;
    db.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run("QMP-FOUR-LINK-0001-0001", "four@example.com", now, now);
    const tokens = {};
    const tokenMap = {};
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      const { token } = generateManagementToken(db, { email: "four@example.com", licenseKey: "QMP-FOUR-LINK-0001-0001", purpose: p, now });
      tokens[p] = token;
      tokenMap[p] = token;
    }
    const payload = createRecoveryOutboxPayload({
      recipient: "four@example.com", licenseKey: "QMP-FOUR-LINK-0001-0001", tokens, secret: SECRET,
    });
    const prepare = createRecoveryMessagePreparer({ db, secret: SECRET, baseUrl: "https://manage.example.com", now: () => now + 60_000 });
    const out = await prepare({ row: { kind: "recovery", recipient_email: "four@example.com", payload_json: "{}" }, payload });
    // Subject uses the new brand, not the legacy Quick Mark Pro name.
    expect(out.subject).toContain("Class Navi Pro Tools");
    expect(out.subject).not.toContain("Quick Mark Pro");
    // Decode escaped href and count links.
    const decoded = out.html.replace(/&amp;/g, "&");
    const linkRegex = /https:\/\/[^\s"'#]+(?:#[^\s"']*)?/g;
    const links = (decoded.match(linkRegex) || []).filter((u) => u.includes("manage.example.com/manage"));
    expect(links.length).toBe(4);
    // Exactly one combined 'view license and installations' link using recover token/family.
    const viewLinks = (decoded.match(/<a [^>]*>[^<]*[Vv]iew [^<]*license[^<]*<\/a>/g) || []);
    expect(viewLinks.length).toBe(1);
    // No duplicate 'recover on this device' link.
    const recoverLinks = (decoded.match(/<a [^>]*>[^<]*[Rr]ecover on this device[^<]*<\/a>/g) || []);
    expect(recoverLinks.length).toBe(0);
    // Token/family correspondence: the four fragment tokens correspond to recover, reset_chrome, reset_edge, reset_all.
    const seenFamilies = new Set();
    for (const url of links) {
      const u = new URL(url);
      const params = new URLSearchParams(u.hash.slice(1));
      const family = params.get("family");
      const t = params.get("token");
      expect(["recover", "reset_chrome", "reset_edge", "reset_all"]).toContain(family);
      expect(t).toBe(tokenMap[family]);
      seenFamilies.add(family);
    }
    expect([...seenFamilies].sort()).toEqual(["recover", "reset_all", "reset_chrome", "reset_edge"]);
  } finally {
    db.close();
  }
});

// ── Slice 3B-1R: atomic BEGIN IMMEDIATE refresh — late failure rolls back 1-3

test("createRecoveryMessagePreparer: ATOMIC refresh — a late failure on the fourth token rolls back refreshes 1-3 (no partial refresh)", async () => {
  const { createRecoveryOutboxPayload, createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const mintAt = 1_000_000;
    const sendAt = mintAt + 30 * 60 * 1000; // past original TTL
    db.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run("QMP-ATOM-IC004-0001-0001", "atom@example.com", mintAt, mintAt);
    const tokens = {};
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      const { token } = generateManagementToken(db, { email: "atom@example.com", licenseKey: "QMP-ATOM-IC004-0001-0001", purpose: p, now: mintAt });
      tokens[p] = token;
    }
    const payload = createRecoveryOutboxPayload({
      recipient: "atom@example.com", licenseKey: "QMP-ATOM-IC004-0001-0001", tokens, secret: SECRET,
    });
    // Corrupt the FOURTH row (reset_all) by marking it USED right before
    // prepare. Its read-back inside the atomic transaction will see
    // used_at != null and the helper must fail closed; the entire transaction
    // is rolled back, so refreshes 1-3 (and any partial updates) must NOT
    // be visible.
    const resetAllHash = hashToken(tokens.reset_all);
    db.query(`UPDATE management_tokens SET used_at = ? WHERE token_hash = ?`).run(sendAt - 1000, resetAllHash);

    const prepare = createRecoveryMessagePreparer({ db, secret: SECRET, baseUrl: "https://manage.example.com", now: () => sendAt });
    let err = null;
    try {
      await prepare({ row: { kind: "recovery", recipient_email: "atom@example.com", payload_json: "{}" }, payload });
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(String(err.message)).toBe("recovery-preparation-failed");
    // Every expiry is unchanged from mint: mintAt + 20m. The atomic
    // transaction must have rolled back refreshes 1-3.
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      const r = db.query(`SELECT expires_at, used_at FROM management_tokens WHERE token_hash = ?`).get(hashToken(tokens[p]));
      expect(r.expires_at).toBe(mintAt + DEFAULT_TOKEN_TTL_MS);
    }
    // The corrupted fourth row's used_at is unchanged.
    const corrupted = db.query(`SELECT used_at FROM management_tokens WHERE token_hash = ?`).get(resetAllHash);
    expect(corrupted.used_at).toBe(sendAt - 1000);
  } finally {
    db.close();
  }
});

test("createRecoveryMessagePreparer: ATOMIC refresh — DELETE the fourth row right before prepare rolls back refreshes 1-3", async () => {
  const { createRecoveryOutboxPayload, createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const SECRET = "0123456789abcdef0123456789abcdef";
  const db = openDb(":memory:");
  try {
    const mintAt = 1_000_000;
    const sendAt = mintAt + 30 * 60 * 1000;
    db.query(`INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run("QMP-ATOM-DEL04-0001-0001", "del@example.com", mintAt, mintAt);
    const tokens = {};
    for (const p of ["recover", "reset_chrome", "reset_edge", "reset_all"]) {
      const { token } = generateManagementToken(db, { email: "del@example.com", licenseKey: "QMP-ATOM-DEL04-0001-0001", purpose: p, now: mintAt });
      tokens[p] = token;
    }
    const payload = createRecoveryOutboxPayload({
      recipient: "del@example.com", licenseKey: "QMP-ATOM-DEL04-0001-0001", tokens, secret: SECRET,
    });
    // DELETE the fourth row — the transaction's read will see no row.
    const resetAllHash = hashToken(tokens.reset_all);
    db.query(`DELETE FROM management_tokens WHERE token_hash = ?`).run(resetAllHash);

    const prepare = createRecoveryMessagePreparer({ db, secret: SECRET, baseUrl: "https://manage.example.com", now: () => sendAt });
    let err = null;
    try {
      await prepare({ row: { kind: "recovery", recipient_email: "del@example.com", payload_json: "{}" }, payload });
    } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(String(err.message)).toBe("recovery-preparation-failed");
    // Refreshes 1-3 unchanged.
    for (const p of ["recover", "reset_chrome", "reset_edge"]) {
      const r = db.query(`SELECT expires_at FROM management_tokens WHERE token_hash = ?`).get(hashToken(tokens[p]));
      expect(r.expires_at).toBe(mintAt + DEFAULT_TOKEN_TTL_MS);
    }
  } finally {
    db.close();
  }
});

test("createRecoveryMessagePreparer: BEGIN failure returns the fixed redacted preparation error", async () => {
  const { createRecoveryOutboxPayload, createRecoveryMessagePreparer } = await import("../recovery-email.js");
  const secret = "0123456789abcdef0123456789abcdef";
  const tokens = {
    recover: "r".repeat(43),
    reset_chrome: "c".repeat(43),
    reset_edge: "e".repeat(43),
    reset_all: "a".repeat(43),
  };
  const payload = createRecoveryOutboxPayload({
    recipient: "begin@example.com",
    licenseKey: "QMP-BEGI-NFAIL-0001-0001",
    tokens,
    secret,
  });
  const dbError = "SQLITE_SECRET_SENTINEL";
  const failingDb = {
    query() {
      throw new Error("query must not run when BEGIN fails");
    },
    exec(sql) {
      if (sql === "BEGIN IMMEDIATE") throw new Error(dbError);
    },
  };
  const prepare = createRecoveryMessagePreparer({
    db: failingDb,
    secret,
    baseUrl: "https://manage.example.com",
    now: () => 1_000_000,
  });

  let err = null;
  try {
    await prepare({
      row: { kind: "recovery", recipient_email: "begin@example.com" },
      payload,
    });
  } catch (caught) {
    err = caught;
  }
  expect(err).not.toBeNull();
  expect(err.message).toBe("recovery-preparation-failed");
  expect(err.message).not.toContain(dbError);
  expect(err.message).not.toContain(secret);
  for (const token of Object.values(tokens)) expect(err.message).not.toContain(token);
});
