// src/angular-hooks.js — classic script; Angular internals access.
// Production build has NO window.ng; component access goes through the
// __ngContext__ lView traversal. Recipe verified in docs/spike-c-angular.md §2.
var QS = globalThis.QS || (globalThis.QS = {});
QS.angular = (function () {
  const MAX_PARENT_DEPTH = 12; // verified target depth is 7

  /** Scan an Angular lView array for the first object exposing any of props. */
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

  /**
   * Walk up from the element matching sel (max 12 levels) looking for a
   * component whose lView holds any of props. Never throws; null on failure.
   */
  function findComp(sel, props, root) {
    try {
      let el = (root || document).querySelector(sel);
      let d = 0;
      while (el && d < MAX_PARENT_DEPTH) {
        const ctx = el.__ngContext__;
        const found = ctx ? scanLView(ctx, props) : null;
        if (found) return { ...found, depth: d, elTag: el.tagName };
        el = el.parentElement;
        d++;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  /**
   * Returns the minWorksheetUnitCountList array backing the worksheets-per-study
   * dropdown (verified: APP-ATD0010P page comp, depth 7), or null when the
   * editor screen is not present / anything fails. Never throws.
   */
  function findMinWorksheetCountList(root) {
    try {
      const found = findComp(".option.setting-options", ["minWorksheetUnitCountList"], root);
      if (!found) return null;
      const list = found.comp.minWorksheetUnitCountList;
      return Array.isArray(list) ? list : null;
    } catch (e) {
      return null;
    }
  }

  return { scanLView, findComp, findMinWorksheetCountList };
})();
