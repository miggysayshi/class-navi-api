# Spike C Findings — Angular Internals Access

Date: 2026-08-05
Status: Complete (investigation by subagent, persisted by controller)
Source: live editor (Noah Grigoryan, Math, 3A), console experiments, state restored
before handoff (dropdown back to 2 options, grid cell restored, source record restored).

## 1. `window.ng` is ABSENT (production build)

`typeof window.ng` === "undefined". The `__ngContext__` lView traversal is **the
required path** — and it works.

## 2. Verified component-finding recipe (copy into angular-hooks.js)

```js
function scanLView(lv, props) {
  if (!Array.isArray(lv)) return null;
  for (let i = 0; i < lv.length; i++) {
    const v = lv[i];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const hit = props.find((p) => p in v);
      if (hit) return { comp: v, idx: i, prop: hit };
    }
  }
  return null;
}

function findComp(sel, props) {
  let el = document.querySelector(sel), d = 0;
  while (el && d < 12) {
    const found = el.__ngContext__ && scanLView(el.__ngContext__, props);
    if (found) return { ...found, depth: d, elTag: el.tagName };
    el = el.parentElement;
    d++;
  }
  return null;
}
```

### Targets (verified)

| Target | Call | Result |
|---|---|---|
| Dropdown options list | `findComp('.option.setting-options', ['minWorksheetUnitCountList'])` | lView on `APP-ATD0010P`, **depth 7**, idx 29 (page component) |
| Grid render model | `findComp('DIV.ATD0010P-root', ['studyUnits'])` | depth 6, idx 63 (also 390 = same object; 133 = past-study wrapper). Component keys: `RowNum`, `WorksheetNOFrom/To`, `bindingData{from,to,id}`, `className`, `editable`, `DeleteFlg` |
| Day records (source) | page comp `.curStudentStudyInfo.StudyUnitInfoList` (48 records; per record: `StudyScheduleIndex`, `StudyDate`, `WorksheetNOFrom/To`, `StudyWorksheetInfoList`) | ⚠️ property path re-verify in Task 9 (direct path worked; `.Result.` prefix threw once) |

## 3. Dropdown push-and-render: VERIFIED, no reload

```js
const comp = findComp(".option.setting-options", ["minWorksheetUnitCountList"]).comp;
comp.minWorksheetUnitCountList.push({ value: "4 worksheets per study", key: 4 });
// → DOM gains the 3rd option INSTANTLY (options are *ngFor over the array)
comp.minWorksheetUnitCountList.splice(idx, 1); // → disappears instantly
```

Native array mutation auto-re-renders (zone-patched array methods trigger CD).
**No ApplicationRef.tick / zone.run needed for the dropdown.**

## 4. Day-block mutation — TWO-LAYER MODEL (critical)

- Mutating the grid's **render-model cells** (`ATD0010P-root` lView idx 63 →
  `.studyUnits` cell objects: change `WorksheetNOFrom/To` + `bindingData.from/to`)
  re-renders the grid **immediately** (verified: a cell's block moved 617→585px,
  restored correctly).
- Mutating the **source record**
  (`comp.curStudentStudyInfo.StudyUnitInfoList[SSI]`) does **NOT** sync the render
  model or DOM — the grid cells are copies made at load/resync time.
- The app saves from the source model, so mutating only render cells would make
  Save write stale data — the source and render models must both reflect the
  change.

### Recommendation for Task 9 (day-blocks.js)

Prefer **synthesizing the app's own grip-drag gesture** (pointer events on
`leftGrip`/`rightGrip` of a roundLeft/roundRight bar) so the app's own code keeps
both models consistent — the mechanism the user uses manually (Spike A). CDK
drag listens for standard pointer events on the grip element; the sequence is
`pointerdown` → `pointermove`(s) → `pointerup`. Fallback: dual-model mutation
(render cells + source records) with a manual re-render trigger. The exact
pointer sequence and the source↔render sync path remain the **top open item**
for Task 9 — budget a focused spike step there before implementing.

## 5. Off-by-one: RESOLVED (none)

DOM row index = `top/32`, **0-based**; `StudyScheduleIndex` = **1-based**.
**DOM row + 1 = StudyScheduleIndex** (row 0 ↔ SSI 1, row 12 ↔ SSI 13). Verified
against all 13 rows: each row's block extent matches its SSI's worksheet range.

## 6. Other useful facts

- 1 worksheet ≈ 3.2px horizontally (a 10-sheet block moved 32px).
- Grid rows: `[...new Set(DOM rows)]` = 13 rows (0..12).
- lView layouts: `APP-ATD0010P` 401 entries (page comp at 29, NgZone at 11 —
  `lView[11]._zone` has `run`/`onMicrotaskEmpty` if a manual tick is needed);
  `ATD0010P-root` 401 entries (grid comp at 63/390).
- Editor root: `study-unit-editor`; grid container `DIV.ATD0010P-root` →
  `.gridContentInner.set` → `.studyUnits`.
- Browser left logged in with the editor open, all test mutations restored.

## 7. Open items for Task 9

1. Grip-drag pointer sequence (verify drag synthesis works before dual-model
   mutation).
2. Re-verify `curStudentStudyInfo.StudyUnitInfoList` property path.
3. If drag synthesis fails: which re-sync path the app uses after Save (or
   whether `lView[11]._zone.run(...)` after dual mutation suffices).
