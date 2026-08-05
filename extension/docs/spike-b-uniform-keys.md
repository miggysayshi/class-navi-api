# Spike B Findings — Uniform-Key Round-Trip

Date: 2026-08-05
Status: Complete (UI injection by subagent; API round-trip executed by controller with
user approval; scratch set created and deleted, verified clean)

## 1. Arbitrary uniform keys flow through the UI — VERIFIED

- Pushed `{value: "4 worksheets per study", key: 4}` into `minWorksheetUnitCountList`
  (Spike C recipe) → renders instantly; clicking selects it, `minWorksheetUnitCount` = 4.
  **No validation errors anywhere.**
- The app's block generator `spliceStudiesByMinCount` (behind quick-set/handleTotalSet)
  produces blocks of exactly `key`:
  - range 81–88 with key 4 → `[81-84, 85-88]`
  - range 1–10 with key 4 → `[1-4, 5-8, 9-10]`
- Existing grid rows do NOT retroactively reshape when the key changes — the key only
  applies at block-generation time.

## 2. Server round-trip — VERIFIED (scratch set, deleted)

Via the API client (`~/class-navi-api`) on student 8402350372837 / SubjectCD 010 /
WorksheetCD H0 (the level with the user's real 4-3-3 at SSI 13):

- **Insert**: `RegisterStudySetInfo` with
  `InsertSetInfoList: [{StudyScheduleIndex:14, WorksheetNOFrom:91, WorksheetNOTo:94,
  GradingMethod:"1"}, {StudyScheduleIndex:14, WorksheetNOFrom:95, WorksheetNOTo:98,
  GradingMethod:"1"}]` →
  **`ErrorSec: "00"`** (clean), response carries `UpdateStudyInfoList` with
  `StudyID` per inserted block (`000597001`, `000598001`).
- **Read back**: `GetStudyResultInfoList` → SSI 14 = exactly the two 4-page blocks
  (91–94, 95–98). Uniform key 4 persists end-to-end.
- **Delete**: `RegisterStudySetInfo` with
  `DeleteSetInfoList: [{StudyID:"000597001", StudySec:"1"}, {StudyID:"000598001",
  StudySec:"1"}]`, empty `InsertSetInfoList` → `ErrorSec: "00"`.
- **Verified clean**: SSI 14 = 0 records, total back to 61. Nothing left behind.

## 3. Critical protocol facts discovered (documented for implementation)

1. **`ErrorSec` semantics** (from bundle + live): `"00"` = clean save,
   `"01"` = **Exclusion** (partial/whole reject — app shows an "Exclusion" dialog),
   `"02"` = UpdateError. `ResultCode: 0` does NOT mean the write landed — check
   `ErrorSec` too.
2. **`NotDownloadLastUpdateTime` must echo the server's value** (from the last
   `GetStudyResultInfoList` response), NOT the current time. A mismatched (newer)
   timestamp → Exclusion (`ErrorSec "01"`). The app uses
   `this.curStudentStudyInfo.NotDownloadLastUpdateTime` verbatim.
3. **Worksheet-range conflicts cause Exclusion**: inserting 81–88 was rejected because
   81–85/86–90 were already assigned on SSI 11. Insert into unassigned territory.
4. **`DeleteSetInfoList` entries are `{StudyID, StudySec}`** — NOT worksheet ranges.
   `StudyID` comes from the insert response's `UpdateStudyInfoList` (or the read-back
   records). The block-range shape only works for `InsertSetInfoList`.
5. `NotUpdateMaxStudyScheduleIndex`/`NotUpdateMaxWorksheetNO` = last studied
   index/worksheet (app sends 11/75 for this student; studied data ends at SSI 11,
   worksheets ≤ 75).

## 4. Implication for the extension design

- The uniform-option injection (add key N to the dropdown) is fully safe: the app
  generates N-blocks on save, and the server accepts them (ErrorSec "00" proven).
- The extension's "no writes" contract holds: the app's Save does the write; the
  extension only adds dropdown options and reshapes day data.
- If Task 9 ever needs an API-driven path (fallback), the full verified recipe is
  here: insert with block ranges → capture StudyIDs → delete with StudyIDs.
