// server/test/recovery-core.test.js — Slice 3A secure-recovery core.
//
// Verifies the recovery module in isolation: never touches db.js except via
// openDb/migrate (which is the frozen seam). Tests use a fresh in-memory DB
// per test so behavior is independent of test order. Temp on-disk DBs are
// used for the migration-shape / concurrency tests and are always removed.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import {
  ALLOWED_PURPOSES,
  DEFAULT_TOKEN_TTL_MS,
  generateManagementToken,
  hashToken,
  inspectManagementToken,
  consumeResetToken,
  sealManagementToken,
  openManagementToken,
  hashRequestSubject,
  consumeRequestLimit,
} from "../recovery.js";

beforeAll(() => {
  // Smoke: modules import cleanly + frozen exports are the documented shape.
  expect([...ALLOWED_PURPOSES].sort()).toEqual([
    "recover",
    "reset_all",
    "reset_chrome",
    "reset_edge",
  ]);
  expect(DEFAULT_TOKEN_TTL_MS).toBe(20 * 60 * 1000);
});

/* ─────────────────────────── helpers ─────────────────────────── */

/** Fresh in-memory DB per call. */
function freshDb() {
  return openDb(":memory:");
}

function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "qmp-recovery-"));
  const dbPath = join(dir, "recovery.db");
  try {
    fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedLicense(db, key, email = "user@example.com", status = "active") {
  const now = Date.now();
  db.query(
    `INSERT INTO licenses (key, email, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(key, String(email).toLowerCase(), status, now, now);
}

function seedSlot(db, licenseKey, browserFamily, instanceId) {
  const now = Date.now();
  db.query(
    `INSERT INTO browser_slots (license_key, browser_family, instance_id, activated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(licenseKey, browserFamily, instanceId, now, now);
}

function allRows(db, table) {
  return db.query(`SELECT * FROM ${table}`).all();
}

/* ─────────────────────────── Migration v6 ─────────────────────────── */

test("migration v6 secure-recovery creates exactly the frozen management_tokens and request_limits tables", () => {
  const db = freshDb();
  try {
    const rows = db
      .query(
        `SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('management_tokens','request_limits') ORDER BY name`
      )
      .all();
    const tableNames = rows.map((r) => r.name);
    expect(tableNames).toEqual(["management_tokens", "request_limits"]);
    const mgmt = rows.find((r) => r.name === "management_tokens").sql;
    expect(mgmt).toContain("token_hash TEXT PRIMARY KEY");
    expect(mgmt).toContain("email TEXT NOT NULL");
    expect(mgmt).toContain("license_key TEXT NOT NULL");
    expect(mgmt).toContain("purpose TEXT NOT NULL");
    expect(mgmt).toContain("expires_at INTEGER NOT NULL");
    expect(mgmt).toContain("used_at INTEGER");
    expect(mgmt).toContain("created_at INTEGER NOT NULL");

    const limits = rows.find((r) => r.name === "request_limits").sql;
    expect(limits).toContain("subject_key TEXT NOT NULL");
    expect(limits).toContain("action TEXT NOT NULL");
    expect(limits).toContain("window_start INTEGER NOT NULL");
    expect(limits).toContain("count INTEGER NOT NULL");
    expect(limits).toContain("PRIMARY KEY(subject_key,action,window_start)");
  } finally {
    db.close();
  }
});

test("openDb on a real pre-v6 DB (v1-v5 only) applies v6 and later migrations cleanly", () => {
  withTempDb((dbPath) => {
    // Phase 1 — open with openDb so the schema reaches the current v1-v7 state.
    const seed = openDb(dbPath);
    try {
      seedLicense(seed, "QMP-UPGR-ADEPR-0001-0001", "upgrade@example.com", "active");
      // Sanity: the freshly-opened DB has versions 1-7 recorded.
      const beforeMigs = seed
        .query(`SELECT version FROM schema_migrations ORDER BY version`)
        .all()
        .map((r) => r.version);
      expect(beforeMigs).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const sentinelRow = seed
        .query(`SELECT email FROM licenses WHERE key = ?`)
        .get("QMP-UPGR-ADEPR-0001-0001");
      expect(sentinelRow.email).toBe("upgrade@example.com");
    } finally {
      seed.close();
    }

    // Phase 2 — open the file directly with bun:sqlite and surgically
    // revert the DB to a true pre-v6 state: drop v6/v7 tables and remove
    // both later rows from schema_migrations. This is the ONLY honest way to
    // simulate "a server that started running before v6 shipped".
    const raw = new Database(dbPath);
    try {
      raw.exec(`DROP TABLE IF EXISTS management_tokens`);
      raw.exec(`DROP TABLE IF EXISTS request_limits`);
      raw.exec(`DROP TABLE IF EXISTS invite_codes`);
      raw.exec(`DROP TABLE IF EXISTS admin_audit`);
      raw.exec(`DELETE FROM schema_migrations WHERE version >= 6`);
    } finally {
      raw.close();
    }

    // Phase 3 — reopen with the production openDb and prove v6 lands
    // safely: the license sentinel survives, both v6 tables exist with
    // their exact shape, and versions 1-7 are each present exactly once.
    const reopened = openDb(dbPath);
    try {
      // License sentinel preserved end-to-end.
      const sentinelAfter = reopened
        .query(`SELECT email, status FROM licenses WHERE key = ?`)
        .get("QMP-UPGR-ADEPR-0001-0001");
      expect(sentinelAfter.email).toBe("upgrade@example.com");
      expect(sentinelAfter.status).toBe("active");

      // v6 tables exist with the documented shape.
      const v6Tables = reopened
        .query(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('management_tokens','request_limits') ORDER BY name`
        )
        .all()
        .map((r) => r.name);
      expect(v6Tables).toEqual(["management_tokens", "request_limits"]);

      // Exact schema statements for the v6 tables.
      const mgmt = reopened.query(`SELECT sql FROM sqlite_master WHERE name='management_tokens'`).get().sql;
      expect(mgmt).toContain("token_hash TEXT PRIMARY KEY");
      expect(mgmt).toContain("email TEXT NOT NULL");
      expect(mgmt).toContain("license_key TEXT NOT NULL");
      expect(mgmt).toContain("purpose TEXT NOT NULL");
      expect(mgmt).toContain("expires_at INTEGER NOT NULL");
      expect(mgmt).toContain("used_at INTEGER");
      expect(mgmt).toContain("created_at INTEGER NOT NULL");

      const limits = reopened.query(`SELECT sql FROM sqlite_master WHERE name='request_limits'`).get().sql;
      expect(limits).toContain("subject_key TEXT NOT NULL");
      expect(limits).toContain("action TEXT NOT NULL");
      expect(limits).toContain("window_start INTEGER NOT NULL");
      expect(limits).toContain("count INTEGER NOT NULL");
      expect(limits).toContain("PRIMARY KEY(subject_key,action,window_start)");

      // schema_migrations has versions 1-7 exactly once each.
      const migs = reopened
        .query(`SELECT version FROM schema_migrations ORDER BY version`)
        .all()
        .map((r) => r.version);
      expect(migs).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const dupes = reopened
        .query(`SELECT version, COUNT(*) AS n FROM schema_migrations GROUP BY version HAVING n > 1`)
        .all();
      expect(dupes.length).toBe(0);
      expect(reopened.query(`SELECT COUNT(*) AS n FROM schema_migrations`).get().n).toBe(7);

      // Re-running openDb on the now-current DB is still a no-op.
    } finally {
      reopened.close();
    }

    // Phase 4 — third reopen proves idempotency end-to-end too.
    const idempotent = openDb(dbPath);
    try {
      const versions2 = idempotent
        .query(`SELECT version FROM schema_migrations ORDER BY version`)
        .all()
        .map((r) => r.version);
      expect(versions2).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const tableCount = idempotent
        .query(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('management_tokens','request_limits')`
        )
        .get().n;
      expect(tableCount).toBe(2);
    } finally {
      idempotent.close();
    }
  });
});

test("management_tokens and request_limits store no plaintext token (full SQLite value sweep)", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-SWEE-PSWEE-P0001-0001", "sweep@example.com");
    const { token, expiresAt } = generateManagementToken(db, {
      email: "sweep@example.com",
      licenseKey: "QMP-SWEE-PSWEE-P0001-0001",
      purpose: "recover",
      now: 1_000_000,
    });
    // Sweep ALL stored values for the plaintext token (case-insensitive, base64url).
    const dump = db.query(`SELECT * FROM management_tokens`).all();
    expect(dump.length).toBe(1);
    for (const row of dump) {
      for (const v of Object.values(row)) {
        if (typeof v === "string") {
          expect(v).not.toContain(token);
          expect(v.toLowerCase()).not.toContain(token.toLowerCase());
        }
      }
    }
    // The stored hash is the SHA-256 hex of the token.
    const stored = db.query(`SELECT token_hash FROM management_tokens`).get().token_hash;
    expect(stored).toBe(hashToken(token));
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    // expiresAt returned equals what was stored.
    const row = db.query(`SELECT expires_at FROM management_tokens WHERE token_hash = ?`).get(stored);
    expect(row.expires_at).toBe(expiresAt);
  } finally {
    db.close();
  }
});

/* ─────────────────────────── Token format / purposes ─────────────────────────── */

test("token is base64url of 32 random bytes (43 chars, no '+' '/')", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-FORM-AT000-00001-0001", "fmt1@example.com");
    seedLicense(db, "QMP-FORM-AT000-00002-0002", "fmt2@example.com");
    const { token } = generateManagementToken(db, {
      email: "fmt1@example.com",
      licenseKey: "QMP-FORM-AT000-00001-0001",
      purpose: "recover",
      now: 2_000_000,
    });
    // base64url of 32 bytes is exactly 43 chars (no padding).
    expect(token.length).toBe(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toMatch(/[+/=]/);
    const other = generateManagementToken(db, {
      email: "fmt2@example.com",
      licenseKey: "QMP-FORM-AT000-00002-0002",
      purpose: "recover",
      now: 2_000_001,
    }).token;
    expect(other).not.toBe(token);
  } finally {
    db.close();
  }
});

test("email is normalized (trim + lowercase) when generating a token", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-NORM-EM000-00001-0001", "user@example.com");
    const out = generateManagementToken(db, {
      email: "  USER@Example.COM  ",
      licenseKey: "QMP-NORM-EM000-00001-0001",
      purpose: "recover",
      now: 3_000_000,
    });
    // The normalized email is only persisted to the DB; it is NOT returned
    // (sensitive field, never echoed back to the caller).
    expect(out).not.toHaveProperty("email");
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("USER@Example.COM");
    const row = db.query(`SELECT email FROM management_tokens WHERE license_key = ?`).get("QMP-NORM-EM000-00001-0001");
    expect(row.email).toBe("user@example.com");
  } finally {
    db.close();
  }
});

test("rejected purposes do not create a token row", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-NOPU-RPOSE-0001-0001", "user@example.com");
    expect(() =>
      generateManagementToken(db, {
        email: "user@example.com",
        licenseKey: "QMP-NOPU-RPOSE-0001-0001",
        purpose: "reset_unknown",
        now: 4_000_000,
      })
    ).toThrow();
    expect(allRows(db, "management_tokens").length).toBe(0);
  } finally {
    db.close();
  }
});

test("rejected when license does not exist", () => {
  const db = freshDb();
  try {
    expect(() =>
      generateManagementToken(db, {
        email: "noone@example.com",
        licenseKey: "QMP-DOES-NOTEX-IST0-0001",
        purpose: "recover",
        now: 5_000_000,
      })
    ).toThrow();
    expect(allRows(db, "management_tokens").length).toBe(0);
  } finally {
    db.close();
  }
});

test("rejected when license does not belong to the (normalized) email", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-OWNS-0WNER-0001-0001", "owner@example.com");
    expect(() =>
      generateManagementToken(db, {
        email: "someoneelse@example.com",
        licenseKey: "QMP-OWNS-0WNER-0001-0001",
        purpose: "recover",
        now: 6_000_000,
      })
    ).toThrow();
    expect(allRows(db, "management_tokens").length).toBe(0);
  } finally {
    db.close();
  }
});

test("generateManagementToken returns plaintext + safe metadata (never the stored hash)", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-META-DATA0-0001-0001", "meta@example.com");
    const out = generateManagementToken(db, {
      email: "meta@example.com",
      licenseKey: "QMP-META-DATA0-0001-0001",
      purpose: "reset_chrome",
      now: 7_000_000,
    });
    expect(out.token).toBeString();
    expect(out.expiresAt).toBe(7_000_000 + DEFAULT_TOKEN_TTL_MS);
    expect(out.usedAt).toBeNull();
    expect(out.purpose).toBe("reset_chrome");
    expect(out.licenseTail).toBe("0001");
    // EXACT key set: never returns email/licenseKey/tokenHash.
    expect(Object.keys(out).sort()).toEqual(["expiresAt", "licenseTail", "purpose", "token", "usedAt"]);
    // Never returns the hash.
    expect(out.tokenHash).toBeUndefined();
    // Never returns the email anywhere in the serialized output.
    const ser = JSON.stringify(out);
    expect(ser).not.toContain("meta@example.com");
    expect(ser).not.toContain("META-DATA");
    expect(ser).not.toContain("QMP-");
  } finally {
    db.close();
  }
});

test("generateManagementToken: rejected invalid purpose throws TypeError without echoing attacker's purpose", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-UNSA-FEPOW-0001-0001", "user@example.com");
    let caught = null;
    try {
      generateManagementToken(db, {
        email: "user@example.com",
        licenseKey: "QMP-UNSA-FEPOW-0001-0001",
        purpose: "evil<script>alert(1)</script>",
        now: 7_100_000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(TypeError);
    // The error must NOT contain the attacker-controlled purpose text.
    expect(String(caught.message)).not.toContain("evil<script>");
    expect(String(caught.message)).not.toContain("alert(1)");
    // No row was inserted.
    expect(allRows(db, "management_tokens").length).toBe(0);
  } finally {
    db.close();
  }
});

/* ─────────────────────────── inspectManagementToken ─────────────────────────── */

test("inspectManagementToken: invalid/expired/used => fixed safe invalid result; never returns email/raw key/instance/token/hash/customer/subscription", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-INSP-ECTION-0001-0001", "insp@example.com");
    const { token } = generateManagementToken(db, {
      email: "insp@example.com",
      licenseKey: "QMP-INSP-ECTION-0001-0001",
      purpose: "reset_chrome",
      now: 8_000_000,
    });

    const bad = inspectManagementToken(db, { token: "not-a-real-token", now: 8_000_000 });
    expect(bad).toEqual({
      valid: false,
      code: "invalid",
      purpose: null,
      status: null,
      licenseTail: null,
      chromeOccupied: false,
      edgeOccupied: false,
    });

    const exp = inspectManagementToken(db, {
      token,
      now: 8_000_000 + DEFAULT_TOKEN_TTL_MS + 1,
    });
    expect(exp).toEqual({
      valid: false,
      code: "expired",
      purpose: null,
      status: null,
      licenseTail: null,
      chromeOccupied: false,
      edgeOccupied: false,
    });

    // Re-mint a token to test "used" without relying on order.
    seedLicense(db, "QMP-USED-TTOKE-0001-0001", "used@example.com");
    const { token: usedTok } = generateManagementToken(db, {
      email: "used@example.com",
      licenseKey: "QMP-USED-TTOKE-0001-0001",
      purpose: "reset_chrome",
      now: 8_100_000,
    });
    seedSlot(db, "QMP-USED-TTOKE-0001-0001", "chrome", "inst-c-1");
    consumeResetToken(db, { token: usedTok, browserFamily: "chrome", now: 8_100_001 });
    const used = inspectManagementToken(db, { token: usedTok, now: 8_100_002 });
    expect(used).toEqual({
      valid: false,
      code: "used",
      purpose: null,
      status: null,
      licenseTail: null,
      chromeOccupied: false,
      edgeOccupied: false,
    });

    // Never includes email, raw key, instance id, token/hash, customer/subscription IDs.
    for (const r of [bad, exp, used]) {
      expect(r).not.toHaveProperty("email");
      expect(r).not.toHaveProperty("licenseKey");
      expect(r).not.toHaveProperty("instance_id");
      expect(r).not.toHaveProperty("instanceId");
      expect(r).not.toHaveProperty("token");
      expect(r).not.toHaveProperty("tokenHash");
      expect(r).not.toHaveProperty("customer_id");
      expect(r).not.toHaveProperty("customerId");
      expect(r).not.toHaveProperty("subscription_id");
      expect(r).not.toHaveProperty("subscriptionId");
    }
  } finally {
    db.close();
  }
});

test("inspectManagementToken: valid returns masked license tail + chrome/edge occupied booleans", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-MASK-ED0UT-0001-0001", "mask@example.com");
    seedSlot(db, "QMP-MASK-ED0UT-0001-0001", "chrome", "inst-mask-c");
    const { token } = generateManagementToken(db, {
      email: "mask@example.com",
      licenseKey: "QMP-MASK-ED0UT-0001-0001",
      purpose: "reset_chrome",
      now: 9_000_000,
    });
    const r = inspectManagementToken(db, { token, now: 9_000_000 });
    expect(r.valid).toBe(true);
    expect(r.code).toBe("ok");
    expect(r.purpose).toBe("reset_chrome");
    expect(r.status).toBe("active");
    expect(r.licenseTail).toBe("0001");
    // NEVER returns the full key or email or hash anywhere in the JSON.
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain("QMP-MASK-ED0UT-0001-0001");
    expect(serialized).not.toContain("mask@example.com");
    expect(serialized).not.toContain(r.licenseTail === "0001" ? "QMP" : ""); // sanity
    expect(r.chromeOccupied).toBe(true);
    expect(r.edgeOccupied).toBe(false);
  } finally {
    db.close();
  }
});

/* ─────────────────────────── consumeResetToken ─────────────────────────── */

test("consumeResetToken: scope mismatch is rejected without mutation", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-SCOP-EMISM-0001-0001", "scope@example.com");
    seedSlot(db, "QMP-SCOP-EMISM-0001-0001", "chrome", "inst-scope-c");
    const { token } = generateManagementToken(db, {
      email: "scope@example.com",
      licenseKey: "QMP-SCOP-EMISM-0001-0001",
      purpose: "reset_chrome",
      now: 10_000_000,
    });
    const before = allRows(db, "browser_slots");
    const r = consumeResetToken(db, { token, browserFamily: "edge", now: 10_000_000 + 1 });
    expect(r).toEqual({ ok: false, code: "scope-mismatch", removed: 0 });
    expect(allRows(db, "browser_slots")).toEqual(before);
    // Token is still unused.
    expect(inspectManagementToken(db, { token, now: 10_000_000 + 1 }).code).toBe("ok");
  } finally {
    db.close();
  }
});

test("consumeResetToken: a recover token cannot reset (no mutation, no consumption)", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-RECV-ERTOK-0001-0001", "rec@example.com");
    seedSlot(db, "QMP-RECV-ERTOK-0001-0001", "chrome", "inst-rec-c");
    const { token } = generateManagementToken(db, {
      email: "rec@example.com",
      licenseKey: "QMP-RECV-ERTOK-0001-0001",
      purpose: "recover",
      now: 11_000_000,
    });
    const before = allRows(db, "browser_slots");
    const r = consumeResetToken(db, { token, browserFamily: "chrome", now: 11_000_000 + 1 });
    expect(r).toEqual({ ok: false, code: "scope-mismatch", removed: 0 });
    expect(allRows(db, "browser_slots")).toEqual(before);
    expect(inspectManagementToken(db, { token, now: 11_000_000 + 1 }).code).toBe("ok");
  } finally {
    db.close();
  }
});

test("consumeResetToken: Chrome reset leaves Edge intact for the same license", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-CRON-LR000-0001-0001", "cr@example.com");
    seedSlot(db, "QMP-CRON-LR000-0001-0001", "chrome", "inst-cr-c");
    seedSlot(db, "QMP-CRON-LR000-0001-0001", "edge", "inst-cr-e");
    const { token } = generateManagementToken(db, {
      email: "cr@example.com",
      licenseKey: "QMP-CRON-LR000-0001-0001",
      purpose: "reset_chrome",
      now: 12_000_000,
    });
    const r = consumeResetToken(db, { token, browserFamily: "chrome", now: 12_000_000 + 1 });
    expect(r).toEqual({ ok: true, code: "ok", removed: 1 });
    const slots = allRows(db, "browser_slots");
    expect(slots.length).toBe(1);
    expect(slots[0].browser_family).toBe("edge");
    expect(inspectManagementToken(db, { token, now: 12_000_000 + 2 }).code).toBe("used");
  } finally {
    db.close();
  }
});

test("consumeResetToken: reset_all affects only the selected license", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-ALL0-KE000-0001-0001", "a0@example.com");
    seedLicense(db, "QMP-ALL0-OTHE-0001-0001", "a1@example.com");
    seedSlot(db, "QMP-ALL0-KE000-0001-0001", "chrome", "inst-a0-c");
    seedSlot(db, "QMP-ALL0-KE000-0001-0001", "edge", "inst-a0-e");
    seedSlot(db, "QMP-ALL0-OTHE-0001-0001", "chrome", "inst-a1-c");
    seedSlot(db, "QMP-ALL0-OTHE-0001-0001", "edge", "inst-a1-e");
    const { token } = generateManagementToken(db, {
      email: "a0@example.com",
      licenseKey: "QMP-ALL0-KE000-0001-0001",
      purpose: "reset_all",
      now: 13_000_000,
    });
    const r = consumeResetToken(db, { token, browserFamily: "all", now: 13_000_000 + 1 });
    expect(r).toEqual({ ok: true, code: "ok", removed: 2 });
    const slots = allRows(db, "browser_slots");
    expect(slots.length).toBe(2);
    for (const s of slots) expect(s.license_key).toBe("QMP-ALL0-OTHE-0001-0001");
  } finally {
    db.close();
  }
});

test("consumeResetToken: expired token does not mutate state", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-EXPI-RED0K-0001-0001", "ex@example.com");
    seedSlot(db, "QMP-EXPI-RED0K-0001-0001", "chrome", "inst-ex-c");
    const { token } = generateManagementToken(db, {
      email: "ex@example.com",
      licenseKey: "QMP-EXPI-RED0K-0001-0001",
      purpose: "reset_chrome",
      now: 14_000_000,
    });
    const before = allRows(db, "browser_slots");
    const r = consumeResetToken(db, {
      token,
      browserFamily: "chrome",
      now: 14_000_000 + DEFAULT_TOKEN_TTL_MS + 1,
    });
    expect(r).toEqual({ ok: false, code: "expired", removed: 0 });
    expect(allRows(db, "browser_slots")).toEqual(before);
  } finally {
    db.close();
  }
});

test("consumeResetToken: reuse is rejected; first call wins", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-REUS-ETOKE-0001-0001", "re@example.com");
    seedSlot(db, "QMP-REUS-ETOKE-0001-0001", "chrome", "inst-reu-c");
    const { token } = generateManagementToken(db, {
      email: "re@example.com",
      licenseKey: "QMP-REUS-ETOKE-0001-0001",
      purpose: "reset_chrome",
      now: 15_000_000,
    });
    const r1 = consumeResetToken(db, { token, browserFamily: "chrome", now: 15_000_000 + 1 });
    expect(r1).toEqual({ ok: true, code: "ok", removed: 1 });
    const r2 = consumeResetToken(db, { token, browserFamily: "chrome", now: 15_000_000 + 2 });
    expect(r2).toEqual({ ok: false, code: "used", removed: 0 });
  } finally {
    db.close();
  }
});

test("consumeResetToken: invalid input is rejected without mutation", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-INVA-LID0K-0001-0001", "in@example.com");
    seedSlot(db, "QMP-INVA-LID0K-0001-0001", "chrome", "inst-inv-c");
    const before = allRows(db, "browser_slots");
    const r = consumeResetToken(db, { token: "nope", browserFamily: "chrome", now: 16_000_000 });
    expect(r).toEqual({ ok: false, code: "invalid", removed: 0 });
    expect(allRows(db, "browser_slots")).toEqual(before);
  } finally {
    db.close();
  }
});

test("consumeResetToken: bad browserFamily is rejected without mutation", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-FAMI-LYUND-0001-0001", "fa@example.com");
    seedSlot(db, "QMP-FAMI-LYUND-0001-0001", "chrome", "inst-fa-c");
    const { token } = generateManagementToken(db, {
      email: "fa@example.com",
      licenseKey: "QMP-FAMI-LYUND-0001-0001",
      purpose: "reset_chrome",
      now: 17_000_000,
    });
    const before = allRows(db, "browser_slots");
    const r = consumeResetToken(db, { token, browserFamily: "safari", now: 17_000_000 + 1 });
    expect(r).toEqual({ ok: false, code: "family-undetermined", removed: 0 });
    expect(allRows(db, "browser_slots")).toEqual(before);
  } finally {
    db.close();
  }
});

test("consumeResetToken: concurrent callers — each token consumed exactly once", () => {
  withTempDb((dbPath) => {
    const seed = openDb(dbPath);
    seedLicense(seed, "QMP-CONC-URENT-0001-0001", "c@example.com");
    seedSlot(seed, "QMP-CONC-URENT-0001-0001", "chrome", "inst-con-c");
    seed.close();

    const total = 6;
    const tokens = [];
    for (let i = 0; i < total; i++) {
      const worker = openDb(dbPath);
      const { token } = generateManagementToken(worker, {
        email: "c@example.com",
        licenseKey: "QMP-CONC-URENT-0001-0001",
        purpose: "reset_chrome",
        now: 18_000_000 + i,
      });
      tokens.push(token);
      worker.close();
    }
    // Re-open on the same file for the consume phase.
    const db = openDb(dbPath);
    try {
      let winners = 0;
      for (const t of tokens) {
        const r = consumeResetToken(db, { token: t, browserFamily: "chrome", now: 19_000_000 });
        if (r.ok) winners++;
      }
      // The first call removes the slot; subsequent calls find no slot and
      // return ok:false code:not-found removed:0. Exactly one token is the
      // "winner" that actually removed a row.
      expect(winners).toBe(1);
      const winnerTokens = db.query(`SELECT COUNT(*) AS n FROM management_tokens WHERE used_at IS NOT NULL`).get().n;
      expect(winnerTokens).toBe(total);
      const slots = db.query(`SELECT * FROM browser_slots WHERE license_key = ?`).all("QMP-CONC-URENT-0001-0001");
      expect(slots.length).toBe(0);
    } finally {
      db.close();
    }
  });
});

test("consumeResetToken: a license WITHOUT a target slot returns ok:false code:not-found; token is consumed (no replay)", () => {
  const db = freshDb();
  try {
    seedLicense(db, "QMP-NOSL-OT000-0001-0001", "ns@example.com");
    const { token } = generateManagementToken(db, {
      email: "ns@example.com",
      licenseKey: "QMP-NOSL-OT000-0001-0001",
      purpose: "reset_chrome",
      now: 20_000_000,
    });
    const r = consumeResetToken(db, { token, browserFamily: "chrome", now: 20_000_000 + 1 });
    expect(r).toEqual({ ok: false, code: "not-found", removed: 0 });
    // The token is consumed (used_at set) so the caller cannot replay it.
    expect(inspectManagementToken(db, { token, now: 20_000_000 + 2 }).code).toBe("used");
  } finally {
    db.close();
  }
});

/* ─────────────────────────── seal/openManagementToken ─────────────────────────── */

test("sealManagementToken / openManagementToken round-trip", () => {
  const token = "round-trip-token-XYZ12345";
  const sealed = sealManagementToken(token, "0123456789abcdef0123456789abcdef");
  expect(typeof sealed).toBe("string");
  const parsed = JSON.parse(sealed);
  expect(parsed).toHaveProperty("ciphertext");
  expect(parsed).toHaveProperty("nonce");
  expect(parsed).toHaveProperty("tag");
  expect(sealed).not.toContain(token);
  const opened = openManagementToken(sealed, "0123456789abcdef0123456789abcdef");
  expect(opened).toBe(token);
});

test("seal rejects blank/missing secret; open rejects wrong secret/tampered ciphertext", () => {
  const token = "tkn-1";
  const secret = "0123456789abcdef0123456789abcdef";
  const sealed = sealManagementToken(token, secret);

  expect(() => sealManagementToken(token, "")).toThrow();
  expect(() => sealManagementToken(token, "  ")).toThrow();
  expect(() => sealManagementToken(token, null)).toThrow();

  // Wrong secret fails closed.
  expect(() => openManagementToken(sealed, "different-secret-with-enough-length")).toThrow();
  // Tampered ciphertext fails closed.
  const obj = JSON.parse(sealed);
  const tampered = JSON.stringify({ ...obj, ciphertext: "AAAA" + obj.ciphertext.slice(4) });
  expect(() => openManagementToken(tampered, secret)).toThrow();
  // Wrong tag fails closed.
  const badTag = JSON.stringify({ ...obj, tag: "AAAAAAAAAAAAAAAAAAAAAA==" });
  expect(() => openManagementToken(badTag, secret)).toThrow();
  // Errors must not contain the secret nor the token.
  try {
    openManagementToken(tampered, secret);
    throw new Error("expected throw");
  } catch (err) {
    expect(String(err.message)).not.toContain(token);
    expect(String(err.message)).not.toContain(secret);
  }
});

test("seal/open reject obviously malformed sealed blobs", () => {
  expect(() => openManagementToken("not-json", "0123456789abcdef0123456789abcdef")).toThrow();
  expect(() => openManagementToken("{}", "0123456789abcdef0123456789abcdef")).toThrow();
  expect(() => openManagementToken(null, "0123456789abcdef0123456789abcdef")).toThrow();
});

/* ─────────────────────────── hashRequestSubject ─────────────────────────── */

test("hashRequestSubject returns HMAC-SHA256 hex (64 hex chars), deterministic, secret-sensitive", () => {
  const a = hashRequestSubject("user@example.com", "secret-1");
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  const b = hashRequestSubject("user@example.com", "secret-1");
  expect(b).toBe(a);
  const c = hashRequestSubject("user@example.com", "secret-2");
  expect(c).not.toBe(a);
  // Different subjects under the same secret produce different hashes.
  const other = hashRequestSubject("someone@example.com", "secret-1");
  expect(other).toMatch(/^[0-9a-f]{64}$/);
  expect(other).not.toBe(a);
  // The empty-secret case is the strict contract: a missing/blank secret is
  // rejected (never used to sign anything) so every caller is forced to
  // supply a real secret. This prevents a global keyless collision attack.
  expect(() => hashRequestSubject("user@example.com", "")).toThrow();
});

test("hashRequestSubject rejects non-string / blank-whitespace value and secret; trims value; never leaks input or secret", () => {
  const ok = "user@example.com";
  const secret = "shared-secret-with-enough-length";
  const expected = hashRequestSubject(ok, secret);

  // Value validation: blank, whitespace, non-string.
  const badValues = ["", "   ", "\t\n", null, undefined, 123, {}, []];
  for (const v of badValues) {
    let msg = "";
    try { hashRequestSubject(v, secret); } catch (err) { msg = String(err.message); }
    expect(msg.length).toBeGreaterThan(0);
    // Error must never echo the raw value or the secret.
    expect(msg).not.toContain(ok);
    expect(msg).not.toContain(secret);
  }

  // Secret validation: blank, whitespace, non-string.
  const badSecrets = ["", "   ", "\t", null, undefined, 42, {}, []];
  for (const s of badSecrets) {
    let msg = "";
    try { hashRequestSubject(ok, s); } catch (err) { msg = String(err.message); }
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain(ok);
    expect(msg).not.toContain(secret);
  }

  // Whitespace around the value is trimmed before hashing: canonical form wins.
  expect(hashRequestSubject("  user@example.com  ", secret)).toBe(expected);
  expect(hashRequestSubject("\tuser@example.com\n", secret)).toBe(expected);
  expect(hashRequestSubject("user@example.com", secret)).toBe(expected);
});

/* ─────────────────────────── consumeRequestLimit ─────────────────────────── */

test("consumeRequestLimit: invalid inputs throw before any mutation", () => {
  const db = freshDb();
  try {
    for (const args of [
      { subjectKey: "", action: "x", now: 1, windowMs: 1000, limit: 1 },
      { subjectKey: "  ", action: "x", now: 1, windowMs: 1000, limit: 1 },
      { subjectKey: "x", action: "", now: 1, windowMs: 1000, limit: 1 },
      { subjectKey: "x", action: "x", now: NaN, windowMs: 1000, limit: 1 },
      { subjectKey: "x", action: "x", now: 1, windowMs: 0, limit: 1 },
      { subjectKey: "x", action: "x", now: 1, windowMs: -1, limit: 1 },
      { subjectKey: "x", action: "x", now: 1, windowMs: 1000, limit: 0 },
      { subjectKey: "x", action: "x", now: 1, windowMs: 1000, limit: -1 },
      { subjectKey: "x", action: "x", now: 1, windowMs: 1000, limit: 1.5 },
      { subjectKey: "x", action: "x", now: 1, windowMs: 1000.5, limit: 1 },
    ]) {
      expect(() => consumeRequestLimit(db, args)).toThrow();
    }
    expect(allRows(db, "request_limits").length).toBe(0);
  } finally {
    db.close();
  }
});

test("consumeRequestLimit: subjectKey must be exactly 64 lowercase hex chars (already hashed); rejects raw subjects before any mutation", () => {
  const db = freshDb();
  try {
    const action = "buy";
    const hash = hashRequestSubject("user@example.com", "route-secret");
    // Happy path: hashed, 64-char lowercase hex is accepted verbatim.
    const r = consumeRequestLimit(db, { subjectKey: hash, action, now: 1_000, windowMs: 60_000, limit: 5 });
    expect(r.allowed).toBe(true);
    // The stored subject_key equals the hash EXACTLY (no internal rehash).
    const rows = allRows(db, "request_limits");
    expect(rows.length).toBe(1);
    expect(rows[0].subject_key).toBe(hash);
    expect(rows[0].subject_key).toMatch(/^[0-9a-f]{64}$/);

    // Reject anything that is not already-hashed shape (raw subject, upper
    // hex, truncated, padded-with-whitespace, wrong length, non-string,
    // with garbage). All must throw BEFORE any mutation.
    const malformed = [
      "user@example.com",                // raw subject
      "USER@EXAMPLE.COM",                // raw subject uppercase
      hash.toUpperCase(),                // uppercase hex
      hash.slice(0, 60),                 // too short
      hash + "ff",                       // 66 chars
      ` ${hash} `,                       // padded whitespace
      `\n${hash}\t`,                     // surrounding whitespace
      hash.slice(0, -1) + "g",           // non-hex char
      null, undefined, 123, {}, [],
    ];
    const baseline = allRows(db, "request_limits").length;
    for (const bad of malformed) {
      let msg = "";
      let threw = false;
      try {
        consumeRequestLimit(db, { subjectKey: bad, action, now: 2_000, windowMs: 60_000, limit: 5 });
      } catch (err) {
        threw = true;
        msg = String(err.message);
      }
      expect(threw).toBe(true);
      // Error messages must not leak the raw hash back to attackers.
      if (typeof bad === "string") {
        expect(msg).not.toContain(bad);
      }
    }
    expect(allRows(db, "request_limits").length).toBe(baseline);
  } finally {
    db.close();
  }
});

test("consumeRequestLimit: route-style usage — hashRequestSubject(raw, secret) then consume stores the hash; raw subject is never persisted", () => {
  const db = freshDb();
  try {
    const raw = "alice@example.com";
    const secret = "route-secret-shared-by-the-edge";
    const hash = hashRequestSubject(raw, secret);

    consumeRequestLimit(db, { subjectKey: hash, action: "recover", now: 1_000_000, windowMs: 60_000, limit: 3 });
    consumeRequestLimit(db, { subjectKey: hash, action: "recover", now: 1_000_100, windowMs: 60_000, limit: 3 });

    const rows = allRows(db, "request_limits");
    expect(rows.length).toBe(1);
    expect(rows[0].subject_key).toBe(hash);

    // Dump the raw row to a string and confirm no trace of the raw subject
    // or the secret anywhere on disk.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(raw);
    expect(dump).not.toContain("alice@");
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain("alice");
  } finally {
    db.close();
  }
});

test("consumeRequestLimit: window counting, boundary, retryAfterMs", () => {
  const db = freshDb();
  try {
    const window = 10_000;
    const limit = 3;
    const sk = hashRequestSubject("sk@1", "route-secret");
    expect(consumeRequestLimit(db, { subjectKey: sk, action: "recover", now: 100_000, windowMs: window, limit }).allowed).toBe(true);
    expect(consumeRequestLimit(db, { subjectKey: sk, action: "recover", now: 100_500, windowMs: window, limit }).allowed).toBe(true);
    const r3 = consumeRequestLimit(db, { subjectKey: sk, action: "recover", now: 105_000, windowMs: window, limit });
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
    const r4 = consumeRequestLimit(db, { subjectKey: sk, action: "recover", now: 105_500, windowMs: window, limit });
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfterMs).toBeGreaterThan(0);
    expect(r4.retryAfterMs).toBeLessThanOrEqual(window);
    // Next window starts at 110_000.
    const r5 = consumeRequestLimit(db, { subjectKey: sk, action: "recover", now: 110_000, windowMs: window, limit });
    expect(r5.allowed).toBe(true);
    expect(r5.remaining).toBe(2);
  } finally {
    db.close();
  }
});

test("consumeRequestLimit: stores only the hashed subject_key (no raw value)", () => {
  const db = freshDb();
  try {
    const raw = "user@example.com";
    const secret = "secret-1";
    const h1 = hashRequestSubject(raw, secret);
    const h2 = hashRequestSubject(raw, "secret-2");
    consumeRequestLimit(db, { subjectKey: h1, action: "buy", now: 200_000, windowMs: 60_000, limit: 5 });
    const rows = allRows(db, "request_limits");
    for (const row of rows) {
      expect(row.subject_key).not.toBe(raw);
      expect(row.subject_key).not.toContain(raw);
      expect(row.subject_key).not.toContain("@");
      expect(row.subject_key).toMatch(/^[0-9a-f]{64}$/);
      expect(row.subject_key).toBe(h1);
    }
    // Different secret signs differently -> distinct key.
    consumeRequestLimit(db, { subjectKey: h2, action: "buy", now: 200_000, windowMs: 60_000, limit: 5 });
    const all = allRows(db, "request_limits");
    const distinct = new Set(all.map((r) => r.subject_key));
    expect(distinct.size).toBe(2);
    expect(distinct.has(h1)).toBe(true);
    expect(distinct.has(h2)).toBe(true);
  } finally {
    db.close();
  }
});

test("consumeRequestLimit: concurrent calls keep count bounded at limit", () => {
  withTempDb((dbPath) => {
    const race = openDb(dbPath);
    try {
      const limit = 5;
      const wins = 20;
      const base = 300_000;
      const sk = hashRequestSubject("h-1", "race-secret");
      let allowed = 0;
      for (let i = 0; i < wins; i++) {
        const r = consumeRequestLimit(race, {
          subjectKey: sk,
          action: "race",
          now: base + i,
          windowMs: 60_000,
          limit,
        });
        if (r.allowed) allowed++;
      }
      expect(allowed).toBe(limit);
      const row = race.query(`SELECT count FROM request_limits WHERE subject_key = ? AND action = ? AND window_start = ?`).get(
        sk,
        "race",
        Math.floor(base / 60_000) * 60_000
      );
      expect(row.count).toBe(limit);
    } finally {
      race.close();
    }
  });
});

test("consumeRequestLimit: a different action is independent", () => {
  const db = freshDb();
  try {
    const limit = 1;
    const sk = hashRequestSubject("sk@2", "route-secret");
    expect(consumeRequestLimit(db, { subjectKey: sk, action: "a", now: 400_000, windowMs: 1000, limit }).allowed).toBe(true);
    expect(consumeRequestLimit(db, { subjectKey: sk, action: "b", now: 400_000, windowMs: 1000, limit }).allowed).toBe(true);
    expect(consumeRequestLimit(db, { subjectKey: sk, action: "a", now: 400_000, windowMs: 1000, limit }).allowed).toBe(false);
  } finally {
    db.close();
  }
});
