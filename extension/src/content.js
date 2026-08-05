// src/content.js — ISOLATED world: serves stored patterns to the MAIN world on request
var QS = globalThis.QS || (globalThis.QS = {});
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.type === "qs:request-patterns") {
    try {
      const patterns = await QS.storage.loadPatterns();
      window.postMessage({ type: "qs:patterns", patterns }, "*");
    } catch (e) {
      // never throw into the page
    }
  }
});
