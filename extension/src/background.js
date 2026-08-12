// src/background.js — MV3 service worker: Quick Mark Pro license validation.
// The MAIN world content scripts have no chrome.* access, so the ISOLATED
// world bridge (src/content.js) relays requests here via
// chrome.runtime.sendMessage. Fetches LemonSqueezy's license API (no CORS
// from the extension context). Results are cached; the MAIN world derives
// the final state (active / grace / invalid / unreachable / unlicensed).
const LS_VALIDATE = "https://api.lemonsqueezy.com/v1/licenses/validate";
const LS_ACTIVATE = "https://api.lemonsqueezy.com/v1/licenses/activate";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // re-validate online at most once/day
const GRACE_MS = 7 * 24 * 60 * 60 * 1000; // offline grace (mirrors license.js)

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
  return chrome.storage.local.get(["qsKey", "qsInstance", "qsCache", "qsLicenseDebug"]);
}

async function callLS(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

/** Raw license status for the MAIN world to derive from. Never throws. */
async function status() {
  try {
    const st = await readAll();
    const instance = st.qsInstance || (await getInstance());
    const out = {
      key: !!st.qsKey,
      instance,
      debug: st.qsLicenseDebug || null,
      validation: null,
      cache: st.qsCache || null,
      error: null,
    };
    if (!st.qsKey) return out;
    const now = Date.now();
    // fresh cache is trustworthy (avoids a network hit on every page load)
    if (st.qsCache && st.qsCache.valid === true && now - st.qsCache.checkedAt < CACHE_TTL_MS) {
      out.validation = st.qsCache;
      return out;
    }
    try {
      const j = await callLS(LS_VALIDATE, { license_key: st.qsKey, instance_id: instance });
      const valid = !!(j && j.valid === true);
      const cache = {
        valid,
        checkedAt: now,
        expiresAt: j && j.license_key ? j.license_key.expires_at : null,
        error: j && j.error ? String(j.error) : null,
      };
      await chrome.storage.local.set({ qsCache: cache });
      out.validation = cache;
      out.cache = cache;
    } catch (e) {
      // network failure — keep the old cache; the MAIN world grants grace
      // from it when it is recent and valid
      out.error = String(e && e.message ? e.message : e);
    }
    return out;
  } catch (e) {
    return { key: false, instance: null, debug: null, validation: null, cache: null, error: String(e && e.message ? e.message : e) };
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
      const j = await callLS(LS_ACTIVATE, { license_key: clean, instance_id: instance });
      if (j && j.activated === true) {
        await chrome.storage.local.set({
          qsKey: clean,
          qsCache: { valid: true, checkedAt: Date.now(), expiresAt: j.license_key ? j.license_key.expires_at : null },
        });
        return { ok: true, activated: true, expiresAt: j.license_key ? j.license_key.expires_at : null };
      }
      return { ok: false, message: (j && j.error) || "activation rejected", detail: j };
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

async function setDebug(value) {
  await chrome.storage.local.set({ qsLicenseDebug: value || null });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "qs-license-status") {
    status().then(sendResponse);
    return true; // async response
  }
  if (msg.type === "qs-license-set-key") {
    setKey(msg.payload && msg.payload.key).then(sendResponse);
    return true;
  }
  if (msg.type === "qs-license-set-debug") {
    setDebug(msg.payload && msg.payload.value).then(sendResponse);
    return true;
  }
});

console.log("[QuickSet] license worker ready");
