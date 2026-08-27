// server/invites.js — Slice 5A family invite core.
//
// Human-copyable, one-time invite codes that are redeemed for individually
// controlled free-forever family access. Secrets by design:
//   * Only SHA-256 hex of each invite code is ever persisted (code_hash PK);
//     the plaintext is returned to the trusted minting caller exactly once and
//     can never be re-derived from the DB.
//   * redeemInvite returns ONLY { redeemed, code, licenseTail } — never a full
//     key, email, code, or hash — and every failure branch returns the SAME
//     neutral shape with zero writes and zero audit rows (a public redemption
//     surface must not leak whether a code was ever minted/redeemed/revoked).
//   * admin_audit rows carry masked subjects and detail JSON with no
//     codes/hashes/keys/emails.
//
// Import-safe: no DB open, server, timer, network, or logging at module load.
// node:crypto only, plus the accepted db/email helpers. Every write path owns
// its own BEGIN IMMEDIATE (and never nests inside an outer transaction); any
// throw rolls back the license, invite, outbox, and audit together.
import { createHash, randomBytes } from "node:crypto";
import { generateKey, normalizeEmail, enqueueEmail } from "./db.js";
import { buildFamilyWelcomeMessage } from "./email.js";

export const INVITE_PREFIX = "FAM";
/** Uppercase alphabet excluding 0/O/1/I/L (32 chars; same spirit as license keys). */
export const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** Frozen human-copyable code shape: FAM-XXXX-XXXX-XXXX-XXXX. */
export const INVITE_CODE_RE = /^FAM-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
const LICENSE_KEY_RE = /^QMP-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

/** Generate one random human-copyable invite code. */
export function generateInviteCode() {
  const bytes = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  return `FAM-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

/** Canonical invite-code form: trim + uppercase. */
export function canonicalizeInviteCode(code) {
  return String(code || "").trim().toUpperCase();
}

/** SHA-256 hex of the canonical code — the ONLY representation ever stored. */
export function hashInviteCode(code) {
  return createHash("sha256").update(canonicalizeInviteCode(code)).digest("hex");
}

function isValidInviteCodeShape(canonical) {
  return typeof canonical === "string" && INVITE_CODE_RE.test(canonical);
}

// ── Internal masks (audit subjects only — never the raw value) ──────────────
function maskLabel(label) {
  const s = String(label || "").trim();
  if (s.length <= 2) return "*".repeat(s.length);
  return s[0] + "*".repeat(s.length - 2) + s[s.length - 1];
}

function maskEmail(email) {
  const at = email.indexOf("@");
  if (at <= 0) return maskLabel(email);
  const local = email.slice(0, at);
  const maskedLocal = local.length <= 2 ? "**" : local[0] + "***";
  return `${maskedLocal}@${email.slice(at + 1)}`;
}

function licenseTail(key) {
  return String(key).slice(-4);
}

function maskKey(key) {
  return `QMP-****-****-****-${licenseTail(key)}`;
}

// ── Contracts ────────────────────────────────────────────────────────────────

/**
 * Mint `count` invite codes (1..50) for a label, all inside ONE transaction.
 * Inserts only hashes/label/timestamps; returns each plaintext code exactly
 * once plus the safe expiry/count. Code collisions (existing rows or same-batch
 * duplicates) are retried with a bounded budget; a stuck codeFn fails and
 * rolls back the whole batch (no partial codes, no audit).
 *
 * Returns { count, expiresAt, codes: [plaintext...] }.
 */
export function mintInviteCodes(
  db,
  { label, count, expiresAt, now = Date.now(), codeFn = generateInviteCode } = {}
) {
  const cleanLabel = String(label || "").trim();
  if (!cleanLabel || cleanLabel.length > 100) {
    throw new TypeError("mintInviteCodes: label must be non-blank and at most 100 chars");
  }
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new TypeError("mintInviteCodes: count must be an integer between 1 and 50");
  }
  const t = Number.isFinite(now) ? now : Date.now();
  if (!Number.isInteger(expiresAt) || expiresAt <= t) {
    throw new TypeError("mintInviteCodes: expiresAt must be a finite integer later than now");
  }

  const codes = [];
  const batchHashes = new Set();
  const knownTaken = new Set(); // hashes already present in the DB
  // Bounded collision budget: every attempt consumes budget (both intra-batch
  // duplicates and existing rows), so a pathological codeFn cannot loop forever.
  let budget = count * 100 + 100;

  db.exec("BEGIN IMMEDIATE");
  try {
    while (codes.length < count) {
      if (--budget < 0) {
        throw new Error("invite collision budget exceeded");
      }
      const canonical = canonicalizeInviteCode(codeFn());
      if (!isValidInviteCodeShape(canonical)) {
        throw new Error("codeFn produced an invalid invite code");
      }
      const h = hashInviteCode(canonical);
      if (batchHashes.has(h) || knownTaken.has(h)) continue;
      const exists = db.query(`SELECT 1 FROM invite_codes WHERE code_hash = ?`).get(h);
      if (exists) {
        knownTaken.add(h);
        continue;
      }
      db.query(
        `INSERT INTO invite_codes (code_hash, label, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
      ).run(h, cleanLabel, t, expiresAt);
      batchHashes.add(h);
      codes.push(canonical);
    }
    // One audit row for the whole batch: masked label subject, safe detail only.
    db.query(
      `INSERT INTO admin_audit (action, subject_masked, detail_json, created_at)
       VALUES (?, ?, ?, ?)`
    ).run("invite_minted", maskLabel(cleanLabel), JSON.stringify({ count, expiresAt }), t);
    db.exec("COMMIT");
    return { count, expiresAt, codes };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* connection already rolled back */
    }
    throw err;
  }
}

/** The single safe neutral redemption failure shape. */
const SAFE_INVALID = Object.freeze({ redeemed: false, code: "invalid", licenseTail: null });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Redeem one invite code for a free-forever family license.
 *
 * Email is normalized and the code shape is canonicalized BEFORE any mutation.
 * Owns ONE BEGIN IMMEDIATE: succeeds by atomically inserting a single
 * `source=family_free` license (active, no expiry, no Stripe fields), marking
 * the invite redeemed (only if still unused AND unrevoked), enqueuing one
 * `family_welcome` email (stable idempotency key derived from the code hash
 * only), and writing one `invite_redeemed` audit. The write lock serializes
 * concurrent contenders so exactly one process wins; the guarded UPDATE is a
 * second line of defense. Any throw rolls back everything.
 *
 * Failure branches (invalid/missing/expired/already-redeemed/revoked/bad email)
 * ALL return { redeemed:false, code:'invalid', licenseTail:null } with no
 * writes and no audit. Success returns only
 * { redeemed:true, code:'redeemed', licenseTail }.
 */
export function redeemInvite(
  db,
  { code, email, now = Date.now(), licenseKeyFn = generateKey } = {}
) {
  const cleanEmail = normalizeEmail(email);
  const canonical = canonicalizeInviteCode(code);
  if (!cleanEmail || !EMAIL_RE.test(cleanEmail) || !isValidInviteCodeShape(canonical)) {
    return SAFE_INVALID;
  }
  const t = Number.isFinite(now) ? now : Date.now();
  const codeHash = hashInviteCode(canonical);

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .query(`SELECT redeemed_at, revoked_at, expires_at FROM invite_codes WHERE code_hash = ?`)
      .get(codeHash);
    if (!row || row.redeemed_at !== null || row.revoked_at !== null || row.expires_at <= t) {
      db.exec("COMMIT");
      return SAFE_INVALID;
    }

    // Fresh license key with bounded collision retry (a candidate that already
    // exists is regenerated up to a fixed budget).
    const seen = new Set();
    let licenseKey = null;
    for (let budget = 8; budget > 0; budget--) {
      const candidate = String(licenseKeyFn() || "").trim().toUpperCase();
      if (!LICENSE_KEY_RE.test(candidate)) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const exists = db.query(`SELECT 1 FROM licenses WHERE key = ?`).get(candidate);
      if (!exists) {
        licenseKey = candidate;
        break;
      }
    }
    if (!licenseKey) {
      db.exec("ROLLBACK");
      throw new Error("family license key collision budget exceeded");
    }

    // Free-forever license: no expiry, no Stripe subscription/customer, no
    // billing period — source alone marks it as a family seat.
    db.query(
      `INSERT INTO licenses
         (key, email, customer_id, subscription_id, status, source, expires_at,
          current_period_end, cancel_at_period_end, last_stripe_event_created, created_at, updated_at)
       VALUES (?, ?, NULL, NULL, 'active', 'family_free', NULL, NULL, 0, NULL, ?, ?)`
    ).run(licenseKey, cleanEmail, t, t);

    // Guarded redeem marker: never mark an already-redeemed or revoked invite.
    const up = db
      .query(
        `UPDATE invite_codes SET redeemed_at = ?, redeemed_email = ?, license_key = ?
         WHERE code_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL`
      )
      .run(t, cleanEmail, licenseKey, codeHash);
    if (up.changes !== 1) {
      db.exec("ROLLBACK");
      return SAFE_INVALID;
    }

    // One family_welcome email inside the same transaction. The idempotency key
    // is derived from the code hash only, so any retry for this code collapses
    // to the persisted outbox row.
    enqueueEmail(db, {
      kind: "family_welcome",
      licenseKey,
      recipientEmail: cleanEmail,
      payload: buildFamilyWelcomeMessage({ licenseKey, recipient: cleanEmail }),
      idempotencyKey: `family-welcome:${codeHash}`,
    });

    db.query(
      `INSERT INTO admin_audit (action, subject_masked, detail_json, created_at)
       VALUES ('invite_redeemed', ?, ?, ?)`
    ).run(maskEmail(cleanEmail), JSON.stringify({ licenseTail: licenseTail(licenseKey) }), t);

    db.exec("COMMIT");
    return { redeemed: true, code: "redeemed", licenseTail: licenseTail(licenseKey) };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* connection already rolled back */
    }
    throw err;
  }
}

/** Safe stable result when a license is not a revocable active family seat. */
const NOT_FOUND = Object.freeze({ revoked: false, code: "not-found", licenseTail: null });

/**
 * Individually revoke ONE family_free license. Matches ONLY `source='family_free'`
 * and `status='active'`: paid Stripe licenses and admin-issued keys never change,
 * and an already-revoked family license returns the same stable not-found with no
 * duplicate audit. Sets status='revoked', stamps the matching invite's
 * revoked_at, and writes one `family_license_revoked` audit with a masked key
 * tail + { licenseTail }. Never returns the full key or redacted string.
 *
 * Returns { revoked:true, code:'revoked', licenseTail } on success, otherwise
 * { revoked:false, code:'not-found', licenseTail:null }.
 */
export function revokeFamilyLicense(db, { licenseKey, now = Date.now() } = {}) {
  const key = String(licenseKey || "").trim();
  if (!key) return NOT_FOUND;
  const t = Number.isFinite(now) ? now : Date.now();

  db.exec("BEGIN IMMEDIATE");
  try {
    const lic = db.query(`SELECT key, source, status FROM licenses WHERE key = ?`).get(key);
    if (!lic || lic.source !== "family_free" || lic.status !== "active") {
      db.exec("COMMIT");
      return NOT_FOUND;
    }
    const r = db
      .query(
        `UPDATE licenses SET status = 'revoked', updated_at = ?
         WHERE key = ? AND source = 'family_free' AND status = 'active'`
      )
      .run(t, key);
    if (r.changes !== 1) {
      db.exec("COMMIT");
      return NOT_FOUND;
    }
    const tail = licenseTail(key);
    // Mark the corresponding invite revoked (harmless no-op if no invite row).
    db.query(`UPDATE invite_codes SET revoked_at = ? WHERE license_key = ? AND revoked_at IS NULL`).run(t, key);
    db.query(
      `INSERT INTO admin_audit (action, subject_masked, detail_json, created_at)
       VALUES ('family_license_revoked', ?, ?, ?)`
    ).run(maskKey(key), JSON.stringify({ licenseTail: tail }), t);
    db.exec("COMMIT");
    return { revoked: true, code: "revoked", licenseTail: tail };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* connection already rolled back */
    }
    throw err;
  }
}
