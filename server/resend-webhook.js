// server/resend-webhook.js — Svix-verified Resend webhook core.
//
// A testable, dependency-injectable webhook handler. Lives in its own module so
// that importing it in tests does NOT start Bun.serve (index.js is the only
// place that instantiates the server).
//
// Design:
//   * Signature verification is synchronous (svix Webhook.verify).
//   * Verified events are applied synchronously through consumeResendEvent
//     (idempotent per providerEventId, atomic via its own BEGIN IMMEDIATE).
//   * Observability is fully redacted: logs and responses never expose
//     provider event/message ids, raw bodies, signature header values, recipient
//     addresses, payload type strings, or exception messages.
import { Webhook } from "svix";
import { consumeResendEvent } from "./db.js";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/**
 * Pull the first non-blank string recipient from a Resend event's `to` array.
 * Returns null when the field is missing, empty, contains no usable string,
 * or is not an array.
 */
function firstRecipient(data) {
  const arr = data && data.to;
  if (!Array.isArray(arr)) return null;
  for (const v of arr) {
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * Map `created_at` (top-level on the verified Resend payload) to integer ms.
 *   * finite number  → Math.trunc(value)
 *   * date-parseable string (non-empty, finite) → Date.parse(value)
 *   * anything else (null/undefined/NaN/non-string/non-parseable/"") → null
 * Caller falls back to `now()` when this returns null.
 *
 * Resend places `created_at` at the TOP level. We never read data.created_at.
 */
function parseCreatedAt(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    return null;
  }
  return null;
}

/**
 * Apply one already-verified Resend event synchronously.
 *
 * The Svix message id (== provider event id) is supplied via `options.providerEventId`
 * and is NEVER attached to the verified payload. The verified payload is read-only.
 *
 * Throws TypeError on malformed verified payloads so the wrapper can return a
 * fixed generic 500.
 */
export function applyVerifiedResendEvent(
  db,
  payload,
  { consumeFn = consumeResendEvent, now = Date.now, providerEventId } = {}
) {
  if (!payload || typeof payload !== "object") {
    throw new TypeError("verified payload must be an object");
  }
  const type = payload.type;
  if (typeof type !== "string" || type.trim() === "") {
    throw new TypeError("verified payload type required");
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : null;
  if (!data) throw new TypeError("verified payload data required");
  const emailId = data.email_id;
  if (typeof emailId !== "string" || emailId.trim() === "") {
    throw new TypeError("verified payload data.email_id required");
  }
  const recipient = firstRecipient(data);
  if (!recipient) {
    throw new TypeError("verified payload data.to has no usable recipient");
  }
  // Top-level created_at only — never data.created_at.
  const receivedAt = parseCreatedAt(payload.created_at) ?? now();

  return consumeFn(db, {
    providerEventId,
    type: type.trim(),
    providerMessageId: emailId.trim(),
    recipient,
    receivedAt,
  });
}

/**
 * Build the Request→Response webhook handler.
 *
 * Dependency-injected for testability: pass the open db, the Svix webhook
 * secret (or null when not configured), and a logger (defaults to console).
 * The webhook secret is the literal `whsec_<base64-key>` string Resend gives
 * the operator; the Svix Webhook class is constructed with it directly.
 * Imports never start Bun.serve.
 */
export function createResendWebhookHandler({
  db,
  webhookSecret,
  logger = console,
  now = Date.now,
  WebhookClass = Webhook,
  consumeFn = consumeResendEvent,
} = {}) {
  return async function resendWebhookHandler(req) {
    // Missing configuration: fixed 500, no body/header processing, no log.
    if (typeof webhookSecret !== "string" || webhookSecret.trim() === "") {
      return json(500, { error: "resend not configured" });
    }

    // Read raw body once. Svix must verify against the exact bytes received.
    let raw;
    try {
      raw = await req.text();
    } catch {
      // Unreadable body — fixed 400 with one fixed redacted log line.
      logger.error("[resend-webhook] signature invalid");
      return json(400, { error: "webhook signature invalid" });
    }

    const svixId = req.headers.get("svix-id");
    const svixTs = req.headers.get("svix-timestamp");
    const svixSig = req.headers.get("svix-signature");
    if (!svixId || !svixTs || !svixSig) {
      logger.error("[resend-webhook] signature invalid");
      return json(400, { error: "webhook signature invalid" });
    }

    // Svix Webhook.verify throws on missing/invalid/stale signatures.
    let payload;
    try {
      payload = new WebhookClass(webhookSecret).verify(raw, {
        "svix-id": svixId,
        "svix-timestamp": svixTs,
        "svix-signature": svixSig,
      });
    } catch {
      // Fixed, fully redacted rejection — one fixed log, never the error text.
      logger.error("[resend-webhook] signature invalid");
      return json(400, { error: "webhook signature invalid" });
    }

    let outcome;
    try {
      outcome = applyVerifiedResendEvent(db, payload, {
        consumeFn,
        now,
        providerEventId: svixId,
      });
    } catch {
      // Fixed generic 500 + fixed redacted failure log.
      logger.error("[resend-webhook] processing failed");
      return json(500, { error: "webhook processing failed" });
    }

    // Success log: duplicate flag only — no ids, recipients, type, or payload.
    logger.info(`[resend-webhook] duplicate=${outcome.duplicate}`);
    return json(200, { received: true, duplicate: outcome.duplicate });
  };
}
