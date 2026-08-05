// src/day-blocks.js — classic script; reshapes worksheet blocks by calling the
// app's own authenticated proxies (getStudyResultInfoList + registerStudySetInfo)
// with the verified Spike B payload recipe. Everything operates on FRESH server
// data fetched per operation — no stale model, no save-diff interaction.
// Deterministic server-side replace per StudyScheduleIndex. Attaches to globalThis.QS.
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

  /** Build the getStudyResultInfoList params the app itself uses. */
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

  /** Fetch the freshest set data through the app's own proxy. */
  async function fetchFresh(comp) {
    if (!comp.proxy || typeof comp.proxy.getStudyResultInfoList !== "function") return null;
    const params = fetchParams(comp);
    if (!params) return null;
    const resp = await comp.proxy.getStudyResultInfoList(params);
    if (!resp || !resp.Result || resp.Result.ResultCode !== 0) return null;
    return resp;
  }

  /**
   * Days from fresh source records. Editable (assignable) = DownloadFlg "0"
   * (studied records carry "1"). Returns [{ id, cells }].
   */
  function daysFromRecords(records) {
    const byId = {};
    for (const u of records) {
      if (!u || String(u.DeleteFlg) === "1" || String(u.DownloadFlg) !== "0") continue;
      if (u.StudyScheduleIndex === undefined) continue;
      if (!byId[u.StudyScheduleIndex]) byId[u.StudyScheduleIndex] = [];
      byId[u.StudyScheduleIndex].push(u);
    }
    return Object.keys(byId).map(Number).map((id) => ({ id, cells: byId[id] }));
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
   * Reshape one day (from fresh records) via the app's own register proxy.
   * Returns { ok, errorSec, message }.
   */
  async function applyPatternToDay(comp, day, blocks) {
    try {
      if (!comp.proxy || typeof comp.proxy.registerStudySetInfo !== "function") {
        return { ok: false, message: "registerStudySetInfo proxy unavailable" };
      }
      const deleteList = day.cells
        .map((c) => ({ StudyID: c.StudyID, StudySec: c.StudySec || "1" }))
        .filter((e) => e.StudyID);
      const start = Math.min(...day.cells.map((c) => Number(c.WorksheetNOFrom)));
      let from = start;
      const insertList = blocks.map((size) => {
        const entry = { StudyScheduleIndex: day.id, WorksheetNOFrom: from, WorksheetNOTo: from + size - 1, GradingMethod: "1" };
        from += size;
        return entry;
      });
      const params = fetchParams(comp);
      const guards = guardValues(comp.curStudentStudyInfo ? comp.curStudentStudyInfo.StudyUnitInfoList || [] : []);
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
        NotDownloadLastUpdateTime: comp.curStudentStudyInfo ? comp.curStudentStudyInfo.NotDownloadLastUpdateTime : null,
        NotUpdateMaxStudyScheduleIndex: guards.maxIdx,
        NotUpdateMaxWorksheetNO: guards.maxWs,
      };
      const resp = await comp.proxy.registerStudySetInfo(payload);
      const resultCode = resp && resp.Result ? resp.Result.ResultCode : -1;
      const errorSec = resp ? resp.ErrorSec : null;
      if (resultCode !== 0 || errorSec !== "00") {
        return { ok: false, errorSec, message: `save rejected (ResultCode ${resultCode}, ErrorSec ${errorSec})` };
      }
      return { ok: true, errorSec };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * Apply a pattern (e.g. "4-3-3") to every assignable day whose total equals
   * the pattern's sum (e.g. 10). Re-fetches fresh data around each save so the
   * NotDownloadLastUpdateTime is never stale (stale → ErrorSec "01" exclusion).
   * Returns { changed, results }.
   */
  async function applyPatternToMatchingDays(rawPattern, root) {
    try {
      const blocks = QS.patterns.parsePattern(rawPattern);
      if (!blocks) return { changed: 0, results: [] };
      const sum = QS.patterns.patternSum(blocks);
      const comp = findPageComp(root);
      if (!comp) return { changed: 0, results: [{ message: "editor component not found" }] };
      const fresh = await fetchFresh(comp);
      if (!fresh || !Array.isArray(fresh.StudyUnitInfoList)) {
        return { changed: 0, results: [{ message: "could not fetch set data" }] };
      }
      const matchIds = daysFromRecords(fresh.StudyUnitInfoList)
        .filter((d) => dayTotal(d) === sum)
        .map((d) => d.id);
      let changed = 0;
      const results = [];
      for (const id of matchIds) {
        // re-fetch before each save: every successful save advances the server
        // timestamp; using a stale one gets the save Excluded
        const f2 = await fetchFresh(comp);
        if (!f2 || !Array.isArray(f2.StudyUnitInfoList)) {
          results.push({ id, ok: false, message: "re-fetch failed before save" });
          continue;
        }
        const day = daysFromRecords(f2.StudyUnitInfoList).find((d) => d.id === id);
        if (!day) {
          results.push({ id, ok: false, message: "day vanished between fetches" });
          continue;
        }
        // adopt the fresh data so payload guards + timestamp are current
        if (comp.curStudentStudyInfo) {
          try {
            comp.curStudentStudyInfo.StudyUnitInfoList = f2.StudyUnitInfoList;
            comp.curStudentStudyInfo.NotDownloadLastUpdateTime = f2.NotDownloadLastUpdateTime;
          } catch (e) {
            /* best-effort */
          }
        }
        const res = await applyPatternToDay(comp, day, blocks);
        results.push({ id, ...res });
        if (res.ok) {
          changed++;
          // refresh the grid view through the app's own post-save path
          if (typeof comp.updateCurViewDataAfterWorksheetChange === "function") {
            try {
              await comp.updateCurViewDataAfterWorksheetChange();
            } catch (e) {
              /* best-effort */
            }
          }
        }
      }
      return { changed, results };
    } catch (e) {
      return { changed: 0, results: [{ message: String(e && e.message ? e.message : e) }] };
    }
  }

  return { findPageComp, applyPatternToMatchingDays };
})();
