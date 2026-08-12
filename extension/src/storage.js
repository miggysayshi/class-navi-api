// src/storage.js — classic script; chrome.storage available ONLY in the ISOLATED world
var QS = globalThis.QS || (globalThis.QS = {});
QS.storage = (function () {
  const DEFAULT_PATTERNS = ["10", "4-3-3", "3-2-3-2", "2-2-2-2-2", "5-5"];
  // Native dropdown options the app always has — the user cannot remove these.
  const NATIVE_PATTERNS = ["10"];
  // Items removed from the extension ENTIRELY (user requests 2026-08-11):
  // "5 worksheets per study" (a uniform 5-page block is not offered — 10-page
  // blocks get broken into session segments via the pattern buttons) and the
  // "3-2" study pattern.
  const HIDDEN_PATTERNS = ["5", "3-2"];
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
    // Hidden keys are dropped from the result (they linger in storage until the
    // next save rewrites the list without them).
    return [...new Set([...stored, ...NATIVE_PATTERNS])].filter(
      (p) => !HIDDEN_PATTERNS.includes(p),
    );
  }
  async function savePatterns(patternStrings) {
    const clean = [...new Set(patternStrings.filter(valid))];
    await chrome.storage.sync.set({ [KEY]: clean });
  }
  return { DEFAULT_PATTERNS, NATIVE_PATTERNS, HIDDEN_PATTERNS, loadPatterns, savePatterns };
})();
