// server/db.js — license storage (bun:sqlite). A license key is bound to a
// Stripe subscription; the key stays valid while the subscription is active.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

/** License key format: QMP-XXXX-XXXX-XXXX-XXXX (no 0/O/1/I/L). */
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Ordered, versioned schema migrations. Each runs exactly once per database,
 * inside a transaction, after the v1 base tables exist. Prefer additive,
 * idempotent statements so a DB that already has some columns is safe.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: "license-billing-fields",
    up(db) {
      const cols = new Set(db.query(`PRAGMA table_info(licenses)`).all().map((c) => c.name));
      if (!cols.has("source")) {
        db.exec(`ALTER TABLE licenses ADD COLUMN source TEXT NOT NULL DEFAULT 'stripe_paid'`);
      }
      if (!cols.has("current_period_end")) {
        db.exec(`ALTER TABLE licenses ADD COLUMN current_period_end INTEGER`);
      }
      if (!cols.has("cancel_at_period_end")) {
        db.exec(`ALTER TABLE licenses ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0`);
      }
      if (!cols.has("last_stripe_event_created")) {
        db.exec(`ALTER TABLE licenses ADD COLUMN last_stripe_event_created INTEGER`);
      }
    },
  },
  {
    version: 2,
    name: "processed-stripe-events",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS processed_stripe_events (
          event_id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          event_created INTEGER NOT NULL,
          processed_at INTEGER NOT NULL
        )
      `);
    },
  },
  {
    version: 3,
    name: "stripe-subscription-states",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS stripe_subscription_states (
          subscription_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          current_period_end INTEGER,
          cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
          last_event_created INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    },
  },
  {
    version: 4,
    name: "durable-email-outbox",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS email_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL,
          license_key TEXT,
          recipient_email TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          provider_message_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          sent_at INTEGER,
          lease_expires_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS email_suppressions (
          email TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          provider_event_id TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS resend_events (
          provider_event_id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          provider_message_id TEXT,
          received_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 5,
    name: "browser-family-slots",
    up(db) {
      // Exact frozen browser_slots shape (Slice 4A): one Chrome slot + one Edge
      // slot per license. UNIQUE(instance_id) guarantees an install id can never
      // occupy more than one slot. The legacy `instances` table is intentionally
      // left intact (existing device bindings) — routes no longer read it, and we
      // never backfill unknown browser families from it.
      db.exec(`
        CREATE TABLE IF NOT EXISTS browser_slots (
          license_key TEXT NOT NULL,
          browser_family TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          activated_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY (license_key, browser_family),
          UNIQUE (instance_id)
        )
      `);
    },
  },
  {
    version: 6,
    name: "secure-recovery",
    up(db) {
      // Slice 3A frozen shape. management_tokens stores ONLY SHA-256 hex of
      // the plaintext token — the plaintext is returned to the trusted caller
      // once (e.g. for sealing in the durable email outbox) and never persisted.
      // request_limits stores HMAC-SHA256 hex of the raw subject so raw email /
      // IP is never written to disk. Both tables are additive and idempotent.
      db.exec(`
        CREATE TABLE IF NOT EXISTS management_tokens (
          token_hash TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          license_key TEXT NOT NULL,
          purpose TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          used_at INTEGER,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS request_limits (
          subject_key TEXT NOT NULL,
          action TEXT NOT NULL,
          window_start INTEGER NOT NULL,
          count INTEGER NOT NULL,
          PRIMARY KEY(subject_key,action,window_start)
        );
      `);
    },
  },
  {
    version: 7,
    name: "family-invite-codes",
    up(db) {
      // Slice 5A frozen shape. invite_codes stores ONLY SHA-256 hex of each
      // plaintext invite code — the plaintext is returned to the trusted
      // minting caller exactly once and never persisted. admin_audit is the
      // no-secrets audit ledger: masked subjects + detail JSON that never
      // carries codes/hashes/keys/emails. Both tables are additive from the
      // v1-v6 schema and idempotent across reopens.
      db.exec(`
        CREATE TABLE IF NOT EXISTS invite_codes (
          code_hash TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          redeemed_at INTEGER,
          redeemed_email TEXT,
          license_key TEXT,
          revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS admin_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action TEXT NOT NULL,
          subject_masked TEXT,
          detail_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
    },
  },
];

/**
 * Apply pending migrations in version order. Concurrency-hardened:
 * each migration runs inside its own BEGIN IMMEDIATE transaction (a write
 * lock is acquired up front), the applied-versions check happens INSIDE that
 * transaction (never a stale precomputed set), and an already-applied
 * migration commits a no-op transaction. Rollback + rethrow on error.
 */
export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  for (const m of MIGRATIONS) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const already = db
        .query(`SELECT version FROM schema_migrations WHERE version = ?`)
        .get(m.version);
      if (already) {
        db.exec("COMMIT");
        continue;
      }
      m.up(db);
      db.query(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`).run(
        m.version,
        m.name,
        Date.now()
      );
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* connection already rolled back (e.g. COMMIT failed) */
      }
      throw err;
    }
  }
  return db;
}

/**
 * Atomically apply a Stripe webhook event exactly once. (Built behavior by
 * behavior via strict TDD — see server/test/stripe-events.test.js.)
 *
 * Returns { processed, duplicate, result }.
 */
export function processStripeEvent(db, { id, type, created }, apply) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new TypeError("processStripeEvent: event id must be a non-blank string");
  }
  if (typeof type !== "string" || type.trim() === "") {
    throw new TypeError("processStripeEvent: event type must be a non-blank string");
  }
  if (typeof created !== "number" || !Number.isFinite(created)) {
    throw new TypeError("processStripeEvent: event created must be a finite number");
  }
  if (typeof apply !== "function") {
    throw new TypeError("processStripeEvent: apply must be a function");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .query(`SELECT event_id FROM processed_stripe_events WHERE event_id = ?`)
      .get(id);
    if (existing) {
      db.exec("COMMIT");
      return { processed: false, duplicate: true, result: null };
    }
    const result = apply(db);
    if (result !== null && typeof result === "object" && typeof result.then === "function") {
      db.exec("ROLLBACK");
      throw new TypeError(
        "processStripeEvent: apply must be synchronous (returned a Promise/thenable)"
      );
    }
    db.query(
      `INSERT INTO processed_stripe_events (event_id, event_type, event_created, processed_at)
       VALUES (?, ?, ?, ?)`
    ).run(id, type, created, Date.now());
    db.exec("COMMIT");
    return { processed: true, duplicate: false, result };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* connection already rolled back (e.g. COMMIT failed) */
    }
    throw err;
  }
}

/** Map Stripe subscription.status values to our license states. Unknown or
 * missing values fail closed to "canceled" — never a fake grant. */
const STRIPE_STATUS_MAP = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  unpaid: "past_due",
  canceled: "canceled",
  incomplete_expired: "canceled",
  incomplete: "incomplete",
  paused: "paused",
};

export function normalizeStripeSubscriptionStatus(status) {
  if (typeof status !== "string") return "canceled";
  return STRIPE_STATUS_MAP[status] || "canceled";
}

/** Read the authoritative stored subscription state as camelCase, or null. */
function readStripeSubscriptionStateRow(db, subscriptionId) {
  const row = db
    .query(
      `SELECT subscription_id, status, current_period_end, cancel_at_period_end, last_event_created
       FROM stripe_subscription_states WHERE subscription_id = ?`
    )
    .get(subscriptionId);
  if (!row) return null;
  return {
    subscriptionId: row.subscription_id,
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    lastEventCreated: row.last_event_created,
  };
}

/**
 * Persist the latest normalized subscription state and return the
 * authoritative stored state. Synchronous, non-transactional: designed to run
 * inside the synchronous apply callback of processStripeEvent.
 */
export function recordStripeSubscriptionState(
  db,
  { subscriptionId, status, currentPeriodEnd = null, cancelAtPeriodEnd = false, eventCreated }
) {
  if (typeof subscriptionId !== "string" || subscriptionId.trim() === "") {
    throw new TypeError("recordStripeSubscriptionState: subscriptionId must be a non-blank string");
  }
  if (typeof eventCreated !== "number" || !Number.isFinite(eventCreated)) {
    throw new TypeError("recordStripeSubscriptionState: eventCreated must be a finite number");
  }
  if (currentPeriodEnd !== null && (typeof currentPeriodEnd !== "number" || !Number.isFinite(currentPeriodEnd))) {
    throw new TypeError("recordStripeSubscriptionState: currentPeriodEnd must be null or a finite number");
  }
  const normalizedStatus = normalizeStripeSubscriptionStatus(status);
  const cancelFlag = cancelAtPeriodEnd ? 1 : 0;
  const now = Date.now();

  // Monotonic state write: insert when absent; update ONLY when the incoming
  // eventCreated is strictly newer than the stored watermark. Equal or older
  // events are stale and never overwrite the stored state.
  const existing = db
    .query(`SELECT last_event_created FROM stripe_subscription_states WHERE subscription_id = ?`)
    .get(subscriptionId);
  let applied = false;
  if (!existing) {
    db.query(
      `INSERT INTO stripe_subscription_states
         (subscription_id, status, current_period_end, cancel_at_period_end, last_event_created, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(subscriptionId, normalizedStatus, currentPeriodEnd, cancelFlag, eventCreated, now);
    applied = true;
  } else if (eventCreated > existing.last_event_created) {
    db.query(
      `UPDATE stripe_subscription_states
         SET status = ?, current_period_end = ?, cancel_at_period_end = ?, last_event_created = ?, updated_at = ?
       WHERE subscription_id = ?`
    ).run(normalizedStatus, currentPeriodEnd, cancelFlag, eventCreated, now, subscriptionId);
    applied = true;
  }

  const state = readStripeSubscriptionStateRow(db, subscriptionId);

  // Monotonic license propagation: only when the state's watermark is strictly
  // newer than the license's (or the license has no watermark yet). This byte
  // range of fields is the ONLY data we may change on the license.
  let licenseUpdated = false;
  if (state) {
    const lic = db
      .query(`SELECT last_stripe_event_created FROM licenses WHERE subscription_id = ?`)
      .get(subscriptionId);
    if (
      lic &&
      (lic.last_stripe_event_created === null || state.lastEventCreated > lic.last_stripe_event_created)
    ) {
      db.query(
        `UPDATE licenses
           SET status = ?, current_period_end = ?, cancel_at_period_end = ?, last_stripe_event_created = ?, updated_at = ?
         WHERE subscription_id = ?`
      ).run(
        state.status,
        state.currentPeriodEnd,
        state.cancelAtPeriodEnd,
        state.lastEventCreated,
        now,
        subscriptionId
      );
      licenseUpdated = true;
    }
  }

  return { applied, licenseUpdated, state };
}

/** Read the authoritative stored subscription state (camelCase) or null. */
export function getStripeSubscriptionState(db, subscriptionId) {
  if (typeof subscriptionId !== "string" || subscriptionId.trim() === "") {
    throw new TypeError("getStripeSubscriptionState: subscriptionId must be a non-blank string");
  }
  return readStripeSubscriptionStateRow(db, subscriptionId);
}

export function generateKey() {
  const bytes = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
  return `QMP-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

/** Open (creating) the license DB. Pass ":memory:" for tests. */
export function openDb(path = "license.db") {
  const db = new Database(path);
  // Set immediately after opening, before any schema creation/migration:
  // concurrent writers must wait on the lock instead of failing immediately.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
      key TEXT PRIMARY KEY,
      email TEXT,
      customer_id TEXT,
      subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS instances (
      license_key TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      activated_at INTEGER NOT NULL,
      PRIMARY KEY (license_key, instance_id)
    );
  `);
  migrate(db);
  return db;
}

/** Create a license for a subscription (idempotent per subscription_id). */
export function upsertLicense(db, { key, email, customerId, subscriptionId, status = "active" }) {
  const now = Date.now();
  const cleanEmail = String(email || "").trim().toLowerCase() || null;
  db.query(
    `INSERT INTO licenses (key, email, customer_id, subscription_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subscription_id) DO UPDATE SET
       email = excluded.email, status = excluded.status, updated_at = excluded.updated_at`
  ).run(key, cleanEmail, customerId || null, subscriptionId, status, now, now);
  // Always return the persisted key for this subscription: on conflict the
  // candidate key is discarded and the original row's key must win (webhook replay).
  const row = db.query(`SELECT key FROM licenses WHERE subscription_id = ?`).get(subscriptionId);
  return row ? row.key : key;
}

/** Update a subscription's license status (webhook path). Returns the key. */
export function setSubscriptionStatus(db, subscriptionId, status) {
  const row = db.query(`SELECT key FROM licenses WHERE subscription_id = ?`).get(subscriptionId);
  if (!row) return null;
  db.query(`UPDATE licenses SET status = ?, updated_at = ? WHERE subscription_id = ?`).run(status, Date.now(), subscriptionId);
  return row.key;
}

export function findLicense(db, key) {
  return db.query(`SELECT * FROM licenses WHERE key = ?`).get(key) || null;
}

/**
 * Validate + bind an instance. Rules: key exists, status active (or
 * trialing), and the instance is already bound OR the instance count is
 * below MAX_INSTANCES. Returns { valid, reason, expiresAt, activated }.
 */
export function activateInstance(db, key, instanceId, maxInstances) {
  const lic = findLicense(db, key);
  if (!lic) return { valid: false, reason: "unknown-key" };
  if (lic.status !== "active" && lic.status !== "trialing") {
    return { valid: false, reason: `license-${lic.status}` };
  }
  const bound = db
    .query(`SELECT COUNT(*) AS n FROM instances WHERE license_key = ?`)
    .get(key);
  const already = db
    .query(`SELECT 1 FROM instances WHERE license_key = ? AND instance_id = ?`)
    .get(key, instanceId);
  const limit = maxInstances && maxInstances > 0 ? maxInstances : 3;
  if (!already && bound.n >= limit) {
    return { valid: false, reason: "instance-limit" };
  }
  if (!already) {
    db.query(`INSERT INTO instances (license_key, instance_id, activated_at) VALUES (?, ?, ?)`).run(
      key,
      instanceId,
      Date.now()
    );
  }
  return { valid: true, reason: "ok", expiresAt: lic.expires_at || null, activated: !already };
}

/** Email → its licenses (for the portal page). Case-insensitive. */
export function licensesForEmail(db, email) {
  const clean = String(email || "").toLowerCase().trim();
  if (!clean) return [];
  return db.query(`SELECT key, status, expires_at FROM licenses WHERE email = ? ORDER BY created_at`).all(clean);
}

/** Mint N fresh active license keys for an email (admin path). */
export function issueKeys(db, email, count) {
  const clean = String(email || "").toLowerCase().trim();
  const n = Math.max(1, Number(count) || 1);
  const stamp = Date.now();
  const keys = [];
  for (let i = 0; i < n; i++) {
    const key = generateKey();
    upsertLicense(db, {
      key,
      email: clean,
      customerId: "admin",
      subscriptionId: `admin-${stamp}-${i}`,
      status: "active",
    });
    keys.push(key);
  }
  return keys;
}

/* ────────────────────────────── Durable email outbox ───────────────────────
 * Synchronous SQL helpers for the durable email outbox, suppression list, and
 * provider-event ledger (Slice 2A). All are plain synchronous functions that
 * do NOT open a transaction of their own, so they compose inside
 * processStripeEvent's apply callback (which already owns a BEGIN IMMEDIATE).
 * The claim/consume helpers wrap only their own atomic BEGIN IMMEDIATE.
 */

/** Normalize a recipient email: trim + lowercase, or null when blank. */
export function normalizeEmail(email) {
  const s = String(email || "").trim().toLowerCase();
  return s || null;
}

/** Bounded retry delay (ms): exponential growth capped at maxMs. */
export function nextRetryDelayMs(attempts, baseMs = 60000, maxMs = 3600000) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(baseMs * Math.pow(2, n - 1), maxMs);
}

/**
 * Enqueue one durable outbox row. Idempotent per idempotencyKey: a duplicate
 * key returns the persisted row unchanged (authoritative first-write wins).
 * Non-transactional so it can run inside processStripeEvent's apply.
 */
export function enqueueEmail(
  db,
  { kind, licenseKey = null, recipientEmail, payload = {}, idempotencyKey, createdAt = Date.now() }
) {
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
    throw new TypeError("enqueueEmail: idempotencyKey must be a non-blank string");
  }
  const email = normalizeEmail(recipientEmail);
  if (!email) throw new TypeError("enqueueEmail: recipientEmail required");
  const existing = db.query(`SELECT * FROM email_outbox WHERE idempotency_key = ?`).get(idempotencyKey);
  if (existing) return existing;
  // Centralize recipient normalization here: the stored payload's `to` reflects
  // the authoritative normalized email so the worker always sends to the
  // canonical address.
  const normalizedPayload = payload && typeof payload.to === "string" ? { ...payload, to: email } : payload;
  db.query(
    `INSERT INTO email_outbox
       (kind, license_key, recipient_email, payload_json, idempotency_key, status, attempts, next_attempt_at, last_error, created_at, sent_at, lease_expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, NULL, NULL)`
  ).run(kind, licenseKey, email, JSON.stringify(normalizedPayload), idempotencyKey, createdAt, createdAt);
  return db.query(`SELECT * FROM email_outbox WHERE idempotency_key = ?`).get(idempotencyKey);
}

/**
 * Atomically claim the single oldest due (pending/retry) row and lease it.
 * BEGIN IMMEDIATE holds the write lock so concurrent claims yield exactly one
 * winner. Returns the claimed row (attempts incremented) or null when none due.
 */
export function claimOneDueEmail(db, { now = Date.now(), leaseMs = 60000 } = {}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .query(
        `SELECT * FROM email_outbox
         WHERE (status IN ('pending','retry') AND next_attempt_at <= ?)
            OR (status = 'sending' AND lease_expires_at <= ?)
         ORDER BY id ASC LIMIT 1`
      )
      .get(now, now);
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.query(
      `UPDATE email_outbox SET status='sending', attempts = attempts + 1, lease_expires_at=? WHERE id=?`
    ).run(now + leaseMs, row.id);
    db.exec("COMMIT");
    return db.query(`SELECT * FROM email_outbox WHERE id=?`).get(row.id);
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/**
 * Atomically claim one due row AND reserve against the free-plan daily cap in
 * the SAME write transaction. The cap is enforced as
 * `sent in the current UTC day + active unexpired sending reservations < dailyCap`.
 * Counting only `sent` rows inside the transaction is insufficient: the first
 * send has not completed yet, so its in-flight claim must hold a reservation.
 * Two connections serializing on `BEGIN IMMEDIATE` therefore can never both
 * cross the cap (the second sees the first's reservation and declines to claim,
 * leaving the unclaimed row pending).
 *
 * Returns { state, row }:
 *   - `{ state: 'claimed', row }` — a row was claimed and reserved;
 *   - `{ state: 'idle',    row: null }` — nothing is due at this moment;
 *   - `{ state: 'daily-cap', row: null }` — rows are due but the cap (sent +
 *     active reservations) is already saturated; the due row is left pending.
 */
export function claimOneDueEmailUnderCap(
  db,
  { now = Date.now(), leaseMs = 60000, dailyCap }
) {
  if (!Number.isFinite(dailyCap) || dailyCap < 0) {
    throw new TypeError("claimOneDueEmailUnderCap: dailyCap must be a non-negative number");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const sentToday = countSentInUtcDay(db, now);
    const activeRes = db
      .query(
        `SELECT COUNT(*) AS n FROM email_outbox
         WHERE status='sending' AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`
      )
      .get(now).n;
    if (sentToday + activeRes >= dailyCap) {
      db.exec("COMMIT");
      return { state: "daily-cap", row: null };
    }
    const row = db
      .query(
        `SELECT * FROM email_outbox
         WHERE (status IN ('pending','retry') AND next_attempt_at <= ?)
            OR (status = 'sending' AND lease_expires_at <= ?)
         ORDER BY id ASC LIMIT 1`
      )
      .get(now, now);
    if (!row) {
      db.exec("COMMIT");
      return { state: "idle", row: null };
    }
    db.query(
      `UPDATE email_outbox SET status='sending', attempts = attempts + 1, lease_expires_at=? WHERE id=?`
    ).run(now + leaseMs, row.id);
    db.exec("COMMIT");
    return { state: "claimed", row: db.query(`SELECT * FROM email_outbox WHERE id=?`).get(row.id) };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}
/**
 * Mark a claimed row sent (provider message id + sent_at recorded).
 * Ownership-guarded: the UPDATE only applies if the row is still `sending`
 * AND held by THIS claim (matching exact lease_expires_at + attempts from the
 * claimed row). A late completion from a reclaimed/stale owner is a no-op that
 * cannot overwrite a newer owner's state. Returns affected-row count (0 = no-op).
 */
export function markEmailSent(
  db,
  id,
  { providerMessageId = null, sentAt = Date.now(), leaseExpiresAt = null, attempts = null } = {}
) {
  return db
    .query(
      `UPDATE email_outbox
       SET status='sent', provider_message_id=?, sent_at=?, last_error=NULL, lease_expires_at=NULL
       WHERE id=? AND status='sending' AND lease_expires_at=? AND attempts=?`
    )
    .run(providerMessageId, sentAt, id, leaseExpiresAt, attempts).changes;
}

/**
 * Reschedule a claimed row for a transient failure with bounded backoff.
 * Ownership-guarded identically to markEmailSent. Returns affected-row count.
 */
export function rescheduleEmailRetry(
  db,
  id,
  { attempts, category, now = Date.now(), baseMs = 60000, maxMs = 3600000, leaseExpiresAt = null } = {}
) {
  const delay = nextRetryDelayMs(attempts, baseMs, maxMs);
  return db
    .query(
      `UPDATE email_outbox SET status='retry', next_attempt_at=?, last_error=?, lease_expires_at=NULL
       WHERE id=? AND status='sending' AND lease_expires_at=? AND attempts=?`
    )
    .run(now + delay, sanitizeCategory(category), id, leaseExpiresAt, attempts).changes;
}

/**
 * Mark a claimed row permanently dead (stop automatic retries).
 * Ownership-guarded identically to markEmailSent. Returns affected-row count.
 */
export function markEmailDead(
  db,
  id,
  { category, leaseExpiresAt = null, attempts = null } = {}
) {
  return db
    .query(
      `UPDATE email_outbox SET status='dead', last_error=?, lease_expires_at=NULL
       WHERE id=? AND status='sending' AND lease_expires_at=? AND attempts=?`
    )
    .run(sanitizeCategory(category), id, leaseExpiresAt, attempts).changes;
}

/** Bounded, non-sensitive error category persisted to last_error (never a body). */
function sanitizeCategory(category) {
  if (typeof category !== "string" || category.trim() === "") return "error";
  const s = category.trim();
  return s.length > 80 ? s.slice(0, 80) : s;
}

/** Idempotently add a suppression for a normalized email. */
export function addSuppression(db, { email, reason, providerEventId = null, createdAt = Date.now() } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new TypeError("addSuppression: email required");
  const existing = db.query(`SELECT 1 FROM email_suppressions WHERE email=?`).get(normalized);
  if (existing) return { added: false, email: normalized };
  db.query(
    `INSERT INTO email_suppressions (email, reason, provider_event_id, created_at) VALUES (?, ?, ?, ?)`
  ).run(normalized, reason || "unknown", providerEventId, createdAt);
  return { added: true, email: normalized };
}

/** True when the normalized email is suppressed. */
export function isSuppressed(db, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return !!db.query(`SELECT 1 FROM email_suppressions WHERE email=?`).get(normalized);
}

/** Idempotently record a raw provider event (duplicate is a no-op). */
export function recordResendEvent(
  db,
  { providerEventId, type, providerMessageId = null, receivedAt = Date.now() }
) {
  if (typeof providerEventId !== "string" || providerEventId.trim() === "") {
    throw new TypeError("recordResendEvent: providerEventId required");
  }
  const existing = db.query(`SELECT 1 FROM resend_events WHERE provider_event_id=?`).get(providerEventId);
  if (existing) return { recorded: false, duplicate: true };
  db.query(
    `INSERT INTO resend_events (provider_event_id, event_type, provider_message_id, received_at) VALUES (?, ?, ?, ?)`
  ).run(providerEventId, type || "unknown", providerMessageId, receivedAt);
  return { recorded: true, duplicate: false };
}

const RESEND_TYPE_TO_STATE = {
  "email.delivered": "delivered",
  "email.delayed": "delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
};
const SUPPRESSING_STATES = new Set(["bounced", "complained", "suppressed"]);

/**
 * Consume an ALREADY VERIFIED Resend provider event. Dedupes provider event id
 * (duplicate is a no-op), records delivered/delayed/bounced/complained/failed/
 * suppressed state, and creates a suppression for bounce/complaint/suppressed.
 * Atomic (own BEGIN IMMEDIATE). Signature/verification is OUT of scope here —
 * callers must verify the webhook before invoking this.
 */
export function consumeResendEvent(
  db,
  { providerEventId, type, providerMessageId = null, recipient = null, receivedAt = Date.now() }
) {
  if (typeof providerEventId !== "string" || providerEventId.trim() === "") {
    throw new TypeError("consumeResendEvent: providerEventId required");
  }
  if (typeof type !== "string" || type.trim() === "") {
    throw new TypeError("consumeResendEvent: type required");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const dup = recordResendEvent(db, { providerEventId, type, providerMessageId, receivedAt });
    if (dup.duplicate) {
      db.exec("COMMIT");
      return { recorded: false, duplicate: true, state: null, suppressed: false };
    }
    const state = RESEND_TYPE_TO_STATE[type] || "unknown";
    let suppressed = false;
    if (SUPPRESSING_STATES.has(state) && recipient) {
      addSuppression(db, { email: recipient, reason: state, providerEventId });
      suppressed = true;
    }
    db.exec("COMMIT");
    return { recorded: true, duplicate: false, state, suppressed };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

/**
 * PII-free queue snapshot for /health. Validates a finite numeric timestamp,
 * counts outbox statuses, and surfaces `oldestDueAgeMs` (the age of the
 * oldest DUE pending/retry + expired-sending row, or null when none are due).
 *
 * Returns ONLY primitives/null — no recipient/license/payload/error text.
 */
export function emailQueueHealth(db, now = Date.now()) {
  if (typeof now !== "number" || !Number.isFinite(now)) {
    throw new TypeError("emailQueueHealth: now must be a finite number");
  }
  const pending =
    db.query(`SELECT COUNT(*) AS n FROM email_outbox WHERE status='pending'`).get().n;
  const retry =
    db.query(`SELECT COUNT(*) AS n FROM email_outbox WHERE status='retry'`).get().n;
  const sending =
    db.query(`SELECT COUNT(*) AS n FROM email_outbox WHERE status='sending'`).get().n;
  const dead =
    db.query(`SELECT COUNT(*) AS n FROM email_outbox WHERE status='dead'`).get().n;
  const suppressed =
    db.query(`SELECT COUNT(*) AS n FROM email_suppressions`).get().n;
  const sentToday = countSentInUtcDay(db, now);

  // Oldest DUE row: pending/retry whose next_attempt_at <= now, OR sending
  // whose lease has already expired. MIN(created_at) across that set gives
  // the oldest still-claimable row; age = max(0, now - MIN(created_at)).
  const oldest = db
    .query(
      `SELECT MIN(created_at) AS m FROM email_outbox
       WHERE (status IN ('pending','retry') AND next_attempt_at <= ?)
          OR (status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)`
    )
    .get(now, now);
  let oldestDueAgeMs = null;
  if (oldest && typeof oldest.m === "number" && Number.isFinite(oldest.m)) {
    oldestDueAgeMs = Math.max(0, now - oldest.m);
  }

  return { pending, retry, sending, dead, sentToday, suppressed, oldestDueAgeMs };
}

/** Number of outbox rows marked sent within the UTC day of `timestamp`. */
export function countSentInUtcDay(db, timestamp = Date.now()) {
  const d = new Date(timestamp);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const end = start + 86400000;
  return db
    .query(`SELECT COUNT(*) AS n FROM email_outbox WHERE status='sent' AND sent_at >= ? AND sent_at < ?`)
    .get(start, end).n;
}
