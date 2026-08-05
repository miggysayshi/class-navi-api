// src/lib.js — classic script; shared DOM helpers; attaches to globalThis.QS
var QS = globalThis.QS || (globalThis.QS = {});
QS.lib = (function () {
  function qsa(sel, root = document) {
    return [...root.querySelectorAll(sel)];
  }
  function on(el, evt, fn) {
    el.addEventListener(evt, fn);
  }
  /** Dispatch events Angular observes (bubbles + composed). */
  function dispatchAngular(el, evtType) {
    el.dispatchEvent(new Event(evtType, { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }
  return { qsa, on, dispatchAngular };
})();
