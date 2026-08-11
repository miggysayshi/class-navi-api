// src/marking.js — classic script; Quick Mark features for the marking screen
// (ATD0020P): mark-all per page, typed on-page comments, keyboard shortcuts.
//
// NATIVE-PARITY design (2026-08-05):
//   - markAll drives the app's OWN per-question method
//     (worksheet-page.updateQuestionMarkToNext — exactly what a mark-box click
//     calls) the right number of cycles to reach the target state; then the
//     app's updateScore/updateScoreStatusForPage/changeMarking.emit.
//   - The CURRENT page = the SELECTED worksheet-page component. The app keeps
//     ALL pages of ALL sets in the DOM (verified: 10 app-worksheet-page
//     elements for a 5-set × 2-page session) — querySelector alone grabs the
//     wrong page. The active one carries isSelected / visible layout.
//   - addTypedComment renders the typed text as REAL INK STROKES (rasterized
//     to SDK cell strings) in the red-comment layer — strokes render and save
//     in any layer; the ink-text item format is loader-unsafe, so no text
//     items. The app's own Save persists the red ink (RedComment).
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

  /**
   * The CURRENT worksheet-page component. The app keeps every page of every
   * set in the DOM (hidden/shown by selection) — pick the SELECTED one, with
   * a visibility fallback. Returns null when none is active.
   */
  function findPageComp(screen) {
    try {
      const els = [...document.querySelectorAll("app-worksheet-page")];
      for (const el of els) {
        const found = QS.angular.findComp(el, ["redCommentStroke"]);
        if (!found) continue;
        const comp = found.comp;
        if (comp.isSelected) return comp;
      }
      // fallback: the visible page element
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && el.offsetParent !== null) {
          const found = QS.angular.findComp(el, ["redCommentStroke"]);
          if (found) return found.comp;
        }
      }
      return null;
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

  // ---------- typed comment (text → real ink strokes) ----------

  /**
   * Pure: map a screen point to page-image (ink) coordinates.
   * The app's own forward mapping is screen = ink * scale (see
   * getWorksheetItemLocation: floor(inkX * scaleX)); the reference origin is
   * the worksheet-container-wrapper rect of the page. Inverting with the
   * SAME scale + origin gives pixel-exact placement (zoomRatio alone drifts).
   */
  function computeInk(clientX, clientY, containerRect, scaleX, scaleY) {
    const sx = Number(scaleX) > 0 ? Number(scaleX) : 1;
    const sy = Number(scaleY) > 0 ? Number(scaleY) : 1;
    return {
      x: (clientX - containerRect.left) / sx,
      y: (clientY - containerRect.top) / sy,
    };
  }

  /** Live: screen point → ink coordinates for the current page. */
  function screenToInk(clientX, clientY, page) {
    try {
      if (!page) return null;
      const cal = getCalibration(page) || { ox: 0, oy: 0, sx: null, sy: null };
      const container = document.querySelector(`.worksheet-container-wrapper:has(#${page.pageID})`) || null;
      const rect = container ? container.getBoundingClientRect() : { left: 0, top: 0 };
      const scaleX = cal.sx > 0 ? cal.sx : page.scaleX;
      const scaleY = cal.sy > 0 ? cal.sy : page.scaleY;
      return {
        x: (clientX - rect.left - cal.ox) / scaleX,
        y: (clientY - rect.top - cal.oy) / scaleY,
      };
    } catch (e) {
      return null;
    }
  }

  /** The active calibration for a page: page-level first, then screen-level. */
  function getCalibration(page) {
    if (page && page.__qsCalibration) return page.__qsCalibration;
    try {
      const screen = findScreen();
      if (screen && screen.__qsCalibration) return screen.__qsCalibration;
    } catch (e) {
      /* best-effort */
    }
    return null;
  }

  /**
   * Pure: derive scale + offset from two screen clicks at known ink corners.
   * Corner 1 = ink (0, 0), corner 2 = ink (imgW, imgH). screen = ink·scale +
   * offset → scale = Δscreen/Δink, offset = corner1 − 0. container origin
   * subtracted so the result is container-relative (like screenToInk expects).
   */
  function computeManualCalibration(s1x, s1y, s2x, s2y, imgW, imgH, cLeft, cTop) {
    const w = Number(imgW) > 0 ? Number(imgW) : 1;
    const h = Number(imgH) > 0 ? Number(imgH) : 1;
    return {
      ox: s1x - (cLeft || 0),
      oy: s1y - (cTop || 0),
      sx: (s2x - s1x) / w,
      sy: (s2y - s1y) / h,
      manual: true,
    };
  }

  /**
   * Apply a manual corner calibration to the page (and the whole screen —
   * all pages share the layout). Returns the calibration.
   */
  function applyManualCalibration(page, s1x, s1y, s2x, s2y, imgW, imgH) {
    try {
      const container = document.querySelector(`.worksheet-container-wrapper:has(#${page.pageID})`);
      const rect = container ? container.getBoundingClientRect() : { left: 0, top: 0 };
      const cal = computeManualCalibration(s1x, s1y, s2x, s2y, imgW, imgH, rect.left, rect.top);
      if (page) page.__qsCalibration = cal;
      const screen = findScreen();
      if (screen) screen.__qsCalibration = cal;
      return cal;
    } catch (e) {
      return null;
    }
  }

  /**
   * Empirically calibrate the ink→screen transform for the page. The app
   * renders check icons at KNOWN ink coordinates (CheckIconLocation1 of each
   * question); the extension locates the actually-rendered icon element and
   * derives the true offset (absorbing container borders, canvas centering,
   * SDK origin offsets, and shell zoom). Stores the result on the page comp
   * as __qsCalibration. Never throws.
   */
  function calibratePage(page) {
    try {
      if (!page || !page.model || !page.studySet) return null;
      const container = document.querySelector(`.worksheet-container-wrapper:has(#${page.pageID})`);
      if (!container) return null;
      const cRect = container.getBoundingClientRect();
      const srd = page.studySet.scoringResultData;
      const marks = srd && srd.gradingResultData && srd.gradingResultData.PageMarks;
      if (!Array.isArray(marks)) return null;
      const pageIndex = page.pagePath ? Number(page.pagePath.pageIndex) : 0;
      const pm = marks.find((p) => Number(p.PageNumber) === pageIndex);
      if (!pm || !Array.isArray(pm.QuestionMarks)) return null;
      // candidates: every question's CheckIconLocation1 (known ink coords)
      const candidates = [];
      for (const q of pm.QuestionMarks) {
        const loc = q.QuestionData && q.QuestionData.CheckIconLocation1;
        if (loc && !isNaN(Number(loc.x)) && !isNaN(Number(loc.y))) {
          candidates.push({ inkX: Number(loc.x), inkY: Number(loc.y) });
        }
        if (candidates.length >= 3) break;
      }
      if (candidates.length === 0) return null;
      const sx = Number(page.scaleX) > 0 ? Number(page.scaleX) : 1;
      const sy = Number(page.scaleY) > 0 ? Number(page.scaleY) : 1;
      // find a rendered element whose rect matches a candidate's predicted
      // position (within tolerance) — the check icon / result box
      const abs = [...container.querySelectorAll("div")].filter(
        (d) => getComputedStyle(d).position === "absolute"
      );
      for (const cand of candidates) {
        const px = cand.inkX * sx;
        const py = cand.inkY * sy;
        for (const el of abs) {
          const r = el.getBoundingClientRect();
          const dx = Math.abs(r.left - cRect.left - px);
          const dy = Math.abs(r.top - cRect.top - py);
          if (dx < 4 && dy < 4 && r.width > 0 && r.height > 0) {
            // verify the scale with a second sample if available
            let vx = null;
            let vy = null;
            if (candidates.length > 1) {
              const c2 = candidates[1];
              const p2x = c2.inkX * sx;
              const p2y = c2.inkY * sy;
              for (const el2 of abs) {
                const r2 = el2.getBoundingClientRect();
                const dx2 = Math.abs(r2.left - cRect.left - p2x);
                const dy2 = Math.abs(r2.top - cRect.top - p2y);
                if (dx2 < 4 && dy2 < 4) {
                  vx = sx;
                  vy = sy;
                  break;
                }
              }
            }
            const cal = { ox: r.left - cRect.left - px, oy: r.top - cRect.top - py, sx: vx, sy: vy };
            page.__qsCalibration = cal;
            return cal;
          }
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Build SDK-format red-pen stroke items from rasterized runs.
   * runs = [{ cs: ["x|y|t", ...], width }]; the loader treats 3-part cells
   * ("x|y|t") with the stationery's width, auto-assigns pen modes and adds
   * the pen-up cell. Returns the items to append (st = red ballpoint pen).
   */
  function buildRedCommentItems(runs, pageIndex, startItm) {
    const items = [];
    let itm = startItm;
    for (const run of runs) {
      if (!run || !Array.isArray(run.cs) || run.cs.length === 0) continue;
      items.push({
        st: { tp: 0, col: "#FF0000", w: 1, minw: 1, maxw: 1 }, // Old_BallpointPen, red
        t: itm,
        cs: run.cs.slice(),
      });
      itm++;
    }
    return items;
  }

  /**
   * Rasterize the text into horizontal ink runs. Draws the text on an
   * offscreen canvas, then walks the pixel rows (step 2) collecting contiguous
   * opaque segments as "x|y|t" cells. Multi-line: "\n" starts a new line
   * (line pitch = fontSize·1.4). Never throws. fontFamily is a CSS
   * font-family value; fontSize in image pixels.
   */
  function rasterizeTextToRuns(text, x, y, fontSize, fontFamily, canvasFactory) {
    try {
      const make = canvasFactory || (() => document.createElement("canvas"));
      const canvas = make();
      const ctx = canvas.getContext("2d");
      const fs = fontSize || 36;
      const fam = fontFamily || '"Comic Sans MS", "Comic Sans", cursive';
      const font = `${fs}px ${fam}`;
      const lines = String(text).split("\n");
      const lineH = Math.ceil(fs * 1.4) + 2; // per-line pitch (2px gap between lines)
      ctx.font = font;
      const widths = lines.map((l) => Math.ceil(ctx.measureText(l || "").width));
      const width = Math.max(...widths, 1) + 4;
      const height = Math.max(1, lines.length) * lineH + 4;
      canvas.width = width;
      canvas.height = height;
      ctx.font = font;
      ctx.fillStyle = "#000";
      ctx.textBaseline = "top";
      lines.forEach((line, idx) => {
        if (line) ctx.fillText(line, 2, 2 + idx * lineH);
      });
      const data = ctx.getImageData(0, 0, width, height).data;
      // alpha at (row, col); out-of-bounds reads are TRANSPARENT — without
      // this, undefined comparisons behave as "opaque" and can loop forever
      const alphaAt = (row, col) => {
        const idx = (row * width + col) * 4 + 3;
        return idx >= 0 && idx < data.length ? data[idx] : 0;
      };
      const runs = [];
      let t = 0;
      const step = 2;
      for (let row = 0; row < height; row += step) {
        let col = 0;
        while (col < width) {
          // find a run start: an opaque pixel
          if (alphaAt(row, col) < 128) {
            col++;
            continue;
          }
          let end = col;
          while (end < width && alphaAt(row, end) >= 128) end++;
          const cells = [];
          for (let c = col; c < end; c += 2) {
            // subtract the 2px rasterizer margin so the glyph edge lands
            // EXACTLY at (x, y) — pixel-exact placement
            cells.push(`${Math.round(x + c - 2)}|${Math.round(y + row - 2)}|${t}`);
            t++;
          }
          runs.push({ cs: cells, width: end - col });
          col = end;
        }
      }
      return runs;
    } catch (e) {
      return [];
    }
  }

  /**
   * Draw rasterized runs onto a canvas at the given screen scale — the
   * PREVIEW renderer. Draws the same connected segments the ink renderer
   * produces, so the preview is literally the placed ink scaled to screen.
   */
  function drawRunsOnCanvas(canvas, runs, scaleX, scaleY) {
    try {
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#e74c3c";
      ctx.lineWidth = Math.max(1, 1 * (Number(scaleX) || 1));
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const run of runs) {
        if (!run || !Array.isArray(run.cs) || run.cs.length === 0) continue;
        ctx.beginPath();
        for (let i = 0; i < run.cs.length; i++) {
          const p = run.cs[i].split("|");
          const px = Number(p[0]) * (Number(scaleX) || 1);
          const py = Number(p[1]) * (Number(scaleY) || 1);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    } catch (e) {
      /* never throw */
    }
  }

  // session tracking of placed comment items (for "erase texts")
  const commentItems = {}; // pageKey → [item t, ...]

  function pageKeyOf(page) {
    const p = (page && page.pagePath) || {};
    return `${p.studySetIndex || 0}-${p.pageIndex || 0}`;
  }

  /**
   * Remove every typed comment from the CURRENT page (only the items this
   * extension placed — drawn pen marks are untouched). Returns
   * { ok, removed, message }.
   */
  async function erasePageComments() {
    try {
      const screen = findScreen();
      if (!screen) return { ok: false, message: "marking screen not found" };
      const page = findPageComp(screen);
      if (!page || !page.model) return { ok: false, message: "worksheet page not found" };
      const key = pageKeyOf(page);
      const tset = new Set(commentItems[key] || []);
      if (tset.size === 0) return { ok: false, message: "no typed comments on this page" };
      let inkStr = page.redCommentStroke && page.redCommentStroke.inkData ? page.redCommentStroke.inkData : page.model.redComment;
      let obj;
      try {
        obj = JSON.parse(typeof inkStr === "string" ? inkStr : JSON.stringify(inkStr || { is: [] }));
      } catch (e) {
        obj = { is: [] };
      }
      if (!obj || typeof obj !== "object") obj = { is: [] };
      if (!Array.isArray(obj.is)) obj.is = [];
      const before = obj.is.length;
      obj.is = obj.is.filter((it) => !(it && tset.has(Number(it.t))));
      const removed = before - obj.is.length;
      if (removed === 0) {
        delete commentItems[key];
        return { ok: false, message: "no typed comments found in the ink" };
      }
      const newInk = JSON.stringify(obj);
      if (page.redCommentStroke) page.redCommentStroke.inkData = newInk;
      if (page.model) page.model.redComment = newInk;
      if (typeof page.updateRedComment === "function") {
        try {
          page.updateRedComment();
        } catch (e) {
          /* best-effort */
        }
      }
      if (typeof page.updateStrokes === "function") {
        try {
          page.updateStrokes();
        } catch (e) {
          /* best-effort */
        }
      }
      try {
        const canvas = page.redCommentStroke && page.redCommentStroke.canvas;
        if (canvas && typeof canvas.redrawInk === "function") canvas.redrawInk();
        else if (canvas && typeof canvas.redrawCurrentLayerByInk === "function") canvas.redrawCurrentLayerByInk();
      } catch (e) {
        /* best-effort */
      }
      delete commentItems[key];
      return { ok: true, removed };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  }

  /**
   * Add a typed comment to the current page's red-comment ink at (x, y) —
   * page-image coordinates — as REAL red-pen strokes. opts: { fontSize,
   * fontFamily }. Returns { ok, message }.
   */
  async function addTypedComment(text, x, y, opts) {
    try {
      const screen = findScreen();
      if (!screen) return { ok: false, message: "marking screen not found" };
      const page = findPageComp(screen);
      if (!page || !page.model) return { ok: false, message: "worksheet page not found" };
      if (!text) return { ok: false, message: "empty comment" };
      const o = opts || {};
      const runs = rasterizeTextToRuns(text, Number(x) || 0, Number(y) || 0, o.fontSize || 36, o.fontFamily);
      if (runs.length === 0) return { ok: false, message: "could not rasterize the text" };
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
      let itm = 0;
      for (const it of obj.is) {
        const t = it && it.t !== undefined ? Number(it.t) : 0;
        if (Number.isFinite(t) && t >= itm) itm = t + 1;
      }
      const items = buildRedCommentItems(runs, 0, itm);
      for (const item of items) obj.is.push(item);
      // track the placed items' t values so "erase texts" can remove exactly
      // these (the SDK drops unknown fields on load, so in-ink markers are
      // unreliable — session tracking is deterministic)
      const key = pageKeyOf(page);
      commentItems[key] = (commentItems[key] || []).concat(items.map((i) => i.t));
      const newInk = JSON.stringify(obj);
      // write into every layer the app reads (the wrapper setter loads the ink
      // into the SDK canvas: inkData = X → canvas.loadInk(X)), sync the save
      // source, then force the redraw.
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
          page.updateStrokes();
        } catch (e) {
          /* best-effort */
        }
      }
      try {
        const canvas = page.redCommentStroke && page.redCommentStroke.canvas;
        if (canvas && typeof canvas.redrawInk === "function") canvas.redrawInk();
        else if (canvas && typeof canvas.redrawCurrentLayerByInk === "function") canvas.redrawCurrentLayerByInk();
      } catch (e) {
        /* best-effort */
      }
      return { ok: true, strokes: items.length };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  }

  return {
    QR,
    rightCodeFor,
    markPageQuestions,
    isTypingTarget,
    computeInk,
    screenToInk,
    getCalibration,
    computeManualCalibration,
    applyManualCalibration,
    calibratePage,
    buildRedCommentItems,
    rasterizeTextToRuns,
    drawRunsOnCanvas,
    erasePageComments,
    findScreen,
    findPageComp,
    markAll,
    addTypedComment,
  };
})();
