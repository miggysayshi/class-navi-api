# Class-Navi Quick Set

Adds **page-pattern options** (e.g. 4-3-3, 3-2-3-2) to Class-Navi's existing
"worksheets per study" dropdown. One click reshapes every matching day's
worksheet blocks — no extra panels, no new UI surfaces.

![Dropdown: native options + page pattern section](docs/screenshot-placeholder.png)

## What it does

- **Uniform options**: adds `4`, `3`, `2 worksheets per study` to the dropdown
  (native values 10 and 5 stay first).
- **Page patterns**: a "`N` pages / day" section lists your patterns. Clicking
  one (e.g. `4-3-3`) finds every assignable day whose editable blocks total
  `N` (e.g. 10) and splits each into the pattern's blocks (e.g. 41-44, 45-47,
  48-50) — including days you just created by dragging in the editor and have
  **not saved yet**.
- Patterns are editable on the extension's **options page** (10 and 5 are
  read-only native values).

## Install (load unpacked)

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Enable **Developer mode** (bottom-left).
3. Click **Load unpacked** and select this `extension/` folder.
4. Log into Class-Navi and open any student's Set editor. The dropdown gains
   the injected options and the pattern section.

Reload the extension (🔄 on its card) and **F5 the Class-Navi page** after
every code change — content scripts inject on page load.

## Default patterns

| Pattern | Sum | Blocks per day |
|---|---|---|
| `10` | 10 | native |
| `5` | 5 | native |
| `4-3-3` | 10 | 4, 3, 3 |
| `3-2-3-2` | 10 | 3, 2, 3, 2 |
| `2-2-2-2-2` | 10 | 2, 2, 2, 2, 2 |
| `5-5` | 10 | 5, 5 |
| `3-2` | 5 | 3, 2 |

Pattern syntax: numbers separated by `-` or `,` (e.g. `4-3-3`, `3,2`).

## How it works (architecture)

- **Dual-world bridge**: an ISOLATED-world content script owns pattern storage
  (`chrome.storage.sync`) and serves it to the MAIN world over `postMessage`;
  the MAIN world injects the UI into the app's dropdown panel.
- **Angular access without `window.ng`**: components are located by walking
  `__ngContext__` lViews up from a known element (see
  `docs/spike-c-angular.md`).
- **Reshape via the app's own API channel**: matching runs against the page
  component's render model (what the user sees — unsaved drags included).
  Each matched day is saved by calling the app's own authenticated
  `registerStudySetInfo` proxy with the payload recipe verified in
  `docs/spike-b-uniform-key.md` (fresh `NotDownloadLastUpdateTime` per save —
  stale timestamps get Excluded with `ErrorSec "01"`; in-place model reshape
  after each save keeps the grid accurate without wiping unsaved work).
- **Dropdown survives clicks**: the app closes its dropdown on any mousedown
  whose target lacks the `setting-options` class — injected elements carry it
  (`docs/spike-a-day-blocks.md` §7).

## Security note

The extension performs its saves **through the app's own authenticated proxy
methods** (`getStudyResultInfoList` / `registerStudySetInfo`) — no separate
credentials, no direct API calls, same session the page uses. It only touches
the student/level currently open in the editor. (Design change from the
original spec: saving through the app's native Save-diff proved unreliable
against real data, so the pattern buttons save deterministically instead.)

## Tests

```bash
cd extension && bun test
```

Covers pattern parsing/grouping (Task 5) and the storage layer (Task 6).

## Docs

- Spec: `docs/superpowers/specs/2026-08-05-class-navi-extension-design.md`
- Plan: `docs/superpowers/plans/2026-08-05-class-navi-quick-set-extension.md`
- Spikes: `docs/spike-a-day-blocks.md`, `docs/spike-b-uniform-key.md`,
  `docs/spike-c-angular.md`
- API client + glossary: `~/class-navi-api` (`CONTEXT.md`)

## Known limitations

- Matching is per-day-total: a day with mixed studied + editable blocks only
  counts the editable ones. A day whose editable total ≠ the pattern sum is
  left untouched.
- Reshaping replaces the whole day's editable blocks with the pattern (the
  studied portion is never touched).
- The dropdown's `setting-options` class check is app-internal behavior —
  if Kumon changes it, pattern clicks stop working (diagnosable via the
  console: `[QuickSet]` logs).
