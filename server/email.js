// server/email.js — Slice 2A: provider-neutral message construction and a
// Resend HTTP adapter (injected fetch). No api key is hardcoded here — the
// adapter is built with an apiKey supplied at runtime (e.g. from .env). The
// string is never logged; only bounded error categories are.
import { normalizeEmail } from "./db.js";

/** Default visible sender / reply-to for transactional license email. */
export const DEFAULT_FROM = "Class Navi Pro Tools <licenses@send.nimira-timer.com>";
export const DEFAULT_REPLY_TO = "support@nimira-timer.com";

/**
 * Build a provider-neutral welcome message ({from, reply_to, to, subject, html}).
 * Recipient is normalized to the canonical address. The license key appears in
 * the body — it is stored in the outbox payload (necessary for delivery) but is
 * NEVER logged by the worker or adapter.
 */
export function buildWelcomeMessage({ licenseKey, recipient, from = DEFAULT_FROM, replyTo = DEFAULT_REPLY_TO }) {
  const to = normalizeEmail(recipient);
  if (!to) throw new TypeError("buildWelcomeMessage: recipient required");
  return {
    from,
    reply_to: replyTo,
    to,
    subject: "Your Class Navi Pro Tools license key",
    html: `<p>Thanks for subscribing to Class Navi Pro Tools.</p>
<p>Your license key is:</p>
<p style="font-size:20px;font-weight:bold;">${licenseKey}</p>
<p>Enter it in the extension to activate. If you ever need to recover it later, use the license recovery email instead of this message.</p>
<p>— Class Navi Pro Tools</p>`,
  };
}

/**
 * Build a provider-neutral family-welcome message ({from, reply_to, to, subject, html}).
 * Same visible sender / reply-to as the paid welcome builder and the same
 * Class Navi Pro Tools brand. The raw license key appears in the body (it is
 * delivered through the durable outbox and never logged). An invite CODE is
 * never included — this builder only receives the minted license key, so the
 * family code never reaches an email.
 */
export function buildFamilyWelcomeMessage({ licenseKey, recipient, from = DEFAULT_FROM, replyTo = DEFAULT_REPLY_TO }) {
  const to = normalizeEmail(recipient);
  if (!to) throw new TypeError("buildFamilyWelcomeMessage: recipient required");
  return {
    from,
    reply_to: replyTo,
    to,
    subject: "Your free Class Navi Pro Tools license key",
    html: `<p>You've been given free access to Class Navi Pro Tools.</p>
<p>Your license key is:</p>
<p style="font-size:20px;font-weight:bold;">${licenseKey}</p>
<p>Enter it in the extension to activate. If you ever need to recover it later, use the license recovery email instead of this message.</p>
<p>— Class Navi Pro Tools</p>`,
  };
}

/**
 * Resend HTTP adapter. `send({idempotencyKey, message})` POSTs to
 * https://api.resend.com/emails with `Idempotency-Key: <idempotencyKey>` so a
 * retry of an ambiguous/transient failure is idempotent end-to-end.
 *
 * Classification (returned to the worker, never bodies/logs):
 *   ok        — 2xx, providerMessageId from response
 *   retryable — network error or 408/409/425/429/5xx
 *   permanent — other 4xx (the message will never succeed as-is)
 */
export function createResendAdapter({ apiKey, fetchFn = fetch, from = DEFAULT_FROM, replyTo = DEFAULT_REPLY_TO } = {}) {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new TypeError("createResendAdapter: apiKey is required");
  }
  return {
    async send({ idempotencyKey, message }) {
      let res;
      try {
        res = await fetchFn("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            from: message.from ?? from,
            reply_to: message.reply_to ?? replyTo,
            to: message.to,
            subject: message.subject,
            html: message.html,
          }),
        });
      } catch {
        return { ok: false, status: 0, retryable: true, permanent: false, providerMessageId: null, network: true };
      }
      const status = typeof res.status === "number" ? res.status : 0;
      if (status >= 200 && status < 300) {
        let providerMessageId = null;
        try {
          const body = await res.json();
          providerMessageId = body.id || null;
        } catch {
          /* 2xx without a parseable id is still a success */
        }
        return { ok: true, status, retryable: false, permanent: false, providerMessageId };
      }
      if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
        return { ok: false, status, retryable: true, permanent: false, providerMessageId: null };
      }
      return { ok: false, status, retryable: false, permanent: true, providerMessageId: null };
    },
  };
}
