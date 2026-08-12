// src/content.js — ISOLATED world: serves stored patterns to the MAIN world on request,
// and relays license messages to the background service worker.
var QS = globalThis.QS || (globalThis.QS = {});
console.log("[QuickSet] bridge ready (ISOLATED world)");

/**
 * Send a message to the background worker using the CALLBACK form —
 * the promise form of chrome.runtime.sendMessage can silently resolve
 * undefined in MV3 when the worker responds asynchronously (Edge quirk).
 * Always resolves; surfaces chrome.runtime.lastError when present.
 */
function sendToWorker(workerType, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: workerType, payload }, (response) => {
      const err = chrome.runtime.lastError;
      if (err && err.message) {
        resolve({ error: err.message });
        return;
      }
      resolve(response || {});
    });
  });
}

/**
 * FALLBACK: when the worker path yields nothing usable, fetch the license
 * server DIRECTLY from the ISOLATED world (the server sends CORS headers).
 * Shares the same instance id via chrome.storage.
 */
async function directFetch(workerType, payload) {
  try {
    const path =
      workerType === "qs-license-set-key"
        ? "/api/license/activate"
        : workerType === "qs-license-status"
          ? "/api/license/validate"
          : null;
    if (!path || !payload || !payload.key) return { error: "direct-fetch-unavailable" };
    const st = await chrome.storage.local.get("qsInstance");
    const instance =
      st.qsInstance ||
      (typeof crypto !== "undefined" && crypto.randomUUID && crypto.randomUUID()) ||
      `i-${Date.now()}`;
    if (!st.qsInstance) await chrome.storage.local.set({ qsInstance: instance });
    const resp = await fetch(`http://localhost:8787${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ license_key: payload.key, instance_id: instance }),
    });
    const j = await resp.json();
    return { ...(j || {}), _direct: true };
  } catch (e) {
    return { error: "direct-fetch: " + String((e && e.message) || e) };
  }
}

async function relayToWorker(event, workerType, outType) {
  const out = (result) =>
    window.postMessage({ type: outType, requestId: event.data.requestId, result: result || {} }, "*");
  try {
    const result = await sendToWorker(workerType, event.data.payload);
    console.log(`[QuickSet] ISOLATED: worker replied to ${workerType}:`, JSON.stringify(result).slice(0, 160));
    // a usable worker reply has one of these fields; anything else means the
    // worker path silently failed → fall back to the direct fetch
    if (result && (result.ok !== undefined || result.valid !== undefined || result.activated !== undefined || result.key !== undefined)) {
      out(result);
      return;
    }
    console.log(`[QuickSet] ISOLATED: worker path empty — using direct fetch`);
    const fb = await directFetch(workerType, event.data.payload);
    console.log(`[QuickSet] ISOLATED: direct fetch result:`, JSON.stringify(fb).slice(0, 160));
    out(fb);
  } catch (err) {
    out({ error: String((err && err.message) || err) });
  }
}

window.addEventListener("message", async (event) => {
  const data = event && event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "qs:request-patterns") {
    try {
      const patterns = await QS.storage.loadPatterns();
      window.postMessage({ type: "qs:patterns", patterns }, "*");
    } catch (err) {
      console.warn("[QuickSet] loadPatterns failed, sending defaults:", err);
      // never leave the MAIN world hanging — fall back to shipped defaults
      window.postMessage({ type: "qs:patterns", patterns: [...QS.storage.DEFAULT_PATTERNS] }, "*");
    }
    return;
  }
  if (data.type === "qs:license-status-request") {
    relayToWorker(event, "qs-license-status", "qs:license-status-response");
    return;
  }
  if (data.type === "qs:license-set-key") {
    relayToWorker(event, "qs-license-set-key", "qs:license-set-key-response");
    return;
  }
  if (data.type === "qs:license-set-debug") {
    relayToWorker(event, "qs-license-set-debug", "qs:license-set-debug-response");
  }
});
