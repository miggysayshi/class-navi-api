// server/recovery-http.js — Slice 3B-2A secure recovery HTTP core.
//
// IMPORTS: only the accepted Slice 3A primitives (recovery.js) and the
// accepted Slice 3B-1 preparer/payload (recovery-email.js) plus licensesFor-
// Email / enqueueEmail from db.js. NO server, NO timer, NO network, NO DB
// OPEN, NO module-load logs. Module load is side-effect free.
//
// This module owns the import-safe HTTP surface for the recovery flow:
//   1) `requestRecovery` — POST /api/recovery/request → EXACT 202 envelope,
//      HMAC rate-limited, atomic per-license token minting + sealed outbox
//      enqueue, idempotent roll-back on any failure. Rate-limit is enforced
//      (allowed=false short-circuits the request with no token/outbox work)
//      and rate-limit errors fail closed (no enqueue at all).
//   2) `inspectToken`   — POST /api/manage/inspect → safe fixed shape only.
//   3) `resetToken`     — POST /api/manage/reset → safe fixed shape only.
//   4) `portalResponse` — GET  /portal → branded Class Navi Pro Tools
//      neutral recovery form. POSTs JSON to /api/recovery/request.
//   5) `manageResponse` — GET  /manage → fragment-only management page. JS
//      reads token+family from URL fragment, immediately strips the fragment
//      via history.replaceState BEFORE any fetch, never stores the token in
//      DOM/localStorage/sessionStorage/cookie, posts the token body to
//      /api/manage/inspect, shows the confirm button only when the family
//      matches the inspected purpose.
//
// The module exports one factory:
//   `createRecoveryHttpService({db, secret, baseUrl, now, randomId,
//                               logger, emailLimit, ipLimit, windowMs})`
// returning exactly:
//   `{ configured, requestRecovery, inspectToken, resetToken,
//      portalResponse, manageResponse }`.
//
// Missing / blank / too-short secret → configured=false; the POST handlers
// return a fixed safe 503, the GET pages stay available and disclose NO
// config values. Required secret length is 16 characters (matches the sealing
// contract in recovery.js).

import {
  generateManagementToken,
  inspectManagementToken,
  consumeResetToken,
  hashRequestSubject,
  consumeRequestLimit,
  normalizeEmail,
  hashToken,
} from "./recovery.js";
import { createRecoveryOutboxPayload, RECOVERY_OUTBOX_KIND } from "./recovery-email.js";
import { licensesForEmail, enqueueEmail } from "./db.js";
import { randomBytes, createHmac } from "node:crypto";

/* ───────────────────────────────── Constants ────────────────────────────── */

/** Max accepted request body in bytes. Anything larger is rejected without
 * mutation (no row created, no outbox, no limit consumed). 16 KiB. */
const MAX_BODY_BYTES = 16 * 1024;

/** Standard fixed-window length (15 minutes). */
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

/** Default per-email attempts per window. */
const DEFAULT_EMAIL_LIMIT = 3;

/** Default per-IP attempts per window. */
const DEFAULT_IP_LIMIT = 10;

/** Minimum MANAGEMENT secret length to match the sealing contract. */
const MIN_SECRET_LENGTH = 16;

/** Fixed safe message bodies. NEVER include PII/secret/key/token. */
const SAFE_NOT_CONFIGURED = { error: "recovery not configured" };
const SAFE_BODY_TOO_LARGE = { error: "request body too large" };
const SAFE_REQUEST_FAILED = { error: "recovery request failed" };
const SAFE_METHOD_NOT_ALLOWED = { error: "method not allowed" };
const SAFE_LOG_REQUEST_FAILED = "[recovery] request failed";

/** Rate-limit action names (named, not user-controlled). */
const ACTION_EMAIL = "recovery_email";
const ACTION_IP = "recovery_ip";

/** Fixed placeholder for a blank clientIp — hashed into the same bucket so
 * missing IPs share one rate-limit cell without leaking 'missing' semantics. */
const UNKNOWN_IP_SUBJECT = "unknown";

/** Safe "always 202" body — used for existing, unknown, malformed, AND
 * rate-limited requests so the response shape is invariant. */
const ALWAYS_202 = Object.freeze({
  message: "If a matching purchase exists, we sent an email.",
});

/** Bounded hex prefix length for the opaque idempotency subject. Long enough
 * to make accidental collisions with another randomId trivial to avoid while
 * staying far below the typical SQLite VARCHAR ceiling. Must be even and >=32. */
const OPAQUE_PREFIX_HEX_LEN = 32;

/* ───────────────────────────── Page builders ───────────────────────────── */

/**
 * Build the Class Navi Pro Tools recovery form. POSTs JSON to
 * /api/recovery/request; renders the neutral message via textContent into an
 * initially-empty element. No query-email workflow. No `/api/portal/keys`.
 *
 * The inline `<script>` must carry the SAME nonce that portalResponse
 * generates and propagates into the CSP. The script is intentionally tiny
 * so the nonce stays meaningful and the CSP can omit 'unsafe-inline'.
 */
function buildPortalHTML(nonce) {
  const script = `
(function () {
  var form = document.getElementById("recovery-form");
  var status = document.getElementById("recovery-status");
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var input = document.getElementById("email");
    var value = (input && input.value) ? String(input.value) : "";
    var payload = JSON.stringify({ email: value });
    fetch("/api/recovery/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      credentials: "same-origin"
    }).then(function (res) { return res.json().catch(function () { return {}; }); })
      .then(function () {
        // Neutral message — invariant whether the email exists or not.
        var msg = "If a matching purchase exists, we sent an email.";
        status.textContent = msg;
      }).catch(function () {
        // Same neutral message on network failure — never disclose state.
        status.textContent = "If a matching purchase exists, we sent an email.";
      });
  });
})();
`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Class Navi Pro Tools — Recover your license</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>
<h1>Class Navi Pro Tools — Recover your license</h1>
<p>Enter the email you used at checkout. We'll send recovery options if a matching purchase exists.</p>
<form id="recovery-form" action="/api/recovery/request" method="post" enctype="application/json">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required>
<button type="submit">Send recovery options</button>
</form>
<p id="recovery-status" role="status" aria-live="polite"></p>
</body>
<script nonce="${nonce}">${script}</script>
</html>`;
}

/**
 * Build the fragment-only management page. The inline `<script>` carries
 * the SAME nonce that manageResponse propagates into CSP. The page:
 *   1) Reads token + family from `location.hash` BEFORE any fetch.
 *   2) IMMEDIATELY removes the fragment via `history.replaceState` so the
 *      token never appears in browser history or referrals.
 *   3) POSTs the token body to /api/manage/inspect.
 *   4) Gates the confirm button by a family vs inspected purpose match.
 *   5) POSTs /api/manage/reset ONLY when the user clicks confirm.
 *   6) Never stores the token in DOM / localStorage / sessionStorage / cookie.
 */
function buildManageHTML(nonce) {
  const script = `
(function () {
  if (!window.history || !history.replaceState) {
    document.body.textContent = "Unsupported browser.";
    return;
  }
  // 1) Parse token + family from URL fragment BEFORE any fetch.
  var hash = window.location.hash || "";
  var params = {};
  var pairs = hash.replace(/^#/, "").split("&");
  for (var i = 0; i < pairs.length; i++) {
    var kv = pairs[i].split("=");
    var k = decodeURIComponent(kv[0] || "");
    var v = decodeURIComponent((kv[1] || "").replace(/\\+/g, " "));
    if (k) params[k] = v;
  }
  var token = params.token || "";
  var family = params.family || "";

  // 2) IMMEDIATELY remove the fragment via history.replaceState BEFORE any
  //    fetch — the token never appears in browser history or referrals.
  try {
    var cleanUrl = window.location.pathname + window.location.search;
    history.replaceState(null, "", cleanUrl);
  } catch (_) { /* non-fatal */ }

  var status = document.getElementById("manage-status");
  var chromeBtn = document.getElementById("confirm-chrome");
  var edgeBtn   = document.getElementById("confirm-edge");
  var allBtn    = document.getElementById("confirm-all");
  var details   = document.getElementById("manage-details");
  var buttons   = document.getElementById("manage-actions");

  function fail(msg) {
    status.textContent = msg;
    details.textContent = "";
    // No token / family remnants in the DOM.
    if (buttons) buttons.textContent = "";
  }

  if (!token || !family) {
    fail("This link is missing required information.");
    return;
  }

  // 3) POST the token body to /api/manage/inspect. The token travels ONLY
  //    in the request body, never in query/path/fragment/cookie/storage.
  fetch("/api/manage/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: token })
  }).then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (info) {
      if (!info || info.valid !== true) {
        var code = (info && info.code) || "invalid";
        fail(code === "expired" ? "This link has expired."
          : code === "used" ? "This link has already been used."
          : "This link is not valid.");
        return;
      }
      // Safe shape only — masked tail.
      var tail = info.licenseTail || "—";
      var status = info.status || "unknown";
      var chrome = info.chromeOccupied ? "occupied" : "vacant";
      var edge   = info.edgeOccupied ? "occupied" : "vacant";
      var lines = [];
      lines.push("License tail: " + tail);
      lines.push("Status: " + status);
      lines.push("Chrome: " + chrome + " · Edge: " + edge);
      details.textContent = lines.join("\\n");
      // Plain status for assistive tech.
      var summary = document.getElementById("manage-summary");
      if (summary) summary.textContent = "Inspect complete.";

      // 4) Confirm button only when the inspected purpose matches the family
      //    from the fragment. Show the matching reset button ONLY.
      var purpose = info.purpose;
      var show = function (btn) {
        btn.style.display = "";
      };
      // Always hide first.
      if (chromeBtn) chromeBtn.style.display = "none";
      if (edgeBtn) edgeBtn.style.display = "none";
      if (allBtn) allBtn.style.display = "none";
      if (purpose === "reset_chrome" && family === "reset_chrome") show(chromeBtn);
      if (purpose === "reset_edge"   && family === "reset_edge")   show(edgeBtn);
      if (purpose === "reset_all"    && family === "reset_all")    show(allBtn);
      // The 'recover' purpose has no confirm button (view-only via fragment).
    })
    .catch(function () { fail("Could not check this link. Please try again."); });

  // 5) Reset POST: only on user click. Each confirm button resolves the
  //    family to a known browser_family string and POSTs the token body.
  function onReset(familyValue) {
    return function (ev) {
      ev.preventDefault();
      fetch("/api/manage/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token, browser_family: familyValue })
      }).then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (out) {
          if (out && out.ok) {
            fail("Reset complete. You can sign in again in this browser.");
          } else if (out && out.code === "used") {
            fail("This link has already been used.");
          } else if (out && out.code === "expired") {
            fail("This link has expired.");
          } else if (out && out.code === "scope-mismatch") {
            fail("This link is not valid for this action.");
          } else if (out && out.code === "not-found") {
            fail("Nothing to reset for this browser.");
          } else {
            fail("Reset could not be completed. Please try again.");
          }
        })
        .catch(function () { fail("Reset could not be completed. Please try again."); });
    };
  }
  if (chromeBtn) chromeBtn.addEventListener("click", onReset("chrome"));
  if (edgeBtn)   edgeBtn.addEventListener("click",   onReset("edge"));
  if (allBtn)    allBtn.addEventListener("click",    onReset("all"));
})();
`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Class Navi Pro Tools — Manage license</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body>
<h1>Class Navi Pro Tools — Manage your license</h1>
<p id="manage-summary" role="status" aria-live="polite"></p>
<pre id="manage-details" aria-live="polite"></pre>
<p id="manage-status" role="status" aria-live="polite"></p>
<div id="manage-actions">
<button id="confirm-chrome" type="button" style="display:none">Reset Chrome activation</button>
<button id="confirm-edge" type="button" style="display:none">Reset Edge activation</button>
<button id="confirm-all" type="button" style="display:none">Reset all browser activations</button>
</div>
</body>
<script nonce="${nonce}">${script}</script>
</html>`;
}

/* ───────────────────────────── HTTP helpers ────────────────────────────── */

/** Make a JSON Response with consistent safe headers. */
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

/** Make an HTML Response with consistent safe headers for GET pages. */
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
 * Bounded body reader. Returns:
 *   { ok:true, text } when content-length (and/or body size) is within limit
 *   { ok:false }      when too large (fixed safe 413 envelope is returned by
 *                     the caller; we never echo body bytes).
 *
 * The Content-Length header (if numeric) MUST match the body size or be
 * absent; an inflated Content-Length is also treated as too-large.
 */
async function readBoundedBody(req, maxBytes) {
  // Pre-check Content-Length if present and numeric.
  const cl = req.headers.get("content-length");
  if (typeof cl === "string" && cl.length > 0) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      return { ok: false };
    }
  }
  const text = await req.text();
  // Belt-and-braces: actual byte length also bounded (UTF-8 bytes may exceed
  // string length; we measure via TextEncoder).
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) {
    return { ok: false };
  }
  return { ok: true, text };
}

/** JSON-parse the bounded body; returns null on parse error or non-objects. */
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

/** True when the normalized-or-null value looks like an email with exactly
 * one '@', a non-empty local-part, and a non-empty domain containing a dot
 * in the post-'@' portion. Accepts any TLD. Defensive — does NOT echo. */
function looksLikeEmail(value) {
  if (typeof value !== "string") return false;
  const at = value.indexOf("@");
  if (at <= 0) return false;
  if (at !== value.lastIndexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length === 0 || domain.length === 0) return false;
  if (!domain.includes(".")) return false;
  return true;
}

/** Hash a raw clientIp-or-blank into the storage-ready subject. Blank maps
 * to a fixed 'unknown' bucket; whitespace-only is trimmed. */
function ipSubjectOrUnknown(rawIp) {
  const v = typeof rawIp === "string" ? rawIp.trim() : "";
  return v.length > 0 ? v : UNKNOWN_IP_SUBJECT;
}

/** Composite "fixed 202 response" — cache-control no-store, status 202,
 * invariant JSON shape. */
function always202() {
  return jsonResponse(202, ALWAYS_202);
}

/** Generate a single random nonce for CSP / inline script pairing. The
 * value is a URL-safe base64 of 16 bytes (≥22 chars). The caller MUST set
 * the same nonce on the inline <script> element AND inside the CSP
 * `script-src 'self' 'nonce-<value>'` directive. */
function makeNonce() {
  return randomBytes(16).toString("base64url");
}

/** Build the opaque, non-PII idempotency subject from a (possibly
 * attacker-controlled) randomId. The result is a bounded lowercase hex
 * prefix of HMAC-SHA256(randomId, secret). The raw randomId is NEVER
 * stored; the prefix is safe to use as part of an idempotency key. */
function opaqueIdempotencySubject(randomIdStr, secret) {
  if (typeof randomIdStr !== "string" || randomIdStr.length === 0) {
    throw new TypeError("randomId must be a non-blank string");
  }
  if (typeof secret !== "string" || secret.length === 0) {
    throw new TypeError("secret must be a non-blank string");
  }
  const full = createHmac("sha256", secret).update(randomIdStr, "utf8").digest("hex");
  return full.slice(0, OPAQUE_PREFIX_HEX_LEN);
}

/* ───────────────────────────── Core factory ────────────────────────────── */

/**
 * Build the import-safe recovery HTTP service. The factory must NOT start
 * a server, open a DB file, schedule a timer, or log anything at module
 * load. The factory body opens no resources either — only the user-supplied
 * db handle is used (and that's already open at call time).
 */
export function createRecoveryHttpService({
  db,
  secret,
  baseUrl,
  now = () => Date.now(),
  randomId = () => randomBytes(16).toString("base64url"),
  logger = console,
  emailLimit = DEFAULT_EMAIL_LIMIT,
  ipLimit = DEFAULT_IP_LIMIT,
  windowMs = DEFAULT_WINDOW_MS,
  minimumResponseMs = 350,
  monotonicNow = () => performance.now(),
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  // ── configuration validation ─────────────────────────────────────────
  if (!db || typeof db.query !== "function") {
    throw new TypeError("createRecoveryHttpService: db required");
  }
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    // baseUrl is required so we can pin the canonical `/manage` path inside
    // the response page (CSP / X-Frame-Options). It is never echoed.
    throw new TypeError("createRecoveryHttpService: baseUrl required");
  }
  if (typeof now !== "function") {
    throw new TypeError("createRecoveryHttpService: now must be a function");
  }
  if (typeof randomId !== "function") {
    throw new TypeError("createRecoveryHttpService: randomId must be a function");
  }
  if (typeof logger !== "object" || logger === null) {
    throw new TypeError("createRecoveryHttpService: logger required");
  }
  if (typeof windowMs !== "number" || !Number.isInteger(windowMs) || windowMs <= 0) {
    throw new TypeError("createRecoveryHttpService: windowMs must be a positive integer");
  }
  if (typeof emailLimit !== "number" || !Number.isInteger(emailLimit) || emailLimit <= 0) {
    throw new TypeError("createRecoveryHttpService: emailLimit must be a positive integer");
  }
  if (typeof ipLimit !== "number" || !Number.isInteger(ipLimit) || ipLimit <= 0) {
    throw new TypeError("createRecoveryHttpService: ipLimit must be a positive integer");
  }
  // The fixed minimum neutral-response floor. It is CONFIG-only: it can never
  // be selected or overridden by a request, so an attacker cannot lower (or
  // raise) the padding to recover timing information. 0 is legal (tests / fast
  // integration mode) and disables the floor.
  if (
    typeof minimumResponseMs !== "number" ||
    !Number.isInteger(minimumResponseMs) ||
    minimumResponseMs < 0
  ) {
    throw new TypeError(
      "createRecoveryHttpService: minimumResponseMs must be a non-negative integer"
    );
  }
  if (typeof monotonicNow !== "function") {
    throw new TypeError("createRecoveryHttpService: monotonicNow must be a function");
  }
  if (typeof sleepFn !== "function") {
    throw new TypeError("createRecoveryHttpService: sleepFn must be a function");
  }
  // Validate baseUrl early so the GET pages know the canonical `/manage`
  // path is sensible. We accept https everywhere and http only for
  // loopback hosts, mirroring the recovery-email preparer's contract.
  validateBaseUrl(baseUrl);

  // configured = true iff secret is a string >= MIN_SECRET_LENGTH. A blank
  // / missing / too-short secret is allowed as a configuration but disables
  // every POST and the page becomes safe-by-disclosure (no BASE_URL or
  // secret leaks).
  const configured =
    typeof secret === "string" && secret.trim().length >= MIN_SECRET_LENGTH;
  const safeSecret = configured ? secret : "";
  // We never persist/return the secret. The baseUrl is page meta — not
  // secret, but we don't echo it in JSON responses either.

  // Fixed safe log helper (never includes the underlying error).
  function logRequestFailed() {
    try {
      if (logger && typeof logger.warn === "function") {
        logger.warn(SAFE_LOG_REQUEST_FAILED);
      }
    } catch {
      /* logger failure is non-fatal */
    }
  }

  // Fixed minimum neutral-response floor. Every NORMAL neutral 202 path
  // (malformed/blank email, unknown email, existing one-or-more licenses,
  // IP-limited, email-limited) returns through this single helper: it reads
  // the monotonic clock ONCE for the elapsed work time, then sleeps only the
  // remaining time up to the configured floor. Known emails that do DB/crypto
  // work therefore take the same wall time to answer as unknown or
  // rate-limited emails — membership and license counts cannot be inferred
  // from response latency. When work already exceeds the floor, no sleep is
  // added. Fixed 503/405/413/500 paths are intentionally not padded.
  async function neutral202(start) {
    const elapsed = monotonicNow() - start;
    const remaining = minimumResponseMs - elapsed;
    if (remaining > 0) {
      await sleepFn(remaining);
    }
    return always202();
  }

  // ── POST handlers ────────────────────────────────────────────────────
  async function requestRecovery(req, opts) {
    if (!configured) {
      return jsonResponse(503, SAFE_NOT_CONFIGURED);
    }
    // POST-only guard: defense in depth even if index.js routes only POST.
    if (req.method !== "POST") {
      return jsonResponse(405, SAFE_METHOD_NOT_ALLOWED);
    }
    const body = await readBoundedBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      return jsonResponse(413, SAFE_BODY_TOO_LARGE);
    }
    const json = parseJsonBody(body.text);

    // Monotonic start timestamp. Recorded AFTER the configured/method/body-
    // size guards and BEFORE any rate-limit/email logic, so every normal
    // neutral-202 path (existing, unknown, malformed, email-limited,
    // IP-limited) measures its floor from the same fixed point. It is config
    // and clock only — never request-controlled.
    const start = monotonicNow();

    // ── Rate limit: enforce (defense in depth + do-not-leak-attempt-counter).
    // Both the IP and the email bucket are consumed BEFORE any business
    // mutation. A rate-limit return of { allowed:false } short-circuits the
    // request with the invariant 202 envelope (no token, no outbox, no
    // license lookup). A rate-limit throw fails CLOSED: no enqueue, fixed
    // log, fixed 500 envelope.
    const ts = now();
    const clientIp =
      opts && typeof opts === "object" && typeof opts.clientIp === "string" ? opts.clientIp : "";
    const ipSubjectKey = hashRequestSubject(ipSubjectOrUnknown(clientIp), safeSecret);

    // IP rate limit.
    let ipAllowed = true;
    try {
      const ipRes = consumeRequestLimit(db, {
        subjectKey: ipSubjectKey,
        action: ACTION_IP,
        now: ts,
        windowMs,
        limit: ipLimit,
      });
      if (ipRes && ipRes.allowed === false) {
        // IP cap reached → refuse work, return the padded invariant 202.
        return neutral202(start);
      }
    } catch {
      // Fail closed: no enqueue, no license lookup, no token mint.
      logRequestFailed();
      return jsonResponse(500, SAFE_REQUEST_FAILED);
    }

    // Email normalization + email rate limit (only when the request looks
    // like a recognized email shape — otherwise we still 202 with the
    // neutral shape, but do NOT consume the email bucket).
    let normalized = null;
    if (json && typeof json.email === "string" && looksLikeEmail(json.email)) {
      normalized = normalizeEmail(json.email);
      if (normalized) {
        try {
          const emailKey = hashRequestSubject(normalized, safeSecret);
          const emailRes = consumeRequestLimit(db, {
            subjectKey: emailKey,
            action: ACTION_EMAIL,
            now: ts,
            windowMs,
            limit: emailLimit,
          });
          if (emailRes && emailRes.allowed === false) {
            // Email cap reached → refuse work, return the padded invariant 202.
            return neutral202(start);
          }
        } catch {
          // Fail closed.
          logRequestFailed();
          return jsonResponse(500, SAFE_REQUEST_FAILED);
        }
      }
    }

    // ── Atomic per-license mint + enqueue.
    // ONE BEGIN IMMEDIATE for the WHOLE matching-license request. If any
    // license's mint or outbox insert fails, the transaction rolls back and
    // all earlier licenses' tokens/outbox rows are reverted.
    try {
      if (normalized) {
        const licenses = licensesForEmail(db, normalized);
        if (licenses.length > 0) {
          // Generate a requestId without touching the DB; treat the raw
          // value as untrusted and run it through HMAC + bounded hex so
          // that the randomId (which may carry attacker-supplied bytes)
          // never reaches storage.
          let opaqueSubject;
          try {
            opaqueSubject = opaqueIdempotencySubject(randomId(), safeSecret);
          } catch {
            // Invalid randomId → fail closed.
            logRequestFailed();
            return jsonResponse(500, SAFE_REQUEST_FAILED);
          }
          try {
            db.exec("BEGIN IMMEDIATE");
            for (let i = 0; i < licenses.length; i++) {
              const lic = licenses[i];
              if (!lic || typeof lic.key !== "string" || lic.key.length === 0) continue;
              const tokens = {
                recover: generateManagementToken(db, {
                  email: normalized,
                  licenseKey: lic.key,
                  purpose: "recover",
                  now: ts,
                  ttlMs: 20 * 60 * 1000,
                }).token,
                reset_chrome: generateManagementToken(db, {
                  email: normalized,
                  licenseKey: lic.key,
                  purpose: "reset_chrome",
                  now: ts,
                  ttlMs: 20 * 60 * 1000,
                }).token,
                reset_edge: generateManagementToken(db, {
                  email: normalized,
                  licenseKey: lic.key,
                  purpose: "reset_edge",
                  now: ts,
                  ttlMs: 20 * 60 * 1000,
                }).token,
                reset_all: generateManagementToken(db, {
                  email: normalized,
                  licenseKey: lic.key,
                  purpose: "reset_all",
                  now: ts,
                  ttlMs: 20 * 60 * 1000,
                }).token,
              };
              const payload = createRecoveryOutboxPayload({
                recipient: normalized,
                licenseKey: lic.key,
                tokens,
                secret: safeSecret,
              });
              const idemKey = `recovery:${opaqueSubject}:${i}`;
              enqueueEmail(db, {
                kind: RECOVERY_OUTBOX_KIND,
                licenseKey: lic.key,
                recipientEmail: normalized,
                payload,
                idempotencyKey: idemKey,
                createdAt: ts,
              });
            }
            db.exec("COMMIT");
          } catch {
            try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
            logRequestFailed();
            return jsonResponse(500, SAFE_REQUEST_FAILED);
          }
        }
      }
      return neutral202(start);
    } catch {
      // Defensive: any synchronous failure also gets the fixed safe log.
      logRequestFailed();
      return jsonResponse(500, SAFE_REQUEST_FAILED);
    }
  }

  async function inspectToken(req) {
    if (!configured) return jsonResponse(503, SAFE_NOT_CONFIGURED);
    if (req.method !== "POST") return jsonResponse(405, SAFE_METHOD_NOT_ALLOWED);
    const body = await readBoundedBody(req, MAX_BODY_BYTES);
    if (!body.ok) return jsonResponse(413, SAFE_BODY_TOO_LARGE);
    const json = parseJsonBody(body.text);
    const token =
      json && typeof json === "object" && typeof json.token === "string" ? json.token : "";
    if (!token) {
      return jsonResponse(400, inspectManagementToken(db, { token: "", now: now() }));
    }
    let info;
    try {
      info = inspectManagementToken(db, { token, now: now() });
    } catch {
      return jsonResponse(400, safeInvalid());
    }
    // 200 OK on valid shape; 400 on invalid/expired/used to make polling
    // rules explicit, with safe shape either way.
    const status = info && info.valid === true ? 200 : 400;
    return jsonResponse(status, info);
  }

  async function resetToken(req) {
    if (!configured) return jsonResponse(503, SAFE_NOT_CONFIGURED);
    if (req.method !== "POST") return jsonResponse(405, SAFE_METHOD_NOT_ALLOWED);
    const body = await readBoundedBody(req, MAX_BODY_BYTES);
    if (!body.ok) return jsonResponse(413, SAFE_BODY_TOO_LARGE);
    const json = parseJsonBody(body.text);
    const token =
      json && typeof json === "object" && typeof json.token === "string" ? json.token : "";
    const browserFamily =
      json && typeof json === "object" && typeof json.browser_family === "string"
        ? json.browser_family
        : "";
    if (!token) {
      return jsonResponse(400, { ok: false, code: "invalid", removed: 0 });
    }
    let result;
    try {
      result = consumeResetToken(db, { token, browserFamily, now: now() });
    } catch {
      return jsonResponse(400, { ok: false, code: "invalid", removed: 0 });
    }
    // 200 on ok=true, 409 on a used/expired/scope-mismatch/not-found
    // failure so callers can distinguish from a fresh invalid input. 400
    // is reserved for malformed/invalid input.
    const status = result.ok
      ? 200
      : result.code === "invalid"
      ? 400
      : 409;
    return jsonResponse(status, result);
  }

  // ── GET handlers ──────────────────────────────────────────────────────
  async function portalResponse() {
    // ONE random nonce per response. The SAME nonce is attached to the
    // inline <script> element AND injected into the CSP. Script-src forbids
    // 'unsafe-inline' so the nonce is the only allowed inline script.
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
    return htmlResponse(200, buildPortalHTML(nonce), null, csp);
  }

  async function manageResponse() {
    // ONE random nonce per response, mirroring the portalResponse contract.
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
    return htmlResponse(200, buildManageHTML(nonce), null, csp);
  }

  return {
    configured,
    requestRecovery,
    inspectToken,
    resetToken,
    portalResponse,
    manageResponse,
  };
}

/* ───────────────────────────── Helpers below ───────────────────────────── */

function safeInvalid() {
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

const BASE_URL_ERROR =
  "createRecoveryHttpService: baseUrl must be an https URL (http only permitted for localhost)";

function validateBaseUrl(rawBaseUrl) {
  if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim() === "") {
    throw new TypeError(BASE_URL_ERROR);
  }
  let parsed;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new TypeError(BASE_URL_ERROR);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(BASE_URL_ERROR);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError(BASE_URL_ERROR);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError(BASE_URL_ERROR);
  }
  if (parsed.protocol === "https:") {
    return { parsed };
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1";
  if (!isLoopback) {
    throw new TypeError(BASE_URL_ERROR);
  }
  return { parsed };
}
