// src/background.js — MV3 service worker: Quick Mark Pro license validation.
// The MAIN world content scripts have no chrome.* access, so the ISOLATED
// world bridge (src/content.js) relays requests here via
// chrome.runtime.sendMessage. Validates against OUR license server (see
// server/ in this repo — it issues keys and listens for Stripe webhooks).
// Results are cached; the MAIN world derives the final state (active /
// grace / invalid / unreachable / unlicensed / …).
//
const API_BASE = "https://license.nimira-timer.com";
const LS_VALIDATE = `${API_BASE}/api/license/validate`;
const LS_ACTIVATE = `${API_BASE}/api/license/activate`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // re-validate online at most once/day
const GRACE_MS = 7 * 24 * 60 * 60 * 1000; // offline grace (mirrors license.js)

// Build-time browser-family seam (mirrors src/license.js). Deterministic and
// fixed — NEVER derived from the browser's user-agent string. The current
// package is Edge; a Chrome build flips this one constant.
const BROWSER_FAMILY = "edge";

var QS = globalThis.QS || (globalThis.QS = {});

/**
 * Pure: build a license-server request body carrying the fixed browser_family
 * (snake_case; exactly "chrome" or "edge") alongside license_key/instance_id.
 * Shared by BOTH activation and validation so they cannot drift.
 */
function buildRequestBody(base, family) {
  const f = family === "chrome" || family === "edge" ? family : BROWSER_FAMILY;
  return Object.assign({}, base || {}, { browser_family: f });
}

/**
 * Pure: true when the server payload carries a NONBLANK failure `error`.
 * Reasons may arrive in the `error` field as well as `code`. A payload that
 * says success (valid:true / activated:true) while carrying a failure error
 * is a malformed/attack answer and must FAIL CLOSED — never treated as a
 * success. `error:null`/`undefined`/empty string are NOT failures (genuine
 * legacy/frozen success may carry them).
 */
function hasFailureError(j) {
  if (!j) return false;
  const e = j.error;
  if (e === null || e === undefined) return false;
  if (typeof e === "string") return e.trim() !== "";
  return true;
}

function responseReason(j) {
  if (!j) return null;
  const reason = j.code || j.error;
  return reason === null || reason === undefined ? null : String(reason);
}

function isValidationSuccess(j) {
  return !!(j && j.valid === true && (!j.code || j.code === "ok") && !hasFailureError(j));
}

function isActivationSuccess(j) {
  return !!(
    j &&
    !hasFailureError(j) &&
    (j.activated === true || (j.valid === true && j.code === "ok"))
  );
}

async function getInstance() {
  const st = await chrome.storage.local.get(["qsInstance"]);
  if (st.qsInstance) return st.qsInstance;
  const id =
    (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
    `i-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await chrome.storage.local.set({ qsInstance: id });
  return id;
}

async function readAll() {
  return chrome.storage.local.get(["qsKey", "qsInstance", "qsCache"]);
}

async function callLS(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

/**
 * Raw license status for the MAIN world to derive from. Never throws.
 * Cache semantics (Slice 7A): only a NETWORK failure may keep a recent-valid
 * cache for offline grace. Any authoritative server response that is not
 * valid:true clears the cache so the client can never grace from a revoked
 * or blocked license.
 */
async function status() {
  try {
    const st = await readAll();
    const instance = st.qsInstance || (await getInstance());
    const out = {
      key: !!st.qsKey,
      instance,
      validation: null,
      cache: st.qsCache || null,
      error: null,
    };
    if (!st.qsKey) return out;
    const now = Date.now();
    // fresh valid cache is trustworthy (avoids a network hit on every load)
    if (st.qsCache && st.qsCache.valid === true && now - st.qsCache.checkedAt < CACHE_TTL_MS) {
      out.validation = st.qsCache;
      return out;
    }
    try {
      const requestBody = buildRequestBody({ license_key: st.qsKey, instance_id: instance });
      let j = await callLS(LS_VALIDATE, requestBody);

      // One-time legacy transition. Migration v5 cannot infer a browser family
      // from old flat `instances` rows, and validation must remain read-only.
      // When a stored key is otherwise entitled but has no family slot, make a
      // separate activation request with the worker-held key/family/instance,
      // then validate again. Never loop, never expose the key to the page.
      if (!isValidationSuccess(j) && responseReason(j) === "not-activated") {
        // The server already answered authoritatively. Clear any stale valid
        // cache BEFORE activation so an activation network failure cannot
        // restore offline grace.
        await chrome.storage.local.set({ qsCache: null });
        out.cache = null;
        try {
          const activation = await callLS(LS_ACTIVATE, requestBody);
          if (isActivationSuccess(activation)) {
            // Revalidate the newly claimed slot. If this follow-up network call
            // fails, the verified activation response remains authoritative.
            try {
              j = await callLS(LS_VALIDATE, requestBody);
            } catch {
              j = activation;
            }
          } else {
            j = activation;
          }
        } catch {
          // The read-only validation already proved `not-activated`; keep that
          // authoritative blocked state and retry the transition next status
          // check. Do not convert this into a network-grace result.
          j = { valid: false, code: "not-activated", error: "not-activated" };
        }
      }

      const errorMsg = j && (j.error || j.message) ? String(j.error || j.message) : null;
      // FAIL CLOSED: valid:true is only a success when there is NO code (legacy
      // validation response) or the code is exactly "ok" (frozen success), AND
      // there is no nonblank failure `error` (the reason may arrive in `error`
      // as well as `code`). A payload saying valid:true while carrying any
      // frozen failure code (family-undetermined, license-canceled, ...) or a
      // failure error is treated as an authoritative failure here, NOT a success.
      if (isValidationSuccess(j)) {
        const cache = {
          valid: true,
          checkedAt: now,
          expiresAt: j.expiresAt ? j.expiresAt : null,
          currentPeriodEnd: j.current_period_end || j.currentPeriodEnd || null,
          cancelAtPeriodEnd: !!(j.cancel_at_period_end || j.cancelAtPeriodEnd),
          error: null,
        };
        await chrome.storage.local.set({ qsCache: cache });
        out.validation = cache;
        out.cache = cache;
      } else {
        // authoritative failure (revoked / blocked / slot / invalid) — clear
        // any previously-valid cache so the client NEVER enters grace from it
        await chrome.storage.local.set({ qsCache: null });
        const reason = responseReason(j);
        const cache = {
          valid: false,
          checkedAt: now,
          reason,
          error: errorMsg || "license rejected",
          currentPeriodEnd: j && (j.current_period_end || j.currentPeriodEnd) || null,
          cancelAtPeriodEnd: !!(j && (j.cancel_at_period_end || j.cancelAtPeriodEnd)),
        };
        out.validation = cache;
        out.cache = null;
        out.blocked = true;
        out.blockedReason = reason;
        out.blockedMessage = errorMsg;
      }
    } catch (e) {
      // network failure — keep the old cache; the MAIN world grants grace
      // from it only when it is recent AND valid
      out.error = String(e && e.message ? e.message : e);
    }
    return out;
  } catch (e) {
    return { key: false, instance: null, validation: null, cache: null, error: String(e && e.message ? e.message : e) };
  }
}

/** Activate a key (binds it to this instance) or clear when key is "". */
async function setKey(key) {
  try {
    const instance = await getInstance();
    const clean = String(key || "").trim();
    if (!clean) {
      await chrome.storage.local.set({ qsKey: null, qsCache: null });
      return { ok: true, action: "cleared" };
    }
    try {
      const j = await callLS(
        LS_ACTIVATE,
        buildRequestBody({ license_key: clean, instance_id: instance })
      );
      if (isActivationSuccess(j)) {
        // Success. `activated` may be false when the server's idempotent
        // same-instance answer comes back as {valid:true, activated:false,
        // code:"ok"} — that is STILL a success, just not a new binding.
        // Legacy success is {activated:true}. FAIL CLOSED: a payload that
        // merely says valid:true while carrying any OTHER (frozen failure)
        // code (family-undetermined, license-canceled, ...) is NOT accepted,
        // and neither is any payload carrying a nonblank failure `error`
        // (the reason may arrive in `error` as well as `code`) — including a
        // contradictory {activated:true, error:'...'} failure.
        // Period timestamps arrive as Stripe Unix SECONDS; persist them so
        // the MAIN world can render accurate period-end copy.
        const cache = {
          valid: true,
          checkedAt: Date.now(),
          expiresAt: j.expiresAt || null,
          currentPeriodEnd: j.current_period_end || j.currentPeriodEnd || null,
          cancelAtPeriodEnd: !!(j.cancel_at_period_end || j.cancelAtPeriodEnd),
        };
        await chrome.storage.local.set({ qsKey: clean, qsCache: cache });
        return {
          ok: true,
          activated: !!(j.activated),
          expiresAt: j.expiresAt || null,
          currentPeriodEnd: cache.currentPeriodEnd,
          cancelAtPeriodEnd: cache.cancelAtPeriodEnd,
        };
      }
      // activation failure (e.g. slot-occupied) — surface only the server's
      // stable reason/message/actions; never forward the raw response object
      return {
        ok: false,
        message: (j && (j.error || j.message)) || "activation rejected",
        reason: (j && (j.code || j.error)) || null,
        actions: j && j.actions,
      };
    } catch (e) {
      // offline: store the key anyway — validation happens later and the
      // MAIN world shows unreachable/grace honestly
      await chrome.storage.local.set({ qsKey: clean });
      return { ok: true, activated: false, pending: true, message: String(e && e.message ? e.message : e) };
    }
  } catch (e) {
    return { ok: false, message: String(e && e.message ? e.message : e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  try {
    if (msg.type === "qs-license-status") {
      status().then(sendResponse);
      return true; // async response
    }
    if (msg.type === "qs-license-set-key") {
      setKey(msg.payload && msg.payload.key).then(sendResponse);
      return true;
    }

  } catch (e) {
    // never leave the caller hanging — surface the failure
    sendResponse({ error: String(e && e.message ? e.message : e) });
    return true;
  }
});

// Expose pure helpers so the worker's request-shaping is unit-testable
// (harmless in the real service worker; used by test/license.test.js).
QS.background = { BROWSER_FAMILY, buildRequestBody, status, setKey };

console.log("[QuickSet] license worker v3 ready (version " + chrome.runtime.getManifest().version + ")");
