# Class-Navi Quick Set Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome/Edge Manifest V3 extension that adds assignment patterns (uniform + split like 4-3-3) to Class-Navi's existing "worksheets per study" dropdown, with zero extra UI and no extension-side server writes.

**Architecture:** TWO content-script worlds, per the approved spec (§3.1):
- **MAIN world** (`content-main.js` + helpers): page context — Angular internals (`minWorksheetUnitCountList`), dropdown DOM, day-block reshaping.
- **ISOLATED world** (`content.js` + `storage.js`): has `chrome.storage`; hands patterns to MAIN via `window.postMessage`.
MAIN-world scripts cannot use `chrome.*` APIs and manifest content scripts cannot use static ES imports — all extension files are **classic scripts** sharing a `globalThis.QS` namespace, loaded in dependency order (no build step). Single-number patterns are pushed into the app's `minWorksheetUnitCountList`; split patterns render as a "Page pattern" section inside the same gear dropdown and reshape day blocks (`.setStudyUnitEditorContainer` / `.studyUnit`). The app's own Save writes the server payload (verified block-list format). Patterns live in `chrome.storage.sync` (single source of truth), edited on the options page.

**Tech Stack:** Manifest V3, classic JavaScript (no build step — load unpacked), `chrome.storage.sync`, `window.postMessage` bridge, `bun test` for pure-logic unit tests (tests import the classic scripts as side-effect modules and read `globalThis.QS`). Target: Chrome 111+ / Edge (Chromium). Repo: `~/class-navi-api` (working API client + credentials in `.env` for scratch-set verification).

**Spec:** `docs/superpowers/specs/2026-08-05-class-navi-extension-design.md`
**Spike findings go to:** `extension/docs/spike-*.md`

---

## File Structure

```
extension/
├── manifest.json          MV3 manifest (MAIN + ISOLATED content script entries, storage, options page)
├── src/
│   ├── patterns.js        PURE classic script → QS.patterns: parse/validate/group/expand — no chrome.* deps
│   ├── lib.js             classic → QS.lib: qsa, on, dispatchAngular (Angular-observed events)
│   ├── angular-hooks.js   classic → QS.angular: find Angular component, access minWorksheetUnitCountList
│   ├── dropdown.js        classic → QS.dropdown: inject uniform options + pattern section into gear dropdown
│   ├── day-blocks.js      classic → QS.blocks: day row detection + apply pattern to matching days
│   ├── content-main.js    classic MAIN-world entry: panel detection, postMessage bridge, boot/re-inject
│   ├── storage.js         classic → QS.storage (ISOLATED only): chrome.storage.sync wrapper + defaults
│   └── content.js         classic ISOLATED entry: postMessage bridge (serves patterns on request)
├── options.html           pattern editor UI (chrome.storage available natively in options pages)
├── options.js             editor logic (load/save storage, validation, 10/5 read-only)
├── test/
│   ├── patterns.test.js   bun test (side-effect import of src/patterns.js)
│   └── storage.test.js    bun test with chrome.storage mock (side-effect import of src/storage.js)
├── docs/
│   ├── spike-a-day-blocks.md     (written by Spike A)
│   ├── spike-b-uniform-keys.md   (written by Spike B)
│   └── spike-c-angular.md        (written by Spike C)
└── icons/                 icon16.png, icon48.png, icon128.png (simple generated PNGs)
```

**Script-loading order (manifest arrays = dependency order):**
- MAIN entry: `patterns.js`, `lib.js`, `angular-hooks.js`, `day-blocks.js`, `dropdown.js`, `content-main.js`
- ISOLATED entry: `patterns.js`, `storage.js`, `content.js`

## Spike tasks first

The three spec §7 unknowns are design-shaping. Complete them in order before feature work
(Spike C before Spike B — B's console injection needs C's component-location recipe). All
spikes use the live app via browser automation (`https://class-navi.digital.kumon.com/us/index.html`,
creds in `~/class-navi-api/.env`) and the API client in `~/class-navi-api` where writes are
needed. NOTE: the reference file `~/Downloads/student setting work 4-3-3.rtf` is a HAR saved
as RTF (convert with `textutil -convert txt` before parsing).

### Task 1: Spike A — day-block edit mechanism

**Files:**
- Create: `extension/docs/spike-a-day-blocks.md`

- [ ] **Step 1: Inspect the assignment editor DOM (read-only)**
  Log in, go to Set List → select a student → Start Setting. In the editor, dump the structure of one day row: `document.querySelector('.studyUnit')` outerHTML (first 4000 chars), the block elements, and any controls (inputs, drag handles, +/- buttons, context menus). Record: how a day's blocks are nested, what each block element contains (WorksheetNOFrom/To text), and whether controls exist for splitting/merging blocks.
- [ ] **Step 2: Find the block-edit gesture**
  On the live editor, click/hover each control candidate and record DOM mutations (MutationObserver in console) or visible changes. The user's manual 4-3-3 manipulation is the reference (HAR at `~/Downloads/student setting work 4-3-3.rtf` — convert from RTF first; it shows the result: 3 blocks on one `StudyScheduleIndex`). Determine: does the app offer split/merge, or did the user type block boundaries directly?
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
  Using `~/class-navi-api` client (`bun run src/index.ts call RegisterStudySetInfo '{...}'`), save a scratch set with 4-page blocks on the test student, reload the editor, confirm the app renders it and the dropdown reflects it, then delete the scratch set (RegisterStudySetInfo with `DeleteSetInfoList` populated, or the UI delete). NOTE: this writes real data briefly — the scratch set must be deleted in the same step; never leave it behind.
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
- Create: `extension/.gitignore`

- [ ] **Step 1: Write manifest.json** (two worlds — MAIN for Angular access, ISOLATED for chrome.storage)

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
      "js": [
        "src/patterns.js",
        "src/lib.js",
        "src/angular-hooks.js",
        "src/day-blocks.js",
        "src/dropdown.js",
        "src/content-main.js"
      ],
      "world": "MAIN",
      "run_at": "document_idle"
    },
    {
      "matches": ["https://class-navi.digital.kumon.com/*"],
      "js": ["src/patterns.js", "src/storage.js", "src/content.js"],
      "run_at": "document_idle"
    }
  ],
  "options_page": "options.html",
  "icons": { "16": "icons/icon16.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
}
```

- [ ] **Step 2: Generate icons**
  Use Python to create three solid-color PNGs (2a6df4 square — fine for v1). Verify with `file icons/icon16.png` → "PNG image data".
- [ ] **Step 3: Load-unpacked smoke test**
  Chrome → chrome://extensions → Developer mode → Load unpacked → `extension/`. Confirm no manifest errors. Edge: edge://extensions → same. Commit.

### Task 5: Pattern logic (TDD)

**Files:**
- Create: `extension/src/patterns.js` (classic script → `QS.patterns`)
- Create: `extension/test/patterns.test.js`

- [ ] **Step 1: Write the failing tests** (bun test; side-effect import of the classic script)

```js
// test/patterns.test.js
import { test, expect } from "bun:test";
await import("../src/patterns.js");
const { parsePattern, patternSum, isValidPattern, groupPatternsBySum, expandAcrossDays } =
  globalThis.QS.patterns;

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
  expect(groups.map((g) => g.sum)).toEqual([5, 10]);
  expect(groups[1].patterns).toEqual(["10", "5-5", "4-3-3"]); // insertion order
});

test("expandAcrossDays repeats pattern to cover N days", () => {
  expect(expandAcrossDays([4, 3, 3], 6)).toEqual([4, 3, 3, 4, 3, 3]);
  expect(expandAcrossDays([4, 3, 3], 2)).toEqual([4, 3]);
});
```

- [ ] **Step 2: Run tests, verify failure**
  Run: `cd extension && bun test`
  Expected: FAIL (`Cannot find module '../src/patterns.js'` or `QS is undefined`).

- [ ] **Step 3: Implement patterns.js** (classic script — NO import/export statements)

```js
// src/patterns.js — classic script; pure logic; attaches to globalThis.QS
var QS = globalThis.QS || (globalThis.QS = {});
QS.patterns = (function () {
  function parsePattern(raw) {
    if (typeof raw !== "string") return null;
    const parts = raw.trim().split(/[-,]/).map((s) => s.trim());
    if (parts.length === 0) return null;
    const nums = [];
    for (const p of parts) {
      if (!/^[1-9]\d*$/.test(p)) return null;
      nums.push(Number(p));
    }
    return nums;
  }
  function patternSum(blocks) {
    return blocks.reduce((a, b) => a + b, 0);
  }
  function isValidPattern(raw) {
    return parsePattern(raw) !== null;
  }
  function groupPatternsBySum(patternStrings) {
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
  function expandAcrossDays(blocks, dayCount) {
    const out = [];
    for (let i = 0; i < dayCount; i++) out.push(blocks[i % blocks.length]);
    return out;
  }
  return { parsePattern, patternSum, isValidPattern, groupPatternsBySum, expandAcrossDays };
})();
```

- [ ] **Step 4: Run tests, verify pass**
  Run: `cd extension && bun test`
  Expected: 5 tests pass. Commit (`feat: pattern parsing logic`).

### Task 6: Storage layer (TDD)

**Files:**
- Create: `extension/src/storage.js` (classic script → `QS.storage`; ISOLATED world only)
- Create: `extension/test/storage.test.js`

- [ ] **Step 1: Write the failing tests**

```js
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
  expect(DEFAULT_PATTERNS).toContain("3-2");
  expect(DEFAULT_PATTERNS).toContain("10");
  expect(DEFAULT_PATTERNS).toContain("5");
});

test("loadPatterns returns defaults when nothing stored", async () => {
  expect(await loadPatterns()).toEqual(DEFAULT_PATTERNS);
});

test("loadPatterns merges stored + defaults and filters invalid entries", async () => {
  store.patterns = ["4-3-3", "bad pattern", "3-2", ""];
  const result = await loadPatterns();
  expect(result).toContain("4-3-3");
  expect(result).toContain("3-2");
  expect(result).not.toContain("bad pattern");
  expect(result).not.toContain("");
  // native read-only keys always present
  expect(result).toContain("10");
  expect(result).toContain("5");
});

test("savePatterns stores and validates", async () => {
  await savePatterns(["10", "4-3-3", "nope"]);
  expect(store.patterns).toEqual(["10", "4-3-3"]);
});

test("removing defaults in the editor still re-merges native 10/5 on load", async () => {
  await savePatterns(["4-3-3"]);
  const result = await loadPatterns();
  expect(result).toContain("10");
  expect(result).toContain("5");
});
```

- [ ] **Step 2: Run tests, verify failure**
  Run: `cd extension && bun test`
  Expected: FAIL (`QS.storage` undefined).

- [ ] **Step 3: Implement storage.js**

```js
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
```

  NOTE: `QS.storage` depends on `QS.patterns` — in the extension, `patterns.js` loads first in the ISOLATED entry's js array too (add it to the ISOLATED entry `js` array in manifest.json: `["src/patterns.js", "src/storage.js", "src/content.js"]`).

- [ ] **Step 4: Run tests, verify pass**
  Expected: 5 tests pass. Commit (`feat: pattern storage layer`).

### Task 7: Options page (pattern editor)

**Files:**
- Create: `extension/options.html`
- Create: `extension/options.js`

- [ ] **Step 1: Write options.html** — pattern list (each row: text + up/down/remove buttons; native 10/5 rows disabled with "(native)" badge), input + Add button, error line. Minimal inline CSS.
- [ ] **Step 2: Write options.js** (classic script — options pages support `chrome.storage` and ES modules, but keep classic for consistency; load via `QS.storage` requires the scripts — use `<script src="src/patterns.js"></script><script src="src/storage.js"></script><script src="options.js"></script>` in options.html)

```js
// options.js
const listEl = document.getElementById("pattern-list");
const inputEl = document.getElementById("pattern-input");
const addBtn = document.getElementById("add-btn");
const errorEl = document.getElementById("error");

const NATIVE = new Set(["10", "5"]);

async function render() {
  const patterns = await QS.storage.loadPatterns();
  listEl.innerHTML = "";
  for (const raw of patterns) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    label.textContent = raw + (NATIVE.has(raw) ? " (native)" : "");
    row.appendChild(label);
    if (!NATIVE.has(raw)) {
      const up = document.createElement("button"); up.textContent = "↑";
      up.onclick = async () => { await move(raw, -1); };
      const down = document.createElement("button"); down.textContent = "↓";
      down.onclick = async () => { await move(raw, 1); };
      const del = document.createElement("button"); del.textContent = "✕";
      del.onclick = async () => { await removePattern(raw); };
      row.append(up, down, del);
    }
    listEl.appendChild(row);
  }
}

async function move(raw, dir) {
  const patterns = await QS.storage.loadPatterns();
  const i = patterns.indexOf(raw);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= patterns.length) return;
  [patterns[i], patterns[j]] = [patterns[j], patterns[i]];
  await QS.storage.savePatterns(patterns);
  render();
}

async function removePattern(raw) {
  const patterns = (await QS.storage.loadPatterns()).filter((p) => p !== raw);
  await QS.storage.savePatterns(patterns);
  render();
}

addBtn.onclick = async () => {
  const raw = inputEl.value.trim();
  if (!QS.patterns.isValidPattern(raw)) {
    errorEl.textContent = "Invalid pattern — use comma/hyphen separated positive integers (e.g. 4-3-3).";
    return;
  }
  errorEl.textContent = "";
  const patterns = await QS.storage.loadPatterns();
  if (!patterns.includes(raw)) patterns.push(raw);
  await QS.storage.savePatterns(patterns);
  inputEl.value = "";
  render();
};

render();
```

- [ ] **Step 3: Manual verify**
  Open options page from chrome://extensions. Add `2-2-2`, reorder, remove it; reload the page — state persists. Native rows are disabled. Invalid input shows an error and doesn't save. Commit (`feat: options page`).

### Task 8: Angular hooks + uniform option injection

**Files:**
- Create: `extension/src/lib.js`, `extension/src/angular-hooks.js`, `extension/src/dropdown.js`

- [ ] **Step 1: Implement lib.js** (classic script → `QS.lib`)

```js
// src/lib.js — classic script
var QS = globalThis.QS || (globalThis.QS = {});
QS.lib = (function () {
  function qsa(sel, root = document) {
    return [...root.querySelectorAll(sel)];
  }
  function on(el, evt, fn) {
    el.addEventListener(evt, fn);
  }
  /** Dispatch events Angular observes (bubbles + composed). */
  function dispatchAngular(el, evtType) {
    el.dispatchEvent(new Event(evtType, { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  return { qsa, on, dispatchAngular };
})();
```

- [ ] **Step 2: Implement angular-hooks.js using Spike C findings** (classic → `QS.angular`)

```js
// src/angular-hooks.js — recipe from docs/spike-c-angular.md
var QS = globalThis.QS || (globalThis.QS = {});
QS.angular = (function () {
  function findMinWorksheetCountList(root = document) {
    // 1) ng debug API if present
    if (window.ng && window.ng.getComponent) {
      const el = root.querySelector(".setting-options");
      if (el) {
        const comp = window.ng.getComponent(el);
        if (comp && comp.minWorksheetUnitCountList) return comp.minWorksheetUnitCountList;
      }
    }
    // 2) __ngContext__ traversal fallback — exact walk code from spike-c-angular.md
    //    (replace this comment with the spike's working traversal; no TODOs)
    return null;
  }
  return { findMinWorksheetCountList };
})();
```

  Replace the fallback comment with the exact traversal from `extension/docs/spike-c-angular.md` — the spike produced the working code; do not leave the comment in the final file.

- [ ] **Step 3: Implement dropdown.js** (classic → `QS.dropdown`)

```js
// src/dropdown.js — classic script
var QS = globalThis.QS || (globalThis.QS = {});
QS.dropdown = (function () {
  const NATIVE_KEYS = new Set([10, 5]);

  /** Single-number patterns → native worksheet options. Returns count injected. */
  function injectUniformOptions(patterns) {
    const list = QS.angular.findMinWorksheetCountList();
    if (!list) return 0;
    const existing = new Set(list.map((o) => Number(o.key)));
    let count = 0;
    for (const raw of patterns) {
      const blocks = QS.patterns.parsePattern(raw);
      if (!blocks || blocks.length !== 1) continue;
      const key = blocks[0];
      if (NATIVE_KEYS.has(key) || existing.has(key)) continue; // dedupe
      list.push({ value: `${key} worksheets per study`, key });
      count++;
    }
    return count;
  }

  /** Multi-number patterns → "Page pattern" section inside the same panel. */
  function injectPatternSection(patterns, onPick) {
    const panel = document.querySelector(".options.setting-options");
    if (!panel || document.querySelector(".qs-pattern-section")) return false;
    const groups = QS.patterns.groupPatternsBySum(
      patterns.filter((raw) => (QS.patterns.parsePattern(raw) || []).length > 1), // splits only
    );
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
        btn.style.cssText =
          "padding:3px 10px;border:1px solid #2a6df4;border-radius:12px;background:#fff;color:#2a6df4;cursor:pointer;font-size:12px;";
        btn.addEventListener("click", () => onPick(raw));
        row.appendChild(btn);
      }
      section.appendChild(row);
    }
    panel.appendChild(section);
    return true;
  }

  return { injectUniformOptions, injectPatternSection };
})();
```

- [ ] **Step 4: Console-driven verification (no boot code exists yet — that's Task 9)**
  Load unpacked; open a student's assignment editor. In the **page console** (all MAIN scripts run in the page world, so `QS` is reachable):
  ```js
  QS.dropdown.injectUniformOptions(["4", "3", "2"]);
  ```
  Open the gear dropdown; confirm injected options (4, 3, 2 worksheets) appear exactly once and native 10/5 are not duplicated. Also verify graceful failure: `QS.angular.findMinWorksheetCountList()` on a non-editor screen returns `null` without throwing. Do NOT save. Commit (`feat: uniform option injection`).

### Task 9: Pattern section + day-block reshape (the core)

**Files:**
- Create: `extension/src/day-blocks.js`
- Create: `extension/src/content-main.js`, `extension/src/content.js` (bridge)

- [ ] **Step 1: Implement day-blocks.js using Spike A findings** (classic → `QS.blocks`)

```js
// src/day-blocks.js — selectors/gesture from docs/spike-a-day-blocks.md
var QS = globalThis.QS || (globalThis.QS = {});
QS.blocks = (function () {
  function findDays(root = document) {
    // exact selector from Spike A (e.g. ".studyUnit" rows)
    return QS.lib.qsa(SELECTOR_FROM_SPIKE_A, root);
  }
  function dayBlockTotal(dayEl) {
    // from Spike A: sum of block sizes in this day row
    return SUM_FROM_SPIKE_A(dayEl);
  }
  function applyPatternToDay(dayEl, blocks) {
    // from Spike A: replace the day's blocks with `blocks` sizes,
    // preserving starting WorksheetNO, using the app's own edit gesture
    // + QS.lib.dispatchAngular on the affected controls
  }
  function applyPatternToMatchingDays(rawPattern) {
    const blocks = QS.patterns.parsePattern(rawPattern);
    if (!blocks) return 0;
    const sum = QS.patterns.patternSum(blocks);
    let changed = 0;
    for (const day of findDays()) {
      if (dayBlockTotal(day) === sum) {
        applyPatternToDay(day, blocks);
        changed++;
      }
    }
    return changed;
  }
  return { findDays, dayBlockTotal, applyPatternToDay, applyPatternToMatchingDays };
})();
```

  Replace `SELECTOR_FROM_SPIKE_A`, `SUM_FROM_SPIKE_A`, and the `applyPatternToDay` body with the Spike A recipe — no TODOs allowed.

- [ ] **Step 2: Implement the postMessage bridge + boot (content.js / content-main.js)**

```js
// src/content.js — ISOLATED world: serves patterns on request
var QS = globalThis.QS || (globalThis.QS = {});
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  if (event.data && event.data.type === "qs:request-patterns") {
    const patterns = await QS.storage.loadPatterns();
    window.postMessage({ type: "qs:patterns", patterns }, "*");
  }
});
```

```js
// src/content-main.js — MAIN world: detects the editor dropdown, boots, re-injects
var QS = globalThis.QS || (globalThis.QS = {});
let currentPanel = null;

function requestPatterns() {
  return new Promise((resolve) => {
    const onMsg = (event) => {
      if (event.source !== window) return;
      if (event.data && event.data.type === "qs:patterns") {
        window.removeEventListener("message", onMsg);
        resolve(event.data.patterns);
      }
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
    QS.dropdown.injectPatternSection(patterns, (raw) => {
      const n = QS.blocks.applyPatternToMatchingDays(raw);
      console.log(`[QuickSet] applied ${raw} to ${n} day(s)`);
    });
  } catch (err) {
    // spec §4: never throw into the page
    console.warn("[QuickSet] boot failed:", err);
  }
}

// SPA navigation re-creates the panel per student — re-inject per NEW panel element,
// debounced; never a one-shot flag
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
```

- [ ] **Step 3: Manual end-to-end on a scratch set**
  Load unpacked. In the options page, confirm defaults include `4-3-3`. Create a scratch set via the UI for the test student (or via the API client per Spike B) with several 10-page days. Open the gear dropdown; click `4-3-3`. Verify: every 10-page day reshaped to 4/3/3 blocks, non-matching days untouched. Click the app's **Save**; then read back via `~/class-navi-api`: `bun run src/index.ts call GetStudyResultInfoList '{"StudentID":"...","SubjectCD":"010","WorksheetCD":"...","SystemCountryCD":"USA","CenterID":"00981474","ClassID":"00981475","ClassStudentSeq":...}'` and confirm 3 blocks per day in the set data. Then delete the scratch set (API client `RegisterStudySetInfo` with `DeleteSetInfoList`, or the UI delete). NOTE: the `StudentID`/`WorksheetCD`/`ClassStudentSeq` in the read-back command come from the scratch set created in this step. Record payload evidence in the commit message. Commit (`feat: day-block pattern application`).

### Task 10: Cross-browser + regression pass

- [ ] **Step 1: Edge load + smoke** — load unpacked in Edge, repeat Task 9 Step 3 on a fresh scratch set (create → pattern → save → read back → delete).
- [ ] **Step 2: Multi-student session check** — in one session, assign for two different students (Next Student flow): confirm the pattern section and uniform options re-inject for the second student without a page reload.
- [ ] **Step 3: Regression** — native 10/5 options still work; Student List / Marking List / Class Notes show no injected UI; no console errors when the dropdown is absent.
- [ ] **Step 4: Final commit** (`chore: cross-browser verification`).

### Task 11: README + wrap-up

**Files:**
- Create: `extension/README.md`

- [ ] **Step 1: Write README.md** — what it does, install (load unpacked, Chrome + Edge), pattern editing, defaults table, architecture summary (dual-world bridge), security note (extension never writes to the server; the app's Save does), link to spec.
- [ ] **Step 2: Final review** — `git log` shows one commit per task; `bun test` green; extension loads with no console errors on the live app. Commit any last docs.

---

## Definition of Done

- `bun test` green (patterns + storage suites)
- Extension loads unpacked in Chrome and Edge
- In a scratch set: clicking 4-3-3 reshapes all 10-page days, Save produces the verified block-list payload, scratch set deleted after
- Multi-student session: injection re-appears for each student without page reload
- No extension UI outside the existing dropdown; no extension writes to the server
- Patterns editable on the options page; 10/5 read-only
