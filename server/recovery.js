// server/recovery.js — Slice 3A secure-recovery core.
//
// IMPORTS: ONLY node:crypto. No DB open, no timers, no network. Module load
// is side-effect free.
//
// This module owns the secure-recovery primitives the HTTP layer wires in
// Slice 3B. It never talks to the request lifecycle, never logs, and never
// logs / persists plaintext tokens: SHA-256 hex is the only on-disk shape
// of a management token. Plaintext is returned to the trusted caller once at
// mint time so it can be sealed into the durable email outbox (or rendered
// directly into a signed link) and never stored again.
import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

/** Allowed management-token purposes. Adding a new purpose requires adding
 * both the string here AND an explicit scope branch in consumeResetToken. */
export const ALLOWED_PURPOSES = Object.freeze([
  "recover",
  "reset_chrome",
  "reset_edge",
  "reset_all",
]);

/** Exact default TTL: 20 minutes. */
export const DEFAULT_TOKEN_TTL_MS = 20 * 60 * 1000;

/** AES-256-GCM key derivation length. */
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/** Normalize email: trim + lowercase, or null when blank. */
export function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  const s = email.trim().toLowerCase();
  return s.length > 0 ? s : null;
}

/** SHA-256 hex of the token bytes (UTF-8). */
export function hashToken(token) {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("hashToken: token must be a non-empty string");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * HMAC-SHA256 hex of the raw subject, so raw email / IP is never stored.
 *
 * Contract (Strict — caller must not bypass):
 *   - value: must be a non-blank, trimmed-evaluable string. Whitespace-only is
 *     rejected with a fixed safe message that NEVER echoes the input.
 *   - secret: must be a non-blank string (whitespace-only also rejected).
 *     An empty/blank secret is NEVER used to sign any subject — that would
 *     be a global collision attack on every keyless caller. Missing/blank
 *     secret throws with a fixed safe message.
 *   - Returns the canonical HMAC-SHA256 hex (64 lowercase chars) of the
 *     TRIMMED value under the supplied secret. Trimming is the caller's
 *     normalization invariant.
 *
 * This function is the ONLY legitimate way for callers to turn a raw
 * subject into an opaque token suitable for storage. consumeRequestLimit
 * accepts the produced hash verbatim and never re-hashes.
 */
export function hashRequestSubject(value, secret) {
  // Fixed safe messages — never include the caller's input or secret.
  if (typeof value !== "string") {
    throw new TypeError("hashRequestSubject: value must be a non-blank string");
  }
  if (value.trim() === "") {
    throw new TypeError("hashRequestSubject: value must be a non-blank string");
  }
  if (typeof secret !== "string") {
    throw new TypeError("hashRequestSubject: secret must be a non-blank string");
  }
  if (secret.trim() === "") {
    throw new TypeError("hashRequestSubject: secret must be a non-blank string");
  }
  return createHmac("sha256", secret).update(value.trim(), "utf8").digest("hex");
}

/* ─────────────────────────── Token generation ─────────────────────────── */

/**
 * Generate a fresh management token, persist only its SHA-256 hash, and
 * return the plaintext alongside safe metadata to the trusted caller.
 *
 * Input validation (rejected before any mutation):
 *   - email normalized (trim + lowercase); blank rejected.
 *   - licenseKey must be a non-blank string (exact-match against licenses.key).
 *   - normalized email must equal licenses.email for that key.
 *   - purpose must be in ALLOWED_PURPOSES (unknown purpose throws a fixed
 *     TypeError that does NOT echo attacker-controlled purpose text).
 *   - now must be a finite number; ttlMs must be > 0 (default DEFAULT_TOKEN_TTL_MS).
 *
 * Returns EXACTLY { token, expiresAt, usedAt, purpose, licenseTail }.
 * NEVER returns: email, the full licenseKey, or any sensitive field. Sensitive
 * identifiers are deliberately omitted from the return shape so this object
 * can be safely logged, sealed into the email outbox, and embedded in links
 * without leaking PII.
 */
export function generateManagementToken(
  db,
  { email, licenseKey, purpose, now = Date.now(), ttlMs = DEFAULT_TOKEN_TTL_MS }
) {
  if (!db || typeof db.query !== "function") {
    throw new TypeError("generateManagementToken: db required");
  }
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new TypeError("generateManagementToken: email required");
  if (typeof licenseKey !== "string" || licenseKey.trim() === "") {
    throw new TypeError("generateManagementToken: licenseKey required");
  }
  if (!ALLOWED_PURPOSES.includes(purpose)) {
    // Fixed safe error: do NOT echo attacker-controlled purpose text.
    throw new TypeError("generateManagementToken: invalid purpose");
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("generateManagementToken: now must be a finite number");
  }
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("generateManagementToken: ttlMs must be a positive finite number");
  }
  const cleanKey = licenseKey.trim();

  const lic = db.query(`SELECT key, email FROM licenses WHERE key = ?`).get(cleanKey);
  if (!lic) throw new TypeError("generateManagementToken: license not found");
  if (normalizeEmail(lic.email) !== normalizedEmail) {
    throw new TypeError("generateManagementToken: license does not belong to this email");
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = now + ttlMs;

  db.query(
    `INSERT INTO management_tokens (token_hash, email, license_key, purpose, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).run(tokenHash, normalizedEmail, cleanKey, purpose, expiresAt, now);

  const licenseTail = cleanKey.slice(-4);
  // EXACT return shape — keep in sync with recovery-core contract tests.
  // Sensitive identifiers (full licenseKey, email) are intentionally omitted.
  return {
    token,
    expiresAt,
    usedAt: null,
    purpose,
    licenseTail,
  };
}

/* ─────────────────────────── Inspection ─────────────────────────── */

/**
 * Inspect a token without consuming it. Returns a fixed safe shape:
 *   { valid:false, code:'invalid'|'expired'|'used', purpose:null,
 *     status:null, licenseTail:null, chromeOccupied:false, edgeOccupied:false }
 * or
 *   { valid:true, code:'ok', purpose, status, licenseTail,
 *     chromeOccupied, edgeOccupied }.
 *
 * NEVER returns: email, raw license key, instance id, token, hash, customer
 * id, subscription id.
 */
export function inspectManagementToken(db, { token, now = Date.now() }) {
  if (!db || typeof db.query !== "function") {
    throw new TypeError("inspectManagementToken: db required");
  }
  if (typeof token !== "string" || token.length === 0) {
    return invalidResult();
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("inspectManagementToken: now must be a finite number");
  }
  const tokenHash = hashToken(token);
  const row = db
    .query(
      `SELECT license_key, purpose, expires_at, used_at FROM management_tokens WHERE token_hash = ?`
    )
    .get(tokenHash);
  if (!row) return { valid: false, code: "invalid", purpose: null, status: null, licenseTail: null, chromeOccupied: false, edgeOccupied: false };
  if (row.used_at !== null && row.used_at !== undefined) {
    return { valid: false, code: "used", purpose: null, status: null, licenseTail: null, chromeOccupied: false, edgeOccupied: false };
  }
  if (typeof row.expires_at === "number" && row.expires_at <= now) {
    return { valid: false, code: "expired", purpose: null, status: null, licenseTail: null, chromeOccupied: false, edgeOccupied: false };
  }

  const lic = db.query(`SELECT status FROM licenses WHERE key = ?`).get(row.license_key);
  const status = lic ? lic.status : null;
  const chromeOccupied = !!db
    .query(`SELECT 1 FROM browser_slots WHERE license_key = ? AND browser_family = 'chrome'`)
    .get(row.license_key);
  const edgeOccupied = !!db
    .query(`SELECT 1 FROM browser_slots WHERE license_key = ? AND browser_family = 'edge'`)
    .get(row.license_key);
  return {
    valid: true,
    code: "ok",
    purpose: row.purpose,
    status,
    licenseTail: row.license_key.slice(-4),
    chromeOccupied,
    edgeOccupied,
  };
}

function invalidResult() {
  return {
    valid: false,
    code: "invalid",
    purpose: null,
    status: null,
    licenseTail: null,
    chromeOccupied: false,
    edgeOccupied: false,
  };
}

/* ─────────────────────────── Scope / reset ─────────────────────────── */

/** Map a token purpose to the row-set it can reset. */
const PURPOSE_TO_RESET_ALL = {
  reset_chrome: "chrome",
  reset_edge: "edge",
  reset_all: "all",
};

/**
 * Consume a reset token in one BEGIN IMMEDIATE transaction:
 *   - validate hash + expiry + unused;
 *   - validate the token's purpose supports the requested browserFamily;
 *   - mark used_at on the token;
 *   - delete only the selected license's authorized browser slot(s) via
 *     direct parameterized DELETE (no nested transaction).
 *
 * Returns the fixed safe shape { ok, code, removed }. Invalid / expired /
 * reused / scope-mismatch inputs cause ZERO mutation. Concurrent callers
 * have exactly one winner because BEGIN IMMEDIATE serializes the whole
 * check-then-mutate critical section.
 */
export function consumeResetToken(db, { token, browserFamily, now = Date.now() }) {
  if (!db || typeof db.query !== "function") {
    throw new TypeError("consumeResetToken: db required");
  }
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, code: "invalid", removed: 0 };
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("consumeResetToken: now must be a finite number");
  }
  if (browserFamily !== "chrome" && browserFamily !== "edge" && browserFamily !== "all") {
    return { ok: false, code: "family-undetermined", removed: 0 };
  }

  const tokenHash = hashToken(token);

  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .query(
        `SELECT license_key, purpose, expires_at, used_at FROM management_tokens WHERE token_hash = ?`
      )
      .get(tokenHash);
    if (!row) {
      db.exec("COMMIT");
      return { ok: false, code: "invalid", removed: 0 };
    }
    if (row.used_at !== null && row.used_at !== undefined) {
      db.exec("COMMIT");
      return { ok: false, code: "used", removed: 0 };
    }
    if (typeof row.expires_at === "number" && row.expires_at <= now) {
      db.exec("COMMIT");
      return { ok: false, code: "expired", removed: 0 };
    }
    const expected = PURPOSE_TO_RESET_ALL[row.purpose];
    if (!expected) {
      // 'recover' (or any non-reset purpose) CAN'T reset a browser slot.
      db.exec("COMMIT");
      return { ok: false, code: "scope-mismatch", removed: 0 };
    }
    if (expected !== browserFamily) {
      db.exec("COMMIT");
      return { ok: false, code: "scope-mismatch", removed: 0 };
    }

    // Mark the token used BEFORE the slot delete so a crash mid-delete leaves
    // the token spent (replay-resistant). The slot delete is a direct
    // parameterized statement — no helper, no nested transaction.
    const upd = db
      .query(`UPDATE management_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`)
      .run(now, tokenHash);
    if (upd.changes !== 1) {
      // Someone else consumed it between our SELECT and UPDATE — treat as
      // "used" and abort without touching slots.
      db.exec("COMMIT");
      return { ok: false, code: "used", removed: 0 };
    }

    let removed = 0;
    if (browserFamily === "all") {
      const r = db
        .query(`DELETE FROM browser_slots WHERE license_key = ?`)
        .run(row.license_key);
      removed = r.changes;
    } else {
      const r = db
        .query(
          `DELETE FROM browser_slots WHERE license_key = ? AND browser_family = ?`
        )
        .run(row.license_key, browserFamily);
      removed = r.changes;
    }
    if (removed === 0) {
      // Token was good but the slot simply didn't exist — no rows gone. We
      // still honor the consume (token is spent) so the caller gets a stable
      // contract: ok:false + code:not-found, and the token can't be replayed.
      db.exec("COMMIT");
      return { ok: false, code: "not-found", removed: 0 };
    }
    db.exec("COMMIT");
    return { ok: true, code: "ok", removed };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/* ─────────────────────────── seal / open (AES-256-GCM) ─────────────────────────── */

/**
 * Derive a 32-byte AES-256 key from the caller's secret. Rejects blank /
 * whitespace-only / non-string / too-short secrets. The key is derived only
 * inside the function — never persisted, never logged.
 */
function deriveKey(secret) {
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new TypeError("seal: secret must be a non-blank string");
  }
  if (secret.length < 16) {
    throw new TypeError("seal: secret must be at least 16 characters");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Seal a plaintext token with AES-256-GCM. Returns a JSON-safe string whose
 * only fields are ciphertext, nonce, and tag. Plaintext is never written to
 * the output.
 */
export function sealManagementToken(token, secret) {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("seal: token must be a non-empty string");
  }
  const key = deriveKey(secret);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    ciphertext: enc.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: tag.toString("base64"),
  });
}

/**
 * Open a sealed blob. Throws on any tampering, wrong secret, malformed
 * payload, or missing field. Error messages NEVER include the secret or the
 * plaintext token.
 */
export function openManagementToken(sealed, secret) {
  if (typeof sealed !== "string" || sealed.length === 0) {
    throw new TypeError("open: sealed must be a non-empty string");
  }
  const key = deriveKey(secret);
  let obj;
  try {
    obj = JSON.parse(sealed);
  } catch {
    throw new TypeError("open: malformed seal");
  }
  if (!obj || typeof obj !== "object") {
    throw new TypeError("open: malformed seal");
  }
  const { ciphertext, nonce, tag } = obj;
  if (typeof ciphertext !== "string" || typeof nonce !== "string" || typeof tag !== "string") {
    throw new TypeError("open: malformed seal");
  }
  let ct, iv, at;
  try {
    ct = Buffer.from(ciphertext, "base64");
    iv = Buffer.from(nonce, "base64");
    at = Buffer.from(tag, "base64");
  } catch {
    throw new TypeError("open: malformed seal");
  }
  if (iv.length !== NONCE_BYTES || at.length !== 16 || ct.length === 0) {
    throw new TypeError("open: malformed seal");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(at);
  let pt;
  try {
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new TypeError("open: authentication failed");
  }
  return pt.toString("utf8");
}

/* ─────────────────────────── Rate limit ─────────────────────────── */

/**
 * Consume one request against a fixed-window counter. Owns its own
 * BEGIN IMMEDIATE so concurrent callers serialize. At limit and beyond, the
 * stored count is BOUNDED at limit (never grows without bound). Returns the
 * fixed safe shape { allowed, remaining, retryAfterMs }.
 *
 * Strict validation (rejected before any mutation):
 *   - subjectKey: MUST already be the opaque HMAC-SHA256 hex produced by
 *     hashRequestSubject. This function performs NO internal rehash — the
 *     caller owns the secret, and the stored shape is the verified hash
 *     verbatim. Must be exactly 64 lowercase hex chars (no whitespace,
 *     no upper-case, no truncation). Anything else (raw subject, padded
 *     string, base64, etc.) is rejected BEFORE any DB write.
 *   - action: non-blank string.
 *   - now: finite number.
 *   - windowMs: positive integer (>= 1).
 *   - limit: positive integer (>= 1).
 *
 * The previous `secret` parameter and default have been removed: secrets
 * must not reach the storage layer at all. Routes call hashRequestSubject
 * with the secret first, then call consumeRequestLimit with the resulting
 * 64-char hex.
 */
export function consumeRequestLimit(
  db,
  { subjectKey, action, now, windowMs, limit }
) {
  if (!db || typeof db.query !== "function") {
    throw new TypeError("consumeRequestLimit: db required");
  }
  if (typeof subjectKey !== "string" || !/^[0-9a-f]{64}$/.test(subjectKey)) {
    // Fixed safe error: never include the (possibly raw) input.
    throw new TypeError(
      "consumeRequestLimit: subjectKey must be exactly 64 lowercase hex chars (hashRequestSubject output)"
    );
  }
  if (typeof action !== "string" || action.trim() === "") {
    throw new TypeError("consumeRequestLimit: action must be a non-empty string");
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("consumeRequestLimit: now must be a finite number");
  }
  if (typeof windowMs !== "number" || !Number.isInteger(windowMs) || windowMs <= 0) {
    throw new TypeError("consumeRequestLimit: windowMs must be a positive integer");
  }
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("consumeRequestLimit: limit must be a positive integer");
  }

  // subjectKey is already the opaque HMAC-SHA256 hex — store it as-is,
  // exactly the value the caller computed. No rehash, no transform.
  const storedSubjectKey = subjectKey;
  const windowStart = Math.floor(now / windowMs) * windowMs;

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .query(
        `SELECT count FROM request_limits
         WHERE subject_key = ? AND action = ? AND window_start = ?`
      )
      .get(storedSubjectKey, action, windowStart);
    const current = existing ? Number(existing.count) || 0 : 0;
    if (current >= limit) {
      db.exec("COMMIT");
      const retryAfterMs = Math.max(0, windowStart + windowMs - now);
      return { allowed: false, remaining: 0, retryAfterMs };
    }
    const next = current + 1;
    if (existing) {
      db.query(
        `UPDATE request_limits SET count = ? WHERE subject_key = ? AND action = ? AND window_start = ?`
      ).run(next, storedSubjectKey, action, windowStart);
    } else {
      db.query(
        `INSERT INTO request_limits (subject_key, action, window_start, count) VALUES (?, ?, ?, ?)`
      ).run(storedSubjectKey, action, windowStart, next);
    }
    db.exec("COMMIT");
    return { allowed: true, remaining: Math.max(0, limit - next), retryAfterMs: 0 };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/* ─────────────────────────── send-time expiry refresh ─────────────────────────── */

/**
 * Refresh a management token's expiry to `now + ttlMs` AT SEND TIME, so a
 * token that was queued but not yet issued can still be delivered. A token
 * is refreshed ONLY when its row exists AND it is still unused; this
 * helper must NEVER revive a used token (replay defense) and must NEVER
 * echo the hash, license key, email, or plaintext back to the caller.
 *
 * Strict input validation (rejected BEFORE any mutation):
 *   - db: must expose .query().
 *   - token: non-empty string.
 *   - now: finite number.
 *   - ttlMs: positive finite number (default DEFAULT_TOKEN_TTL_MS).
 *
 * Returns EXACTLY { refreshed, expiresAt } — never a hash, license key,
 * email, or the plaintext token. Used/missing rows return
 * { refreshed: false, expiresAt: null } and never throw.
 *
 * Parameterized SQL only. No logs.
 */
export function refreshManagementTokenExpiry(
  db,
  { token, now, ttlMs = DEFAULT_TOKEN_TTL_MS }
) {
  if (!db || typeof db.query !== "function") {
    throw new TypeError("refreshManagementTokenExpiry: db required");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("refreshManagementTokenExpiry: token required");
  }
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("refreshManagementTokenExpiry: now must be a finite number");
  }
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("refreshManagementTokenExpiry: ttlMs must be a positive finite number");
  }
  const tokenHash = hashToken(token);
  const newExpiresAt = now + ttlMs;
  const res = db
    .query(
      `UPDATE management_tokens SET expires_at = ? WHERE token_hash = ? AND used_at IS NULL`
    )
    .run(newExpiresAt, tokenHash);
  if (res.changes !== 1) {
    return { refreshed: false, expiresAt: null };
  }
  return { refreshed: true, expiresAt: newExpiresAt };
}
