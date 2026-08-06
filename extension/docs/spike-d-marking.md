# Spike D — Marking/scoring internals (2026-08-05)

Target: the **Marking List → marking screen** flow (instructor grades completed
worksheets). Goal: design extension features — mark-all-correct/wrong per page,
typed on-page comments ("pen").

## Entry points (live-verified)

- Tab: **Marking List(N)** → screen component `APP-ATE0012P` (body:
  `studentList` > `app-score-list-item.studentRow` rows; per-subject cells
  `app-score-list-subject-cell` > `app-score-list-worksheet-bar.worksheetBar`
  per completed set: "Ⅰ 27-30 07:48" = level + range + finish time).
- List page comp (APP-ATE0012P, found via `findComp(el,['isEnableScoreChecked'])`):
  - `onClick_worksheet({StudentInfo, StudentStudyInfo, GradingWaitingSetInfo})`
    → `context.studentList.registerStartScoreSingleWorksheet(...)` → opens the
    marking screen for that set (gated on `GradingWaitingSetInfo.MarkingEnabled`).
  - `onClick_beginScore` — the "Begin Marking" button (footer SPAN "Begin Marking").
  - `isEnableScoreChecked` / `isBreakScoreChecked` — marking button states.
- Console-driven navigation to the marking screen is NOT reliable (synthetic
  clicks + EventEmitter chains don't fire; bar comp exposes only
  `hoverBar/worksheetClick/studyInfo/idVal/authList`; `studyInfo` is empty on
  the instance). Verify the screen visually with the user's real browser when
  needed.

## API surface (bundle `main.js`, proxy class RS — `super.api("Name", payload)`)

Marking data:
- `GetGradingTarget` — the pending-marking list (drives Marking List).
- `GetGradingStudyUnit` / `GetGradingResultPageData` — the set + per-page data
  for the marking screen (page `model`: `inkData` (student handwriting, base64),
  `resultBoxs`, `scoreList`, `answers`, `type` (`Xr.Result` etc.)).
- `GetScoreDetailInfo` — the past-study score grid (the "May24 45.2min | …" view).

Scoring writes:
- `RegisterStartScore` / `RegisterStartScoreSingleWorksheet` — open a scoring
  session (the screen init calls it before showing pages).
- `RegisterScore` — **the grade save**. Payload shape (bundle 3585435):
  ```js
  o.push({ WorksheetNO, CorrectionCount, GradingResultData: zip(JSON),   // per-page result boxes
           RedComment: zip(ink), Score: number|null, GraderID, GradingDate,
           GradingTime, GradingEvaluationTime });
  s = { ...setData, SystemCountryCD, InstructorID, InstructorAssistantSec,   // from userInfo
        GradingWorksheetInfoList: o };
  e.registerScore(s);
  ```
- `RegisterEndScoring` — close the session after grading.
- `registerTestScore` / `RegisterEvaluationGradingLog` / `RegisterStudyDataReplayLog` — auxiliary.

Per-page status helpers (component-local, NOT network):
- `getScoreStatusForPage(s)` / `updateScoreStatusForPage()` — page status
  (correct/wrong/partial) display logic.

Comments:
- `GetStudyWorksheetCommentList` / `RegisterStudyWorksheetCommentList` —
  per-worksheet comment list API (separate from ink annotations).
- On-page annotations: `RedComment` (red-pen ink, base64/zip) + `TagComment` +
  `SoundComment` + `SoundRecord` — the "pen" layer. `getMemoImage`.

## Design implications

- "Mark all on page correct/wrong": on the marking screen, one action sets every
  result box of the current page to correct/wrong. Two candidate mechanisms:
  (a) mutate the page model's `resultBoxs` + call the screen's own save
  (registerScore with the full `GradingWorksheetInfoList` — the app's own
  assembly, verified shape above); (b) the `updateScoreStatusForPage` local
  machinery. **(a) is the proxy-API path — same as Quick Set day-blocks.**
- "Typed comment on the page": the RedComment layer is INK (drawing). A typed
  comment needs a text-overlay rendered as ink OR the per-worksheet comment
  list (RegisterStudyWorksheetCommentList). NEEDS the marking screen's renderer
  internals (how RedComment strokes render) before deciding.

## Open questions for design

1. Marking screen UI: toolbar/header structure (where to inject buttons) —
   verify visually with Miguel's real browser (open a set from Marking List).
2. `GradingResultData` JSON schema (how a "correct" box is encoded) — extract a
   sample by having Miguel grade one worksheet in a scratch session, or read the
   `getResultBoxs`/`getMarkBoxs` parsers in the bundle.
3. Comment target: on-page annotation vs worksheet comment list — Miguel's
   "pen" wording suggests on-page.
