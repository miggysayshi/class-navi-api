// server/email-worker.js — Slice 2A: bounded one-tick email worker.
//
// `createEmailWorker(...)` returns an async `deliverNext()` that claims at most
// ONE outbox row with a lease, checks suppression + the free-plan daily cap
// BEFORE sending, calls the injected provider-neutral sender OUTSIDE the Stripe
// webhook, and records the outcome (sent / retry with bounded backoff / dead).
// No daemon or route is started here — a later slice schedules the ticks.
//
// Observability is fully redacted: logs carry only fixed text + bounded status
// numbers/counts. Recipient, license key, payload, and provider error bodies
// are NEVER logged.
import {
  claimOneDueEmailUnderCap,
  markEmailSent,
  markEmailDead,
  rescheduleEmailRetry,
  isSuppressed,
  countSentInUtcDay,
} from "./db.js";

export function createEmailWorker({
  db,
  sender,
  now = () => Date.now(),
  leaseMs = 60000,
  dailyCap = 100,
  warnAt = 80,
  retryBaseMs,
  retryMaxMs,
  logger = console,
  prepareMessage,
}) {
  // Default prepareMessage is identity: it accepts the {row, payload} shape
  // (matching the injected recovery preparer) and returns the payload
  // unchanged. The recovery row path uses a richer preparer that opens
  // seals, re-verifies the management_tokens rows, and refreshes expiries
  // immediately before send.
  const prepare = typeof prepareMessage === "function"
    ? prepareMessage
    : ({ payload } = {}) => payload;
  return async function deliverNext() {
    const ts = now();
    const sentToday = countSentInUtcDay(db, ts);
    const warning = sentToday >= warnAt;
    // Fast path: already at/over the cap — nothing to claim/send; rows stay pending.
    if (sentToday >= dailyCap) {
      logger.warn(`[email] daily cap reached (${sentToday}/${dailyCap})`);
      return { state: "daily-cap", sent: false, warning: true };
    }

    // Atomic claim + cap reservation: `sent today + active unexpired sending
    // reservations < dailyCap` is enforced INSIDE the claim's write transaction,
    // so two concurrent worker ticks (even on separate DB connections) can never
    // both cross the cap. The worker distinguishes "idle" (nothing due) from
    // "daily-cap" (due but saturated) and never drops unclaimed rows.
    const res = claimOneDueEmailUnderCap(db, { now: ts, leaseMs, dailyCap });
    if (res.state === "daily-cap") {
      logger.warn(`[email] daily cap reserved (${sentToday}/${dailyCap})`);
      return { state: "daily-cap", sent: false, warning: true };
    }
    if (res.state === "idle") return { state: "idle", sent: false, warning };
    const row = res.row;

    // Suppressed recipients never send again without an explicit override.
    if (isSuppressed(db, row.recipient_email)) {
      const applied = markEmailDead(db, row.id, {
        category: "suppressed",
        leaseExpiresAt: row.lease_expires_at,
        attempts: row.attempts,
      });
      logger.info("[email] suppressed recipient skipped");
      return { state: applied ? "suppressed" : "stale", sent: false, warning };
    }

    let payload = {};
    try {
      payload = JSON.parse(row.payload_json || "{}");
    } catch {
      payload = {};
    }

    // Send-time preparation: for non-recovery rows the default identity
    // returns payload unchanged. For recovery rows the injected preparer
    // opens seals, re-verifies tokens, and refreshes expiries immediately
    // before the provider send. A preparation failure is a fixed, redacted
    // dead-letter event — the sender is never called, the row is marked
    // dead with category=preparation, and the log line is the fixed
    // `[email] message preparation failed` with no error object, no
    // payload bytes, no key, email, or token.
    let message;
    try {
      message = await prepare({ row, payload });
    } catch {
      const applied = markEmailDead(db, row.id, {
        category: "preparation",
        leaseExpiresAt: row.lease_expires_at,
        attempts: row.attempts,
      });
      logger.warn("[email] message preparation failed");
      return { state: applied ? "dead" : "stale", sent: false, warning };
    }

    const outcome = await sender.send({ idempotencyKey: row.idempotency_key, message });

    // Attribution/recovery timestamps come from COMPLETION (now AFTER the
    // provider call), never the earlier claim time: a provider call that
    // crosses a UTC midnight must record sent_at on the completion day (so the
    // hard daily-cap day-count is not undercounted), and a retry must be
    // scheduled from completion so a long provider call can never schedule a
    // retry in the past.
    const completion = now();

    if (outcome.ok) {
      const applied = markEmailSent(db, row.id, {
        providerMessageId: outcome.providerMessageId || null,
        sentAt: completion,
        leaseExpiresAt: row.lease_expires_at,
        attempts: row.attempts,
      });
      return { state: applied ? "sent" : "stale", sent: !!applied, warning };
    }
    if (outcome.permanent) {
      const applied = markEmailDead(db, row.id, {
        category: `http_${outcome.status}`,
        leaseExpiresAt: row.lease_expires_at,
        attempts: row.attempts,
      });
      logger.warn(`[email] permanent failure (${outcome.status})`);
      return { state: applied ? "dead" : "stale", sent: false, warning };
    }
    // Retryable (408/409/425/429/5xx/network ambiguity): bounded backoff, and
    // the same idempotency key is reused so the provider dedupes the retry.
    const applied = rescheduleEmailRetry(db, row.id, {
      attempts: row.attempts,
      category: outcome.network ? "network" : `http_${outcome.status}`,
      now: completion,
      baseMs: retryBaseMs,
      maxMs: retryMaxMs,
      leaseExpiresAt: row.lease_expires_at,
    });
    logger.warn(`[email] transient failure (${outcome.network ? "network" : outcome.status}), will retry`);
    return { state: applied ? "retry" : "stale", sent: false, warning };
  };
}
