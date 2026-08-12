// server/db.js — license storage (bun:sqlite). A license key is bound to a
// Stripe subscription; the key stays valid while the subscription is active.
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

/** License key format: QMP-XXXX-XXXX-XXXX-XXXX (no 0/O/1/I/L). */
const KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateKey() {
  const bytes = randomBytes(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
  return `QMP-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}`;
}

/** Open (creating) the license DB. Pass ":memory:" for tests. */
export function openDb(path = "license.db") {
  const db = new Database(path);
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
  return db;
}

/** Create a license for a subscription (idempotent per subscription_id). */
export function upsertLicense(db, { key, email, customerId, subscriptionId, status = "active" }) {
  const now = Date.now();
  db.query(
    `INSERT INTO licenses (key, email, customer_id, subscription_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subscription_id) DO UPDATE SET
       email = excluded.email, status = excluded.status, updated_at = excluded.updated_at`
  ).run(key, email || null, customerId || null, subscriptionId, status, now, now);
  return key;
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
