// src/content.js — ISOLATED world: serves stored patterns to the MAIN world on
// request. Patterns relay only — no licensing, no background worker, no
// browser-family seam.
var QS = globalThis.QS || (globalThis.QS = {});
console.log("[QuickSet] bridge ready (ISOLATED world)");

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
});