// src/content.js — ISOLATED world: serves stored patterns to the MAIN world on request,
// and relays license messages to the background service worker.
var QS = globalThis.QS || (globalThis.QS = {});
console.log("[QuickSet] bridge ready (ISOLATED world)");

async function relayToWorker(event, workerType, outType) {
  try {
    const result = await chrome.runtime.sendMessage({ type: workerType, payload: event.data.payload });
    window.postMessage({ type: outType, requestId: event.data.requestId, result: result || {} }, "*");
  } catch (err) {
    window.postMessage(
      { type: outType, requestId: event.data.requestId, result: { error: String((err && err.message) || err) } },
      "*"
    );
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
