// server/stripe-webhook.js — final shared webhook foundation (Slice 1B-2b).
//
// A testable, dependency-injectable webhook handler. Lives in its own module so
// that importing it in tests does NOT start Bun.serve (index.js is the only
// place that instantiates the server).
//
// Design:
//   * Signature verification is async (stripe.webhooks.constructEventAsync).
//   * Every verified event is applied synchronously through processStripeEvent
//     (idempotent per event_id, atomic rollback on failure). The apply callback
//     is a PLAIN NON-ASYNC function — processStripeEvent rejects thenables.
//   * Subscription lifecycle events are the entitlement authority (monotonic
//     via recordStripeSubscriptionState). Checkout only mints/links a license
//     key and then re-applies any stored authoritative state atomically.
//   * Observability is fully redacted: logs and responses never expose license
//     keys, emails, customer/subscription IDs, raw bodies, signatures, or
//     exception messages.
import {
  processStripeEvent,
  upsertLicense,
  generateKey,
  recordStripeSubscriptionState,
  getStripeSubscriptionState,
  enqueueEmail,
} from "./db.js";
import { buildWelcomeMessage } from "./email.js";

/** Accept Stripe server-side secret or restricted keys; reject publishable keys. */
export function isStripeServerKey(value) {
  return typeof value === "string" && /^(?:sk|rk)_(?:test|live)_/.test(value);
}

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

/** Extract an id from a plain string or an expanded stripe object ({id}). */
function extractId(value) {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id.trim() || null;
  return null;
}

/**
 * Synchronously apply one already-verified Stripe event.
 *
 * Calls processStripeEvent with a PLAIN NON-ASYNC callback so the event is
 * idempotent (per event_id), atomic (rollback on any throw), and the callback
 * never returns a Promise/thenable. Wraps the event-specific business logic
 * (checkout key minting, subscription state authority, invoice/no-op ledger).
 *
 * Returns processStripeEvent's result: { processed, duplicate, result } where
 * result = { action } on success and null on duplicate.
 */
export function applyVerifiedStripeEvent(db, event, { generateKeyFn = generateKey } = {}) {
  const { id, type, created } = event;

  const apply = function applyWebhookEvent(d) {
    const data = event.data && event.data.object;

    switch (type) {
      case "checkout.session.completed": {
        const cs = data || {};
        const subId = extractId(cs.subscription);
        const email =
          (cs.customer_details && cs.customer_details.email) || cs.customer_email || null;
        // A key cannot be delivered without both a subscription and an email —
        // fail the whole event rather than mint an undeliverable key.
        if (!subId || !email) {
          throw new Error("checkout requires a subscription and a customer email");
        }

        // Existing license for this subscription wins: a past_due/canceled
        // license must not be re-activated by the checkout default. Email is
        // normalized (trim+lowercase) inside upsertLicense. upsertLicense always
        // returns the PERSISTED key (replay-safe): a retried/different checkout
        // event must deliver the original key, never a candidate.
        const existing = d
          .query(`SELECT key, status, email FROM licenses WHERE subscription_id = ?`)
          .get(subId);
        const status = existing ? existing.status : "active";

        const persistedKey = upsertLicense(d, {
          key: generateKeyFn(),
          email,
          customerId: cs.customer ? extractId(cs.customer) || null : null,
          subscriptionId: subId,
          status,
        });

        // Apply authoritative stored subscription state atomically (pre-checkout
        // cancel/past_due propagation): a fresh license has a NULL watermark, so
        // the NULL-watermark branch of recordStripeSubscriptionState applies any
        // already-stored state even though the state write itself is stale.
        const stored = getStripeSubscriptionState(d, subId);
        if (stored) {
          recordStripeSubscriptionState(d, {
            subscriptionId: subId,
            status: stored.status,
            currentPeriodEnd: stored.currentPeriodEnd,
            cancelAtPeriodEnd: Boolean(stored.cancelAtPeriodEnd),
            eventCreated: stored.lastEventCreated,
          });
        }

        // One intended welcome per subscription, committed in the SAME
        // transaction as the license + ledger row. Idempotency key is stable
        // per subscription, so an exact duplicate or a different event id for
        // the same subscription collapses to the persisted outbox row (first
        // committed wins) using the persisted key + authoritative email. This
        // only writes the durable row — it never sends or waits for Resend.
        enqueueEmail(d, {
          kind: "welcome",
          licenseKey: persistedKey,
          recipientEmail: email,
          payload: buildWelcomeMessage({ licenseKey: persistedKey, recipient: email }),
          idempotencyKey: `stripe-welcome:${subId}`,
        });

        return { action: "checkout" };
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = data || {};
        const subId = extractId(sub);
        if (!subId) throw new Error("subscription event is missing a subscription id");
        const periodEnd = sub.current_period_end == null ? null : sub.current_period_end;
        if (periodEnd !== null && (typeof periodEnd !== "number" || !Number.isFinite(periodEnd))) {
          throw new Error("subscription event has an invalid current_period_end");
        }
        recordStripeSubscriptionState(d, {
          subscriptionId: subId,
          status: sub.status,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
          eventCreated: created,
        });
        return { action: "subscription-updated" };
      }

      case "customer.subscription.deleted": {
        const sub = data || {};
        const subId = extractId(sub);
        if (!subId) throw new Error("subscription deleted event is missing a subscription id");
        const periodEnd = sub.current_period_end == null ? null : sub.current_period_end;
        if (periodEnd !== null && (typeof periodEnd !== "number" || !Number.isFinite(periodEnd))) {
          throw new Error("subscription deleted event has an invalid current_period_end");
        }
        // deleted FORCES canceled regardless of the payload status.
        recordStripeSubscriptionState(d, {
          subscriptionId: subId,
          status: "canceled",
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
          eventCreated: created,
        });
        return { action: "subscription-deleted" };
      }

      // invoice.payment_succeeded: ledger only. Subscription lifecycle events
      // are the entitlement authority; an invoice must never revive canceled or
      // newer state (and must not touch subscription state either).
      case "invoice.payment_succeeded":
        return { action: "invoice" };

      // Any other verified event: ledger as a safe no-op.
      default:
        return { action: "noop" };
    }
  };

  return processStripeEvent(db, { id, type, created }, apply);
}

/**
 * Build the async Request→Response webhook handler.
 *
 * Dependency-injected for testability: pass the open db, a stripe client (or
 * null when not configured), the webhook secret, and a logger (defaults to
 * console). Imports never start Bun.serve.
 */
export function createStripeWebhookHandler({ db, stripe, webhookSecret, logger = console }) {
  return async function stripeWebhookHandler(req) {
    // Missing configuration: fixed 500, no body/signature processing.
    if (!stripe || !webhookSecret) {
      return json(500, { error: "stripe not configured" });
    }

    const raw = await req.text();
    const sig = req.headers.get("stripe-signature");

    let event;
    try {
      // ASYNC verification (SDK 17 sync constructEvent throws) — keep it async.
      event = await stripe.webhooks.constructEventAsync(raw, sig, webhookSecret);
    } catch {
      // Fixed, fully redacted rejection — never the error message/body/signature.
      logger.error("[webhook] signature rejected");
      return json(400, { error: "webhook signature invalid" });
    }

    const id = event.id;
    const type = event.type;

    let outcome;
    try {
      outcome = applyVerifiedStripeEvent(db, event);
    } catch {
      // Fixed generic 500 + fixed redacted failure log (event id/type only).
      logger.error(`[webhook] processing failed (${type} ${id})`);
      return json(500, { error: "webhook processing failed" });
    }

    // Success log: event type, event id, duplicate flag, non-sensitive action only.
    logger.info(
      `[webhook] ${type} ${id} duplicate=${outcome.duplicate} action=${outcome.result ? outcome.result.action : "none"}`
    );
    return json(200, { received: true, duplicate: outcome.duplicate });
  };
}
