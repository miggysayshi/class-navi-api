// src/marking.js — classic script; Quick Mark features for the marking screen
// (ATD0020P): mark-all per page, typed on-page comments, keyboard shortcuts.
// Mutates the in-memory grading model ONLY (the same object the app reads) and
// drives the app's own refresh paths (updateScore, updateScoreStatusForPage,
// changeMarking.emit) — the app's own Save persists it; the extension never
// touches the wire. Attaches to globalThis.QS.
var QS = globalThis.QS || (globalThis.QS = {});

QS.marking = (function () {
  // qr codes (bundle: qr enum) — what the app stores per answer attempt
  const QR = { Default: 0, Incorrect: 1, Right: 2, Triangle: 3 };

  function rightCodeFor(correct) {
    return correct ? QR.Right : QR.Incorrect;
  }

  /**
   * Set every question's LAST attempt on the given page to the code
   * (2 = correct, 1 = wrong). AutoRight (machine auto-grade) is untouched;
   * earlier attempts untouched. Same object the app's own getQuestionMarks
   * reads. Returns the number of questions changed; never throws.
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

  /**
   * Build the InkTool.addTextDataToInkData args (the SDK uses 0-based pages —
   * the Mi wrapper subtracts 1 from the app's 1-based page index).
   */
  function buildTextDataArgs(ink, pageIndex, text, x, y) {
    return [ink, pageIndex - 1, text, x, y, undefined];
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
      const el = (screen._qsPageEl || (screen._qsPageEl = document.querySelector("app-worksheet-page")));
      if (!el) return null;
      const found = QS.angular.findComp(el, ["redCommentStroke"]);
      return found ? found.comp : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Mark all questions on the current page. Returns { ok, changed, message }.
   * Mutates gradingResultData in place, then drives the app's own refresh
   * paths so the page UI, score, and status stay in sync.
   */
  async function markAll(correct) {
    try {
      const screen = findScreen();
      if (!screen) return { ok: false, message: "marking screen not found" };
      const page = findPageComp(screen);
      if (!page) return { ok: false, message: "worksheet page not found" };
      const set = page.studySet || (Array.isArray(screen.studySetList) ? screen.studySetList[0] : null);
      const srd = set && set.scoringResultData;
      if (!srd || !srd.gradingResultData) return { ok: false, message: "no scoring data on this page" };
      const pageIndex = page.pagePath ? Number(page.pagePath.pageIndex) : 0;
      const code = rightCodeFor(correct);
      const changed = markPageQuestions(srd.gradingResultData, pageIndex, code);
      if (changed === 0) return { ok: false, message: "no markable questions on this page" };
      // app-native refresh paths (mirrors onClick_btnMarkBox's post-mark flow)
      if (typeof page.updateScore === "function") page.updateScore();
      if (typeof page.updateScoreStatusForPage === "function") page.updateScoreStatusForPage();
      if (typeof page.getMarkBoxs === "function" && page.model && Array.isArray(page.model.resultBoxs)) {
        try {
          page.markBoxs = page.getMarkBoxs(page.model.resultBoxs);
        } catch (e) {
          /* best-effort */
        }
      }
      if (page.changeMarking && typeof page.changeMarking.emit === "function") {
        try {
          page.changeMarking.emit({ studySet: set, path: page.pagePath });
        } catch (e) {
          /* best-effort */
        }
      }
      return { ok: true, changed };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * Add a typed text element to the current page's red-comment ink at
   * (x, y) — page-image coordinates — via the app's own InkTool SDK, then
   * re-render the page. Returns { ok, message }.
   */
  async function addTypedComment(text, x, y) {
    try {
      const screen = findScreen();
      if (!screen) return { ok: false, message: "marking screen not found" };
      const page = findPageComp(screen);
      if (!page || !page.model) return { ok: false, message: "worksheet page not found" };
      const ink = page.model.redComment;
      if (!ink) return { ok: false, message: "no red-comment layer on this page" };
      if (typeof window.InkTool === "undefined" || !window.InkTool.InkCanvasLib) {
        return { ok: false, message: "InkTool SDK unavailable" };
      }
      const pageIndex = page.pagePath ? Number(page.pagePath.pageIndex) + 1 : 1;
      const args = buildTextDataArgs(ink, pageIndex, text, x, y);
      window.InkTool.InkCanvasLib.addTextDataToInkData(...args);
      // re-render the red-comment layer through the app's own stroke pipeline
      if (typeof page.updateStrokes === "function") {
        try {
          page.updateStrokes();
        } catch (e) {
          /* best-effort */
        }
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  }

  return {
    QR,
    rightCodeFor,
    markPageQuestions,
    isTypingTarget,
    buildTextDataArgs,
    findScreen,
    findPageComp,
    markAll,
    addTypedComment,
  };
})();
