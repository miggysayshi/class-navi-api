// src/storage.js — classic script; chrome.storage available ONLY in the ISOLATED world
var QS = globalThis.QS || (globalThis.QS = {});
QS.storage = (function () {
  const DEFAULT_PATTERNS = ["10", "5", "4-3-3", "3-2-3-2", "2-2-2-2-2", "5-5", "3-2"];
  // Native dropdown options the app always has — the user cannot remove these.
  const NATIVE_PATTERNS = ["10", "5"];
  const KEY = "patterns";
  function valid(raw) {
    return typeof raw === "string" && QS.patterns.isValidPattern(raw);
  }
  async function loadPatterns() {
    const { patterns } = await chrome.storage.sync.get(KEY);
    if (patterns === undefined) {
      // First run: seed the shipped defaults once; afterwards the stored list is authoritative.
      await chrome.storage.sync.set({ [KEY]: DEFAULT_PATTERNS });
      return [...DEFAULT_PATTERNS];
    }
    const stored = Array.isArray(patterns) ? patterns.filter(valid) : [];
    // Re-merge ONLY the native read-only keys — everything else the user can remove.
    return [...new Set([...stored, ...NATIVE_PATTERNS])];
  }
  async function savePatterns(patternStrings) {
    const clean = [...new Set(patternStrings.filter(valid))];
    await chrome.storage.sync.set({ [KEY]: clean });
  }
  return { DEFAULT_PATTERNS, NATIVE_PATTERNS, loadPatterns, savePatterns };
})();
