// server/index.js — Quick Mark Pro license server.
// Routes:
//   POST /api/license/activate {license_key, instance_id, browser_family} → bind + validate a browser-family slot
//   POST /api/license/validate {license_key, instance_id, browser_family} → read-only validate a browser-family slot
//   POST /api/stripe/webhook                                   → Stripe events
//   POST /api/resend/webhook                                   → Resend (Svix-verified) events
//   POST /api/recovery/request                                 → secure email-recovery (HMAC rate-limited, no raw-key lookup)
//   POST /api/manage/inspect                                   → masked safe-shape inspection of a management token
//   POST /api/manage/reset                                     → consume a reset management token to free a browser slot
//   POST /api/invites/redeem                                   → neutral family-invite redemption
//   POST /api/admin/invites/mint                               → bearer-authenticated invite minting
//   POST /api/admin/family/revoke                              → bearer-authenticated family-license revocation
//   GET  /portal                                                → email-recovery form (recovery portal, not a key lookup)
//   GET  /manage                                                → fragment-only management page (consumes /api/manage/inspect + /api/manage/reset)
//   GET  /invite                                                → family-invite redemption form
//   GET  /privacy                                               → privacy policy
//   GET  /health                                                → ok + email PII-free snapshot
// Environment: see .env.example.
import { openDb, issueKeys, emailQueueHealth } from "./db.js";
import { activateBrowserSlot, validateBrowserSlot } from "./browser-slots.js";
import { createStripeWebhookHandler, isStripeServerKey } from "./stripe-webhook.js";
import { createResendWebhookHandler } from "./resend-webhook.js";
import { createResendAdapter, DEFAULT_FROM, DEFAULT_REPLY_TO } from "./email.js";
import { createEmailWorker } from "./email-worker.js";
import { createEmailScheduler } from "./email-scheduler.js";
import { createRecoveryHttpService } from "./recovery-http.js";
import { createRecoveryMessagePreparer, RECOVERY_OUTBOX_KIND } from "./recovery-email.js";
import { createInviteHttpService } from "./invite-http.js";
import { safeSecretEqual } from "./auth.js";

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const BASE_URL = process.env.BASE_URL || "http://localhost:8787";
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || "license.db";

// Recovery-management secret. Blank/short disables every recovery POST with a
// fixed 503 envelope; the GET pages still render (with no config leaks). Must
// be at least 16 random bytes — see .env.example.
const MANAGEMENT_TOKEN_SECRET = process.env.MANAGEMENT_TOKEN_SECRET || "";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET || "";
const EMAIL_FROM = process.env.EMAIL_FROM || DEFAULT_FROM;
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO || DEFAULT_REPLY_TO;

/**
 * Parse a positive-integer env value with a default. Invalid / non-positive
 * / non-integer values fall back to the default (never throw, never crash).
 */
function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

const _cap = positiveIntEnv("EMAIL_DAILY_CAP", 100);
const EMAIL_CONFIG = {
  pollMs: positiveIntEnv("EMAIL_POLL_INTERVAL_MS", 5000),
  drainMax: positiveIntEnv("EMAIL_DRAIN_MAX_ITER", 20),
  leaseMs: positiveIntEnv("EMAIL_LEASE_MS", 60000),
  dailyCap: _cap,
  // warnAt default 80; clamped to dailyCap when warn > cap.
  warnAt: Math.min(positiveIntEnv("EMAIL_DAILY_WARN", 80), _cap),
  retryBaseMs: positiveIntEnv("EMAIL_RETRY_BASE_MS", 60000),
  retryMaxMs: positiveIntEnv("EMAIL_RETRY_MAX_MS", 3600000),
};

// Recovery tunables (positive integers, fall back to safe defaults).
const RECOVERY_WINDOW_MS = positiveIntEnv("RECOVERY_WINDOW_MS", 900000); // 15 min
const RECOVERY_EMAIL_LIMIT = positiveIntEnv("RECOVERY_EMAIL_LIMIT", 3);
const RECOVERY_IP_LIMIT = positiveIntEnv("RECOVERY_IP_LIMIT", 10);
// Fixed minimum neutral recovery-response delay (ms) that defeats the
// membership/liveness timing oracle (known emails do DB/crypto work, unknown
// emails answer faster). 0 env falls back to 350 (positiveIntEnv); tests use 1.
const RECOVERY_MIN_RESPONSE_MS = positiveIntEnv("RECOVERY_MIN_RESPONSE_MS", 350);

// Family invite tunables (positive integers; invalid/blank fall back to defaults).
const INVITE_WINDOW_MS = positiveIntEnv("INVITE_WINDOW_MS", 900000); // 15 min
const INVITE_IP_LIMIT = positiveIntEnv("INVITE_IP_LIMIT", 20);
const INVITE_CODE_LIMIT = positiveIntEnv("INVITE_CODE_LIMIT", 5);
const INVITE_ADMIN_IP_LIMIT = positiveIntEnv("INVITE_ADMIN_IP_LIMIT", 20);
const INVITE_MIN_RESPONSE_MS = positiveIntEnv("INVITE_MIN_RESPONSE_MS", 350);

const db = openDb(DB_PATH);
const stripe =
  isStripeServerKey(STRIPE_SECRET)
    ? (await import("stripe")).default(STRIPE_SECRET)
    : null;

// Stripe webhook handler lives in stripe-webhook.js (importable without
// starting the server). It handles idempotent processing, monotonic
// subscription-state authority, pre-checkout state application, and redacted
// logging. Passed the live db + stripe client; when stripe is unconfigured it
// serves the fixed "stripe not configured" 500.
const stripeWebhookHandler = createStripeWebhookHandler({
  db,
  stripe,
  webhookSecret: STRIPE_WEBHOOK_SECRET,
});

// Always construct the Resend webhook handler — the handler itself returns a
// fixed 500 when webhookSecret is blank, so missing-secret configs stay safe.
const resendWebhookHandler = createResendWebhookHandler({
  db,
  webhookSecret: RESEND_WEBHOOK_SECRET,
});

// Always construct the recovery HTTP service. With a blank/short secret the
// service marks `configured=false` and POST handlers return a fixed 503
// envelope; the GET pages still render with no config values disclosed. The
// service HMACs the client IP — we never log/store raw IP bytes.
const recoveryService = createRecoveryHttpService({
  db,
  secret: MANAGEMENT_TOKEN_SECRET,
  baseUrl: BASE_URL,
  windowMs: RECOVERY_WINDOW_MS,
  emailLimit: RECOVERY_EMAIL_LIMIT,
  ipLimit: RECOVERY_IP_LIMIT,
  minimumResponseMs: RECOVERY_MIN_RESPONSE_MS,
});

const inviteService = createInviteHttpService({
  db,
  adminToken: ADMIN_TOKEN,
  rateSecret: MANAGEMENT_TOKEN_SECRET,
  windowMs: INVITE_WINDOW_MS,
  inviteIpLimit: INVITE_IP_LIMIT,
  inviteCodeLimit: INVITE_CODE_LIMIT,
  adminIpLimit: INVITE_ADMIN_IP_LIMIT,
  minimumResponseMs: INVITE_MIN_RESPONSE_MS,
});

// Recovery message preparer. Only the FULL preparer is wired when the
// management secret is valid (>=16 chars). When the secret is missing/short we
// still pass a small local preparer that:
//   • lets the welcome-email payload through unchanged (identity), so the
//     worker can dispatch welcome emails when Resend is enabled;
//   • REJECTS any outbox row whose kind === "recovery" by throwing a fixed,
//     redacted internal error. The email worker catches the throw, marks the
//     row dead with category='preparation', and logs a fixed redacted line —
//     the encrypted outbox payload is NEVER passed to the provider as a
//     message.
// This is the "fail closed at preparation" gate. The recovery HTTP service's
// own `configured=false` already short-circuits POSTs at the HTTP layer; this
// preparer is the belt-and-braces for any row that somehow slipped into the
// outbox while the secret was missing/short.
const hasManagementSecret =
  typeof MANAGEMENT_TOKEN_SECRET === "string" &&
  MANAGEMENT_TOKEN_SECRET.trim().length >= 16;
const PREP_REJECTED_ERROR = "recovery-preparation-rejected";
const recoveryPreparer = hasManagementSecret
  ? createRecoveryMessagePreparer({
      db,
      secret: MANAGEMENT_TOKEN_SECRET,
      baseUrl: BASE_URL,
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
    })
  : async function identityOrReject({ row, payload }) {
      if (row && row.kind === RECOVERY_OUTBOX_KIND) {
        throw new Error(PREP_REJECTED_ERROR);
      }
      return payload;
    };

// Email scheduler is constructed ONLY when RESEND_API_KEY is non-blank. With
// a blank/whitespace key we leave both the adapter and the scheduler off —
// the server still starts, Stripe still queues, and /health still surfaces DB
// counts + disabled-safe runtime/config fields. The scheduler's worker uses
// the recovery preparer above as its `prepareMessage` so any outbox row
// dispatched by the worker goes through the sealed-token hydration + send-time
// re-verification gate.
const emailEnabled = RESEND_API_KEY.trim() !== "";
let emailScheduler = null;
if (emailEnabled) {
  const adapter = createResendAdapter({
    apiKey: RESEND_API_KEY,
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
  });
  const deliverNext = createEmailWorker({
    db,
    sender: adapter,
    leaseMs: EMAIL_CONFIG.leaseMs,
    dailyCap: EMAIL_CONFIG.dailyCap,
    warnAt: EMAIL_CONFIG.warnAt,
    retryBaseMs: EMAIL_CONFIG.retryBaseMs,
    retryMaxMs: EMAIL_CONFIG.retryMaxMs,
    prepareMessage: recoveryPreparer,
  });
  emailScheduler = createEmailScheduler({
    deliverNext,
    queueHealth: () => emailQueueHealth(db, Date.now()),
    intervalMs: EMAIL_CONFIG.pollMs,
    drainMax: EMAIL_CONFIG.drainMax,
  });
} else {
  console.log("[email] scheduler disabled");
}

/**
 * Resolve the client IP for the recovery flow. We never trust
 * X-Forwarded-For (it's spoofable and the server is hosted behind a known
 * proxy that exposes CF-Connecting-IP). Order:
 *   1) Trimmed CF-Connecting-IP header if present.
 *   2) server.requestIP(req)?.address — the bare host socket peer.
 *   3) Fixed "unknown" (no PII leak; service HMACs whatever we return).
 * The raw IP is never logged or stored — the service hashes it before it
 * touches the rate-limit table.
 */
function getClientIp(req) {
  const cf = req.headers.get("cf-connecting-ip");
  if (typeof cf === "string") {
    const trimmed = cf.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const ip = server.requestIP(req);
  if (ip && typeof ip.address === "string" && ip.address.length > 0) {
    return ip.address;
  }
  return "unknown";
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function readJson(req) {
  try {
    return await req.json();
  } catch (e) {
    return null;
  }
}

/**
 * Non-sensitive billing fields to expose alongside route results, read ONLY
 * from the license row (never email/customer/subscription/key). A missing
 * license yields an empty object. cancel_at_period_end is surfaced as a
 * boolean; a valid active cancellation-at-period-end license stays valid and
 * returns its period-end date + flag.
 */
function billingFields(licenseKey) {
  if (typeof licenseKey !== "string" || licenseKey.trim() === "") return {};
  const lic = db
    .query(`SELECT expires_at, current_period_end, cancel_at_period_end FROM licenses WHERE key = ?`)
    .get(licenseKey.trim());
  if (!lic) return {};
  return {
    expiresAt: lic.expires_at ?? null,
    current_period_end: lic.current_period_end ?? null,
    cancel_at_period_end: !!lic.cancel_at_period_end,
  };
}

/** Map a browser-slot service failure code to HTTP status. Request problems →
 * 400; entitlement/slot problems → 403. */
function slotFailureStatus(code) {
  return code === "invalid-input" || code === "family-undetermined" ? 400 : 403;
}

/** Parse the shared {license_key, instance_id, browser_family} request body. */
function parseSlotRequest(body) {
  if (!body || typeof body !== "object") return null;
  const licenseKey = typeof body.license_key === "string" ? body.license_key.trim() : "";
  const instanceId = typeof body.instance_id === "string" ? body.instance_id.trim() : "";
  const browserFamily = typeof body.browser_family === "string" ? body.browser_family.trim() : "";
  if (!licenseKey || !instanceId || !browserFamily) return null;
  return { licenseKey, browserFamily, instanceId };
}

/** Stripe webhook: handled by createStripeWebhookHandler (stripe-webhook.js). */

const ADMIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Quick Mark Pro — Admin</title>
<style>
  body { font-family: -apple-system,'Segoe UI',Roboto,sans-serif; background:#f4f7fa; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; }
  .card { background:#fff; border:1px solid #d9e2e6; border-radius:12px; padding:28px 32px; width:460px; max-width:94vw; box-shadow:0 8px 24px rgba(0,0,0,.08); }
  h1 { font-size:18px; color:#1c3a5e; margin:0 0 4px; }
  p { font-size:12px; color:#8aa5b0; margin:0 0 16px; }
  input, select { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid #cbd5dd; border-radius:6px; font-size:13px; margin-bottom:10px; }
  button { width:100%; padding:10px 0; background:#2a6df4; color:#fff; border:none; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer; }
  .key { font-family: ui-monospace, Menlo, monospace; background:#f0f6ff; border:1px solid #cfe0ff; border-radius:6px; padding:8px 10px; font-size:13px; margin:6px 0; color:#1c3a5e; display:flex; justify-content:space-between; align-items:center; }
  .key button { width:auto; padding:4px 10px; font-size:11px; background:#e8eef4; color:#1c3a5e; }
  .err { font-size:11px; color:#c0392b; min-height:14px; margin-bottom:8px; }
</style></head>
<body><div class="card">
  <h1>Quick Mark Pro — Admin</h1>
  <p>Mint license keys for your center. Each key = one active seat (3 devices).</p>
  <input id="token" type="password" placeholder="Admin token">
  <input id="email" type="email" placeholder="Instructor email">
  <select id="count">
    <option value="1">1 key</option><option value="2">2 keys</option><option value="3">3 keys</option>
    <option value="5">5 keys</option><option value="10">10 keys</option><option value="20">20 keys</option>
  </select>
  <button id="go">Mint keys</button>
  <div class="err" id="err"></div>
  <div id="out"></div>
</div>
<script>
  const go = document.getElementById('go'), out = document.getElementById('out'), err = document.getElementById('err');
  const token = document.getElementById('token'), email = document.getElementById('email'), count = document.getElementById('count');
  go.addEventListener('click', async () => {
    out.innerHTML = ''; err.textContent = '';
    const r = await fetch('/api/admin/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token.value.trim(), email: email.value.trim(), count: Number(count.value) }) });
    const j = await r.json();
    if (!r.ok) { err.textContent = j.error || 'failed'; return; }
    for (const k of j.keys) {
      const div = document.createElement('div');
      div.className = 'key';
      const span = document.createElement('span');
      span.textContent = k;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Copy';
      btn.addEventListener('click', async () => { try { await navigator.clipboard.writeText(k); btn.textContent = 'Copied!'; } catch (e) { btn.textContent = k; } });
      div.appendChild(span); div.appendChild(btn);
      out.appendChild(div);
    }
    const note = document.createElement('p');
    note.textContent = 'Give each instructor their key — they paste it into the Quick Mark Pro activation screen.';
    out.appendChild(note);
  });
</script></body></html>`;

const PRIVACY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Privacy Policy — Class Navi Pro Tools</title>
<style>
  body { font-family: -apple-system,'Segoe UI',Roboto,sans-serif; background:#f4f7fa; color:#1c3a5e; margin:0; padding:32px 16px; line-height:1.6; }
  .card { background:#fff; border:1px solid #d9e2e6; border-radius:12px; padding:28px 32px; max-width:720px; margin:0 auto; box-shadow:0 8px 24px rgba(0,0,0,.08); }
  h1 { font-size:22px; margin:0 0 4px; }
  .meta { color:#5b738c; font-size:13px; margin-bottom:20px; }
  h2 { font-size:16px; margin:28px 0 8px; }
  p, li { font-size:14px; }
  ul { padding-left:20px; }
  table { border-collapse:collapse; width:100%; font-size:13px; margin:12px 0; }
  th, td { border:1px solid #d9e2e6; padding:8px 10px; text-align:left; }
  th { background:#f0f5f8; }
  a { color:#2a6df4; }
</style></head><body><div class="card">
<h1>Privacy Policy</h1>
<div class="meta">Class Navi Pro Tools (the "extension") — last updated August 17, 2026</div>

<p>This page explains what data the extension and its license service collect,
why, and how it is handled. It is a plain-English summary in one page.</p>

<h2>Short version</h2>
<ul>
  <li>The extension helps Kumon instructors assign homework and mark worksheets
    inside the Class-Navi web app. It never reads, stores, or transmits student
    data, worksheet content, or anything from the Class-Navi screen.</li>
  <li>It sends only a license key and an anonymous install ID to the license
    server, to verify your paid subscription.</li>
  <li>If you forget your key, you can request a secure email-recovery link from
    the portal. The link uses a one-time sealed token; we never show the key
    on screen after recovery.</li>
  <li>Your payment details go to Stripe — we never see or store card numbers.</li>
  <li>We do not sell data, show ads, or run analytics.</li>
</ul>

<h2>What the extension sends</h2>
<table>
  <tr><th>Data</th><th>Where it goes</th><th>Why</th></tr>
  <tr><td>License key</td><td>License server (this site)</td><td>Verify your subscription is active</td></tr>
  <tr><td>Anonymous install ID</td><td>License server (this site)</td><td>Enforce the per-key device limit</td></tr>
  <tr><td>Pattern preferences, comment settings</td><td>Nowhere — stored only in your browser's local storage</td><td>Your personal settings</td></tr>
</table>

<h2>What the license server stores</h2>
<ul>
  <li>License keys, the email used at purchase, subscription status, and a
    list of device IDs bound to each key.</li>
  <li>Short-lived sealed management tokens (used only for the email-recovery
    and browser-reset links). The plaintext token is never stored — only a
    hash + AES-GCM seal.</li>
  <li>This data exists to operate the subscription: issue keys after payment,
    validate them, and let you securely recover your key or free a slot by
    email.</li>
</ul>

<h2>Payments</h2>
<p>Payments are processed by <a href="https://stripe.com/privacy">Stripe</a>.
Card numbers and payment details are handled by Stripe under their own
privacy policy. The license server never receives or stores card data.</p>

<h2>Retention</h2>
<p>Subscription records are kept while your subscription is active and for a
reasonable period after cancellation (to handle refunds and support).
Browser-local settings remain on your device until you remove the extension.</p>

<h2>Sharing</h2>
<p>We do not sell, rent, or share your data with anyone except the processors
named above (Stripe for payments). No third-party analytics, no advertising,
no location tracking.</p>

<h2>Security</h2>
<p>All communication with the license server happens over HTTPS. Data is
minimized to what the service needs. Recovery and reset links use sealed,
single-use tokens that expire in minutes; IP addresses used to throttle
recovery requests are stored only as HMAC-SHA256 hashes.</p>

<h2>Your rights / deletion</h2>
<p>To request deletion of your license records, email
<a href="mailto:support@nimira-timer.com">support@nimira-timer.com</a> from
the address used at purchase. We will remove the associated license keys and
device bindings. Cancelling your subscription stops all future billing
(manageable in the Stripe customer portal).</p>

<h2>Contact</h2>
<p>Questions: <a href="mailto:support@nimira-timer.com">support@nimira-timer.com</a>.</p>

<p><a href="/portal">Back to the email-recovery portal</a></p>
</div></body></html>`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return json(204, {});
    }

    if (req.method === "POST" && path === "/api/license/activate") {
      const body = await readJson(req);
      const input = parseSlotRequest(body);
      if (!input) {
        return json(400, {
          valid: false,
          code: "invalid-input",
          browserFamily: null,
          actions: null,
          error: "invalid-input",
        });
      }
      const r = activateBrowserSlot(db, {
        licenseKey: input.licenseKey,
        browserFamily: input.browserFamily,
        instanceId: input.instanceId,
      });
      const billing = billingFields(input.licenseKey);
      if (r.valid) {
        // Exact frozen success shape + error:null legacy channel + billing.
        return json(200, {
          valid: true,
          activated: r.activated,
          code: r.code,
          browserFamily: r.browserFamily,
          error: null,
          ...billing,
        });
      }
      return json(slotFailureStatus(r.code), {
        valid: false,
        code: r.code,
        browserFamily: r.browserFamily,
        actions: r.actions,
        error: r.code,
        ...billing,
      });
    }

    if (req.method === "POST" && path === "/api/license/validate") {
      const body = await readJson(req);
      const input = parseSlotRequest(body);
      if (!input) {
        return json(400, {
          valid: false,
          code: "invalid-input",
          browserFamily: null,
          actions: null,
          error: "invalid-input",
        });
      }
      // Strictly read-only: validateBrowserSlot never activates/mutates a slot
      // or refreshes last_seen_at. Response is the same mapping as activation,
      // but validation success carries NO `activated` field.
      const r = validateBrowserSlot(db, {
        licenseKey: input.licenseKey,
        browserFamily: input.browserFamily,
        instanceId: input.instanceId,
      });
      const billing = billingFields(input.licenseKey);
      if (r.valid) {
        return json(200, {
          valid: true,
          code: r.code,
          browserFamily: r.browserFamily,
          error: null,
          ...billing,
        });
      }
      return json(slotFailureStatus(r.code), {
        valid: false,
        code: r.code,
        browserFamily: r.browserFamily,
        actions: r.actions,
        error: r.code,
        ...billing,
      });
    }

    if (req.method === "POST" && path === "/api/stripe/webhook") {
      return stripeWebhookHandler(req);
    }

    if (req.method === "POST" && path === "/api/resend/webhook") {
      // Delegate the exact raw Request to the Resend webhook core. The core
      // reads svix headers + raw body itself and returns the fixed 400/500/200
      // envelope. A blank RESEND_WEBHOOK_SECRET still safely returns 500.
      return resendWebhookHandler(req);
    }

    // ── Secure email-recovery flow ──────────────────────────────────────
    // All four routes below delegate to the recovery HTTP service. Client IP
    // is resolved locally (CF-Connecting-IP → server.requestIP → fixed
    // "unknown"); the service HMACs the IP before it touches the rate-limit
    // table. Raw IP bytes are never logged or stored.
    if (req.method === "POST" && path === "/api/recovery/request") {
      return recoveryService.requestRecovery(req, {
        clientIp: getClientIp(req),
      });
    }
    if (req.method === "POST" && path === "/api/manage/inspect") {
      return recoveryService.inspectToken(req);
    }
    if (req.method === "POST" && path === "/api/manage/reset") {
      return recoveryService.resetToken(req);
    }
    if (req.method === "GET" && path === "/portal") {
      return recoveryService.portalResponse();
    }
    if (req.method === "GET" && path === "/manage") {
      return recoveryService.manageResponse();
    }

    if (req.method === "POST" && path === "/api/invites/redeem") {
      return inviteService.redeemInviteRequest(req, { clientIp: getClientIp(req) });
    }
    if (req.method === "POST" && path === "/api/admin/invites/mint") {
      return inviteService.mintInvites(req, { clientIp: getClientIp(req) });
    }
    if (req.method === "POST" && path === "/api/admin/family/revoke") {
      return inviteService.revokeFamily(req, { clientIp: getClientIp(req) });
    }
    if (req.method === "GET" && path === "/invite") {
      return inviteService.invitePageResponse();
    }

    if (req.method === "GET" && path === "/privacy") {
      return new Response(PRIVACY_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // ── admin: mint license keys (protected by ADMIN_TOKEN) ──
    if (req.method === "POST" && path === "/api/admin/keys") {
      const body = await readJson(req);
      const token = body && body.token ? String(body.token) : "";
      const email = body && body.email ? String(body.email) : "";
      const count = Number((body && body.count) || 1);
      if (!safeSecretEqual(token, ADMIN_TOKEN)) {
        return json(403, { error: "invalid admin token" });
      }
      if (!email) return json(400, { error: "email required" });
      const keys = issueKeys(db, email, count);
      return json(200, { keys, email, count: keys.length });
    }

    if (req.method === "GET" && path === "/admin") {
      return new Response(ADMIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (req.method === "GET" && path === "/download") {
      // script-relative default (import.meta.dir = server/) — env override
      // for deployed layouts
      const file =
        process.env.DOWNLOAD_FILE || `${import.meta.dir}/../class-navi-pro-tools-1.0.0.zip`;
      try {
        const data = await Bun.file(file).arrayBuffer();
        return new Response(data, {
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="class-navi-pro-tools-1.0.0.zip"`,
          },
        });
      } catch (e) {
        return json(404, { error: "extension zip not found" });
      }
    }

    if (req.method === "GET" && path === "/health") {
      // PII-free email snapshot. Disabled → enabled/running/inFlight=false,
      // last null/"disabled", healthErrors 0. Scheduler runtime fields win
      // when the scheduler is live. Never includes secrets, recipients, keys,
      // payloads, or error text.
      const queue = emailQueueHealth(db, Date.now());
      const runtime = emailScheduler ? emailScheduler.health() : null;
      const email = {
        enabled: runtime ? runtime.enabled : false,
        running: runtime ? runtime.running : false,
        inFlight: runtime ? runtime.inFlight : false,
        lastTickState: runtime ? runtime.lastTickState : null,
        lastTickAt: runtime ? runtime.lastTickAt : null,
        intervalMs: EMAIL_CONFIG.pollMs,
        drainMax: EMAIL_CONFIG.drainMax,
        dailyCap: EMAIL_CONFIG.dailyCap,
        warnAt: EMAIL_CONFIG.warnAt,
        warnTriggered: queue.sentToday >= EMAIL_CONFIG.warnAt,
        pending: queue.pending,
        retry: queue.retry,
        sending: queue.sending,
        dead: queue.dead,
        sentToday: queue.sentToday,
        suppressed: queue.suppressed,
        oldestDueAgeMs: queue.oldestDueAgeMs,
        healthErrors: runtime ? runtime.healthErrors : 0,
      };
      return json(200, { ok: true, email });
    }

    return json(404, { error: "not found" });
  },
});

console.log(
  `[license] server on ${BASE_URL}:${PORT} (stripe ${stripe ? "configured" : "NOT configured"}, email ${emailEnabled ? "enabled" : "disabled"}, recovery ${recoveryService.configured ? "configured" : "NOT configured"}, invites ${inviteService.configured ? "configured" : "NOT configured"})`
);

// Start the email scheduler AFTER Bun.serve so the server is already
// accepting requests when the immediate microtask tick can fire. No signal
// handlers — the scheduler's interval is unref'd and the process lifetime is
// owned by Bun.serve.
if (emailScheduler) {
  emailScheduler.start();
}