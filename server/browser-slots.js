// server/browser-slots.js — Slice 4A standalone browser-family slot service.
//
// Frozen contract: one Chrome slot + one Edge slot per license. This module is
// intentionally STANDALONE: it owns its own BEGIN IMMEDIATE transactions and
// must never run inside an outer transaction from db.js/index.js. It also
// creates only the browser_slots table (no migrations) so it can be exercised
// in isolation by the integration owner and by unit tests.
//
// Frozen result shapes:
//   success activation: { valid:true, activated:<bool>, code:"ok", browserFamily }
//   success validation: { valid:true, code:"ok", browserFamily }
//   failure:            { valid:false, code:<reason>, browserFamily:<family|null>, actions:<object|null> }
// Only `slot-occupied` (family clash) carries actions
// { manageInstallations:true, buyAnotherSeat:true }. Results never include the
// raw license key or instance id.
import { Database } from "bun:sqlite";

export const BROWSER_FAMILIES = Object.freeze(["chrome", "edge"]);

const SLOT_OCCUPIED_ACTIONS = Object.freeze({ manageInstallations: true, buyAnotherSeat: true });

/** Create exactly the browser_slots table. Idempotent; no other tables/migrations. */
export function createBrowserSlotsSchema(db) {
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
  return db;
}

const isBlank = (v) => typeof v !== "string" || v.trim() === "";

const failure = (code, browserFamily, actions = null) => ({
  valid: false,
  code,
  browserFamily: browserFamily ?? null,
  actions,
});

/** Normalize the service-seam input {licenseKey, browserFamily, instanceId}. */
function normalizeInput({ licenseKey, browserFamily, instanceId } = {}) {
  if (typeof licenseKey === "undefined" || typeof browserFamily === "undefined" || typeof instanceId === "undefined") {
    return { ok: false, result: failure("invalid-input", null) };
  }
  if (isBlank(licenseKey) || isBlank(instanceId)) {
    return { ok: false, result: failure("invalid-input", null) };
  }
  if (browserFamily !== "chrome" && browserFamily !== "edge") {
    return { ok: false, result: failure("family-undetermined", null) };
  }
  return {
    ok: true,
    value: { licenseKey: licenseKey.trim(), browserFamily, instanceId: instanceId.trim() },
  };
}

/**
 * Activate a browser-family slot for a license. Standalone: owns its own
 * BEGIN IMMEDIATE so concurrent contenders serialize and exactly one wins.
 * Fails closed — never silently replaces an existing binding.
 */
export function activateBrowserSlot(db, input, { now } = {}) {
  const n = normalizeInput(input);
  if (!n.ok) return n.result;
  const { licenseKey, browserFamily, instanceId } = n.value;
  const t = typeof now === "number" && Number.isFinite(now) ? now : Date.now();

  db.exec("BEGIN IMMEDIATE");
  try {
    const lic = db.query(`SELECT status FROM licenses WHERE key = ?`).get(licenseKey);
    if (!lic) {
      db.exec("COMMIT");
      return failure("unknown-key", browserFamily);
    }
    if (lic.status !== "active" && lic.status !== "trialing") {
      db.exec("COMMIT");
      return failure(`license-${lic.status}`, browserFamily);
    }

    const slot = db
      .query(`SELECT instance_id FROM browser_slots WHERE license_key = ? AND browser_family = ?`)
      .get(licenseKey, browserFamily);
    if (slot) {
      if (slot.instance_id === instanceId) {
        // Idempotent re-claim: refresh last_seen_at only.
        db.query(`UPDATE browser_slots SET last_seen_at = ? WHERE license_key = ? AND browser_family = ?`).run(
          t, licenseKey, browserFamily
        );
        db.exec("COMMIT");
        return { valid: true, activated: false, code: "ok", browserFamily };
      }
      // Family already occupied by a different instance.
      db.exec("COMMIT");
      return failure("slot-occupied", browserFamily, SLOT_OCCUPIED_ACTIONS);
    }

    // Empty slot. Ensure the instance isn't already bound elsewhere (another
    // license or family) — fail closed, never replace.
    const elsewhere = db
      .query(`SELECT license_key FROM browser_slots WHERE instance_id = ?`)
      .get(instanceId);
    if (elsewhere) {
      db.exec("ROLLBACK");
      return failure("slot-occupied", browserFamily, SLOT_OCCUPIED_ACTIONS);
    }

    try {
      db.query(
        `INSERT INTO browser_slots (license_key, browser_family, instance_id, activated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(licenseKey, browserFamily, instanceId, t, t);
    } catch (err) {
      // UNIQUE(instance_id) / PRIMARY KEY collision (e.g. a concurrent
      // contender) -> fail closed without replacement. Still a slot-occupied
      // rejection, so it carries the same frozen actions as the other paths.
      db.exec("ROLLBACK");
      return failure("slot-occupied", browserFamily, SLOT_OCCUPIED_ACTIONS);
    }
    db.exec("COMMIT");
    return { valid: true, activated: true, code: "ok", browserFamily };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* connection already rolled back */
    }
    throw err;
  }
}

/**
 * Validate a browser-family slot. STRICTLY READ-ONLY — never inserts or
 * refreshes last_seen_at. Accepts {now} for signature symmetry but ignores it.
 */
export function validateBrowserSlot(db, input, { now } = {}) {
  const n = normalizeInput(input);
  if (!n.ok) return n.result;
  const { licenseKey, browserFamily, instanceId } = n.value;

  const lic = db.query(`SELECT status FROM licenses WHERE key = ?`).get(licenseKey);
  if (!lic) return failure("unknown-key", browserFamily);
  if (lic.status !== "active" && lic.status !== "trialing") return failure(`license-${lic.status}`, browserFamily);

  const slot = db
    .query(`SELECT instance_id FROM browser_slots WHERE license_key = ? AND browser_family = ?`)
    .get(licenseKey, browserFamily);
  if (!slot) return failure("not-activated", browserFamily);
  if (slot.instance_id !== instanceId) return failure("slot-mismatch", browserFamily);
  return { valid: true, code: "ok", browserFamily };
}

/**
 * Reset one license's slot(s). Seam: the caller is ALREADY AUTHENTICATED at
 * the route level — this service performs no authentication itself. Operation:
 *   browserFamily "chrome"|"edge" -> removes only that slot;
 *   browserFamily "all"           -> removes both slots for that license;
 *   unknown family                -> fails with code "family-undetermined".
 * Returns { code, removed }.
 */
export function resetBrowserSlots(db, { licenseKey, browserFamily } = {}) {
  if (typeof licenseKey !== "string" || licenseKey.trim() === "") {
    return { removed: 0, code: "invalid-input" };
  }
  const cleanKey = licenseKey.trim();
  if (browserFamily === "all") {
    const r = db.query(`DELETE FROM browser_slots WHERE license_key = ?`).run(cleanKey);
    return { removed: r.changes, code: "ok" };
  }
  if (browserFamily !== "chrome" && browserFamily !== "edge") {
    return { removed: 0, code: "family-undetermined" };
  }
  const r = db.query(`DELETE FROM browser_slots WHERE license_key = ? AND browser_family = ?`).run(cleanKey, browserFamily);
  return { removed: r.changes, code: "ok" };
}
