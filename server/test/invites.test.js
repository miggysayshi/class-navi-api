// server/test/invites.test.js — Slice 5A FAMILY INVITE CORE.
//
// Scope: hash-only invite codes (migration v7 `family-invite-codes`), atomic
// free-forever redemption that mints exactly one `source=family_free` license
// + one `family_welcome` outbox row + one audit entry in a single transaction,
// and individually revocable family licenses isolated from Stripe.
//
// Uses ONLY :memory:/temp on-disk DBs and a temp child process — never
// server/license.db, never production, no network, no commit.
//
// The invites.js module is imported LAZILY per test so the suite loads (RED)
// before the module exists and grows in lockstep with it.
import { test, expect } from "bun:test";
import {
  openDb,
  upsertLicense,
  generateKey,
  recordStripeSubscriptionState,
} from "../db.js";
import { buildWelcomeMessage } from "../email.js";
import { applyVerifiedStripeEvent } from "../stripe-webhook.js";
import { activateBrowserSlot, validateBrowserSlot } from "../browser-slots.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Code shape fixture for the frozen format. */
const SHAPE_RE = /^FAM-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

/** Full SQLite sweep of every row in the two v7 tables, as one JSON string. */
function v7Dump(db) {
  return JSON.stringify({
    codes: db.query(`SELECT * FROM invite_codes`).all(),
    audit: db.query(`SELECT * FROM admin_audit`).all(),
  });
}

// ── Behavior 0: migration v7 ─────────────────────────────────────────────────
test("migration v7 family-invite-codes creates the exact frozen invite_codes + admin_audit tables, idempotent across reopen, from v1-v6", () => {
  const dir = mkdtempSync(join(tmpdir(), "qmp-invites-mig-"));
  const dbPath = join(dir, "test.db");
  try {
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
    expect(applied[5].version).toBe(6);
    expect(applied[5].name).toBe("secure-recovery");
    expect(applied[6].version).toBe(7);
    expect(applied[6].name).toBe("family-invite-codes");

    // invite_codes exact frozen column/type/notnull/PK shape, in order.
    const inv = reopened.query(`PRAGMA table_info(invite_codes)`).all();
    expect(inv.map((c) => c.name)).toEqual([
      "code_hash",
      "label",
      "created_at",
      "expires_at",
      "redeemed_at",
      "redeemed_email",
      "license_key",
      "revoked_at",
    ]);
    expect(inv.map((c) => c.type)).toEqual([
      "TEXT",
      "TEXT",
      "INTEGER",
      "INTEGER",
      "INTEGER",
      "TEXT",
      "TEXT",
      "INTEGER",
    ]);
    expect(inv.filter((c) => c.pk === 1).map((c) => c.name)).toEqual(["code_hash"]);
    expect(inv.find((c) => c.name === "label").notnull).toBe(1);
    expect(inv.find((c) => c.name === "created_at").notnull).toBe(1);
    expect(inv.find((c) => c.name === "expires_at").notnull).toBe(1);
    expect(inv.find((c) => c.name === "redeemed_at").notnull).toBe(0);
    expect(inv.find((c) => c.name === "redeemed_email").notnull).toBe(0);
    expect(inv.find((c) => c.name === "license_key").notnull).toBe(0);
    expect(inv.find((c) => c.name === "revoked_at").notnull).toBe(0);

    // admin_audit exact frozen shape: AUTOINCREMENT id + masked subject + no-secrets detail.
    const aud = reopened.query(`PRAGMA table_info(admin_audit)`).all();
    expect(aud.map((c) => c.name)).toEqual([
      "id",
      "action",
      "subject_masked",
      "detail_json",
      "created_at",
    ]);
    expect(aud.filter((c) => c.pk === 1).map((c) => c.name)).toEqual(["id"]);
    expect(aud.find((c) => c.name === "action").notnull).toBe(1);
    expect(aud.find((c) => c.name === "subject_masked").notnull).toBe(0);
    expect(aud.find((c) => c.name === "detail_json").notnull).toBe(1);
    expect(aud.find((c) => c.name === "created_at").notnull).toBe(1);
    expect(aud.find((c) => c.name === "id").type).toBe("INTEGER");
    const [tbl] = reopened
      .query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='admin_audit'`)
      .all();
    expect(tbl.sql).toContain("AUTOINCREMENT");

    // Prior migrations' tables all still present (additive from v1-v6).
    const tables = reopened
      .query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((t) => t.name);
    for (const t of [
      "licenses",
      "instances",
      "processed_stripe_events",
      "stripe_subscription_states",
      "email_outbox",
      "browser_slots",
      "management_tokens",
      "invite_codes",
      "admin_audit",
    ]) {
      expect(tables).toContain(t);
    }

    // Reopen again: still exactly 7, no re-run (idempotent).
    reopened.close();
    const third = openDb(dbPath);
    expect(third.query(`SELECT COUNT(*) AS n FROM schema_migrations`).get().n).toBe(7);
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Behavior 1: format + hash helpers ────────────────────────────────────────
test("invite code format helpers: FAM-XXXX-XXXX-XXXX-XXXX, alphabet excludes 0/O/1/I/L", async () => {
  const inv = await import("../invites.js");
  expect(typeof inv.generateInviteCode).toBe("function");
  expect(typeof inv.canonicalizeInviteCode).toBe("function");
  expect(typeof inv.hashInviteCode).toBe("function");

  for (let i = 0; i < 50; i++) {
    const c = inv.generateInviteCode();
    expect(c).toMatch(SHAPE_RE);
    // Excluded characters never appear.
    expect(c).not.toMatch(/[0O1IL]/);
    // Every segment char is from the allowed alphabet.
    const body = c.slice(4).replaceAll("-", "");
    expect([...body].every((ch) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789".includes(ch))).toBe(true);
  }
  // distinct over a modest batch
  const set = new Set(Array.from({ length: 200 }, () => inv.generateInviteCode()));
  expect(set.size).toBe(200);

  // canonicalize trims + uppercases
  expect(inv.canonicalizeInviteCode("  fam-abcd-efgh-jkmn-pqrs  ")).toBe(
    "FAM-ABCD-EFGH-JKMN-PQRS"
  );
  expect(inv.canonicalizeInviteCode(inv.generateInviteCode())).toMatch(SHAPE_RE);

  // hash is SHA-256 hex (64 lowercase hex chars) and stable for the canonical form
  const h1 = inv.hashInviteCode("  FAM-abcd-EFGH-jkmn-pqrs  ");
  const h2 = inv.hashInviteCode("FAM-ABCD-EFGH-JKMN-PQRS");
  expect(h1).toBe(h2);
  expect(h1).toMatch(/^[0-9a-f]{64}$/);
  expect(h1).not.toContain("ABCD"); // hashed — no plaintext
});

// ── Behavior 2: mintInviteCodes ──────────────────────────────────────────────
test("mintInviteCodes returns unique plaintext codes once; DB stores ONLY hashes; one invite_minted audit with masked label + safe detail", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    const expiresAt = 1_800_000_000_000;
    const out = inv.mintInviteCodes(db, { label: "Cousin Jenna", count: 3, expiresAt });
    expect(out.count).toBe(3);
    expect(out.expiresAt).toBe(expiresAt);
    expect(out.codes.length).toBe(3);
    expect(new Set(out.codes).size).toBe(3);
    for (const c of out.codes) expect(c).toMatch(SHAPE_RE);

    // Exactly 3 invite rows, all hashes.
    const rows = db.query(`SELECT * FROM invite_codes ORDER BY created_at, rowid`).all();
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(out.codes).not.toContain(r.code_hash); // never a stored plaintext
      expect(r.label).toBe("Cousin Jenna");
      expect(r.created_at).toBeGreaterThan(0);
      expect(r.expires_at).toBe(expiresAt);
      expect(r.redeemed_at).toBeNull();
      expect(r.redeemed_email).toBeNull();
      expect(r.license_key).toBeNull();
      expect(r.revoked_at).toBeNull();
      // stored hash == sha256 of the corresponding returned code (canonical)
      expect(r.code_hash).toBe(inv.hashInviteCode(out.codes[rows.indexOf(r)]));
    }

    // Full SQLite sweep: invite plaintext appears nowhere on disk.
    const dump = v7Dump(db);
    for (const c of out.codes) expect(dump).not.toContain(c);

    // One audit row, invite_minted, masked label subject, {count, expiresAt} only.
    const audits = db.query(`SELECT * FROM admin_audit ORDER BY id`).all();
    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe("invite_minted");
    expect(audits[0].subject_masked).not.toBe("Cousin Jenna");
    expect(audits[0].subject_masked).not.toContain("Cousin Jenna");
    expect(audits[0].subject_masked.length).toBeGreaterThan(0);
    expect(JSON.parse(audits[0].detail_json)).toEqual({ count: 3, expiresAt });
    const detail = JSON.stringify(audits[0]);
    for (const c of out.codes) expect(detail).not.toContain(c);
  } finally {
    db.close();
  }
});

test("mintInviteCodes validates label (nonblank, <=100), count (integer 1..50), expiresAt (finite integer > now) — no writes on failure", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  const valid = { label: "Uncle", count: 2, expiresAt: 1_800_000_000_000 };
  const bads = [
    { ...valid, label: "" },
    { ...valid, label: "   " },
    { ...valid, label: "x".repeat(101) },
    { ...valid, count: 0 },
    { ...valid, count: 51 },
    { ...valid, count: -1 },
    { ...valid, count: 1.5 },
    { ...valid, count: NaN },
    { ...valid, expiresAt: Date.now() }, // expiresAt must be > now
    { ...valid, expiresAt: 123 },
  ];
  try {
    let threw = 0;
    for (const b of bads) {
      try {
        inv.mintInviteCodes(db, b);
      } catch (e) {
        threw++;
        expect(e instanceof TypeError).toBe(true);
      }
    }
    expect(threw).toBe(bads.length);
    expect(db.query(`SELECT COUNT(*) AS n FROM invite_codes`).get().n).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n).toBe(0);
  } finally {
    db.close();
  }
});

test("mintInviteCodes retries bounded collisions (existing hash) and unique-ifies intra-batch duplicates; a stuck codeFn fails and rolls back everything", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    // Pre-seed one code whose hash already exists.
    const taken = "FAM-TAKN-TAKN-TAKN-TAKN";
    const takenCodeHash = inv.hashInviteCode(taken);
    db.query(
      `INSERT INTO invite_codes (code_hash, label, created_at, expires_at) VALUES (?, 'taken', ?, ?)`
    ).run(takenCodeHash, 1000, 2_000_000_000_000);

    // codeFn: returns the colliding code first, then two distinct fresh codes.
    const seeds = [taken, "FAM-AAAA-AAAA-AAAA-AAAA", "FAM-BBBB-BBBB-BBBB-BBBB"];
    let i = 0;
    const out = inv.mintInviteCodes(db, {
      label: "Retry",
      count: 2,
      expiresAt: 2_000_000_000_000,
      codeFn: () => seeds[i++ % seeds.length],
    });
    expect(out.codes).toEqual(["FAM-AAAA-AAAA-AAAA-AAAA", "FAM-BBBB-BBBB-BBBB-BBBB"]);
    const rows = db.query(`SELECT code_hash FROM invite_codes`).all();
    expect(rows.length).toBe(3); // 1 pre-seeded + 2 minted
    expect(new Set(rows.map((r) => r.code_hash)).size).toBe(3);

    // Stuck codeFn (always the same code) exhausts the retry bound -> rollback.
    const db2 = openDb(":memory:");
    try {
      let err = null;
      try {
        inv.mintInviteCodes(db2, {
          label: "Stuck",
          count: 2,
          expiresAt: 2_000_000_000_000,
          codeFn: () => "FAM-AAAA-AAAA-AAAA-AAAA", // always the same valid code -> budget exhausts
        });
      } catch (e) {
        err = e;
      }
      expect(err).not.toBeNull();
      expect(String(err.message)).not.toContain("FAM-"); // error never leaks a code
      expect(db2.query(`SELECT COUNT(*) AS n FROM invite_codes`).get().n).toBe(0);
      expect(db2.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n).toBe(0);
    } finally {
      db2.close();
    }
  } finally {
    db.close();
  }
});

test("mintInviteCodes: a throwing codeFn rolls back what came before (no partial codes, no audit)", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    let calls = 0;
    let err = null;
    const candidates = ["FAM-AAAA-AAAA-AAAA-AAAA", "FAM-AAAA-AAAA-AAAA-AAAB"];
    try {
      inv.mintInviteCodes(db, {
        label: "Boom",
        count: 5,
        expiresAt: 2_000_000_000_000,
        codeFn: () => {
          calls++;
          if (calls === 3) throw new Error("boom");
          return candidates[(calls - 1) % 2];
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.message).toBe("boom");
    // full rollback of the earlier inserts
    expect(db.query(`SELECT COUNT(*) AS n FROM invite_codes`).get().n).toBe(0);
    expect(db.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n).toBe(0);
  } finally {
    db.close();
  }
});

// ── Behavior 3: buildFamilyWelcomeMessage (email.js) ─────────────────────────
test("buildFamilyWelcomeMessage: provider-neutral Class Navi Pro Tools builder, raw key only in the body, never an invite code", async () => {
  const { buildFamilyWelcomeMessage } = await import("../email.js");
  const m = buildFamilyWelcomeMessage({
    licenseKey: "QMP-AAAA-BBBB-CCCC-DDDD",
    recipient: "  Aunt@Example.COM  ",
  });
  expect(m.from).toBe("Class Navi Pro Tools <licenses@send.nimira-timer.com>");
  expect(m.reply_to).toBe("support@nimira-timer.com");
  expect(m.to).toBe("aunt@example.com"); // normalized
  expect(m.subject).toContain("free");
  expect(m.subject).toContain("Class Navi Pro Tools");
  expect(m.html).toContain("QMP-AAAA-BBBB-CCCC-DDDD"); // raw key in the body (for delivery)
  expect(m.html).toContain("Class Navi Pro Tools");
  expect(m.html).not.toContain("FAM-"); // invite code never appears

  // provider-neutral shape matches the paid welcome builder
  const paid = buildWelcomeMessage({ licenseKey: "QMP-0000-0000-0000-0000", recipient: "x@y.z" });
  expect(typeof paid.from).toBe("string");
  expect(typeof paid.html).toBe("string");
  expect(m.from === paid.from).toBe(true); // same sender fields
  expect(m.reply_to === paid.reply_to).toBe(true);

  expect(() => buildFamilyWelcomeMessage({ licenseKey: "K", recipient: "" })).toThrow(TypeError);
});

// ── Behavior 4: redeemInvite ─────────────────────────────────────────────────
test("redeemInvite success: one family_free license (active, no expiry, NULL Stripe fields) + one redeemed invite + one family_welcome outbox + one invite_redeemed audit", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    const expiresAt = 2_000_000_000_000;
    const { codes } = inv.mintInviteCodes(db, { label: "Niece", count: 1, expiresAt });
    const code = codes[0];
    const beforeAudit = db.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n;

    const r = inv.redeemInvite(db, { code, email: "  Niece@Example.COM  " });
    // Safe return shape ONLY: no full key, no email, no code, no hash.
    expect(r).toEqual({ redeemed: true, code: "redeemed", licenseTail: expect.any(String) });
    const s = JSON.stringify(r);
    expect(s).not.toContain(code);
    expect(s).not.toContain("niece@example.com");
    expect(s).not.toContain("QMP-");

    // Exactly one license with the frozen family_free shape.
    const lic = db.query(`SELECT * FROM licenses WHERE source='family_free'`).all();
    expect(lic.length).toBe(1);
    expect(lic[0].status).toBe("active");
    expect(lic[0].email).toBe("niece@example.com"); // normalized email
    expect(lic[0].expires_at).toBeNull();
    expect(lic[0].customer_id).toBeNull();
    expect(lic[0].subscription_id).toBeNull();
    expect(lic[0].current_period_end).toBeNull();
    expect(lic[0].cancel_at_period_end).toBe(0);
    expect(lic[0].last_stripe_event_created).toBeNull();
    expect(lic[0].key).toMatch(/^QMP-/);
    expect(lic[0].key.slice(-4)).toBe(r.licenseTail);
    const licenseKey = lic[0].key;
    const tail = licenseKey.slice(-4);

    // Invite row redeemed exactly once with hash-linked fields.
    const row = db.query(`SELECT * FROM invite_codes WHERE code_hash=?`).get(inv.hashInviteCode(code));
    expect(row.redeemed_at).toBeGreaterThan(0);
    expect(row.redeemed_email).toBe("niece@example.com");
    expect(row.license_key).toBe(licenseKey);

    // Exactly one durable outbox row, family_welcome, stable idempotency key from code_hash.
    const out = db.query(`SELECT * FROM email_outbox`).all();
    expect(out.length).toBe(1);
    expect(out[0].kind).toBe("family_welcome");
    expect(out[0].recipient_email).toBe("niece@example.com");
    expect(out[0].idempotency_key).toBe(`family-welcome:${inv.hashInviteCode(code)}`);
    expect(out[0].license_key).toBe(licenseKey);
    const payload = JSON.parse(out[0].payload_json);
    expect(payload.to).toBe("niece@example.com");
    expect(payload.html).toContain(licenseKey);
    expect(payload.html).not.toContain(code);

    // Exactly one invite_redeemed audit: masked email subject, {licenseTail} detail, no secrets.
    const audits = db.query(`SELECT * FROM admin_audit ORDER BY id`).all();
    expect(audits.length).toBe(beforeAudit + 1);
    const aud = audits[audits.length - 1];
    expect(aud.action).toBe("invite_redeemed");
    expect(aud.subject_masked).not.toContain("niece@example.com");
    expect(JSON.parse(aud.detail_json)).toEqual({ licenseTail: tail });
    const adump = JSON.stringify(aud);
    expect(adump).not.toContain("niece@example.com");
    expect(adump).not.toContain(licenseKey);
    expect(adump).not.toContain(code);
  } finally {
    db.close();
  }
});

test("redeemInvite canonicalizes the code (trim+uppercase) before looking it up", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    const { codes } = inv.mintInviteCodes(db, { label: "Canon", count: 1, expiresAt: 2_000_000_000_000 });
    const r = inv.redeemInvite(db, { code: `  ${codes[0].toLowerCase()}  `, email: "canon@example.com" });
    expect(r.redeemed).toBe(true);
    expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(1);
  } finally {
    db.close();
  }
});

test("redeemInvite neutral failures: invalid/missing/expired/already-redeemed/revoked/blank-email all return the SAME safe shape with no writes and no audit", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    const mint = () =>
      inv.mintInviteCodes(db, { label: "Neutral", count: 1, expiresAt: 2_000_000_000_000 }).codes[0];

    // Four invites minted up front (each adds one invite_minted audit row).
    const cBlank = mint();
    const cExpired = mint();
    const cOnce = mint();
    const cRevoked = mint();

    const safe = { redeemed: false, code: "invalid", licenseTail: null };
    // (a) invalid shape
    expect(inv.redeemInvite(db, { code: "GARBAGE", email: "a@b.com" })).toEqual(safe);
    // (b) missing (valid shape, not minted)
    expect(inv.redeemInvite(db, { code: "FAM-ZZZZ-ZZZZ-ZZZZ-ZZZZ", email: "a@b.com" })).toEqual(safe);
    // (c) blank email
    expect(inv.redeemInvite(db, { code: cBlank, email: "   " })).toEqual(safe);
    // (d) expired — backdate the invite
    db.query(`UPDATE invite_codes SET expires_at = ? WHERE code_hash = ?`).run(
      Date.now() - 1,
      inv.hashInviteCode(cExpired)
    );
    expect(inv.redeemInvite(db, { code: cExpired, email: "d@e.com" })).toEqual(safe);
    // (e) already-redemed
    expect(inv.redeemInvite(db, { code: cOnce, email: "once@example.com" }).redeemed).toBe(true);
    const auditsAfterRedeem = db.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n;
    expect(inv.redeemInvite(db, { code: cOnce, email: "again@example.com" })).toEqual(safe);
    // (f) revoked invite (defensive: pre-revoked invitation)
    db.query(`UPDATE invite_codes SET revoked_at = ? WHERE code_hash = ?`).run(
      Date.now(),
      inv.hashInviteCode(cRevoked)
    );
    expect(inv.redeemInvite(db, { code: cRevoked, email: "g@h.com" })).toEqual(safe);

    // Neutral failures wrote NOTHING: only the one real redemption's license/outbox exist.
    expect(db.query(`SELECT COUNT(*) AS n FROM licenses`).get().n).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM email_outbox`).get().n).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n).toBe(auditsAfterRedeem);
    // All 4 invites still present; exactly one redeemed, one revoked, none else touched.
    expect(db.query(`SELECT COUNT(*) AS n FROM invite_codes`).get().n).toBe(4);
    expect(db.query(`SELECT COUNT(*) AS n FROM invite_codes WHERE redeemed_at IS NOT NULL`).get().n).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM invite_codes WHERE revoked_at IS NOT NULL OR redeemed_at IS NOT NULL`).get().n).toBe(2);
  } finally {
    db.close();
  }
});

test("redeemInvite key safety: a colliding license-key candidate is retried; a stuck one throws and rolls everything back; a throwing licenseKeyFn rolls back too", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    const existing = "QMP-EEEE-EEEE-EEEE-EEEE";
    upsertLicense(db, { key: existing, email: "seed@example.com", customerId: "cus_x", subscriptionId: "sub_x", status: "active" });

    const mint = (label, count) =>
      inv.mintInviteCodes(db, { label, count, expiresAt: 2_000_000_000_000 }).codes;

    // (1) one colliding candidate, then a fresh key -> retry works, one license
    const [c1] = mint("RetryKey", 1);
    const freshTail = "FRES"; // exactly 4 chars: slice(-4) must equal it
    let seq = 0;
    const r1 = inv.redeemInvite(db, {
      code: c1,
      email: "retry@example.com",
      licenseKeyFn: () => (seq++ === 0 ? existing : `QMP-AAAA-AAAA-AAAA-${freshTail}`),
    });
    expect(r1.redeemed).toBe(true);
    expect(r1.licenseTail).toBe(freshTail);
    const lic1 = db.query(`SELECT key FROM licenses WHERE source='family_free'`).get();
    expect(lic1.key).toBe(`QMP-AAAA-AAAA-AAAA-${freshTail}`);

    // (2) stuck keyFn -> throws, full rollback (invite/redeemed/outbox/audit untouched)
    const [c2] = mint("StuckKey", 1);
    const auditsBefore = db.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n;
    let err2 = null;
    try {
      inv.redeemInvite(db, {
        code: c2,
        email: "stuck@example.com",
        licenseKeyFn: () => existing,
      });
    } catch (e) {
      err2 = e;
    }
    expect(err2).not.toBeNull();
    expect(db.query(`SELECT COUNT(*) AS n FROM licenses WHERE source='family_free'`).get().n).toBe(1); // only retry's license
    const row2 = db.query(`SELECT redeemed_at FROM invite_codes WHERE code_hash=?`).get(inv.hashInviteCode(c2));
    expect(row2.redeemed_at).toBeNull();
    expect(db.query(`SELECT COUNT(*) AS n FROM email_outbox`).get().n).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n).toBe(auditsBefore);

    // (3) throwing licenseKeyFn -> throws, full rollback
    const [c3] = mint("ThrowKey", 1);
    const auditsBefore3 = db.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n;
    let err3 = null;
    try {
      inv.redeemInvite(db, { code: c3, email: "throw@example.com", licenseKeyFn: () => { throw new Error("keygen down"); } });
    } catch (e) {
      err3 = e;
    }
    expect(err3).not.toBeNull();
    expect(db.query(`SELECT COUNT(*) AS n FROM licenses WHERE source='family_free'`).get().n).toBe(1);
    const row3 = db.query(`SELECT redeemed_at FROM invite_codes WHERE code_hash=?`).get(inv.hashInviteCode(c3));
    expect(row3.redeemed_at).toBeNull();
    expect(db.query(`SELECT COUNT(*) AS n FROM email_outbox`).get().n).toBe(1);
    expect(db.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n).toBe(auditsBefore3);
  } finally {
    db.close();
  }
});

// ── Behavior 5: browser-slot activation/validation until revoke ──────────────
test("family_free license activates + validates a browser slot; after individual revocation, activation and validation fail closed", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    const { codes } = inv.mintInviteCodes(db, { label: "Slot", count: 1, expiresAt: 2_000_000_000_000 });
    const r = inv.redeemInvite(db, { code: codes[0], email: "slot@example.com" });
    expect(r.redeemed).toBe(true);
    const licenseKey = db.query(`SELECT key FROM licenses WHERE source='family_free'`).get().key;

    // Active family license occupies + validates a Chrome slot (like any active license).
    const act = activateBrowserSlot(db, { licenseKey, browserFamily: "chrome", instanceId: "inst-fam-1" });
    expect(act).toEqual({ valid: true, activated: true, code: "ok", browserFamily: "chrome" });
    const val = validateBrowserSlot(db, { licenseKey, browserFamily: "chrome", instanceId: "inst-fam-1" });
    expect(val).toEqual({ valid: true, code: "ok", browserFamily: "chrome" });

    // Individual revocation kills that family license's access.
    const rev = inv.revokeFamilyLicense(db, { licenseKey });
    expect(rev).toEqual({ revoked: true, code: "revoked", licenseTail: licenseKey.slice(-4) });
    expect(validateBrowserSlot(db, { licenseKey, browserFamily: "chrome", instanceId: "inst-fam-1" })).toEqual({ valid: false, code: "license-revoked", browserFamily: "chrome", actions: null });
    expect(activateBrowserSlot(db, { licenseKey, browserFamily: "chrome", instanceId: "inst-fam-2" })).toEqual({ valid: false, code: "license-revoked", browserFamily: "chrome", actions: null });
    // Existing slot row is still present but the license is dead; validation wrote nothing.
    expect(db.query(`SELECT COUNT(*) AS n FROM browser_slots`).get().n).toBe(1);
  } finally {
    db.close();
  }
});

// ── Behavior 6: revokeFamilyLicense ──────────────────────────────────────────
test("revokeFamilyLicense revokes only the targeted family license; other family + paid/admin licenses stay active; repeat is a stable not-found with no duplicate audit", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    const mint = (label) =>
      inv.mintInviteCodes(db, { label, count: 1, expiresAt: 2_000_000_000_000 }).codes[0];

    // two family licenses + one paid + one admin-issued (source defaults to stripe_paid)
    const famA = mint("A");
    const famB = mint("B");
    const rA = inv.redeemInvite(db, { code: famA, email: "a@example.com" });
    const rB = inv.redeemInvite(db, { code: famB, email: "b@example.com" });
    const keyA = db.query(`SELECT key FROM licenses WHERE source='family_free' AND email='a@example.com'`).get().key;
    const keyB = db.query(`SELECT key FROM licenses WHERE source='family_free' AND email='b@example.com'`).get().key;
    const paidKey = generateKey();
    upsertLicense(db, { key: paidKey, email: "paid@example.com", customerId: "cus_p", subscriptionId: "sub_p", status: "active" });
    const adminKey = generateKey();
    upsertLicense(db, { key: adminKey, email: "admin@example.com", customerId: "admin", subscriptionId: `admin-${adminKey.slice(-4)}`, status: "active" });

    // Revoke A only.
    const rev = inv.revokeFamilyLicense(db, { licenseKey: keyA });
    expect(rev).toEqual({ revoked: true, code: "revoked", licenseTail: keyA.slice(-4) });
    expect(db.query(`SELECT status FROM licenses WHERE key=?`).get(keyA).status).toBe("revoked");
    // invite A got revoked_at; invite B untouched.
    const inviteA = db.query(`SELECT revoked_at FROM invite_codes WHERE license_key=?`).get(keyA);
    expect(inviteA.revoked_at).not.toBeNull();
    expect(db.query(`SELECT revoked_at FROM invite_codes WHERE license_key=?`).get(keyB).revoked_at).toBeNull();

    // Others untouched.
    for (const k of [keyB, paidKey, adminKey]) {
      expect(db.query(`SELECT status FROM licenses WHERE key=?`).get(k).status).toBe("active");
    }
    // sources unchanged.
    expect(db.query(`SELECT source FROM licenses WHERE key=?`).get(keyB).source).toBe("family_free");
    expect(db.query(`SELECT source FROM licenses WHERE key=?`).get(paidKey).source).toBe("stripe_paid");
    expect(db.query(`SELECT source FROM licenses WHERE key=?`).get(adminKey).source).toBe("stripe_paid");

    // Repeat revoke = stable safe not-found, NO duplicate audit.
    const auditBefore = db.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n;
    const again = inv.revokeFamilyLicense(db, { licenseKey: keyA });
    expect(again).toEqual({ revoked: false, code: "not-found", licenseTail: null });
    expect(db.query(`SELECT COUNT(*) AS n FROM admin_audit`).get().n).toBe(auditBefore);

    // Revoking a PAID key never changes it and returns not-found.
    const paidRev = inv.revokeFamilyLicense(db, { licenseKey: paidKey });
    expect(paidRev).toEqual({ revoked: false, code: "not-found", licenseTail: null });
    expect(db.query(`SELECT status FROM licenses WHERE key=?`).get(paidKey).status).toBe("active");
    // Revoking an ADMIN-issued key (stripe_paid source) never changes it either.
    const adminRev = inv.revokeFamilyLicense(db, { licenseKey: adminKey });
    expect(adminRev.revoked).toBe(false);
    expect(db.query(`SELECT status FROM licenses WHERE key=?`).get(adminKey).status).toBe("active");

    // Revoke audit shape: masked key-tail subject + {licenseTail}, no secrets.
    const aud = db.query(`SELECT * FROM admin_audit WHERE action='family_license_revoked'`).all();
    expect(aud.length).toBe(1);
    expect(aud[0].subject_masked).not.toContain(keyA);
    expect(JSON.parse(aud[0].detail_json)).toEqual({ licenseTail: keyA.slice(-4) });
    const ad = JSON.stringify(aud[0]);
    expect(ad).not.toContain(keyA);
    expect(ad).not.toContain(famA);
    expect(ad).not.toContain("a@example.com");
    expect(rA.redeemed && rB.redeemed).toBe(true);
  } finally {
    db.close();
  }
});

// ── Behavior 7: Stripe isolation ─────────────────────────────────────────────
test("Stripe state/events for adversarial subscription ids NEVER mutate the family_free license (NULL subscription_id is unreachable)", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    const { codes } = inv.mintInviteCodes(db, { label: "Iso", count: 1, expiresAt: 2_000_000_000_000 });
    inv.redeemInvite(db, { code: codes[0], email: "iso@example.com" });
    const family = db.query(`SELECT * FROM licenses WHERE source='family_free'`).get();
    const before = JSON.stringify(family);
    expect(family.subscription_id).toBeNull();

    // 1) recordStripeSubscriptionState with an adversarial subscription id.
    recordStripeSubscriptionState(db, { subscriptionId: "sub_family_adversary", status: "canceled", eventCreated: 1_700_000_900 });
    expect(db.query(`SELECT status FROM licenses WHERE source='family_free'`).get().status).toBe("active");

    // 2) applyVerifiedStripeEvent: canceled subscription event for an unrelated id.
    const out1 = applyVerifiedStripeEvent(db, {
      id: "evt_family_isolation_1",
      type: "customer.subscription.updated",
      created: 1_700_000_100,
      data: { object: { id: "sub_family_adversary", status: "canceled", current_period_end: 12345, cancel_at_period_end: false } },
    });
    expect(out1.processed).toBe(true);
    expect(out1.duplicate).toBe(false);

    // 3) applyVerifiedStripeEvent: a checkout for yet another subscription — it
    // mints its OWN paid license but can never touch the family license.
    const out2 = applyVerifiedStripeEvent(db, {
      id: "evt_family_isolation_2",
      type: "checkout.session.completed",
      created: 1_700_000_200,
      data: { object: { id: "cs_adv", subscription: "sub_other_checkout", customer: "cus_adv", customer_details: { email: "other@example.com" } } },
    });
    expect(out2.processed).toBe(true);
    expect(db.query(`SELECT COUNT(*) AS n FROM licenses WHERE source='family_free'`).get().n).toBe(1);

    // 4) Direct subscription-id mutation cannot target NULL subscription_id.
    const chg = db.query(`UPDATE licenses SET status='canceled' WHERE subscription_id='sub_family_adversary'`).run();
    expect(chg.changes).toBe(0);
    db.query(`UPDATE licenses SET status='canceled' WHERE subscription_id='sub_other_checkout'`).run();

    // Family row: key/status/source/expiry/billing bytes all unchanged the whole time.
    const after = db.query(`SELECT * FROM licenses WHERE source='family_free'`).get();
    expect(JSON.stringify(after)).toBe(before);
    expect(after.status).toBe("active");
    expect(after.source).toBe("family_free");
    expect(after.expires_at).toBeNull();
    expect(after.subscription_id).toBeNull();
    expect(after.current_period_end).toBeNull();
  } finally {
    db.close();
  }
});

// ── Behavior 8: two-process concurrency — one winner ─────────────────────────
test("concurrent redemption across two processes yields exactly one license/outbox/audit and one safe loser", async () => {
  const inv = await import("../invites.js");
  const dir = mkdtempSync(join(tmpdir(), "qmp-invites-race-"));
  const dbPath = join(dir, "race.db");
  const start = join(dir, "start");
  const childScript = join(dir, "child.mjs");
  try {
    // Seed the shared on-disk DB with one invite.
    const db = openDb(dbPath);
    const { codes } = inv.mintInviteCodes(db, { label: "Race", count: 1, expiresAt: 2_000_000_000_000 });
    const code = codes[0];
    db.close();

    // Child script: open the same DB, wait for the start gate, redeem, report result.
    const dbUrl = pathToFileURL(fileURLToPath(new URL("../db.js", import.meta.url))).href;
    const invUrl = pathToFileURL(fileURLToPath(new URL("../invites.js", import.meta.url))).href;
    writeFileSync(
      childScript,
      `import { existsSync } from "node:fs";
const { openDb } = await import(${JSON.stringify(dbUrl)});
const { redeemInvite } = await import(${JSON.stringify(invUrl)});
const db = openDb(process.argv[2]);
try {
  let waited = 0;
  while (!existsSync(process.argv[3]) && waited < 10000) { await new Promise((r) => setTimeout(r, 5)); waited += 5; }
  const out = redeemInvite(db, { code: process.argv[4], email: "child@example.com" });
  console.log("RESULT:" + JSON.stringify(out));
} catch (e) {
  console.log("ERR:" + String((e && e.message) || e));
} finally { db.close(); }
`
    );

    const child = spawn(process.execPath, [childScript, dbPath, start, code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childOut = "";
    const exited = new Promise((resolve) => {
      child.stdout.on("data", (d) => { childOut += d; });
      child.stderr.on("data", (d) => { childOut += d; });
      child.on("exit", (c) => resolve(c));
    });

    // Open the gate and race from this process immediately after spawning so the
    // two processes genuinely contend on the SQLite write lock.
    writeFileSync(start, "go");
    const parentDb = openDb(dbPath);
    const parentResult = inv.redeemInvite(parentDb, { code, email: "parent@example.com" });
    parentDb.close();

    const exitCode = await Promise.race([exited, sleep(15000).then(() => "TIMEOUT")]);
    if (exitCode !== 0) {
      throw new Error("child redeem process failed: " + childOut);
    }
    child.kill("SIGTERM");

    const childResult = JSON.parse(childOut.slice(childOut.indexOf("RESULT:") + 7));

    // Exactly one winner overall, one safe loser.
    const winners = [parentResult, childResult].filter((r) => r.redeemed === true);
    const losers = [parentResult, childResult].filter((r) => r.redeemed === false);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(winners[0]).toEqual({ redeemed: true, code: "redeemed", licenseTail: winners[0].licenseTail });
    expect(losers[0]).toEqual({ redeemed: false, code: "invalid", licenseTail: null });

    // DB invariants: one license, one redeemed invite, one outbox row, one invite_redeemed audit.
    const check = openDb(dbPath);
    try {
      expect(check.query(`SELECT COUNT(*) AS n FROM licenses WHERE source='family_free'`).get().n).toBe(1);
      expect(check.query(`SELECT COUNT(*) AS n FROM invite_codes WHERE redeemed_at IS NOT NULL`).get().n).toBe(1);
      expect(check.query(`SELECT COUNT(*) AS n FROM email_outbox WHERE kind='family_welcome'`).get().n).toBe(1);
      expect(check.query(`SELECT COUNT(*) AS n FROM admin_audit WHERE action='invite_redeemed'`).get().n).toBe(1);
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mintInviteCodes rejects codeFn output containing excluded invite characters", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    for (const code of [
      "FAM-IIII-AAAA-AAAA-AAAA",
      "FAM-LLLL-AAAA-AAAA-AAAA",
      "FAM-OOOO-AAAA-AAAA-AAAA",
      "FAM-0000-AAAA-AAAA-AAAA",
      "FAM-1111-AAAA-AAAA-AAAA",
    ]) {
      expect(() =>
        inv.mintInviteCodes(db, {
          label: "Invalid alphabet",
          count: 1,
          expiresAt: 2_000_000_000_000,
          codeFn: () => code,
        })
      ).toThrow();
    }
    expect(db.query("SELECT COUNT(*) AS n FROM invite_codes").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM admin_audit").get().n).toBe(0);
  } finally {
    db.close();
  }
});

test("redeemInvite rejects malformed license-key candidates and rolls back", async () => {
  const inv = await import("../invites.js");
  const db = openDb(":memory:");
  try {
    const [code] = inv.mintInviteCodes(db, {
      label: "Malformed key",
      count: 1,
      expiresAt: 2_000_000_000_000,
    }).codes;
    const auditsBefore = db.query("SELECT COUNT(*) AS n FROM admin_audit").get().n;
    expect(() =>
      inv.redeemInvite(db, {
        code,
        email: "family@example.com",
        licenseKeyFn: () => "<script>not-a-license-key</script>",
      })
    ).toThrow();
    expect(db.query("SELECT COUNT(*) AS n FROM licenses").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM email_outbox").get().n).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM admin_audit").get().n).toBe(auditsBefore);
    const invite = db.query("SELECT redeemed_at, redeemed_email, license_key FROM invite_codes").get();
    expect(invite).toEqual({ redeemed_at: null, redeemed_email: null, license_key: null });
  } finally {
    db.close();
  }
});
