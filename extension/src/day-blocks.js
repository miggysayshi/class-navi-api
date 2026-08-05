// src/day-blocks.js — classic script; reshapes worksheet blocks by calling the
// app's own authenticated proxies (getStudyResultInfoList + registerStudySetInfo)
// with the verified Spike B payload recipe.
//
// Matching runs against the RENDER MODEL (the page comp's studyUnits — the
// user's live view, including unsaved drag-created blocks). Timestamps + guard
// values come from a fresh proxy fetch per save (stale timestamps get the save
// Excluded, ErrorSec "01"). Deterministic server-side replace per SSI.
// Attaches to globalThis.QS.
var QS = globalThis.QS || (globalThis.QS = {});

QS.blocks = (function () {
  /**
   * Locate the ATD0010P page component. "checkDiff" uniquely identifies it
   * (the grid component also exposes studyUnits and sits closer in the DOM walk).
   */
  function findPageComp(root) {
    try {
      const el = (root || document).querySelector(".setStudyUnitEditorContainer, study-unit-editor");
      if (!el) return null;
      if (!QS.angular || typeof QS.angular.findComp !== "function") return null;
      const found = QS.angular.findComp(el, ["checkDiff"]);
      if (!found || !Array.isArray(found.comp.studyUnits)) return null;
      return found.comp;
    } catch (e) {
      return null;
    }
  }

  /**
   * Days from the render model. Editable cells = DeleteFlg "0" && editable !==
   * false. Grouped by bindingData.id (the StudyScheduleIndex). Includes
   * unsaved drag-created blocks — exactly what the user sees.
   */
  function daysFromRender(units) {
    const byId = new Map();
    for (const u of units) {
      const bd = u && u.bindingData;
      if (!bd || bd.id === undefined) continue;
      if (String(u.DeleteFlg) === "1" || u.editable === false) continue;
      if (!byId.has(bd.id)) byId.set(bd.id, []);
      byId.get(bd.id).push(u);
    }
    const days = [];
    for (const [id, cells] of byId) {
      if (cells.length > 0) days.push({ id, cells });
    }
    return days;
  }

  /** Sum of a day's block sizes. */
  function dayTotal(day) {
    let sum = 0;
    for (const c of day.cells) {
      const from = Number(c.WorksheetNOFrom);
      const to = Number(c.WorksheetNOTo);
      if (Number.isFinite(from) && Number.isFinite(to)) sum += to - from + 1;
    }
    return sum;
  }

  /** getStudyResultInfoList params the app itself uses. */
  function fetchParams(comp) {
    const student = comp.curStudentInfo;
    const subject = comp.curSubjectInfo;
    const cache = comp.context && comp.context.cache ? comp.context.cache : null;
    const appConfig = comp.context && comp.context.appConfig ? comp.context.appConfig : null;
    if (!student || !subject || !cache || !appConfig) return null;
    return {
      StudentID: student.StudentID,
      SubjectCD: comp.curSubjectCD,
      WorksheetCD: comp.curWorksheetCD,
      SystemCountryCD: appConfig.systemCountryCD || "USA",
      CenterID: cache.instructorInfo.MainCenterID,
      ClassID: subject.ClassID,
      ClassStudentSeq: subject.ClassStudentSeq,
    };
  }

  /** Fresh set data through the app's own proxy (timestamp + guards source). */
  async function fetchFresh(comp) {
    if (!comp.proxy || typeof comp.proxy.getStudyResultInfoList !== "function") return null;
    const params = fetchParams(comp);
    if (!params) return null;
    const resp = await comp.proxy.getStudyResultInfoList(params);
    if (!resp || !resp.Result || resp.Result.ResultCode !== 0) return null;
    return resp;
  }

  /** Guard values from studied records (DownloadFlg "1") — mirrors the app. */
  function guardValues(records) {
    const studied = records.filter((u) => String(u.DownloadFlg) === "1");
    if (studied.length === 0) return { maxIdx: null, maxWs: null };
    let maxIdx = null;
    let maxWs = null;
    for (const u of studied) {
      const idx = Number(u.StudyScheduleIndex);
      if (maxIdx === null || idx > maxIdx) maxIdx = idx;
    }
    const atMax = studied.filter((u) => Number(u.StudyScheduleIndex) === maxIdx);
    let hasSec3 = false;
    for (const u of atMax) if (String(u.StudySec) === "3") { hasSec3 = true; break; }
    if (!hasSec3) {
      for (const u of atMax) {
        const ws = Number(u.WorksheetNOTo);
        if (maxWs === null || ws > maxWs) maxWs = ws;
      }
    }
    return { maxIdx, maxWs };
  }

  /**
   * Reshape one render-model day via the app's own register proxy.
   * Fresh timestamp + guards are adopted per call. Returns { ok, errorSec, message }.
   */
  async function applyPatternToDay(comp, day, blocks) {
    try {
      if (!comp.proxy || typeof comp.proxy.registerStudySetInfo !== "function") {
        return { ok: false, message: "registerStudySetInfo proxy unavailable" };
      }
      // fresh timestamp + guards: every successful save advances the server's
      // NotDownloadLastUpdateTime — stale values get the save Excluded ("01")
      const fresh = await fetchFresh(comp);
      if (!fresh || !fresh.StudyUnitInfoList) {
        return { ok: false, message: "could not fetch fresh set data" };
      }
      const params = fetchParams(comp);
      const guards = guardValues(fresh.StudyUnitInfoList);
      // delete only blocks that have real StudyIDs (unsaved drag-created blocks
      // have none — the server treats their SSI as new)
      const deleteList = day.cells
        .map((c) => c.bindingData)
        .filter((bd) => bd && bd.StudyID)
        .map((bd) => ({ StudyID: bd.StudyID, StudySec: bd.StudySec || "1" }));
      const start = Math.min(...day.cells.map((c) => Number(c.WorksheetNOFrom)));
      let from = start;
      const insertList = blocks.map((size) => {
        const entry = {
          StudyScheduleIndex: day.id,
          WorksheetNOFrom: from,
          WorksheetNOTo: from + size - 1,
          GradingMethod: "1",
        };
        from += size;
        return entry;
      });
      const payload = {
        SystemCountryCD: params.SystemCountryCD,
        CenterID: params.CenterID,
        StudentID: params.StudentID,
        ClassID: params.ClassID,
        ClassStudentSeq: params.ClassStudentSeq,
        SubjectCD: params.SubjectCD,
        WorksheetCD: params.WorksheetCD,
        FinishTestSetInfoList: [],
        DiagnosticTestSetRegisterKbn: "0",
        DeleteSetInfoList: deleteList,
        InsertSetInfoList: insertList,
        NotDownloadLastUpdateTime: fresh.NotDownloadLastUpdateTime,
        NotUpdateMaxStudyScheduleIndex: guards.maxIdx,
        NotUpdateMaxWorksheetNO: guards.maxWs,
      };
      const resp = await comp.proxy.registerStudySetInfo(payload);
      const resultCode = resp && resp.Result ? resp.Result.ResultCode : -1;
      const errorSec = resp ? resp.ErrorSec : null;
      if (resultCode !== 0 || errorSec !== "00") {
        return { ok: false, errorSec, message: `save rejected (ResultCode ${resultCode}, ErrorSec ${errorSec})` };
      }
      // reshape the MODEL CELLS in place so the grid shows the new pattern.
      // NEVER call the app's refresh (updateCurViewDataAfterWorksheetChange):
      // it rebuilds the model from server data and WIPES any other unsaved
      // drag-created blocks the user has in the editor. In-place reshaping
      // keeps the grid accurate AND preserves their unsaved work — a later
      // app-Save stays idempotent for the days we already wrote.
      reshapeCellsInModel(comp, day.id, blocks);
      return { ok: true, errorSec };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * Replace a day's editable cells in the page comp's studyUnits with pattern
   * cells (same bindingData.id, ranges split per pattern). Zone-patched array
   * methods trigger the grid re-render. Never throws.
   */
  function reshapeCellsInModel(comp, dayId, blocks) {
    try {
      const units = comp.studyUnits;
      if (!Array.isArray(units)) return;
      const dayCells = units.filter(
        (u) => u && u.bindingData && u.bindingData.id === dayId && String(u.DeleteFlg) === "0" && u.editable !== false
      );
      if (dayCells.length === 0) return;
      const first = dayCells[0];
      const proto = Object.getPrototypeOf(first);
      const start = Math.min(...dayCells.map((c) => Number(c.WorksheetNOFrom)));
      let offset = 0;
      const keep = [];
      for (const size of blocks) {
        const from = start + offset;
        const to = from + size - 1;
        offset += size;
        if (keep.length === 0) {
          first.WorksheetNOFrom = from;
          first.WorksheetNOTo = to;
          if (first.bindingData) {
            first.bindingData.from = from;
            first.bindingData.to = to;
          }
          keep.push(first);
        } else {
          const c = proto ? Object.create(proto) : {};
          Object.assign(c, first, { WorksheetNOFrom: from, WorksheetNOTo: to });
          c.bindingData = Object.assign({}, first.bindingData, { from, to, lastFrom: from, lastTo: to });
          keep.push(c);
        }
      }
      // remove the day's other cells, insert the extra pattern cells at the
      // first cell's position
      const firstIdx = units.indexOf(first);
      for (const c of dayCells) {
        if (c === first) continue;
        const i = units.indexOf(c);
        if (i >= 0) units.splice(i, 1);
      }
      if (firstIdx >= 0) {
        for (let i = keep.length - 1; i >= 1; i--) units.splice(firstIdx, 0, keep[i]);
      }
    } catch (e) {
      /* best-effort */
    }
  }

  /**
   * Apply a pattern (e.g. "4-3-3") to every assignable day in the RENDER MODEL
   * whose editable total equals the pattern's sum (e.g. 10). Returns
   * { changed, results }.
   */
  async function applyPatternToMatchingDays(rawPattern, root) {
    try {
      const blocks = QS.patterns.parsePattern(rawPattern);
      if (!blocks) return { changed: 0, results: [] };
      const sum = QS.patterns.patternSum(blocks);
      const comp = findPageComp(root);
      if (!comp) return { changed: 0, results: [{ message: "editor component not found" }] };
      const matchIds = daysFromRender(comp.studyUnits)
        .filter((d) => dayTotal(d) === sum)
        .map((d) => d.id);
      let changed = 0;
      const results = [];
      for (const id of matchIds) {
        // re-derive the day from the CURRENT model (a previous save's refresh
        // may have rebuilt it)
        const day = daysFromRender(comp.studyUnits).find((d) => d.id === id);
        if (!day) {
          results.push({ id, ok: false, message: "day not in model anymore" });
          continue;
        }
        const res = await applyPatternToDay(comp, day, blocks);
        results.push({ id, ...res });
        if (res.ok) changed++;
      }
      return { changed, results };
    } catch (e) {
      return { changed: 0, results: [{ message: String(e && e.message ? e.message : e) }] };
    }
  }

  return { findPageComp, applyPatternToMatchingDays };
})();
