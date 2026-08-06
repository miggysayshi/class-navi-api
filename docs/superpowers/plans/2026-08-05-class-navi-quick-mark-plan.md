# Quick Mark — marking-screen extension plan (2026-08-05)

Extends the Class-Navi marking screen (ATD0020P) with: mark-all per page,
typed on-page comments, keyboard shortcuts. Same extension, same patterns as
Quick Set (spike docs: `extension/docs/spike-d-marking.md`).

## Features (user-confirmed)

1. **Mark all on page correct/wrong** — current page only; overwrites all
   answer boxes; buttons + shortcuts.
2. **Typed comment** — click pen → click a spot on the worksheet → type →
   Enter places it (renders like pen text, saved with the grade); Esc cancels.
3. **Toolbar** injected into the app's `app-grading-toolbar` (icons-only bar)
   + keyboard shortcuts `A` (all correct), `S` (all wrong), `C` (comment).
   Shortcuts inactive while typing in inputs/textareas/contenteditable.

## Verified internals (bundle + live sample)

- Screen comp: `app-atd0020p`, `findComp(el, ['studySetList'])` at depth 0;
  keys: `studySetList`, `currentPage`, `totalPages`, `redCommentStroke`,
  `displayId: "ATD0020P"`, `endScoring(e, n)` (the app's own save →
  registerEndScoring → registerScore; serializes the live model).
- Set model: `studySet.scoringResultData = {count, score, gradingTime,
  gradingResultData, redCommentList, gradingEvaluationTime}`.
- `gradingResultData` (live sample): `{FullScore, PageMarks: [{PageNumber,
  QuestionMarks: [{AnswerRectMarks, AnswerRightList: [{AutoRight, ManualRight,
  Right}], QuestionData: {QuestionNumber, QuestionScore, CheckIconLocation…}}]}]}`
- Right enum (`qr`): Default 0, Incorrect 1, Right 2, Triangle 3.
- **Mark all correct** = last attempt of every question on
  `PageMarks[currentPage]`: `Right = 2, ManualRight = 2` (wrong: `1, 1`).
  AutoRight untouched (machine grade). No wire call — the user's own Save
  (endScoring) persists it.
- **Typed comment**: `window.InkTool.InkCanvasLib.addTextDataToInkData(ink,
  pageIndex - 1, text, x, y, opts)` (verified `window.InkTool` exists in MAIN
  world). Ink = the page's red-comment ink (model `redComment` /
  `redCommentStroke`). Save serializes `redCommentList` (joinInkData →
  `{ps:[pageInk]}`) — the added text element flows into it.
- Toolbar: `app-grading-toolbar` element exists, icons-only (textContent "").

## Files

- `extension/src/marking.js` (NEW, MAIN world) — `QS.marking`:
  - `findScreen()` — ATD0020P page comp via findComp(['studySetList'])
  - `injectToolbar()` — 3 buttons into `app-grading-toolbar` (classes include
    `setting-options`? NO — that's the dropdown's mousedown gate; the marking
    screen toolbar has no such gate — but keep the class-token lesson in mind
    and test clicks live)
  - `markAll(screen, right)` — mutate gradingResultData for the current page;
    then re-render: call the app's own per-page refresh (verify live: either
    the page re-derives via CD from the mutated model, or call the worksheet
    page comp's update method; fallback: per-question native mark-box clicks)
  - `addTypedComment(screen, text, x, y)` — InkTool text injection into the
    current page's red-comment ink + re-render
  - keyboard handler (A/S/C, input-typing guard)
- `extension/src/content-main.js` — boot: observe for `app-atd0020p` (the
  marking screen appears per set), inject toolbar once per screen instance.
- `extension/test/marking.test.js` (NEW) — TDD: mark-all mutation shape
  (Right/ManualRight codes, last-attempt only, AutoRight untouched), page
  selection from currentPage, pattern of gradingResultData structure.
- manifest: marking.js joins the MAIN entry script list.

## Safety

- Marking = REAL student grading data. The extension mutates the in-memory
  model only; the app's own Save persists. The user reviews before saving
  (marks are visible on the page immediately).
- e2e (live, Miguel's browser): open a real pending set (e.g. Arman),
  apply all-correct, verify the page shows the marks, then CORRECT any real
  mistakes manually before the app's Save (or use a set where all-correct is
  genuinely correct). Typed comment: place at a corner, save, verify it
  persists in GetScoreDetailInfo / the grading view.

## Tasks

1. marking.js core + content-main boot + manifest (TDD tests first)
2. Live verification with Miguel (mark-all + save, comment + save)
3. README + wrap-up
