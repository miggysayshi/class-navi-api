// src/marking.js — classic script; Quick Mark features for the marking screen
// (ATD0020P): mark-all per page, typed on-page comments, keyboard shortcuts.
//
// NATIVE-PARITY design (2026-08-05, after live bug: mark boxes vanished when a
// re-derived markBoxs array was assigned — the app renders mark boxes from its
// own per-question derivation):
//   - markAll drives the app's OWN per-question method
//     (worksheet-page.updateQuestionMarkToNext — exactly what a mark-box click
//     calls) the right number of cycles to reach the target state; then the
//     app's updateScore/updateScoreStatusForPage/changeMarking.emit.
//   - addTypedComment constructs the SDK's text item (InkPenType.Old_KesText)
//     directly and writes it into the red-comment layer: the stroke's inkData,
//     the model, and scoringResultData.redCommentList[pageIndex] (the app's own
//     updateRedComment sync — the save source). The app's own Save persists it.
// Attaches to globalThis.QS.
var QS = globalThis.QS || (globalThis.QS = {});

QS.marking = (function () {
  // qr codes (bundle: qr enum) — what the app stores per answer attempt
  const QR = { Default: 0, Incorrect: 1, Right: 2, Triangle: 3 };

  function rightCodeFor(correct) {
    return correct ? QR.Right : QR.Incorrect;
  }

  /**
   * Set every question's LAST attempt on the given page to the code
   * (2 = correct, 1 = wrong). Direct-mutation utility (fallback path); the
   * live markAll prefers the native cycle (updateQuestionMarkToNext) so the
   * visible mark boxes stay in sync. Never throws.
   */
  function markPageQuestions(gradingResultData, pageNumber, code) {
    try {
      if (!gradingResultData || !Array.isArray(gradingResultData.PageMarks)) return 0;
      const page = gradingResultData.PageMarks.find((p) => Number(p.PageNumber) === Number(pageNumber));
      if (!page || !Array.isArray(page.QuestionMarks)) return 0;
      let changed = 0;
      for (const q of page.QuestionMarks) {
        const list = q && Array.isArray(q.AnswerRightList) ? q.AnswerRightList : null;
        if (!list || list.length === 0) continue;
        const last = list[list.length - 1];
        if (!last || typeof last !== "object") continue;
        last.Right = code;
        last.ManualRight = code;
        changed++;
      }
      return changed;
    } catch (e) {
      return 0;
    }
  }

  /** True when the focused element is a typing target (shortcut guard). */
  function isTypingTarget(el) {
    if (!el) return false;
    const t = (el.tagName || "").toUpperCase();
    return t === "INPUT" || t === "TEXTAREA" || el.isContentEditable === true;
  }

  // ---------- live-screen integration ----------

  /** The ATD0020P page component (the marking screen). */
  function findScreen(root) {
    try {
      const el = (root || document).querySelector("app-atd0020p");
      if (!el) return null;
      if (!QS.angular || typeof QS.angular.findComp !== "function") return null;
      const found = QS.angular.findComp(el, ["studySetList"]);
      return found && found.comp.displayId === "ATD0020P" ? found.comp : null;
    } catch (e) {
      return null;
    }
  }

  /** The current worksheet-page component (canvas with mark boxes). */
  function findPageComp(screen) {
    try {
      if (!screen) return null;
      const el = document.querySelector("app-worksheet-page");
      if (!el) return null;
      const found = QS.angular.findComp(el, ["redCommentStroke"]);
      return found ? found.comp : null;
    } catch (e) {
      return null;
    }
  }

  /** The set + scoring data behind the current page. */
  function currentSet(screen, page) {
    const set = page && page.studySet ? page.studySet : null;
    if (set) return set;
    if (screen && Array.isArray(screen.studySetList)) return screen.studySetList[0] || null;
    return null;
  }

  /**
   * Mark all questions on the current page via the app's own per-question
   * cycle (updateQuestionMarkToNext — what a mark-box click calls), cycling
   * each question just enough to reach the target state. Returns
   * { ok, changed, message }.
   */
  async function markAll(correct) {
    try {
      const screen = findScreen();
      if (!screen) return { ok: false, message: "marking screen not found" };
      const page = findPageComp(screen);
      if (!page || typeof page.updateQuestionMarkToNext !== "function") {
        return { ok: false, message: "worksheet page not found" };
      }
      const set = currentSet(screen, page);
      const srd = set && set.scoringResultData;
      if (!srd || !srd.gradingResultData) return { ok: false, message: "no scoring data on this page" };
      const pageIndex = page.pagePath ? Number(page.pagePath.pageIndex) : 0;
      const marks = srd.gradingResultData.PageMarks;
      const pageMarks = Array.isArray(marks) ? marks.find((p) => Number(p.PageNumber) === pageIndex) : null;
      const questions = pageMarks && Array.isArray(pageMarks.QuestionMarks) ? pageMarks.QuestionMarks : [];
      if (questions.length === 0) return { ok: false, message: "no markable questions on this page" };
      const code = rightCodeFor(correct);
      let changed = 0;
      let cycled = 0;
      for (const q of questions) {
        const list = q && Array.isArray(q.AnswerRightList) ? q.AnswerRightList : null;
        if (!list || list.length === 0) continue;
        const qn = q.QuestionData && q.QuestionData.QuestionNumber;
        if (qn === undefined || qn === null || isNaN(Number(qn))) continue;
        // skip questions already correct via a PRIOR attempt: cycling the last
        // attempt to Right would create the app's native double-right state,
        // which HIDES the mark box (getMarkBox returns null) — the exact bug
        // the user hit ("boxes disappear when all already correct")
        const prev = list.length > 1 ? list[list.length - 2] : null;
        if (code === QR.Right && prev && Number(prev.Right) === QR.Right) continue;
        // cycle natively until the last attempt reaches the target code
        let guard = 0;
        while (guard < 8) {
          const last = list[list.length - 1];
          if (!last || Number(last.Right) === code) break;
          page.updateQuestionMarkToNext(Number(qn));
          guard++;
        }
        if (guard > 0) cycled += guard;
        changed++;
      }
      // native post-mark sync (mirrors onClick_btnMarkBox). SKIPPED entirely
      // when nothing changed: the sync re-derives state, and re-deriving an
      // already-correct page can hide boxes — a pure no-op must stay a no-op.
      if (cycled > 0) {
        if (typeof page.updateScore === "function") page.updateScore();
        if (typeof page.updateScoreStatusForPage === "function") page.updateScoreStatusForPage();
        if (page.changeMarking && typeof page.changeMarking.emit === "function") {
          try {
            page.changeMarking.emit({ studySet: set, path: page.pagePath });
          } catch (e) {
            /* best-effort */
          }
        }
      }
      return { ok: true, changed };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * Add a typed text element to the current page's red-comment ink at
   * (x, y) — page-image coordinates. Constructs the SDK's text item
   * (InkPenType.Old_KesText) directly, writes it into the stroke layer +
   * model + redCommentList (save source) via the app's own sync.
   * Returns { ok, message }.
   */
  async function addTypedComment(text, x, y) {
    try {
      const screen = findScreen();
      if (!screen) return { ok: false, message: "marking screen not found" };
      const page = findPageComp(screen);
      if (!page || !page.model) return { ok: false, message: "worksheet page not found" };
      if (typeof window.InkTool === "undefined" || !window.InkTool.InkPenType) {
        return { ok: false, message: "InkTool SDK unavailable" };
      }
      const pageIndex = page.pagePath ? Number(page.pagePath.pageIndex) : 0;
      // the red-comment ink for this page (JSON string, or null when unused)
      let inkStr = page.redCommentStroke && page.redCommentStroke.inkData ? page.redCommentStroke.inkData : page.model.redComment;
      let obj;
      try {
        obj = JSON.parse(typeof inkStr === "string" ? inkStr : JSON.stringify(inkStr || { is: [] }));
      } catch (e) {
        obj = { is: [] };
      }
      if (!obj || typeof obj !== "object") obj = { is: [] };
      if (!Array.isArray(obj.is)) obj.is = [];
      // item number: one past the largest existing (the SDK sorts by t)
      let itm = 0;
      for (const it of obj.is) {
        const t = it && it.t !== undefined ? Number(it.t) : 0;
        if (Number.isFinite(t) && t >= itm) itm = t + 1;
      }
      const item = {
        // full InkText stationery (matches what the SDK serializes for text
        // items — the loader creates the stationery from st.tp; col default
        // black renders readably on the worksheet)
        st: { tp: window.InkTool.InkPenType.Old_KesText, col: "black", w: 1, minw: 1, maxw: 1 },
        t: itm,
        kmn: {
          qu: 0,
          ar: 0,
          tr: pageIndex,
          sd: 0,
          si: 0,
          tx: text,
          txtRect: { x: Number(x) || 0, y: Number(y) || 0, width: Math.max(40, text.length * 8), height: 20 },
        },
      };
      obj.is.push(item);
      const newInk = JSON.stringify(obj);
      // write into every layer the app reads, then sync + re-render
      if (page.redCommentStroke) page.redCommentStroke.inkData = newInk;
      if (page.model) page.model.redComment = newInk;
      if (typeof page.updateRedComment === "function") {
        try {
          page.updateRedComment(); // redCommentList[pageIndex] = newInk (save source)
        } catch (e) {
          /* best-effort */
        }
      }
      if (typeof page.updateStrokes === "function") {
        try {
          page.updateStrokes(); // re-sync the stroke layers from the model
        } catch (e) {
          /* best-effort */
        }
      }
      // FORCE the canvas redraw — the app never calls this for the red layer
      // (only the study layer gets prepareForPlay); without it the new ink
      // sits in the model but never renders.
      try {
        const canvas = page.redCommentStroke && page.redCommentStroke.canvas;
        if (canvas && typeof canvas.redrawInk === "function") canvas.redrawInk();
        else if (canvas && typeof canvas.redrawCurrentLayerByInk === "function") canvas.redrawCurrentLayerByInk();
      } catch (e) {
        /* best-effort */
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * Build the SDK text item for the red-comment ink (InkPenType.Old_KesText).
   * ink = the parsed ink object ({is: [...]}); returns the item to push.
   * Pure — no SDK access needed.
   */
  function buildTextItem(ink, pageIndex, text, x, y) {
    let itm = 0;
    const items = ink && Array.isArray(ink.is) ? ink.is : [];
    for (const it of items) {
      const t = it && it.t !== undefined ? Number(it.t) : 0;
      if (Number.isFinite(t) && t >= itm) itm = t + 1;
    }
    return {
      st: { tp: 23 }, // InkPenType.Old_KesText (numeric, SDK-agnostic in tests)
      t: itm,
      kmn: {
        qu: 0,
        ar: 0,
        tr: pageIndex,
        sd: 0,
        si: 0,
        tx: text,
        txtRect: { x: Number(x) || 0, y: Number(y) || 0, width: Math.max(40, text.length * 8), height: 20 },
      },
    };
  }

  return {
    QR,
    rightCodeFor,
    markPageQuestions,
    isTypingTarget,
    buildTextItem,
    findScreen,
    findPageComp,
    markAll,
    addTypedComment,
  };
})();
