// src/day-blocks.js — classic script; reshapes worksheet blocks via the page
// component's studyUnits model (the array the app's Save diff reads); attaches to globalThis.QS
var QS = globalThis.QS || (globalThis.QS = {});

QS.blocks = (function () {
  /**
   * Locate the ATD0010P page component (has studyUnits + checkDiff).
   * Same __ngContext__ traversal as angular-hooks.js — reuses QS.angular if present.
   */
  function findPageComp(root) {
    try {
      const r = root || document;
      const el = r.querySelector(".setStudyUnitEditorContainer, study-unit-editor");
      if (!el) return null;
      if (QS.angular && QS.angular.findComp) {
        const found = QS.angular.findComp(el, ["studyUnits", "checkDiff"]);
        return found ? found.comp : null;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Days = studyUnits grouped by bindingData.id (the true StudyScheduleIndex).
   * Returns [{ id, cells: [...] }] — only rows that have editable (cls0) cells.
   */
  function findDays(root) {
    try {
      const comp = findPageComp(root);
      if (!comp || !Array.isArray(comp.studyUnits)) return [];
      const byId = new Map();
      for (const u of comp.studyUnits) {
        const bd = u.bindingData;
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
   * Reshape one day into the given block sizes (e.g. [4,3,3]).
   * Mutates the FIRST cell in place (keeps its StudyID/bindingData) and pushes
   * clones for the remaining blocks — the app's Save diff then emits
   * InsertSetInfoList entries for every changed block (verified mechanism).
   */
  function applyPatternToDay(day, blocks) {
    try {
      if (!day || !Array.isArray(blocks) || blocks.length === 0 || day.cells.length === 0) return false;
      const cells = day.cells.slice().sort((a, b) => Number(a.WorksheetNOFrom) - Number(b.WorksheetNOFrom));
      const start = Number(cells[0].WorksheetNOFrom);
      if (!Number.isFinite(start)) return false;
      const first = cells[0];
      const proto = Object.getPrototypeOf(first);
      // rebuild the day's editable cells in place: reuse the first, replace the rest
      const keep = [first];
      for (let i = 1; i < blocks.length; i++) {
        const from = start + blocks.slice(0, i).reduce((a, b) => a + b, 0);
        const to = from + blocks[i] - 1;
        const clone = Object.create(proto);
        Object.assign(clone, first, {
          WorksheetNOFrom: from,
          WorksheetNOTo: to,
          bindingData: Object.assign({}, first.bindingData, {
            from: from,
            to: to,
            lastFrom: from,
            lastTo: to,
          }),
        });
        keep.push(clone);
      }
      // set the first cell's range to the first block
      first.WorksheetNOFrom = start;
      first.WorksheetNOTo = start + blocks[0] - 1;
      first.bindingData.from = start;
      first.bindingData.to = start + blocks[0] - 1;
      first.bindingData.lastFrom = start;
      first.bindingData.lastTo = start + blocks[0] - 1;
      // swap the day's cells: remove the old editable cells, insert the new ones
      const comp = findPageComp();
      const all = comp.studyUnits;
      const oldIdxs = cells.map((c) => all.indexOf(c)).filter((i) => i >= 0).sort((a, b) => b - a);
      for (const i of oldIdxs) all.splice(i, 1);
      const insertAt = Math.max(0, ...all.map((c, i) => (c.bindingData && c.bindingData.id === day.id ? i : -1))) ;
      const at = insertAt >= 0 ? insertAt : all.length;
      all.splice(at, 0, ...keep);
      // the app gates Save on checkDiff() — flip it via the app's own method
      if (typeof comp.checkDiff === "function") {
        try {
          comp.checkDiff();
        } catch (e) {
          /* never throw into the page */
        }
      }
      return true;
    } catch (e) {
      // never throw into the page
      return false;
    }
  }

  /**
   * Apply a pattern (e.g. "4-3-3") to every day whose editable total equals
   * the pattern's sum (e.g. 10). Returns the number of days reshaped.
   */
  function applyPatternToMatchingDays(rawPattern, root) {
    try {
      const blocks = QS.patterns.parsePattern(rawPattern);
      if (!blocks) return 0;
      const sum = QS.patterns.patternSum(blocks);
      let changed = 0;
      for (const day of findDays(root)) {
        if (dayBlockTotal(day) === sum) {
          if (applyPatternToDay(day, blocks)) changed++;
        }
      }
      return changed;
    } catch (e) {
      return 0;
    }
  }

  return { findDays, dayBlockTotal, applyPatternToDay, applyPatternToMatchingDays, findPageComp };
})();
