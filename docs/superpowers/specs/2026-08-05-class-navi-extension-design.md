# Class-Navi Quick Set Extension — Design Spec

Date: 2026-08-05
Status: Approved by Miguel (design review)
Scope: Browser extension v1 — more assignment patterns in the existing dropdown

## 1. Problem

Assigning work in Class-Navi's Set List screen is repetitive. For each student the
instructor must set the daily page counts. The app's built-in "worksheets per study"
dropdown only offers **uniform** counts (10 default, or 5 → displayed as "5-5"), but
real students need **split patterns** across days — e.g. 4-3-3 (4 pages, 3 pages,
3 pages, repeat), 3-2-3-2, 2-2-2-2-2. Today the instructor must manually reshape the
day blocks for every student, every assignment cycle.

Goal: make any pattern (uniform or split) available as **one click inside the
existing dropdown** — no new panels, no floating UI, no change to the app's save flow.

## 2. Verified facts (reverse-engineering evidence)

All facts below were verified against the live app (v2.12.0), the JS bundle, and real
captured traffic (user's HAR files + live browser capture).

### 2.1 The dropdown

- Located on the Set List assignment editor (student set screen, ATD0010P).
- Opened via the gear/settings icon next to "View".
- DOM: `div.options.setting-options > div.option.setting-options[.option-select]`.
- Backing model (from bundle):

```js
this.minWorksheetUnitCount = 10;
this.minWorksheetUnitCountList = [
  { value: "10 worksheets per study (Default)", key: 10 },
  { value: "5 worksheets per study", key: 5 },
];
```

- Labels are built from `minStudyWorksheetUnitLabel = "{0} worksheets per study"`
  and `DefaultLabel = " (Default)"` — new options can reuse the same label pattern.

### 2.2 The server model (from a real 4-3-3 save)

`RegisterStudySetInfo` (POST `{api}/{ATD0010P}/RegisterStudySetInfo`) accepts a list
of worksheet blocks per study day. A day = `StudyScheduleIndex`; **multiple blocks per
day are fully supported**. Example payload (student 8402350372837, subject 010, level
H0 — the user's real 4-3-3 save):

```json
{
  "SystemCountryCD": "USA",
  "CenterID": "00981474",
  "StudentID": "8402350372837",
  "ClassID": "00981475",
  "ClassStudentSeq": 12,
  "SubjectCD": "010",
  "WorksheetCD": "H0",
  "FinishTestSetInfoList": [],
  "DiagnosticTestSetRegisterKbn": "0",
  "DeleteSetInfoList": [],
  "InsertSetInfoList": [
    { "StudyScheduleIndex": 13, "WorksheetNOFrom": 41, "WorksheetNOTo": 44, "GradingMethod": "1" },
    { "StudyScheduleIndex": 13, "WorksheetNOFrom": 45, "WorksheetNOTo": 47, "GradingMethod": "1" },
    { "StudyScheduleIndex": 13, "WorksheetNOFrom": 48, "WorksheetNOTo": 50, "GradingMethod": "1" }
  ],
  "NotDownloadLastUpdateTime": "2026/08/04 23:39:03",
  "NotUpdateMaxStudyScheduleIndex": 11,
  "NotUpdateMaxWorksheetNO": 75,
  "client": { "applicationName": "Class-Navi", "version": "1.0.0.0", "programName": "Class-Navi", "os": "<ua>", "machineName": "-" },
  "id": "<counter>"
}
```

- 10 pages/day → one block (e.g. 41–50). 5-5 → two blocks (41–45, 46–50).
  4-3-3 → three blocks (41–44, 45–47, 48–50).
- `GradingMethod: "1"` = instructor marking (observed value).
- Guard fields prevent overwriting studied work: `NotUpdateMaxStudyScheduleIndex`,
  `NotUpdateMaxWorksheetNO`, `NotDownloadLastUpdateTime`.
- The day-block UI: rows live in `.setStudyUnitEditorContainer`, individual days are
  `.studyUnit` elements; worksheet tiles are the numbered pills per day.

### 2.3 Environment

- User runs the app in Edge (Chromium) — target Chrome + Edge via Manifest V3.
- Host: `https://class-navi.digital.kumon.com` (SPA; API on
  `instructor2-lon.digital.kumon.com`).

## 3. Design

### 3.1 Architecture

Manifest V3 extension, minimal permissions:

```
extension/
├── manifest.json          (MV3; host perms: class-navi.digital.kumon.com; storage)
├── content.js             (main world? NO — isolated world; uses DOM events)
├── content-main.js        (MAIN-world script for Angular component access, if needed)
├── options.html           (pattern editor)
├── options.js
└── icons/
```

Two injection paths (see 3.2/3.3) — both modify ONLY the existing dropdown panel.

### 3.2 Uniform options (native fit)

Push entries into the component's `minWorksheetUnitCountList`:

```js
{ value: "4 worksheets per study", key: 4 }
{ value: "3 worksheets per study", key: 3 }
{ value: "2 worksheets per study", key: 2 }
```

Implementation: locate the Angular component instance owning `minWorksheetUnitCountList`
(via `ng.getComponent` / `__ngContext__` traversal on the `.setting-options` element),
push, and let Angular re-render. The app's existing selection flow handles the rest.

**Open question (verify during build):** whether the app's save path accepts arbitrary
`key` values (server-side it is block-list based, so it should; verify with a live
save on a scratch set, then delete it).

### 3.3 Split patterns (the 4-3-3 family)

Add a "Page pattern" section INSIDE the same dropdown panel, below the worksheet
options:

```
Page pattern:  [ 4-3-3 ] [ 3-2-3-2 ] [ 2-2-2-2-2 ] [ 5-5 ]
```

Clicking a pattern reshapes the current day's blocks (or the assignment period's days)
to the pattern's block sizes — replicating the user's manual manipulation:
- Detect the day row(s) in `.setStudyUnitEditorContainer` / `.studyUnit`.
- Determine current block boundaries and the starting `WorksheetNO`.
- Replace one block of N pages with the pattern blocks (e.g. 10 → 4,3,3).
- Fire the same DOM events the app uses so Angular registers the change (input/change
  events on the app's controls; exact mechanism to be confirmed during build against
  the live editor — the user's manual flow is the reference).

The app's own Save then writes the payload (verified shape in §2.2).

### 3.4 Patterns & storage

- Defaults: `10`, `5-5`, `4-3-3`, `3-2-3-2`, `2-2-2-2-2` (the split-of-10 family) plus
  `5`, `3-2` (5-page days).
- Stored in `chrome.storage.sync` as a list of comma-separated positive integers.
- Editor: extension options page (`chrome://extensions` → details → options) — add,
  remove, reorder patterns. NOT in the page (zero UI footprint).
- Panel grouping: patterns grouped by their sum (10/day group, 5/day group, custom
  sums as they appear).

### 3.5 Scope guard (v1)

IN: uniform options injection + split-pattern section + pattern storage/editor.
OUT (future): marking shortcuts, CSV quick-export, multi-student apply, the separate
monitoring app (separate spec).

## 4. Error handling

- If the Angular component cannot be located (app update), the extension logs and
  disables injection gracefully — never throws into the page.
- Invalid patterns (non-positive ints, empty) are rejected by the options editor.
- No server writes by the extension itself in v1 — the app's Save always does the
  write; the extension only fills UI state.

## 5. Testing

- Manual: load unpacked in Chrome + Edge; on a scratch set (created and deleted
  after), verify: dropdown shows injected options; selecting 4-3-3 reshapes day
  blocks; Save produces an `InsertSetInfoList` matching the pattern; the set renders
  correctly after reload (GetStudyResultInfoList round-trip).
- Regression: app's native 10/5 still work; other screens unaffected.
- Unit (optional, if time): pattern parser (validation, grouping, expansion across N
  days).

## 6. Success criteria

1. One click inside the existing dropdown applies 4-3-3 (or any configured pattern).
2. No extra UI outside the dropdown; app's Save untouched; no extension writes.
3. Patterns persist across sessions (sync storage).
4. Works on Chrome and Edge.

## 7. Open items (resolved during build)

- Exact day-block edit controls in the assignment editor (find the mechanism the user
  uses manually; the HAR shows the result, not the gesture).
- Whether uniform keys other than 10/5 flow through the app's save unchanged.
- MAIN-world script necessity for Angular internals access (production build strips
  `ng` debug API; `__ngContext__` traversal may be needed).
