// src/content-main.js — MAIN world: detects the worksheets-per-study dropdown,
// boots the injection, and re-injects per panel (SPA navigation creates a new
// panel per student)
var QS = globalThis.QS || (globalThis.QS = {});
let currentPanel = null;

function requestPatterns() {
  return new Promise((resolve) => {
    const onMsg = (event) => {
      const data = event && event.data;
      if (!data || typeof data !== "object" || data.type !== "qs:patterns") return;
      window.removeEventListener("message", onMsg);
      resolve(data.patterns);
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ type: "qs:request-patterns" }, "*");
    setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve(null);
    }, 2000);
  });
}

async function getPatternsWithRetry() {
  let patterns = await requestPatterns();
  if (!patterns) {
    // ISOLATED listener may not be registered yet (cross-world task ordering)
    await new Promise((r) => setTimeout(r, 300));
    patterns = await requestPatterns();
  }
  if (!patterns) console.warn("[QuickSet] pattern bridge timed out — nothing injected.");
  return patterns;
}

async function boot() {
  try {
    const patterns = await getPatternsWithRetry();
    if (!patterns) return;
    const injected = QS.dropdown.injectUniformOptions(patterns);
    if (!injected && !QS.angular.findMinWorksheetCountList()) {
      console.warn("[QuickSet] Angular component not found — injection disabled on this screen.");
    }
    QS.dropdown.injectPatternSection(patterns, async (raw) => {
      try {
        const result = await QS.blocks.applyPatternToMatchingDays(raw);
        if (result.changed > 0) {
          console.log(`[QuickSet] applied ${raw} to ${result.changed} day(s)`);
        } else {
          const failed = result.results.filter((r) => !r.ok);
          if (failed.length > 0) {
            console.warn(`[QuickSet] ${raw} failed:`, failed.map((f) => f.message || f.errorSec).join("; "));
          } else {
            console.log(`[QuickSet] ${raw} matched 0 day(s) — nothing to change`);
          }
        }
      } catch (e) {
        console.warn("[QuickSet] pattern application failed:", e);
      }
    });
  } catch (err) {
    // spec §4: never throw into the page
    console.warn("[QuickSet] boot failed:", err);
  }
}

// SPA navigation re-creates the panel per student — re-inject per NEW panel
// element, debounced; never a one-shot flag
let debounce = null;
const mo = new MutationObserver(() => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    const panel = document.querySelector(".options.setting-options");
    if (panel && panel !== currentPanel) {
      currentPanel = panel;
      boot();
    }
  }, 250);
});
mo.observe(document.documentElement, { childList: true, subtree: true });
