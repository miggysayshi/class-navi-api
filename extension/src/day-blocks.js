// src/day-blocks.js — classic script; reshapes worksheet blocks in BOTH the page
// component's studyUnits (what the app's Save diff reads) and the grid component's
// render copy (what the user sees); attaches to globalThis.QS
var QS = globalThis.QS || (globalThis.QS = {});

QS.blocks = (function () {
  /**
   * Locate a component via the shared __ngContext__ traversal (reuses QS.angular).
   */
  function findCompFrom(el, props) {
    try {
      if (!el) return null;
      if (QS.angular && QS.angular.findComp) {
        return QS.angular.findComp(el, props);
      }
      return null;
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
   * Core reshape on one units array: replace the day's editable cells with the
   * pattern blocks, preserving the first cell's StudyID/bindingData (the app's
   * Save diff keys off those). Returns the new cells (for reuse across arrays).
   */
  function reshapeCells(all, dayCells, blocks) {
    const sorted = dayCells.slice().sort((a, b) => Number(a.WorksheetNOFrom) - Number(b.WorksheetNOFrom));
    const start = Number(sorted[0].WorksheetNOFrom);
    if (!Number.isFinite(start)) return null;
    const first = sorted[0];
    const proto = Object.getPrototypeOf(first);
    const news = [first];
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
      news.push(clone);
    }
    first.WorksheetNOFrom = start;
    first.WorksheetNOTo = start + blocks[0] - 1;
    first.bindingData.from = start;
    first.bindingData.to = start + blocks[0] - 1;
    first.bindingData.lastFrom = start;
    first.bindingData.lastTo = start + blocks[0] - 1;
    // remove the day's old cells, re-insert the new ones at the first old index
    const oldIdxs = sorted.map((c) => all.indexOf(c)).filter((i) => i >= 0).sort((a, b) => a - b);
    if (oldIdxs.length === 0) return null;
    const at = oldIdxs[0];
    for (let i = oldIdxs.length - 1; i >= 0; i--) all.splice(oldIdxs[i], 1);
    all.splice(at, 0, ...news);
    return news;
  }

  /**
   * Reshape one day in BOTH models: the page comp's studyUnits (Save reads it)
   * and the grid comp's render copy (the user sees it). Returns true on success.
   */
  function applyPatternToDay(day, blocks) {
    try {
      if (!day || !Array.isArray(blocks) || blocks.length === 0 || day.cells.length === 0) return false;
      const pageComp = findPageComp();
      if (!pageComp || !Array.isArray(pageComp.studyUnits)) return false;
      const pageCells = day.cells.filter((c) => pageComp.studyUnits.includes(c));
      if (pageCells.length === 0) return false;
      const reshaped = reshapeCells(pageComp.studyUnits, pageCells, blocks);
      if (!reshaped) return false;
      // mirror into the grid component's render copy (same structure, same id)
      try {
        const grid = findCompFrom(document.querySelector("DIV.ATD0010P-root"), ["studyUnits"]);
        if (grid && Array.isArray(grid.comp.studyUnits)) {
          const gridDayCells = grid.comp.studyUnits.filter(
            (c) => c.bindingData && c.bindingData.id === day.id && String(c.DeleteFlg) === "0" && c.editable !== false,
          );
          if (gridDayCells.length > 0) reshapeCells(grid.comp.studyUnits, gridDayCells, blocks);
        }
      } catch (e) {
        /* grid mirror is best-effort — never throw into the page */
      }
      // the app gates Save on checkDiff() — flip it via the app's own method
      if (typeof pageComp.checkDiff === "function") {
        try {
          pageComp.checkDiff();
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

  function findPageComp(root) {
    try {
      const el = (root || document).querySelector(".setStudyUnitEditorContainer, study-unit-editor");
      if (!el) return null;
      // "checkDiff" uniquely identifies the PAGE component (the grid component
      // also exposes studyUnits and sits closer in the DOM walk — searching for
      // studyUnits first would grab the grid comp and leave Save disabled)
      const found = findCompFrom(el, ["checkDiff"]);
      if (!found || !Array.isArray(found.comp.studyUnits)) return null;
      return found.comp;
    } catch (e) {
      return null;
    }
  }

  return { findDays, dayBlockTotal, applyPatternToDay, applyPatternToMatchingDays, findPageComp };
})();
