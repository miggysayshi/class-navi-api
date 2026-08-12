// src/day-blocks.js — classic script; reshapes worksheet blocks by calling the
// app's own authenticated proxies (getStudyResultInfoList + registerStudySetInfo)
// with the verified Spike B payload recipe.
//
// Matching (v2 semantics, 2026-08-05):
//   - Only days whose editable blocks are ALL full 10-page blocks (10, 20, 30, …)
//     are changed. Custom-split days (5-5, 4-3-3, 2-2-2-2-2, mixed) are skipped
//     — never re-flattened.
//   - Each full-10 block is expanded: the pattern repeats to fill it (sum 10 →
//     once per 10 pages, sum 5 → twice, …).
// Matching runs against the RENDER MODEL (the page comp's studyUnits — the
// user's live view, including unsaved drag-created blocks). Timestamps + guard
// values come from a fresh proxy fetch per save (stale timestamps get the save
// Excluded, ErrorSec "01"). Attaches to globalThis.QS.
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

  /** Block size of a cell. */
  function blockSize(c) {
    const from = Number(c.WorksheetNOFrom);
    const to = Number(c.WorksheetNOTo);
    return Number.isFinite(from) && Number.isFinite(to) ? to - from + 1 : 0;
  }

  /**
   * Candidate day = every editable block is a full 10-page block (10, 20, 30…).
   * Already-formatted days (5-5, 4-3-3, …) fail this and are skipped.
   */
  function isCandidateDay(day) {
    return QS.patterns.isFullTenBlocks(day.cells.map(blockSize));
  }

  /**
   * The day's new block sizes: for each existing block (in worksheet order),
   * the pattern repeated to fill it. Null when a block can't be filled.
   */
  function expandedSizes(day, pattern) {
    const out = [];
    const ordered = day.cells
      .slice()
      .sort((a, b) => Number(a.WorksheetNOFrom) - Number(b.WorksheetNOFrom));
    for (const c of ordered) {
      const sizes = QS.patterns.expandForBlock(blockSize(c), pattern);
      if (!sizes) return null;
      for (const s of sizes) out.push(s);
    }
    return out;
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
  async function applyPatternToDay(comp, day, pattern) {
    try {
      if (!comp.proxy || typeof comp.proxy.registerStudySetInfo !== "function") {
        return { ok: false, message: "registerStudySetInfo proxy unavailable" };
      }
      const sizes = expandedSizes(day, pattern);
      if (!sizes) {
        return { ok: false, message: `pattern does not divide the day's blocks evenly` };
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
      // expanded ranges: each original block (in worksheet order) is filled by
      // the repeated pattern, starting at that block's WorksheetNOFrom
      const insertList = [];
      const ordered = day.cells
        .slice()
        .sort((a, b) => Number(a.WorksheetNOFrom) - Number(b.WorksheetNOFrom));
      for (const c of ordered) {
        let from = Number(c.WorksheetNOFrom);
        for (const size of QS.patterns.expandForBlock(blockSize(c), pattern)) {
          insertList.push({
            StudyScheduleIndex: day.id,
            WorksheetNOFrom: from,
            WorksheetNOTo: from + size - 1,
            GradingMethod: "1",
          });
          from += size;
        }
      }
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
      reshapeCellsInModel(comp, day.id, insertList);
      return { ok: true, errorSec };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * Replace a day's editable cells in the page comp's studyUnits with the
   * already-built insert cells (same bindingData.id, ranges per the expanded
   * pattern). Zone-patched array methods trigger the grid re-render.
   * Never throws.
   */
  function reshapeCellsInModel(comp, dayId, insertList) {
    try {
      const units = comp.studyUnits;
      if (!Array.isArray(units)) return;
      const dayCells = units.filter(
        (u) => u && u.bindingData && u.bindingData.id === dayId && String(u.DeleteFlg) === "0" && u.editable !== false
      );
      if (dayCells.length === 0) return;
      const first = dayCells[0];
      const proto = Object.getPrototypeOf(first);
      // build pattern cells from the insert entries
      const keep = [];
      let firstDone = false;
      for (const ins of insertList) {
        const from = Number(ins.WorksheetNOFrom);
        const to = Number(ins.WorksheetNOTo);
        if (!firstDone) {
          first.WorksheetNOFrom = from;
          first.WorksheetNOTo = to;
          if (first.bindingData) {
            first.bindingData.from = from;
            first.bindingData.to = to;
          }
          keep.push(first);
          firstDone = true;
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
   * Apply a pattern (e.g. "4-3-3") to every assignable day made of full 10-page
   * blocks. Custom-split days are skipped. Returns { changed, results }.
   * opts.onProgress(done, total) fires before each day's save.
   */
  async function applyPatternToMatchingDays(rawPattern, root, opts) {
    try {
      const blocks = QS.patterns.parsePattern(rawPattern);
      if (!blocks) return { changed: 0, results: [] };
      const sum = QS.patterns.patternSum(blocks);
      if (10 % sum !== 0) {
        return { changed: 0, results: [{ message: `pattern sum ${sum} does not divide 10-page chunks` }] };
      }
      const onProgress = opts && typeof opts.onProgress === "function" ? opts.onProgress : null;
      const comp = findPageComp(root);
      if (!comp) return { changed: 0, results: [{ message: "editor component not found" }] };
      const candidates = daysFromRender(comp.studyUnits).filter(isCandidateDay);
      const total = candidates.length;
      let changed = 0;
      const results = [];
      for (let i = 0; i < candidates.length; i++) {
        if (onProgress) onProgress(i + 1, total);
        // re-derive the day from the CURRENT model (a previous save's in-place
        // reshape replaced its cells)
        const day = daysFromRender(comp.studyUnits).find((d) => d.id === candidates[i].id);
        if (!day) {
          results.push({ id: candidates[i].id, ok: false, message: "day not in model anymore" });
          continue;
        }
        const res = await applyPatternToDay(comp, day, blocks);
        results.push({ id: day.id, ...res });
        if (res.ok) changed++;
      }
      return { changed, results };
    } catch (e) {
      return { changed: 0, results: [{ message: String(e && e.message ? e.message : e) }] };
    }
  }

  return { findPageComp, fetchParams, applyPatternToMatchingDays };
})();
