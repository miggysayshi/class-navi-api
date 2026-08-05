// src/day-blocks.js — classic script; reshapes worksheet blocks by calling the
// app's own authenticated registerStudySetInfo proxy with the verified payload
// recipe (Spike B: ErrorSec "00" proven twice). No model mutation, no save-diff
// interaction — deterministic server-side replace per StudyScheduleIndex.
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
   * Days = studyUnits grouped by bindingData.id (the true StudyScheduleIndex).
   * Returns [{ id, cells: [...] }] — only days that have editable cells.
   */
  function daysFrom(units) {
    const byId = new Map();
    for (const u of units) {
      const bd = u && u.bindingData;
      if (!bd || bd.id === undefined) continue;
      if (!byId.has(bd.id)) byId.set(bd.id, []);
      byId.get(bd.id).push(u);
    }
    const days = [];
    for (const [id, cells] of byId) {
      const editable = cells.filter((c) => String(c.DeleteFlg) === "0" && c.editable !== false);
      if (editable.length > 0) days.push({ id, cells: editable });
    }
    return days;
  }

  function findDays(root) {
    try {
      const comp = findPageComp(root);
      return comp && Array.isArray(comp.studyUnits) ? daysFrom(comp.studyUnits) : [];
    } catch (e) {
      return [];
    }
  }

  /** Sum of a day's editable block sizes. */
  function dayBlockTotal(day) {
    try {
      let sum = 0;
      for (const c of day.cells) {
        const from = Number(c.WorksheetNOFrom);
        const to = Number(c.WorksheetNOTo);
        if (Number.isFinite(from) && Number.isFinite(to)) sum += to - from + 1;
      }
      return sum;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Build the registerStudySetInfo payload for replacing one day's blocks —
   * mirrors the app's own save assembly (bundle: registerStudySetInfo call).
   */
  function buildPayload(comp, day, blocks) {
    const info = comp.curStudentStudyInfo;
    const student = comp.curStudentInfo;
    const subject = comp.curSubjectInfo;
    const cache = comp.context && comp.context.cache ? comp.context.cache : null;
    const appConfig = comp.context && comp.context.appConfig ? comp.context.appConfig : null;
    if (!info || !student || !subject || !cache || !appConfig) return null;

    // delete the day's current blocks by StudyID (deterministic replace)
    const deleteList = day.cells
      .map((c) => c.bindingData)
      .filter((bd) => bd && bd.StudyID)
      .map((bd) => ({ StudyID: bd.StudyID, StudySec: bd.StudySec || "1" }));

    // insert the new pattern blocks on the day's true StudyScheduleIndex
    const start = Math.min(...day.cells.map((c) => Number(c.WorksheetNOFrom)));
    let from = start;
    const insertList = blocks.map((size) => {
      const entry = { StudyScheduleIndex: day.id, WorksheetNOFrom: from, WorksheetNOTo: from + size - 1, GradingMethod: "1" };
      from += size;
      return entry;
    });

    // guard values: max studied index/worksheet among DownloadFlg "1" records
    let maxIdx = null;
    let maxWs = null;
    const studied = (info.StudyUnitInfoList || []).filter((u) => String(u.DownloadFlg) === "1");
    if (studied.length > 0) {
      maxIdx = Math.max(...studied.map((u) => Number(u.StudyScheduleIndex)));
      const atMax = studied.filter((u) => Number(u.StudyScheduleIndex) === maxIdx);
      let hasSec3 = false;
      for (const u of atMax) if (String(u.StudySec) === "3") { hasSec3 = true; break; }
      if (!hasSec3) maxWs = Math.max(...atMax.map((u) => Number(u.WorksheetNOTo)));
    }

    return {
      SystemCountryCD: appConfig.systemCountryCD || "USA",
      CenterID: cache.instructorInfo.MainCenterID,
      StudentID: student.StudentID,
      ClassID: subject.ClassID,
      ClassStudentSeq: subject.ClassStudentSeq,
      SubjectCD: comp.curSubjectCD,
      WorksheetCD: comp.curWorksheetCD,
      FinishTestSetInfoList: [],
      DiagnosticTestSetRegisterKbn: "0",
      DeleteSetInfoList: deleteList,
      InsertSetInfoList: insertList,
      NotDownloadLastUpdateTime: info.NotDownloadLastUpdateTime,
      NotUpdateMaxStudyScheduleIndex: maxIdx,
      NotUpdateMaxWorksheetNO: maxWs,
    };
  }

  /**
   * Reshape one day via the app's own proxy. Returns { ok, errorSec, message }.
   */
  async function applyPatternToDay(day, blocks) {
    try {
      const comp = findPageComp();
      if (!comp) return { ok: false, message: "editor component not found" };
      if (!comp.proxy || typeof comp.proxy.registerStudySetInfo !== "function") {
        return { ok: false, message: "registerStudySetInfo proxy unavailable" };
      }
      const payload = buildPayload(comp, day, blocks);
      if (!payload) return { ok: false, message: "could not build payload" };
      const resp = await comp.proxy.registerStudySetInfo(payload);
      const resultCode = resp && resp.Result ? resp.Result.ResultCode : -1;
      const errorSec = resp ? resp.ErrorSec : null;
      if (resultCode !== 0 || errorSec !== "00") {
        return { ok: false, errorSec, message: `save rejected (ResultCode ${resultCode}, ErrorSec ${errorSec})` };
      }
      // refresh the editor view through the app's own post-save path
      if (typeof comp.updateCurViewDataAfterWorksheetChange === "function") {
        try {
          await comp.updateCurViewDataAfterWorksheetChange();
        } catch (e) {
          /* refresh is best-effort */
        }
      }
      return { ok: true, errorSec };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * Apply a pattern (e.g. "4-3-3") to every day whose editable total equals
   * the pattern's sum (e.g. 10). Returns { changed, results }.
   */
  async function applyPatternToMatchingDays(rawPattern, root) {
    try {
      const blocks = QS.patterns.parsePattern(rawPattern);
      if (!blocks) return { changed: 0, results: [] };
      const sum = QS.patterns.patternSum(blocks);
      let changed = 0;
      const results = [];
      for (const day of findDays(root)) {
        if (dayBlockTotal(day) !== sum) continue;
        const res = await applyPatternToDay(day, blocks);
        results.push({ id: day.id, ...res });
        if (res.ok) changed++;
      }
      return { changed, results };
    } catch (e) {
      return { changed: 0, results: [{ message: String(e && e.message ? e.message : e) }] };
    }
  }

  return { findDays, dayBlockTotal, applyPatternToDay, applyPatternToMatchingDays, findPageComp };
})();
