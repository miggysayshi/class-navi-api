# Class-Navi Quick Set Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome/Edge Manifest V3 extension that adds assignment patterns (uniform + split like 4-3-3) to Class-Navi's existing "worksheets per study" dropdown, with zero extra UI and no extension-side server writes.

**Architecture:** One MAIN-world content script injects into the existing gear dropdown on the Set List assignment editor (ATD0010P). Single-number patterns are pushed into the app's `minWorksheetUnitCountList` component array; split patterns render as a "Page pattern" section inside the same dropdown panel and reshape day blocks in the DOM (`.setStudyUnitEditorContainer` / `.studyUnit`). The app's own Save writes the server payload (verified block-list format). Patterns live in `chrome.storage.sync` (single source of truth), edited on the options page.

**Tech Stack:** Manifest V3, plain JavaScript (no build step — load unpacked), `chrome.storage.sync`, `bun test` for pure-logic unit tests. Target: Chrome 111+ / Edge (Chromium). Repo: `~/class-navi-api` (has working API client + credentials in `.env` for scratch-set verification).

**Spec:** `docs/superpowers/specs/2026-08-05-class-navi-extension-design.md`
**Spike findings go to:** `extension/docs/spike-*.md`

---

## File Structure

```
extension/
├── manifest.json          MV3 manifest (content script world=MAIN, storage, options page)
├── src/
│   ├── patterns.js        PURE: parse/validate/group/expand patterns — no chrome.* deps
│   ├── storage.js         chrome.storage.sync wrapper + defaults + read-only 10/5
│   ├── angular-hooks.js   find Angular component (ng / __ngContext__), access minWorksheetUnitCountList
│   ├── dropdown.js        inject uniform options + pattern section into gear dropdown
│   ├── day-blocks.js      day row detection + apply pattern to matching days
│   ├── content.js         entry: screen detection, wiring, MutationObserver
│   └── lib.js             shared DOM/event helpers
├── options.html           pattern editor UI
├── options.js             editor logic (load/save storage, validation)
├── test/
│   ├── patterns.test.js   bun test unit tests
│   └── storage.test.js    bun test with chrome.storage mock
├── docs/
│   ├── spike-a-day-blocks.md     (written by Spike A)
│   ├── spike-b-uniform-keys.md   (written by Spike B)
│   └── spike-c-angular.md        (written by Spike C)
└── icons/                 icon16.png, icon48.png, icon128.png (simple generated PNGs)
```

## Spike tasks first

The three spec §7 unknowns are design-shaping. Complete them in order before feature work. All spikes use the live app via browser automation (`https://class-navi.digital.kumon.com/us/index.html`, creds in `~/class-navi-api/.env`) and the API client in `~/class-navi-api` where writes are needed.

### Task 1: Spike A — day-block edit mechanism

**Files:**
- Create: `extension/docs/spike-a-day-blocks.md`

- [ ] **Step 1: Inspect the assignment editor DOM (read-only)**
  Log in, go to Set List → select a student → Start Setting. In the editor, dump the structure of one day row: `document.querySelector('.studyUnit')` outerHTML (first 4000 chars), the block elements, and any controls (inputs, drag handles, +/- buttons, context menus). Record: how a day's blocks are nested, what each block element contains (WorksheetNOFrom/To text), and whether controls exist for splitting/merging blocks.
- [ ] **Step 2: Find the block-edit gesture**
  On the live editor, click/hover each control candidate and record DOM mutations (MutationObserver in console) or visible changes. The user's manual 4-3-3 manipulation is the reference (HAR at `~/Downloads/student setting work 4-3-3.rtf` shows the result: 3 blocks on one `StudyScheduleIndex`). Determine: does the app offer split/merge, or did the user type block boundaries directly?
- [ ] **Step 3: Determine the Angular event protocol**
  For any input/control that changes block boundaries, record which DOM events make Angular update (input/change/click; capture-phase listeners). Note any `ng-reflect-*` attributes that reveal bindings.
- [ ] **Step 4: Write findings**
  `extension/docs/spike-a-day-blocks.md`: DOM structure with selectors, the edit gesture, the event protocol, and a concrete recipe for "replace day's blocks with [4,3,3] starting at WorksheetNO 41". Commit.

### Task 2: Spike B — uniform-key round-trip

**Files:**
- Create: `extension/docs/spike-b-uniform-keys.md`

- [ ] **Step 1: Inject a test key into the live dropdown**
  In the live assignment editor, run in console: locate the component with `minWorksheetUnitCountList` (see Spike C — do Spike C first if needed), push `{value: "4 worksheets per study", key: 4}`, and select it.
- [ ] **Step 2: Observe the day reshape**
  Record what happens to an unassigned/future day's blocks when key 4 is selected (expect: blocks of 4). This proves the app's own UI accepts arbitrary keys.
- [ ] **Step 3: Round-trip with a scratch set (write, then delete)**
  Using `~/class-navi-api` client (`bun run src/index.ts call RegisterStudySetInfo '{...}'` with a `DeleteSetInfoList` entry or a fresh scratch set on the test student), save a set with 4-page blocks, reload the editor, confirm the app renders it and the dropdown reflects it, then delete the scratch set (RegisterStudySetInfo with `DeleteSetInfoList` populated, or the app's delete). NOTE: this writes real data briefly — the scratch set must be deleted in the same step; never leave it behind.
- [ ] **Step 4: Write findings**
  `extension/docs/spike-b-uniform-keys.md`: whether arbitrary keys flow through UI+save, any validation errors, exact payload used. Commit.

### Task 3: Spike C — Angular internals access

**Files:**
- Create: `extension/docs/spike-c-angular.md`

- [ ] **Step 1: Test `ng.getComponent`**
  In the live editor console: `typeof window.ng?.getComponent` and try `ng.getComponent(document.querySelector('.setting-options'))` — record result (production builds often strip it).
- [ ] **Step 2: Build the `__ngContext__` traversal fallback**
  If `ng` is absent, walk from `.setting-options` up through `parentElement`s reading `el.__ngContext__`; for each, if it has an `lView`, scan for an object with a `minWorksheetUnitCountList` property (spread the lView array). Record the working recipe (element, walk depth, property found) — this becomes `angular-hooks.js`.
- [ ] **Step 3: Verify push-and-render**
  Push a new entry into the found array; confirm the dropdown re-renders it without a page reload (Angular zone handles it).
- [ ] **Step 4: Write findings**
  `extension/docs/spike-c-angular.md` with the exact code recipe. Commit.

## Feature tasks

### Task 4: Extension skeleton

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/icons/icon16.png`, `icon48.png`, `icon128.png`
- Create: `extension/.gitignore` (node_modules only if added later)

- [ ] **Step 1: Write manifest.json**

```json
{
  "manifest_version": 3,
  "name": "Class-Navi Quick Set",
  "version": "0.1.0",
  "description": "More assignment patterns (4-3-3, 3-2-3-2, ...) in the Class-Navi worksheets-per-study dropdown.",
  "permissions": ["storage"],
  "host_permissions": ["https://class-navi.digital.kumon.com/*"],
  "content_scripts": [
    {
      "matches": ["https://class-navi.digital.kumon.com/*"],
      "js": ["src/patterns.js", "src/storage.js", "src/angular-hooks.js", "src/day-blocks.js", "src/dropdown.js", "src/content.js"],
      "world": "MAIN",
      "run_at": "document_idle"
    }
  ],
  "options_page": "options.html",
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

- [ ] **Step 2: Generate icons**
  Use `sips`/Python to create three solid-color PNGs (e.g. 2a6df4 with a "Q" — a plain filled square is fine for v1). Verify files exist and are valid PNGs (`file icons/icon16.png`).
- [ ] **Step 3: Load-unpacked smoke test**
  Chrome → chrome://extensions → Developer mode → Load unpacked → `extension/`. Confirm the extension loads with no manifest errors (check the error card). Edge: edge://extensions → same. Commit.

### Task 5: Pattern logic (TDD)

**Files:**
- Create: `extension/src/patterns.js`
- Create: `extension/test/patterns.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/patterns.test.js
import { test, expect } from "bun:test";
import { parsePattern, patternSum, isValidPattern, groupPatternsBySum, expandAcrossDays } from "../src/patterns.js";

test("parsePattern parses and validates", () => {
  expect(parsePattern("4-3-3")).toEqual([4, 3, 3]);
  expect(parsePattern("10")).toEqual([10]);
  expect(parsePattern("4,3,3")).toEqual([4, 3, 3]);
  expect(parsePattern("0-3")).toBeNull();
  expect(parsePattern("4-3-x")).toBeNull();
  expect(parsePattern("4--3")).toBeNull();
  expect(parsePattern("")).toBeNull();
});

test("patternSum sums blocks", () => {
  expect(patternSum([4, 3, 3])).toBe(10);
  expect(patternSum([10])).toBe(10);
});

test("isValidPattern accepts only comma/hyphen separated positive ints", () => {
  expect(isValidPattern("4-3-3")).toBe(true);
  expect(isValidPattern("4,3,3")).toBe(true);
  expect(isValidPattern("4 3 3")).toBe(false);
  expect(isValidPattern("4-0")).toBe(false);
});

test("groupPatternsBySum groups and orders by sum", () => {
  const groups = groupPatternsBySum(["10", "5-5", "4-3-3", "5", "3-2"]);
  expect(groups.map(g => g.sum)).toEqual([5, 10]);
  expect(groups[1].patterns).toEqual(["5-5", "4-3-3"]);
});

test("expandAcrossDays repeats pattern to cover N days", () => {
  expect(expandAcrossDays([4, 3, 3], 6)).toEqual([4, 3, 3, 4, 3, 3]);
  expect(expandAcrossDays([4, 3, 3], 2)).toEqual([4, 3]);
});
```

- [ ] **Step 2: Run tests, verify failure**
  Run: `cd extension && bun test`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement patterns.js**

```js
// src/patterns.js — pure logic, no chrome.* deps
export function parsePattern(raw) {
  if (typeof raw !== "string") return null;
  const parts = raw.trim().split(/[-,]/).map(s => s.trim());
  if (parts.length === 0) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^[1-9]\d*$/.test(p)) return null;
    nums.push(Number(p));
  }
  return nums;
}

export function patternSum(blocks) {
  return blocks.reduce((a, b) => a + b, 0);
}

export function isValidPattern(raw) {
  return parsePattern(raw) !== null;
}

export function groupPatternsBySum(patternStrings) {
  const bySum = new Map();
  for (const raw of patternStrings) {
    const blocks = parsePattern(raw);
    if (!blocks) continue;
    const sum = patternSum(blocks);
    if (!bySum.has(sum)) bySum.set(sum, []);
    bySum.get(sum).push(raw);
  }
  return [...bySum.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sum, patterns]) => ({ sum, patterns }));
}

export function expandAcrossDays(blocks, dayCount) {
  const out = [];
  for (let i = 0; i < dayCount; i++) out.push(blocks[i % blocks.length]);
  return out;
}
```

- [ ] **Step 4: Run tests, verify pass**
  Run: `cd extension && bun test`
  Expected: 5 tests pass. Commit (`feat: pattern parsing logic`).

### Task 6: Storage layer (TDD)

**Files:**
- Create: `extension/src/storage.js`
- Create: `extension/test/storage.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/storage.test.js
import { test, expect, mock } from "bun:test";
import { DEFAULT_PATTERNS, loadPatterns, savePatterns } from "../src/storage.js";

// minimal chrome.storage.sync mock
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
  expect(DEFAULT_PATTERNS).toContain("3-2");
  expect(DEFAULT_PATTERNS).toContain("10");
  expect(DEFAULT_PATTERNS).toContain("5");
});

test("loadPatterns returns defaults when nothing stored", async () => {
  expect(await loadPatterns()).toEqual(DEFAULT_PATTERNS);
});

test("loadPatterns returns stored patterns and filters invalid entries", async () => {
  store.patterns = ["4-3-3", "bad pattern", "3-2", ""];
  expect(await loadPatterns()).toEqual(["4-3-3", "3-2"]);
});

test("savePatterns stores and validates", async () => {
  await savePatterns(["10", "4-3-3", "nope"]);
  expect(store.patterns).toEqual(["10", "4-3-3"]);
});

test("native keys 10 and 5 are read-only (always present)", async () => {
  await savePatterns(["4-3-3"]);
  expect(await loadPatterns()).toContain("10");
  expect(await loadPatterns()).toContain("5");
});
```

- [ ] **Step 2: Run tests, verify failure**
  Run: `cd extension && bun test`
  Expected: FAIL.

- [ ] **Step 3: Implement storage.js**

```js
// src/storage.js
import { isValidPattern } from "./patterns.js";

export const DEFAULT_PATTERNS = ["10", "5", "4-3-3", "3-2-3-2", "2-2-2-2-2", "5-5", "3-2"];
const KEY = "patterns";

async function getSync(keys) {
  return chrome.storage.sync.get(keys);
}

export async function loadPatterns() {
  const { patterns } = await getSync(KEY);
  const stored = Array.isArray(patterns)
    ? patterns.filter((p) => typeof p === "string" && isValidPattern(p))
    : [];
  const merged = [...new Set([...stored, ...DEFAULT_PATTERNS])]; // native 10/5 read-only
  return merged;
}

export async function savePatterns(patternStrings) {
  const clean = [...new Set(patternStrings.filter((p) => typeof p === "string" && isValidPattern(p)))];
  // native keys 10/5 are read-only: always re-merged on load, never removed
  await chrome.storage.sync.set({ [KEY]: clean });
}
```

- [ ] **Step 4: Run tests, verify pass**
  Expected: 5 tests pass. Commit (`feat: pattern storage layer`).

### Task 7: Angular hooks + uniform option injection

**Files:**
- Create: `extension/src/angular-hooks.js`
- Create: `extension/src/dropdown.js` (uniform part)
- Create: `extension/src/lib.js`

- [ ] **Step 1: Implement angular-hooks.js using Spike C findings**

```js
// src/angular-hooks.js — recipe from docs/spike-c-angular.md
export function findMinWorksheetCountList(root = document) {
  // 1) ng debug API if present
  if (window.ng?.getComponent) {
    const el = root.querySelector(".setting-options");
    if (el) {
      const comp = window.ng.getComponent(el);
      if (comp?.minWorksheetUnitCountList) return comp.minWorksheetUnitCountList;
    }
  }
  // 2) __ngContext__ traversal fallback (recipe in spike-c-angular.md)
  // ...exact walk code from spike findings...
  return null;
}
```

  Replace the fallback with the exact traversal from `extension/docs/spike-c-angular.md` (no TODOs — the spike produced the working code).

- [ ] **Step 2: Implement lib.js**

```js
// src/lib.js
export function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function on(el, evt, fn) { el.addEventListener(evt, fn); }

/** Dispatch an event Angular will observe (bubbles + composed, trusted-like). */
export function dispatchAngular(el, evtType) {
  el.dispatchEvent(new Event(evtType, { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}
```

- [ ] **Step 3: Implement uniform injection in dropdown.js**

```js
// src/dropdown.js
import { findMinWorksheetCountList } from "./angular-hooks.js";

const NATIVE_KEYS = new Set([10, 5]);

export function injectUniformOptions(patterns) {
  const list = findMinWorksheetCountList();
  if (!list) return false;
  const existing = new Set(list.map((o) => Number(o.key)));
  let changed = false;
  for (const raw of patterns) {
    const blocks = parsePattern(raw);
    if (!blocks || blocks.length !== 1) continue;      // uniforms only
    const key = blocks[0];
    if (NATIVE_KEYS.has(key) || existing.has(key)) continue; // dedupe
    list.push({ value: `${key} worksheets per study`, key });
    changed = true;
  }
  return changed;
}
```

  (Add the missing `parsePattern` import.)

- [ ] **Step 4: Manual verify in live app**
  Load unpacked; open a student's assignment editor; open the gear dropdown; confirm injected options (4, 3, 2 worksheets) appear once, native 10/5 not duplicated, and selecting one reshapes a future day's blocks. Record observations; do NOT save. Commit (`feat: uniform option injection`).

### Task 8: Pattern section in the dropdown

**Files:**
- Modify: `extension/src/dropdown.js`

- [ ] **Step 1: Implement the pattern section renderer**

```js
// src/dropdown.js (additions)
import { groupPatternsBySum } from "./patterns.js";

export function injectPatternSection(patterns, onPick) {
  const panel = document.querySelector(".options.setting-options");
  if (!panel || document.querySelector(".qs-pattern-section")) return false;
  const groups = groupPatternsBySum(patterns);
  const section = document.createElement("div");
  section.className = "qs-pattern-section";
  section.style.cssText = "padding:8px 12px;border-top:1px solid #d9e2e6;";
  for (const g of groups) {
    const label = document.createElement("div");
    label.textContent = `${g.sum} pages / day`;
    label.style.cssText = "font-size:11px;color:#5b7a86;margin:6px 0 4px;";
    section.appendChild(label);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
    for (const raw of g.patterns) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = raw;
      btn.className = "qs-pattern-btn";
      btn.style.cssText = "padding:3px 10px;border:1px solid #2a6df4;border-radius:12px;background:#fff;color:#2a6df4;cursor:pointer;font-size:12px;";
      btn.addEventListener("click", () => onPick(raw));
      row.appendChild(btn);
    }
    section.appendChild(row);
  }
  panel.appendChild(section);
  return true;
}
```

- [ ] **Step 2: Wire onPick to the day reshape** (see Task 9) — stub now with a console log, replaced in Task 9.
- [ ] **Step 3: Manual verify**
  Load unpacked; open gear dropdown; confirm "Page pattern" section with grouped buttons renders inside the panel, styling matches the app, and clicking logs (stub). Commit (`feat: pattern section UI`).

### Task 9: Day-block reshape (the core)

**Files:**
- Create: `extension/src/day-blocks.js`
- Modify: `extension/src/content.js`

- [ ] **Step 1: Implement day-blocks.js using Spike A findings**

```js
// src/day-blocks.js — selectors/gesture from docs/spike-a-day-blocks.md
import { parsePattern, patternSum } from "./patterns.js";
import { dispatchAngular } from "./lib.js";

export function findDays(root = document) {
  // exact selector from Spike A (e.g. ".studyUnit" rows)
  return qsa(SELECTOR, root);
}

export function dayBlockTotal(dayEl) {
  // from Spike A: sum of block sizes in this day row
  return ...;
}

export function applyPatternToDay(dayEl, blocks) {
  // from Spike A: replace the day's blocks with `blocks` sizes,
  // preserving starting WorksheetNO, using the app's own edit gesture
  // + dispatchAngular on the affected controls
}

export function applyPatternToMatchingDays(patterns, rawPattern) {
  const blocks = parsePattern(rawPattern);
  if (!blocks) return 0;
  const sum = patternSum(blocks);
  let changed = 0;
  for (const day of findDays()) {
    if (dayBlockTotal(day) === sum) {
      applyPatternToDay(day, blocks);
      changed++;
    }
  }
  return changed;
}
```

  Replace every `...` with the Spike A recipe — no TODOs allowed.

- [ ] **Step 2: Wire content.js**

```js
// src/content.js
import { loadPatterns } from "./storage.js";
import { injectUniformOptions, injectPatternSection } from "./dropdown.js";
import { applyPatternToMatchingDays } from "./day-blocks.js";

async function boot() {
  const patterns = await loadPatterns();
  injectUniformOptions(patterns);
  injectPatternSection(patterns, (raw) => {
    const n = applyPatternToMatchingDays(patterns, raw);
    console.log(`[QuickSet] applied ${raw} to ${n} day(s)`);
  });
}

// assignment editor appears via SPA navigation — watch for the dropdown panel
const mo = new MutationObserver(() => {
  if (document.querySelector(".options.setting-options") && !window.__qsBooted) {
    window.__qsBooted = true;
    boot();
  }
});
mo.observe(document.documentElement, { childList: true, subtree: true });
```

- [ ] **Step 3: Manual end-to-end on a scratch set**
  Load unpacked. Create a scratch set via the UI for the test student (or via the API client per Spike B), with several 10-page days. Click `4-3-3` in the pattern section. Verify: every 10-page day reshaped to 4/3/3 blocks, non-matching days untouched. Click the app's **Save**; then read back via `~/class-navi-api`: `bun run src/index.ts call GetStudyResultInfoList '{"StudentID":"...","SubjectCD":"010","WorksheetCD":"...","SystemCountryCD":"USA","CenterID":"00981474","ClassID":"00981475","ClassStudentSeq":...}'` and confirm `InsertSetInfoList`-style blocks (3 blocks per day). Then delete the scratch set (API client `RegisterStudySetInfo` with `DeleteSetInfoList`, or the UI delete). Record payload evidence in the commit message. Commit (`feat: day-block pattern application`).

### Task 10: Options page (pattern editor)

**Files:**
- Create: `extension/options.html`
- Create: `extension/options.js`

- [ ] **Step 1: Write options.html** — list of patterns (checkbox per pattern with native-10/5 read-only), text input + Add button (validated, comma/hyphen separated), Remove/Reorder (up/down) buttons. Minimal inline CSS.
- [ ] **Step 2: Write options.js** — load via `loadPatterns()`, render list, add/remove/reorder via `savePatterns()`, show validation error for invalid input. Native 10/5 rows disabled with "(native)" badge.
- [ ] **Step 3: Manual verify**
  Open options page from chrome://extensions. Add `2-2-2`, reorder, remove it; reload the page — state persists. Invalid input shows an error and doesn't save. Commit (`feat: options page`).

### Task 11: Cross-browser + regression pass

- [ ] **Step 1: Edge load + smoke** — load unpacked in Edge, repeat Task 9 Step 3 on a fresh scratch set (create → pattern → save → read back → delete).
- [ ] **Step 2: Regression** — confirm native 10/5 options still work, other screens (Student List, Marking List, Class Notes) show no injected UI, dropdown absent → no errors in console.
- [ ] **Step 3: Final commit** (`chore: cross-browser verification`).

### Task 12: README + wrap-up

**Files:**
- Create: `extension/README.md`

- [ ] **Step 1: Write README.md** — what it does, install (load unpacked, Chrome + Edge), pattern editing, defaults table, architecture summary, security note (extension never writes to the server; the app's Save does), link to spec.
- [ ] **Step 2: Final review** — `git log` should show one commit per task; `bun test` green; extension loads with no console errors on the live app. Commit any last docs.

---

## Definition of Done

- `bun test` green (patterns + storage suites)
- Extension loads unpacked in Chrome and Edge
- In a scratch set: clicking 4-3-3 reshapes all 10-page days, Save produces the verified block-list payload, scratch set deleted after
- No extension UI outside the existing dropdown; no extension writes to the server
- Patterns editable on the options page; 10/5 read-only
