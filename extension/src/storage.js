// src/storage.js — classic script; chrome.storage available ONLY in the ISOLATED world
var QS = globalThis.QS || (globalThis.QS = {});
QS.storage = (function () {
  const DEFAULT_PATTERNS = ["10", "5", "4-3-3", "3-2-3-2", "2-2-2-2-2", "5-5", "3-2"];
  const KEY = "patterns";
  function valid(raw) {
    return typeof raw === "string" && QS.patterns.isValidPattern(raw);
  }
  async function loadPatterns() {
    const { patterns } = await chrome.storage.sync.get(KEY);
    const stored = Array.isArray(patterns) ? patterns.filter(valid) : [];
    // native 10/5 are read-only: always re-merged on load
    return [...new Set([...stored, ...DEFAULT_PATTERNS])];
  }
  async function savePatterns(patternStrings) {
    const clean = [...new Set(patternStrings.filter(valid))];
    await chrome.storage.sync.set({ [KEY]: clean });
  }
  return { DEFAULT_PATTERNS, loadPatterns, savePatterns };
})();
