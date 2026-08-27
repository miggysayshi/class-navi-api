// server/invite-http.js — Slice 5B-1 FAMILY INVITE HTTP SERVICE.
//
// IMPORT-SAFE: only the accepted Slice 5A core (invites.js), the accepted
// recovery rate/hash primitives (recovery.js), the accepted auth helper
// (auth.js), the db normalizeEmail helper, and node:crypto. NO server, NO
// timer, NO network, NO DB OPEN, NO module-load logs. Module load is
// side-effect free.
//
// This module owns the import-safe HTTP surface for the family-invite flow:
//   1) `redeemInviteRequest(req,{clientIp})` — POST /api/invites/redeem.
//      ALWAYS answers the EXACT neutral 202 envelope
//        { message: "If this invite is valid, we sent your license by email." }
//      for success, malformed, invalid, missing, expired, already-used,
//      revoked, AND rate-limited requests — so the public surface discloses
//      no membership/code-validity information. Per-IP and per-canonical-code
//      HMAC fixed-window limits run BEFORE any core work; only 64-hex subjects
//      are stored. A rate/hash/core error fails CLOSED with a fixed safe 500
//      and a fixed log line. Every normal 202 path returns through ONE
//      minimum-response-floor helper anchored before the rate/core logic, so
//      code-validity timing is masked. Config cannot be affected by requests.
//   2) bearer-authenticated admin: `mintInvites(req,{clientIp})` returns the
//      plaintext codes to the authenticated admin EXACTLY once (the DB only
//      ever stores hashes); `revokeFamily(req,{clientIp})` revokes one
//      active family_free seat. Authorization is `Bearer <token>` ONLY — the
//      admin IP rate bucket is consumed (HMAC with the admin token) BEFORE
//      the constant-time comparison, including invalid attempts. Body/query
//      tokens are never accepted. Tokens/IPs are never logged.
//   3) `invitePageResponse()` — Class Navi Pro Tools public redemption form.
//      Per-response CSP nonce matches the inline script (no unsafe-inline),
//      X-Frame-Options DENY, no-store/no-referrer/nosniff. The form JS POSTs
//      JSON to /api/invites/redeem, ALWAYS renders the neutral message via
//      textContent, clears both inputs AFTER building the body, and uses no
//      local/session storage, cookies, innerHTML, or auto-activation.
//
// The module exports one factory:
//   `createInviteHttpService({db, adminToken, rateSecret, now,
//     monotonicNow, sleepFn, minimumResponseMs, windowMs, inviteIpLimit,
//     inviteCodeLimit, adminIpLimit, logger})`
// returning EXACTLY `{configured, redeemInviteRequest, mintInvites,
// revokeFamily, invitePageResponse}`.
//
// Public redemption is configured iff rateSecret is a string >=16 nonblank
// chars; admin actions are configured iff adminToken is a string >=16
// nonblank chars. Missing/short config leaves the public 202 envelope and
// the admin actions returning fixed safe 503s that disclose no values; the
// public page stays available.
import { randomBytes } from "node:crypto";
import {
  redeemInvite,
  mintInviteCodes,
  revokeFamilyLicense,
  canonicalizeInviteCode,
  INVITE_CODE_RE,
} from "./invites.js";
import { normalizeEmail } from "./db.js";
import { hashRequestSubject, consumeRequestLimit } from "./recovery.js";
import { safeSecretEqual } from "./auth.js";

/* ───────────────────────────────── Constants ────────────────────────────── */

/** Max accepted request body in bytes (16 KiB). Larger → fixed 413. */
const MAX_BODY_BYTES = 16 * 1024;

/** Standard fixed-window length (15 minutes). */
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

/** Default public per-IP redeem attempts per window. */
const DEFAULT_INVITE_IP_LIMIT = 20;

/** Default public per-canonical-code redeem attempts per window. */
const DEFAULT_INVITE_CODE_LIMIT = 5;

/** Default admin per-IP attempts per window (auth attempts included). */
const DEFAULT_ADMIN_IP_LIMIT = 20;

/** Minimum secret/token length for a flow to be configured. */
const MIN_SECRET_LENGTH = 16;

/** Fixed safe response bodies — NEVER include PII/secrets/codes/keys. */
const SAFE_NOT_CONFIGURED = { error: "invite service not configured" };
const SAFE_METHOD_NOT_ALLOWED = { error: "method not allowed" };
const SAFE_BODY_TOO_LARGE = { error: "request body too large" };
const SAFE_UNAUTHORIZED = { error: "unauthorized" };
const SAFE_LIMITED = { error: "rate limit exceeded" };
const SAFE_INVALID_INPUT = { error: "invalid invite request" };
const SAFE_PUBLIC_FAILED = { error: "invite request failed" };
const SAFE_ADMIN_AUTH_FAILED = { error: "invite admin auth failed" };
const SAFE_MINT_FAILED = { error: "invite mint failed" };
const SAFE_REVOKE_FAILED = { error: "invite revoke failed" };

/** Fixed log lines — NEVER include input/error details. */
const LOG_PUBLIC_FAILED = "[invite] request failed";
const LOG_ADMIN_AUTH_FAILED = "[invite-admin] auth failed";
const LOG_MINT_FAILED = "[invite-admin] mint failed";
const LOG_REVOKE_FAILED = "[invite-admin] revoke failed";

/** Rate-limit action names (named, never user-controlled). */
const ACTION_INVITE_IP = "invite_ip";
const ACTION_INVITE_CODE = "invite_code";
const ACTION_ADMIN_IP = "invite_admin_ip";

/** Fixed placeholder for a blank clientIp — all IP-less requests share one
 * rate-limit cell, so "missing" never leaks meaningfully. */
const UNKNOWN_SUBJECT = "unknown";

/** The fixed invariant 202 envelope for the public redeem endpoint. */
const ALWAYS_202 = Object.freeze({
  message: "If this invite is valid, we sent your license by email.",
});

/* ────────────────────────────── Page builder ───────────────────────────── */

/**
 * Build the Class Navi Pro Tools public redemption form. The inline `<script>`
 * carries the SAME nonce that invitePageResponse puts into the CSP. The
 * script:
 *   1) reads code + email from the two inputs,
 *   2) builds the JSON body,
 *   3) IMMEDIATELY clears both inputs (no key/code/email lingers in the DOM),
 *   4) POSTs that body to /api/invites/redeem,
 *   5) ALWAYS renders the neutral message via textContent — whether the
 *      response succeeded, failed, or never arrived.
 * No localStorage / sessionStorage / cookies / innerHTML / auto-submit.
 */
function buildInvitePageHTML(nonce) {
  const script = `
(function () {
  var form = document.getElementById("invite-form");
  var status = document.getElementById("invite-status");
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var codeInput = document.getElementById("code");
    var emailInput = document.getElementById("email");
    var code = (codeInput && codeInput.value) ? String(codeInput.value) : "";
    var email = (emailInput && emailInput.value) ? String(emailInput.value) : "";
    var payload = JSON.stringify({ code: code, email: email });
    // Clear code + email after the body is built.
    if (codeInput) { codeInput.value = ""; }
    if (emailInput) { emailInput.value = ""; }
    fetch("/api/invites/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      credentials: "same-origin"
    }).then(function (res) { return res.json().catch(function () { return {}; }); })
      .then(function () {
        var msg = "If this invite is valid, we sent your license by email.";
        status.textContent = msg;
      }).catch(function () {
        status.textContent = "If this invite is valid, we sent your license by email.";
      });
  });
})();
`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Class Navi Pro Tools — Redeem your invitation</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>
<h1>Class Navi Pro Tools — Redeem your invitation</h1>
<p>Enter your invitation code and email to activate your free family license.</p>
<form id="invite-form" action="/api/invites/redeem" method="post" enctype="application/json">
<label for="code">Invitation code</label>
<input id="code" name="code" type="text" autocomplete="off" required>
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required>
<button type="submit">Redeem invitation</button>
</form>
<p id="invite-status" role="status" aria-live="polite"></p>
</body>
<script nonce="${nonce}">${script}</script>
</html>`;
}

/* ───────────────────────────── HTTP helpers ───────────────────────────── */

/** Make a JSON Response with the fixed safe header set. */
function jsonResponse(status, body, extraHeaders) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...(extraHeaders || {}),
  };
  return new Response(JSON.stringify(body), { status, headers });
}

/** Make an HTML Response with the fixed safe header set + CSP. */
function htmlResponse(status, html, extraHeaders, csp) {
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "content-security-policy": csp,
    ...(extraHeaders || {}),
  };
  return new Response(html, { status, headers });
}

/**
 * Bounded body reader. Returns { ok:true, text } within the limit, else
 * { ok:false }. The Content-Length header (if numeric) is pre-checked; an
 * inflated value is treated as too-large so we never read a huge stream.
 */
async function readBoundedBody(req, maxBytes) {
  const cl = req.headers.get("content-length");
  if (typeof cl === "string" && cl.length > 0) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) return { ok: false };
  }
  const text = await req.text();
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) return { ok: false };
  return { ok: true, text };
}

/** JSON-parse body text; returns null on parse error or non-objects (arrays
 * and primitives are rejected — JSON objects only). */
function parseJsonBody(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  return obj;
}

/** Trim a raw clientIp; blank/whitespace-only maps to the shared unknown
 * bucket (the same behavior for public redeem and admin auth). */
function ipSubjectOrUnknown(rawIp) {
  const v = typeof rawIp === "string" ? rawIp.trim() : "";
  return v.length > 0 ? v : UNKNOWN_SUBJECT;
}

/** The fixed invariant 202 response (no-store, no body revealed). */
function always202() {
  return jsonResponse(202, ALWAYS_202);
}

/** One random per-response CSP nonce (URL-safe base64 of 16 bytes). */
function makeNonce() {
  return randomBytes(16).toString("base64url");
}

/** Extract the bearer token from an Authorization header. Accepts ONLY the
 * exact `Bearer <token>` form (a single token, no extra whitespace words). */
function extractBearerToken(header) {
  if (typeof header !== "string") return "";
  const m = header.match(/^Bearer\s+(\S+)$/);
  return m ? m[1] : "";
}

/* ───────────────────────────── Core factory ────────────────────────────── */

/**
 * Build the import-safe family invite HTTP service. The factory opens no
 * DB/server/timer and logs nothing; it only validates its own config and
 * closes over the caller-supplied db handle.
 */
export function createInviteHttpService({
  db,
  adminToken,
  rateSecret,
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  minimumResponseMs = 350,
  windowMs = DEFAULT_WINDOW_MS,
  inviteIpLimit = DEFAULT_INVITE_IP_LIMIT,
  inviteCodeLimit = DEFAULT_INVITE_CODE_LIMIT,
  adminIpLimit = DEFAULT_ADMIN_IP_LIMIT,
  logger = console,
} = {}) {
  // ── configuration validation ───────────────────────────────────────────
  if (!db || typeof db.query !== "function") {
    throw new TypeError("createInviteHttpService: db required");
  }
  if (typeof now !== "function") {
    throw new TypeError("createInviteHttpService: now must be a function");
  }
  if (typeof monotonicNow !== "function") {
    throw new TypeError("createInviteHttpService: monotonicNow must be a function");
  }
  if (typeof sleepFn !== "function") {
    throw new TypeError("createInviteHttpService: sleepFn must be a function");
  }
  if (!logger || typeof logger !== "object") {
    throw new TypeError("createInviteHttpService: logger required");
  }
  if (typeof windowMs !== "number" || !Number.isInteger(windowMs) || windowMs <= 0) {
    throw new TypeError("createInviteHttpService: windowMs must be a positive integer");
  }
  if (
    typeof inviteIpLimit !== "number" ||
    !Number.isInteger(inviteIpLimit) ||
    inviteIpLimit <= 0
  ) {
    throw new TypeError("createInviteHttpService: inviteIpLimit must be a positive integer");
  }
  if (
    typeof inviteCodeLimit !== "number" ||
    !Number.isInteger(inviteCodeLimit) ||
    inviteCodeLimit <= 0
  ) {
    throw new TypeError("createInviteHttpService: inviteCodeLimit must be a positive integer");
  }
  if (
    typeof adminIpLimit !== "number" ||
    !Number.isInteger(adminIpLimit) ||
    adminIpLimit <= 0
  ) {
    throw new TypeError("createInviteHttpService: adminIpLimit must be a positive integer");
  }
  // The fixed minimum neutral-response floor is CONFIG-only: requests can
  // never select or override it. 0 is legal (tests / fast integration mode).
  if (
    typeof minimumResponseMs !== "number" ||
    !Number.isInteger(minimumResponseMs) ||
    minimumResponseMs < 0
  ) {
    throw new TypeError(
      "createInviteHttpService: minimumResponseMs must be a non-negative integer"
    );
  }

  // Independent sub-configuration. Each flow is gated by its own secret so
  // one missing secret never disables the other flow that IS configured.
  const publicConfigured =
    typeof rateSecret === "string" && rateSecret.trim().length >= MIN_SECRET_LENGTH;
  const adminConfigured =
    typeof adminToken === "string" && adminToken.trim().length >= MIN_SECRET_LENGTH;
  const configured = publicConfigured && adminConfigured;
  const safeRateSecret = publicConfigured ? rateSecret : "";
  const safeAdminToken = adminConfigured ? adminToken : "";

  /** Fixed log helper — only ever emits the fixed line, never the error. */
  function logFixed(message) {
    try {
      if (logger && typeof logger.warn === "function") logger.warn(message);
    } catch {
      /* logger failure is non-fatal */
    }
  }

  /**
   * The ONE minimum-response-floor helper shared by every normal neutral 202
   * path. `start` is the monotonic timestamp recorded AFTER the
   * configured/method/body guards and BEFORE any rate/core logic, so every
   * redeem outcome (success, malformed, invalid, expired, used, revoked,
   * rate-limited) answers with the same wall-clock padding. Fixed 500/503/
   * 405/413 paths intentionally bypass it.
   */
  async function neutral202(start) {
    const elapsed = monotonicNow() - start;
    const remaining = minimumResponseMs - elapsed;
    if (remaining > 0) {
      await sleepFn(remaining);
    }
    return always202();
  }

  /** Read a caller-supplied clientIp (or blank); blank → unknown bucket. */
  function callerIp(opts) {
    return opts && typeof opts === "object" && typeof opts.clientIp === "string"
      ? opts.clientIp
      : "";
  }

  /** Consume one fixed-window rate bucket. Returns a Response (failure) or
   * null (allowed). Fails closed: a hash/SQL throw yields a fixed 500. */
  function consumeBucket({ subject, action, secret, limit, logLine }) {
    let subjectKey;
    try {
      subjectKey = hashRequestSubject(subject, secret);
    } catch {
      logFixed(logLine);
      return jsonResponse(500, SAFE_PUBLIC_FAILED);
    }
    try {
      const res = consumeRequestLimit(db, {
        subjectKey,
        action,
        now: now(),
        windowMs,
        limit,
      });
      if (res && res.allowed === false) {
        return null; // caller chooses the invariant 202 (public) or 429 (admin)
      }
      return null;
    } catch {
      logFixed(logLine);
      return jsonResponse(500, SAFE_PUBLIC_FAILED);
    }
  }

  /**
   * Bearer-only admin authentication, internal to the service. Returns a
   * Response on failure (503/500/429/403) or null when authenticated. The
   * admin IP bucket is consumed (HMAC with the admin token) BEFORE the
   * constant-time comparison, on EVERY attempt including missing/malformed/
   * invalid credentials, so failed guesses and valid calls share one bucket.
   * Tokens/IPs/bearers are never logged; the body/query are never inspected.
   */
  async function authenticateAdmin(req, clientIp) {
    const ipValue = typeof clientIp === "string" ? clientIp : "";
    const subjectKey = hashRequestSubject(ipSubjectOrUnknown(ipValue), safeAdminToken);
    try {
      const res = consumeRequestLimit(db, {
        subjectKey,
        action: ACTION_ADMIN_IP,
        now: now(),
        windowMs,
        limit: adminIpLimit,
      });
      if (res && res.allowed === false) {
        // Nothing (not even comparison) runs once the bucket is exhausted.
        return jsonResponse(429, SAFE_LIMITED);
      }
    } catch {
      logFixed(LOG_ADMIN_AUTH_FAILED);
      return jsonResponse(500, SAFE_ADMIN_AUTH_FAILED);
    }
    const header = req && typeof req.headers.get === "function" ? req.headers.get("authorization") : "";
    const token = extractBearerToken(header);
    if (!token || !safeSecretEqual(token, safeAdminToken)) {
      return jsonResponse(403, SAFE_UNAUTHORIZED);
    }
    return null;
  }

  // ── Public redeem ──────────────────────────────────────────────────────
  async function redeemInviteRequest(req, opts) {
    if (!publicConfigured) return jsonResponse(503, SAFE_NOT_CONFIGURED);
    if (!req || req.method !== "POST") return jsonResponse(405, SAFE_METHOD_NOT_ALLOWED);
    const body = await readBoundedBody(req, MAX_BODY_BYTES);
    if (!body.ok) return jsonResponse(413, SAFE_BODY_TOO_LARGE);
    const json = parseJsonBody(body.text);
    const clientIp = callerIp(opts);

    // Floor anchor: measured AFTER guards, BEFORE rate/core logic.
    const start = monotonicNow();

    // ── HMAC fixed-window limits BEFORE any core work. Both buckets are
    // consumed on validly-framed requests (the code bucket only when a
    // non-blank canonical code-like input is present) and both fail closed.
    // Per-IP (blank → unknown bucket).
    let ipSubjectKey;
    try {
      ipSubjectKey = hashRequestSubject(ipSubjectOrUnknown(clientIp), safeRateSecret);
    } catch {
      logFixed(LOG_PUBLIC_FAILED);
      return jsonResponse(500, SAFE_PUBLIC_FAILED);
    }
    try {
      const ipRes = consumeRequestLimit(db, {
        subjectKey: ipSubjectKey,
        action: ACTION_INVITE_IP,
        now: now(),
        windowMs,
        limit: inviteIpLimit,
      });
      if (ipRes && ipRes.allowed === false) return neutral202(start);
    } catch {
      logFixed(LOG_PUBLIC_FAILED);
      return jsonResponse(500, SAFE_PUBLIC_FAILED);
    }

    // Per canonical code-like input.
    const canonical =
      json && typeof json.code === "string" ? canonicalizeInviteCode(json.code) : "";
    if (canonical.length > 0) {
      let codeSubjectKey;
      try {
        codeSubjectKey = hashRequestSubject(canonical, safeRateSecret);
      } catch {
        logFixed(LOG_PUBLIC_FAILED);
        return jsonResponse(500, SAFE_PUBLIC_FAILED);
      }
      try {
        const codeRes = consumeRequestLimit(db, {
          subjectKey: codeSubjectKey,
          action: ACTION_INVITE_CODE,
          now: now(),
          windowMs,
          limit: inviteCodeLimit,
        });
        if (codeRes && codeRes.allowed === false) return neutral202(start);
      } catch {
        logFixed(LOG_PUBLIC_FAILED);
        return jsonResponse(500, SAFE_PUBLIC_FAILED);
      }
    }

    // Core redeem runs ONLY for a normalized email + exact invite-code shape.
    // redeemInvite itself re-checks email shape; invalid inputs return the
    // neutral core shape with ZERO writes, never throwing on user input.
    const normalized = normalizeEmail(json && json.email);
    if (normalized && INVITE_CODE_RE.test(canonical)) {
      try {
        redeemInvite(db, { code: canonical, email: normalized, now: now() });
      } catch {
        // Defensive, fail closed: fixed log, fixed 500, everything rolled back.
        logFixed(LOG_PUBLIC_FAILED);
        return jsonResponse(500, SAFE_PUBLIC_FAILED);
      }
    }
    return neutral202(start);
  }

  // ── Admin: mint ────────────────────────────────────────────────────────
  async function mintInvites(req, opts) {
    if (!adminConfigured) return jsonResponse(503, SAFE_NOT_CONFIGURED);
    if (!req || req.method !== "POST") return jsonResponse(405, SAFE_METHOD_NOT_ALLOWED);
    const clientIp = callerIp(opts);
    const authFail = await authenticateAdmin(req, clientIp);
    if (authFail) return authFail;
    const body = await readBoundedBody(req, MAX_BODY_BYTES);
    if (!body.ok) return jsonResponse(413, SAFE_BODY_TOO_LARGE);
    const json = parseJsonBody(body.text);
    const label = json && typeof json.label === "string" ? json.label : "";
    const count = json ? json.count : undefined;
    const expiresAt = json ? json.expires_at : undefined;
    try {
      // Validate via the accepted core (TypeError = invalid input).
      const result = mintInviteCodes(db, { label, count, expiresAt, now: now() });
      return jsonResponse(200, {
        count: result.count,
        expiresAt: result.expiresAt,
        codes: result.codes,
      });
    } catch (err) {
      if (err instanceof TypeError) {
        // Fixed safe 400 — invalid input, no codes, no error details.
        return jsonResponse(400, SAFE_INVALID_INPUT);
      }
      logFixed(LOG_MINT_FAILED);
      return jsonResponse(500, SAFE_MINT_FAILED);
    }
  }

  // ── Admin: revoke ──────────────────────────────────────────────────────
  async function revokeFamily(req, opts) {
    if (!adminConfigured) return jsonResponse(503, SAFE_NOT_CONFIGURED);
    if (!req || req.method !== "POST") return jsonResponse(405, SAFE_METHOD_NOT_ALLOWED);
    const clientIp = callerIp(opts);
    const authFail = await authenticateAdmin(req, clientIp);
    if (authFail) return authFail;
    const body = await readBoundedBody(req, MAX_BODY_BYTES);
    if (!body.ok) return jsonResponse(413, SAFE_BODY_TOO_LARGE);
    const json = parseJsonBody(body.text);
    const licenseKey = json && typeof json.license_key === "string" ? json.license_key : "";
    if (!String(licenseKey || "").trim()) {
      // Fixed 400 with the same safe core failure shape.
      return jsonResponse(400, { revoked: false, code: "not-found", licenseTail: null });
    }
    try {
      const result = revokeFamilyLicense(db, { licenseKey, now: now() });
      if (result && result.revoked) {
        return jsonResponse(200, result);
      }
      // NotFound for non-family / unknown / already-revoked — safe shape.
      return jsonResponse(404, result || { revoked: false, code: "not-found", licenseTail: null });
    } catch {
      logFixed(LOG_REVOKE_FAILED);
      return jsonResponse(500, SAFE_REVOKE_FAILED);
    }
  }

  // ── Public page ────────────────────────────────────────────────────────
  async function invitePageResponse() {
    // ONE random nonce per response, shared by the inline <script> and the
    // CSP. script-src forbids 'unsafe-inline'; the nonce is the only allowed
    // inline script. frame-ancestors 'none' + X-Frame-Options DENY.
    const nonce = makeNonce();
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    return htmlResponse(200, buildInvitePageHTML(nonce), null, csp);
  }

  return {
    configured,
    redeemInviteRequest,
    mintInvites,
    revokeFamily,
    invitePageResponse,
  };
}
