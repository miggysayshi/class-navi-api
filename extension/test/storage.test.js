// test/storage.test.js
import { test, expect, mock } from "bun:test";
await import("../src/patterns.js"); // QS.patterns — storage.js depends on it at runtime
await import("../src/storage.js");
const { DEFAULT_PATTERNS, loadPatterns, savePatterns } = globalThis.QS.storage;

// minimal chrome.storage.sync mock (chrome is NOT a global in bun)
const store = {};
globalThis.chrome = {
  storage: {
    sync: {
      get: mock(async (keys) => {
        const out = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) out[k] = store[k];
        return out;
      }),
      set: mock(async (obj) => Object.assign(store, obj)),
    },
  },
};

test("defaults include the shipped pattern set", () => {
  expect(DEFAULT_PATTERNS).toContain("4-3-3");
  expect(DEFAULT_PATTERNS).toContain("3-2-3-2");
  expect(DEFAULT_PATTERNS).toContain("2-2-2-2-2");
  expect(DEFAULT_PATTERNS).toContain("5-5");
  expect(DEFAULT_PATTERNS).toContain("10");
  expect(DEFAULT_PATTERNS).not.toContain("5"); // removed entirely (2026-08-11)
  expect(DEFAULT_PATTERNS).not.toContain("3-2"); // removed entirely (2026-08-11)
});

test("loadPatterns returns defaults when nothing stored (first-run seed)", async () => {
  expect(await loadPatterns()).toEqual(DEFAULT_PATTERNS);
  // seeding persists so the user's list becomes authoritative afterwards
  expect(store.patterns).toEqual(DEFAULT_PATTERNS);
});

test("loadPatterns merges stored + native 10, filters invalid and hidden keys, keeps removals removed", async () => {
  store.patterns = ["4-3-3", "bad pattern", "3-2", ""];
  const result = await loadPatterns();
  expect(result).toContain("4-3-3");
  expect(result).not.toContain("3-2"); // hidden pattern never comes back
  expect(result).not.toContain("bad pattern");
  expect(result).not.toContain("");
  // native read-only key always present
  expect(result).toContain("10");
  // the removed uniform option never comes back
  expect(result).not.toContain("5");
  // non-native defaults the user removed stay removed
  expect(result).not.toContain("5-5");
  expect(result).not.toContain("2-2-2-2-2");
});

test("loadPatterns tolerates a non-array stored value", async () => {
  store.patterns = "10";
  const result = await loadPatterns();
  expect(result).toEqual(["10"]);
});

test("savePatterns stores and validates", async () => {
  await savePatterns(["10", "4-3-3", "nope"]);
  expect(store.patterns).toEqual(["10", "4-3-3"]);
});

test("removing defaults in the editor still re-merges native 10 on load", async () => {
  await savePatterns(["4-3-3"]);
  const result = await loadPatterns();
  expect(result).toContain("10");
  expect(result).not.toContain("5");
  expect(result).toEqual(["4-3-3", "10"]); // removed defaults stay removed
});

test("hidden keys (5, 3-2) are dropped from the returned list even when stored", async () => {
  store.patterns = ["5", "3-2", "10", "4-3-3"];
  expect(await loadPatterns()).toEqual(["10", "4-3-3"]);
});
