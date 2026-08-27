// server/recovery-email.js — Slice 3B-1: encrypted recovery email payload
// hydration and safe message preparation.
// Slice 3B-1R: strict exact-map contracts, HTTPS base-URL safety, four
// link contract, atomic send-time token validation + expiry refresh.
//
// IMPORTS: only the accepted recovery primitives (seal/open + normalizeEmail
// from db.js). No timers, no network, no server, no DB opens, no logs.
// Module load is side-effect free.
//
// This module owns:
//   1. `createRecoveryOutboxPayload(...)` — mint-time shape: a JSON-safe
//      outbox payload whose only secret-bearing fields are AES-GCM-sealed
//      management tokens. No plaintext token, no secret, no recover link
//      ever lives in the durable outbox row.
//   2. `createRecoveryMessagePreparer(...)` — send-time hydration: opens
//      the seals, re-verifies every management token row still matches
//      (purpose + license + normalized email + unused) inside one
//      BEGIN IMMEDIATE transaction, refreshes the exact send-time +20m
//      expiry on every row immediately before provider dispatch, and
//      builds a provider-neutral message whose fragments carry the
//      plaintext tokens (never in query/path). Any mismatch, tampering,
//      missing row, used token, or wrong secret throws a fixed, redacted
//      preparation error that never echoes the token, key, email, or
//      secret. The transaction is all-or-nothing: a late failure on any
//      of the four rows rolls back every refresh.
import { sealManagementToken, openManagementToken, hashToken, DEFAULT_TOKEN_TTL_MS } from "./recovery.js";
import { normalizeEmail } from "./db.js";

/** Exact outbox-payload shape version. Bumping is a one-line change here. */
export const RECOVERY_OUTBOX_VERSION = 1;

/** Exact outbox kind string for the durable email_outbox.kind column. */
export const RECOVERY_OUTBOX_KIND = "recovery";

/**
 * The four purposes the recovery email must always carry. Exact-match with
 * ALLOWED_PURPOSES in recovery.js, but pinned here so the preparer can
 * enforce a complete set without re-importing internal arrays.
 */
const RECOVERY_TOKEN_PURPOSES = Object.freeze([
  "recover",
  "reset_chrome",
  "reset_edge",
  "reset_all",
]);

/**
 * Sorted canonical list of the required OWN keys of the tokens map.
 * Exact-match: every entry below must be an own enumerable string
 * property on the supplied tokens object, and no other own keys may
 * exist. Order is alphabetical for a stable error message.
 */
const REQUIRED_TOKEN_KEYS = Object.freeze(
  Object.freeze(RECOVERY_TOKEN_PURPOSES).slice().sort()
);

/**
 * Build the JSON-safe, durable outbox payload for a recovery email.
 *
 * Contract:
 *   - recipient is normalized (trim + lowercase).
 *   - licenseKey is required non-blank.
 *   - tokens MUST be an exact map whose OWN enumerable string keys are
 *     EXACTLY `[recover, reset_all, reset_chrome, reset_edge]` (sorted).
 *     Each value must be a non-empty string. Inherited, missing, or
 *     extra keys are all rejected with a fixed, redacted error that
 *     never echoes any caller-controlled field.
 *   - secret must be a non-blank string.
 *   - Each plaintext token is sealed with the accepted AES-GCM primitive;
 *     the resulting seal replaces the plaintext in the returned payload.
 *
 * Returned payload shape (JSON-safe — no functions, no Buffers):
 *   { kind: 'recovery', version: 1, recipient, licenseKey, tokens: {p: seal} }
 *
 * The serialized payload contains none of the four plaintext tokens, the
 * secret, or any precomputed recover/reset links. Links are built ONLY at
 * send time inside the preparer.
 */
export function createRecoveryOutboxPayload({ recipient, licenseKey, tokens, secret }) {
  if (typeof licenseKey !== "string" || licenseKey.trim() === "") {
    throw new TypeError("createRecoveryOutboxPayload: licenseKey required");
  }
  const normalizedRecipient = normalizeEmail(recipient);
  if (!normalizedRecipient) {
    throw new TypeError("createRecoveryOutboxPayload: recipient required");
  }
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new TypeError("createRecoveryOutboxPayload: secret required");
  }
  if (!tokens || typeof tokens !== "object") {
    throw new TypeError("createRecoveryOutboxPayload: invalid tokens map");
  }

  // Enforce the EXACT own-key contract. hasOwnProperty(...).call(tokens, key)
  // is the gate; Object.keys() excludes inherited keys but the actual
  // .recover / .reset_* reads still resolve to inherited values, so a
  // shape with inherited keys must still be rejected. We also reject any
  // own key that isn't in the required set.
  const ownKeys = Object.keys(tokens);
  if (ownKeys.length !== REQUIRED_TOKEN_KEYS.length) {
    throw new TypeError("createRecoveryOutboxPayload: invalid tokens map");
  }
  for (const k of REQUIRED_TOKEN_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(tokens, k)) {
      throw new TypeError("createRecoveryOutboxPayload: invalid tokens map");
    }
  }
  // After confirming the key count matches and every required key is own,
  // confirm no extra own keys exist (defense in depth — ownKeys.length check
  // already covers this, but the per-key loop above is the canonical guard).
  for (const k of ownKeys) {
    if (!REQUIRED_TOKEN_KEYS.includes(k)) {
      throw new TypeError("createRecoveryOutboxPayload: invalid tokens map");
    }
  }

  const sealed = {};
  for (const p of RECOVERY_TOKEN_PURPOSES) {
    const t = tokens[p];
    if (typeof t !== "string" || t.length === 0) {
      throw new TypeError("createRecoveryOutboxPayload: invalid tokens map");
    }
    sealed[p] = sealManagementToken(t, secret);
  }
  return {
    kind: RECOVERY_OUTBOX_KIND,
    version: RECOVERY_OUTBOX_VERSION,
    recipient: normalizedRecipient,
    licenseKey: licenseKey.trim(),
    tokens: sealed,
  };
}

/* ─────────────────────────── Send-time preparer ─────────────────────────── */

/** Fixed safe error name. Throws are the only way out of the preparer on any
 * mismatch — the message is intentionally constant, never includes the
 * plaintext, key, email, or secret. */
const PREP_ERROR = "recovery-preparation-failed";

/** Fixed safe error for an invalid HTTPS / localhost baseUrl. Never echoes
 * the caller-supplied URL (which may carry attacker-controlled bytes). */
const BASE_URL_ERROR =
  "createRecoveryMessagePreparer: baseUrl must be an https URL (http only permitted for localhost)";

/**
 * Build a fragment-only URL whose path is `${origin}/manage` (no family
 * suffix). Token and family travel ONLY in the fragment.
 *
 * The canonical manage target is the SINGLE `/manage` path. The browser
 * resolves the family from the fragment, not the path. This means we
 * never build `/manage/<family>` and never expose the family in the
 * server/CDN log path.
 */
function buildFragmentLink({ manageUrl, family, token }) {
  const frag = `#token=${encodeURIComponent(token)}&family=${encodeURIComponent(family)}`;
  return manageUrl + frag;
}

/** HTML escaper for safe insertion in element text and attribute values.
 * Escapes the full set of HTML-special characters. */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Validate baseUrl at constructor time. Production requires `https:`.
 * `http:` is permitted only for localhost / loopback development hosts
 * (`localhost`, `127.0.0.1`, `[::1]`). Credentials, query, and fragment
 * are NEVER allowed on the base. The error message is fixed and never
 * echoes the caller-supplied URL.
 *
 * On success returns the parsed URL object AND the canonical manage
 * target string `${origin}/manage` (origin = scheme + host + port). All
 * four recovery links point at this single canonical path.
 */
function validateBaseUrl(rawBaseUrl) {
  // Type guard first — no echo.
  if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim() === "") {
    throw new TypeError(BASE_URL_ERROR);
  }
  let parsed;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new TypeError(BASE_URL_ERROR);
  }
  // Reject any non-http(s) protocol (e.g. file:, data:, ftp:, javascript:,
  // and the protocol-relative `//host` form, which URL() rejects — already
  // caught above).
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(BASE_URL_ERROR);
  }
  // Reject credentials, query, and fragment on the BASE itself. Tokens are
  // only ever carried in the per-link fragment, never in the base.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError(BASE_URL_ERROR);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError(BASE_URL_ERROR);
  }
  // Production requires https. Loopback HTTP is the only allowed exception.
  if (parsed.protocol === "https:") {
    const origin = parsed.origin; // scheme + host + port, normalized
    return { url: parsed, manageUrl: `${origin}/manage` };
  }
  // http: — must be a loopback host.
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1";
  if (!isLoopback) {
    throw new TypeError(BASE_URL_ERROR);
  }
  const origin = parsed.origin;
  return { url: parsed, manageUrl: `${origin}/manage` };
}

/**
 * Create a send-time message preparer for `kind: 'recovery'` outbox rows.
 *
 * Inputs (all validated, no fallback to caller-supplied defaults):
 *   - db: a bun:sqlite Database (must expose .query()).
 *   - secret: non-blank string used to open the AES-GCM seals.
 *   - baseUrl: non-blank string (must be `https:` in production; `http:`
 *     is permitted ONLY for the loopback hosts `localhost`, `127.0.0.1`,
 *     `[::1]`. Credentials, query, and fragment are NEVER allowed on the
 *     base. The path of every generated link is exactly `${origin}/manage`.
 *   - now(): a function returning finite ms. Defaults to Date.now.
 *   - from / replyTo: optional override strings.
 *
 * Returns an async function accepting `{ row, payload }` that:
 *   - non-recovery rows: returns the payload unchanged (identity).
 *   - recovery rows: validates the payload shape + version + recipient + key
 *     + four seals; enforces the exact own-key contract on payload.tokens;
 *     opens every seal; runs ONE atomic BEGIN IMMEDIATE that validates every
 *     of the four management_tokens rows (purpose + license_key + normalized
 *     email + unused) and refreshes every expiry to exactly `now() + 20m`
 *     BEFORE provider dispatch. Any mismatch, tamper, used, missing, or
 *     wrong secret throws a fixed safe preparation error and the whole
 *     transaction is rolled back — no partial refresh is ever visible.
 *
 * The returned transient message is provider-neutral:
 *   { from, reply_to, to, subject, html }.
 *
 * The plaintext tokens appear ONLY in URL fragments (#token=...&family=...),
 * never in the query string or path, so they are NOT sent to HTTP/CDN logs.
 * HTML values are escaped.
 *
 * No logs. No mutates the input row or payload. The prepared message is
 * transient — the SQLite outbox row is never updated with the prepared
 * message bytes.
 */
export function createRecoveryMessagePreparer({
  db,
  secret,
  baseUrl,
  now = () => Date.now(),
  from = "Class Navi Pro Tools <licenses@send.nimira-timer.com>",
  replyTo = "support@nimira-timer.com",
} = {}) {
  if (!db || typeof db.query !== "function") {
    throw new TypeError("createRecoveryMessagePreparer: db required");
  }
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new TypeError("createRecoveryMessagePreparer: secret required");
  }
  // baseUrl validation: parse + enforce https (or http+loopback). Never
  // echo the caller-supplied string. Canonical manageUrl is captured here.
  const { manageUrl } = validateBaseUrl(baseUrl);
  if (typeof now !== "function") {
    throw new TypeError("createRecoveryMessagePreparer: now must be a function");
  }
  if (typeof from !== "string" || from.length === 0) {
    throw new TypeError("createRecoveryMessagePreparer: from required");
  }
  if (typeof replyTo !== "string" || replyTo.length === 0) {
    throw new TypeError("createRecoveryMessagePreparer: replyTo required");
  }

  async function prepare({ row, payload } = {}) {
    // Defensive: non-recovery rows return their payload unchanged. The email
    // worker treats the returned value as the message to send.
    if (!row || row.kind !== RECOVERY_OUTBOX_KIND) {
      return payload;
    }

    // Shape validation. Throws are fixed + redacted; never include the
    // key, email, or any token/plaintext.
    if (!payload || typeof payload !== "object") {
      throw new TypeError(PREP_ERROR);
    }
    if (payload.kind !== RECOVERY_OUTBOX_KIND) {
      throw new TypeError(PREP_ERROR);
    }
    if (payload.version !== RECOVERY_OUTBOX_VERSION) {
      throw new TypeError(PREP_ERROR);
    }
    if (typeof payload.licenseKey !== "string" || payload.licenseKey.trim() === "") {
      throw new TypeError(PREP_ERROR);
    }
    const payloadRecipient = normalizeEmail(payload.recipient);
    if (!payloadRecipient) {
      throw new TypeError(PREP_ERROR);
    }
    // Recipient must equal the row's normalized recipient.
    const rowRecipient = normalizeEmail(row.recipient_email);
    if (!rowRecipient || rowRecipient !== payloadRecipient) {
      throw new TypeError(PREP_ERROR);
    }
    if (!payload.tokens || typeof payload.tokens !== "object") {
      throw new TypeError(PREP_ERROR);
    }

    // Enforce the EXACT own-key contract on payload.tokens BEFORE opening
    // any seal. hasOwnProperty guards against inherited keys; the count +
    // membership checks guard against extras.
    const ownKeys = Object.keys(payload.tokens);
    if (ownKeys.length !== REQUIRED_TOKEN_KEYS.length) {
      throw new TypeError(PREP_ERROR);
    }
    for (const k of REQUIRED_TOKEN_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(payload.tokens, k)) {
        throw new TypeError(PREP_ERROR);
      }
    }
    for (const k of ownKeys) {
      if (!REQUIRED_TOKEN_KEYS.includes(k)) {
        throw new TypeError(PREP_ERROR);
      }
    }

    // Open every seal in memory. Any tamper / wrong secret fails closed.
    const opened = {};
    for (const p of RECOVERY_TOKEN_PURPOSES) {
      const seal = payload.tokens[p];
      if (typeof seal !== "string" || seal.length === 0) {
        throw new TypeError(PREP_ERROR);
      }
      let pt;
      try {
        pt = openManagementToken(seal, secret);
      } catch {
        throw new TypeError(PREP_ERROR);
      }
      if (typeof pt !== "string" || pt.length === 0) {
        throw new TypeError(PREP_ERROR);
      }
      opened[p] = pt;
    }

    // Compute send-time ONCE before entering the transaction. Finite check
    // before any DB work.
    const sendAt = now();
    if (typeof sendAt !== "number" || !Number.isFinite(sendAt)) {
      throw new TypeError(PREP_ERROR);
    }
    const newExpiresAt = sendAt + DEFAULT_TOKEN_TTL_MS;

    // Atomic send-time validation + refresh. ONE BEGIN IMMEDIATE transaction
    // that:
    //   - validates all four rows (presence + purpose + license + email +
    //     unused) inside the same transaction snapshot;
    //   - refreshes all four expiries inside the same transaction;
    //   - COMMITs only when every check + every update succeeded.
    // Any failure (missing row, used row, mismatch, DB error) -> ROLLBACK
    // and a single fixed PREP_ERROR. No partial refresh is ever visible.
    let transactionStarted = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      for (const p of RECOVERY_TOKEN_PURPOSES) {
        const tok = opened[p];
        const tokenHash = hashToken(tok);
        const rowT = db
          .query(
            `SELECT license_key, email, purpose, expires_at, used_at FROM management_tokens WHERE token_hash = ?`
          )
          .get(tokenHash);
        if (!rowT) throw new TypeError(PREP_ERROR);
        if (rowT.used_at !== null && rowT.used_at !== undefined) {
          throw new TypeError(PREP_ERROR);
        }
        if (rowT.purpose !== p) throw new TypeError(PREP_ERROR);
        if (rowT.license_key !== payload.licenseKey) throw new TypeError(PREP_ERROR);
        const normEmail = normalizeEmail(rowT.email);
        if (normEmail !== payloadRecipient) throw new TypeError(PREP_ERROR);
      }
      // Every row validated. Now refresh every expiry atomically. Direct
      // parameterized UPDATE — no helper, no nested transaction. The
      // WHERE clause includes `used_at IS NULL` for replay defense in
      // depth (mirrors the accepted helper's contract).
      for (const p of RECOVERY_TOKEN_PURPOSES) {
        const tok = opened[p];
        const tokenHash = hashToken(tok);
        const upd = db
          .query(
            `UPDATE management_tokens SET expires_at = ? WHERE token_hash = ? AND used_at IS NULL`
          )
          .run(newExpiresAt, tokenHash);
        if (upd.changes !== 1) {
          // Row vanished or was spent between the read and the refresh.
          throw new TypeError(PREP_ERROR);
        }
      }
      db.exec("COMMIT");
      transactionStarted = false;
    } catch {
      if (transactionStarted) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
      }
      throw new TypeError(PREP_ERROR);
    }

    // Build provider-neutral message. Plaintext tokens appear ONLY in URL
    // fragments (#token=...&family=...) so they are not transmitted to the
    // server / Cloudflare logs. Every link targets the SINGLE canonical
    // `${origin}/manage` path; the family comes from the fragment only.
    // Exactly FOUR links total: one combined view-and-installations link
    // (using the recover token + family) plus the three reset links.
    const links = {
      view: buildFragmentLink({ manageUrl, family: "recover", token: opened.recover }),
      reset_chrome: buildFragmentLink({ manageUrl, family: "reset_chrome", token: opened.reset_chrome }),
      reset_edge: buildFragmentLink({ manageUrl, family: "reset_edge", token: opened.reset_edge }),
      reset_all: buildFragmentLink({ manageUrl, family: "reset_all", token: opened.reset_all }),
    };
    const keyHtml = esc(payload.licenseKey);
    const html = `<p>Use the link below to view your license and recovery options.</p>
<p>Your license key is:</p>
<p style="font-size:18px;font-weight:bold;">${keyHtml}</p>
<p><a href="${esc(links.view)}">View license and installations</a></p>
<p><a href="${esc(links.reset_chrome)}">Reset Chrome activation</a></p>
<p><a href="${esc(links.reset_edge)}">Reset Edge activation</a></p>
<p><a href="${esc(links.reset_all)}">Reset all browser activations</a></p>
<p>If you did not request this, you can ignore this message.</p>`;

    return {
      from,
      reply_to: replyTo,
      to: payloadRecipient,
      subject: "Your Class Navi Pro Tools license recovery options",
      html,
    };
  }

  return prepare;
}