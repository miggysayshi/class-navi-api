# Spike A Findings — Day-Block Edit Mechanism

Date: 2026-08-05
Status: Complete (investigation by subagent, verified by controller)
Source: live editor (Noah Grigoryan, Math, 3A, "Sort by Level" view) + reference HAR
(`~/Downloads/student setting work 4-3-3.rtf` → converted `/tmp/433.txt`)

## 1. The editor is a grid/gantry UI — not a form

- Editor root: `<study-unit-editor>` with `<div class="columnHeaderOuter">` (top
  worksheet-number scale) and `<div id="gridContentOuter">` → `.gridContentInner.set`
  → div `.studyUnits`.
- **Each day = one row; each worksheet = one `.studyUnit` cell** (32px high).
  Geometry: `style="left:{px}; top:{row*32}px; width:31/32px; height:32px"`.
  Column ↔ worksheet number: **1 cell ≈ 32px** (scale labels at left 0→"1",
  32→"11", 65→"21"…; cells alternate 31/32px).
- Each `.studyUnit` contains `<div class="bar" id="bar-N">`. Bar classes:
  - `cls1` = past completed worksheet
  - `cls8` = correction-like
  - `cls0 editable` = assignable/set cells
  - `roundLeft` / `roundRight` mark a **block's edges** (start/end of a contiguous
    run) — a block IS a contiguous run of `cls0 editable` cells on one row.
- Hover tooltip = study minutes (mat-tooltip), not block info.

## 2. Edit mechanism: drag grips (no inputs anywhere)

- `<div class="leftGrip">` / `<div class="rightGrip">` appear exactly on
  roundLeft/roundRight bars — these are **drag-resize handles**.
- No inputs, no +/- buttons, no context menus on bars. Bars carry CDK drag-style
  inline styles (`touch-action:none; user-select:none; -webkit-user-drag:none`)
  implying pointer-based dragging.
- The user's 4-3-3 was made by **dragging the grips** on the day's block to split it
  into 3 contiguous runs (41–44, 45–47, 48–50). There is no typing surface.
- Grip drags were NOT physically executed during the spike (would alter draft data).
  The drag inference is from DOM structure + CDK styles. Driving the DOM by
  synthesizing pointer drags is fragile — NOT recommended.

## 3. Angular state (via `__ngContext__` on the editor element)

Component exposes:
- `studyUnits` (10), `pastStudyUnits` (14), `minWorksheetNO: 1`, `maxWorksheetNO: 200`,
  `editable`, `gradingMethod: "1"`, `scaleX/scaleY/rowHeight`,
  `subjectCDStandardTimeList` (worksheet range buckets 1–10 … 191–200).
- Per-day records (both arrays): `{ StudyIDs, CompleteTime, FirstCompleteTime,
  StudyDate, StartDate, FirstNo, LastNo, Count, StudyScheduleIndex, DeleteFlg, …,
  ScoreGridViews }`. **`StudyScheduleIndex` is the day index — matches the save
  payload key.**
- No `ng-reflect-*` bindings on bars; bindings are positional in LView (minified).

## 4. Recommended recipe — mutate the data model, let Angular re-render

**Primary (recommended):** replace the day's block data in the component's
`studyUnits`/`pastStudyUnits` arrays (set `FirstNo`/`LastNo`/`Count` per block),
then trigger Angular change detection. The grid re-renders; the user clicks the
app's **Save**, and the app itself sends the correct `RegisterStudySetInfo` payload
(the verified protocol). This keeps the extension's "never writes to the server"
contract — it edits the draft, the app writes.

Mechanics (to be finalized in Spike C):
- Locate the component instance (same `__ngContext__` walk as
  `minWorksheetUnitCountList` — likely the same component or a parent).
- Day rows are 0-based in DOM (`top/32`); the API/payload uses 1-based
  `StudyScheduleIndex`. **Confirm the off-by-one against `FirstNo/LastNo` before
  coding.**
- After mutating records, Angular re-render may need `NgZone`/markForCheck —
  verify what makes the grid update (Spike C Step 3 style test).

**Fallback (robust but writes):** call `RegisterStudySetInfo` directly with
`InsertSetInfoList`/`DeleteSetInfoList` for that `StudyScheduleIndex` — the app's
own protocol, verified payload shape. Only if data-model mutation proves
unreliable; violates the "no extension writes" constraint, so it needs user
sign-off.

## 5. Verified save payload (reference)

`POST /USA/api/ATD0010P/RegisterStudySetInfo` with
`InsertSetInfoList: [{StudyScheduleIndex:13, WorksheetNOFrom:41, WorksheetNOTo:44,
GradingMethod:"1"}, {13, 45–47}, {13, 48–50}]`, `DeleteSetInfoList: []`,
`NotDownloadLastUpdateTime`, `NotUpdateMaxStudyScheduleIndex: 11`,
`NotUpdateMaxWorksheetNO: 75` (+ client block, id).

## 7. Grip-drag synthesis verification (Task 9 — 2026-08-05)

- Synthesized drags DO NOT work: pointerdown/move/up and mousedown/move/up sequences
  on `leftGrip`/`rightGrip` elements and on the bars themselves did not move a
  block. CDK-style drag is not drivable via dispatched synthetic events in this
  app build. Drag synthesis is NOT a viable mechanism.
- The working mechanism (live-verified): mutate the **page component's**
  `studyUnits` array (NOT the grid component's render copy — they are separate
  arrays; the grid's is a derived render list, the page's is what Save reads):
  1. Mutate the first cell of the target day (`WorksheetNOFrom/To` +
     `bindingData.from/to/lastFrom/lastTo`), push clones (same prototype, same
     `bindingData.StudyID`/`id`) for the remaining blocks, splice out the old
     cells of that day (`bindingData.id` = StudyScheduleIndex).
  2. Call the page comp's `checkDiff()` — it compares `studyUnits` against
     `firstStudyUnits`; changed length/contents flips `confirmBtnDisabled` to
     false, enabling the app's Save button.
  3. The app's Save diff (bundle `registerStudySetInfo`) emits
     `InsertSetInfoList` entries for every current unit without an exact
     `initStudyUnit` match — mutated blocks land in the payload with
     `StudyScheduleIndex = bindingData.id`.
- Verified in-app: reshape of a 10-page day (91-100) into [4-3-3] rendered in
  the grid (49 cells) with the model showing 91-94/95-97/98-100, and
  `checkDiff()` flipped `confirmBtnDisabled` to false.
- NOTE: console-driven tests can't tick Angular's change detection (no zone),
  so the DOM Save button stays visually disabled in console tests — in real
  usage the user's clicks run inside Angular's zone and CD happens naturally.
- IMPORTANT student-ID correction: the morning 4-3-3 HAR and all Spike B data
  belong to **Lainey Valerene Abella (StudentID 8402350372837, ClassStudentSeq
  12)** — NOT Noah Grigoryan (8402640414247, seq 69). The two share the first
  name; the Set List first row is Noah. Always match by StudentID.

## 8. Open items for implementation (resolved)

1. Off-by-one: DOM row index vs payload `StudyScheduleIndex`.
2. What triggers grid re-render after data mutation (markForCheck? zone tick?).
3. Whether `studyUnits` (assignable days) or `pastStudyUnits` (past days) is the
   target for a new assignment period.
