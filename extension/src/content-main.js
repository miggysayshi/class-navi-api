// src/content-main.js — MAIN world: detects the worksheets-per-study dropdown,
// boots the injection, and re-injects per panel (SPA navigation creates a new
// panel per student)
var QS = globalThis.QS || (globalThis.QS = {});
let currentPanel = null;

function requestPatterns() {
  return new Promise((resolve) => {
    const onMsg = (event) => {
      const data = event && event.data;
      if (!data || typeof data !== "object" || data.type !== "qs:patterns") return;
      window.removeEventListener("message", onMsg);
      resolve(data.patterns);
    };
    window.addEventListener("message", onMsg);
    window.postMessage({ type: "qs:request-patterns" }, "*");
    setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve(null);
    }, 2000);
  });
}

async function getPatternsWithRetry() {
  let patterns = await requestPatterns();
  if (!patterns) {
    // ISOLATED listener may not be registered yet (cross-world task ordering)
    await new Promise((r) => setTimeout(r, 300));
    patterns = await requestPatterns();
  }
  if (!patterns) console.warn("[QuickSet] pattern bridge timed out — nothing injected.");
  return patterns;
}

async function boot() {
  try {
    const patterns = await getPatternsWithRetry();
    if (!patterns) return;
    // remove options we no longer offer ("5 worksheets per study") first, so
    // the injected uniform options can't collide with them
    QS.dropdown.pruneUniformOptions();
    const injected = QS.dropdown.injectUniformOptions(patterns);
    if (!injected && !QS.angular.findMinWorksheetCountList()) {
      console.warn("[QuickSet] Angular component not found — injection disabled on this screen.");
    }
    QS.dropdown.injectPatternSection(patterns, async (raw) => {
      try {
        const result = await QS.blocks.applyPatternToMatchingDays(raw, null, {
          onProgress: (done, total) => QS.dropdown.setPatternProgress({ done, total, label: raw }),
        });
        QS.dropdown.clearPatternProgress();
        if (result.changed > 0) {
          console.log(`[QuickSet] applied ${raw} to ${result.changed} day(s)`);
        } else {
          const failed = result.results.filter((r) => !r.ok);
          if (failed.length > 0) {
            console.warn(`[QuickSet] ${raw} failed:`, failed.map((f) => f.message || f.errorSec).join("; "));
          } else {
            console.log(`[QuickSet] ${raw} matched 0 day(s) — nothing to change`);
          }
        }
      } catch (e) {
        QS.dropdown.clearPatternProgress();
        console.warn("[QuickSet] pattern application failed:", e);
      }
    });
  } catch (err) {
    // spec §4: never throw into the page
    console.warn("[QuickSet] boot failed:", err);
  }
}

// SPA navigation re-creates the panel per student — re-inject per NEW panel
// element, debounced; never a one-shot flag
let debounce = null;
let markingToolbarInjected = false;

/** Boot every feature (patterns dropdown, marking toolbar, aggregates). */
function runBoots() {
  const panel = document.querySelector(".options.setting-options");
  if (panel && panel !== currentPanel) {
    currentPanel = panel;
    boot();
  }
  bootMarking();
  // editor header aggregates (avg pages/time per study session) — its own
  // student/level key makes repeated calls cheap
  if (QS.aggregate) QS.aggregate.updateDisplay();
}

const mo = new MutationObserver(() => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    runBoots();
  }, 250);
});
mo.observe(document.documentElement, { childList: true, subtree: true });

// keep the aggregate chip anchored to the "Default" button if the header
// re-renders (level switches, view menu open/close)
if (!window.__qsAggregatePinger) {
  window.__qsAggregatePinger = setInterval(() => {
    const chip = document.getElementById("qs-aggregate");
    if (chip && QS.aggregate) QS.aggregate.positionChip(chip);
  }, 1000);
}

// level stats pill (assign homework screen): refresh in the background
if (!window.__qsStatsPinger) {
  window.__qsStatsPinger = setInterval(refreshLevelStats, 1500);
  refreshLevelStats();
}

// ---------- Quick Mark: toolbar placement ----------

/**
 * Keep our button stack BELOW the entire native control stack. The
 * worksheet-tool container holds, top to bottom: toolbar box, zoom button,
 * page pager (up/down), one-side display switch, and the answer-display
 * button — some are conditionally rendered, so we anchor to the LOWEST
 * control currently present and re-place on every resize.
 */
function positionQuickMarkToolbar() {
  try {
    const wrap = document.getElementById("qs-mark-toolbar");
    const tb = document.querySelector("app-grading-toolbar");
    if (!wrap || !tb) return;
    const tool = tb.closest(".worksheet-tool") || tb.parentElement;
    if (!tool) return;
    const selectors = [".answer-zoom-btn", ".pager", ".display-mode-switch", ".answer-disp-btn", "app-grading-toolbar"];
    let bottom = 0;
    for (const sel of selectors) {
      const el = tool.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > bottom) bottom = r.bottom;
    }
    if (bottom <= 0) return;
    const tRect = tool.getBoundingClientRect();
    wrap.style.position = "absolute";
    wrap.style.left = "2px";
    wrap.style.right = "2px";
    wrap.style.top = `${Math.max(4, bottom - tRect.top + 6)}px`;
    wrap.style.marginTop = "0";
    wrap.style.zIndex = "99990";
  } catch (e) {
    /* never throw */
  }
}

// ---------- Quick Mark: level stats (assign homework screen) ----------

/** Find the studyUnits array inside the study-unit-editor's Angular state. */
function findStudyUnits() {
  try {
    const el = document.querySelector("study-unit-editor");
    if (!el || !el.__ngContext__) return null;
    const ctx = Array.isArray(el.__ngContext__) ? el.__ngContext__ : null;
    if (!ctx) return null;
    for (let i = 0; i < ctx.length; i++) {
      const v = ctx[i];
      if (v && typeof v === "object" && Array.isArray(v.studyUnits)) return v.studyUnits;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Level stats from the homework history. Each studyUnits row = one time a
 * set was given, with its page range (WorksheetNOFrom → WorksheetNOTo).
 * - pages done = Σ over rows of the set length (each given set counts its
 *   pages — "how many times the last page was given")
 * - avg repeat = assignments ÷ distinct sets
 */
function computeLevelStats() {
  const rows = findStudyUnits();
  if (!rows || rows.length === 0) return null;
  const ranges = new Set();
  let pages = 0;
  let valid = 0;
  for (const r of rows) {
    const from = Number(r && r.WorksheetNOFrom);
    const to = Number(r && r.WorksheetNOTo);
    if (!from || !to || to < from) continue;
    ranges.add(`${from}-${to}`);
    pages += to - from + 1;
    valid++;
  }
  if (valid === 0 || ranges.size === 0) return null;
  return { pages, assignments: valid, sets: ranges.size, avgRepeat: valid / ranges.size };
}

/**
 * Day gaps between consecutive assignments. Uses the API records
 * (curStudentStudyInfo.StudyUnitInfoList — same source as the aggregate
 * chip), sorted by StudyDate; each gap = days between one set being given
 * and the next. Returns { avg, med, n } or null (fewer than 2 dated
 * records).
 */
function computeGapStats() {
  try {
    const comp = QS.blocks && QS.blocks.findPageComp ? QS.blocks.findPageComp() : null;
    const list =
      comp && comp.curStudentStudyInfo && Array.isArray(comp.curStudentStudyInfo.StudyUnitInfoList)
        ? comp.curStudentStudyInfo.StudyUnitInfoList
        : null;
    if (!list) return null;
    const times = [];
    for (const r of list) {
      const d = r && r.StudyDate ? String(r.StudyDate).trim() : "";
      if (!d) continue;
      const t = Date.parse(d);
      if (Number.isFinite(t)) times.push(t);
    }
    times.sort((a, b) => a - b);
    if (times.length < 2) return null;
    const DAY = 86400000;
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(Math.round((times[i] - times[i - 1]) / DAY));
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    const med = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return { avg, med, n: gaps.length };
  } catch (e) {
    return null;
  }
}

/**
 * Level-stats chip, connected to the aggregate row: renders right of the
 * #qs-aggregate chip (same band, same height, same visual language). The
 * anchor falls back to the "Default" view button when the aggregate chip is
 * hidden (e.g. no studied sessions yet). Never throws.
 */
function refreshLevelStats() {
  try {
    const s = computeLevelStats();
    const g = computeGapStats();
    let chip = document.getElementById("qs-level-stats");
    const anchor = document.getElementById("qs-aggregate") || document.querySelector(".progress-model-select-selected-view");
    if (!s || !anchor) {
      if (chip) chip.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "qs-level-stats";
      chip.style.cssText =
        "position:fixed;z-index:99990;display:grid;grid-template-columns:repeat(4,auto);column-gap:14px;align-items:center;justify-items:center;align-content:center;box-sizing:border-box;height:32px;padding:0 12px;background:#fff;border:1px solid #d9e2e6;border-radius:6px;font-size:12px;color:#1c3a5e;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.08);pointer-events:none;";
      document.body.appendChild(chip);
    }
    chip.textContent = "";
    const cell = (text, isHeader) => {
      const sp = document.createElement("span");
      sp.textContent = text;
      if (isHeader) {
        sp.style.cssText = "font-size:9px;line-height:1;color:#8aa5b0;text-transform:uppercase;letter-spacing:.4px;";
      } else {
        sp.style.cssText = "line-height:1.2;";
      }
      return sp;
    };
    chip.appendChild(cell("lvl pages", true));
    chip.appendChild(cell("repeat avg", true));
    chip.appendChild(cell("gap avg", true));
    chip.appendChild(cell("gap med", true));
    chip.appendChild(cell(String(s.pages), false));
    chip.appendChild(cell(s.avgRepeat.toFixed(2), false));
    chip.appendChild(cell(g ? g.avg.toFixed(1) : "—", false));
    chip.appendChild(cell(g ? g.med.toFixed(1) : "—", false));
    chip.title = `${s.assignments} assignments / ${s.sets} sets on this level — ${s.pages} pages done, ${s.avgRepeat.toFixed(2)} avg repeat` +
      (g ? `, ${g.avg.toFixed(1)}d avg / ${g.med.toFixed(1)}d med between sets (${g.n} gaps)` : "");
    const a = document.getElementById("qs-aggregate") || document.querySelector(".progress-model-select-selected-view");
    if (!a) return;
    const ar = a.getBoundingClientRect();
    chip.style.left = `${Math.round(ar.right + 8)}px`;
    const bar = document.querySelector(".menu-bar");
    if (bar) {
      const b = bar.getBoundingClientRect();
      const h = chip.offsetHeight || 32;
      chip.style.top = `${Math.round(b.top + (b.height - h) / 2)}px`;
    } else {
      chip.style.top = `${Math.round(ar.top)}px`;
    }
  } catch (e) {
    /* never throw */
  }
}

// ---------- Quick Mark: marking screen (ATD0020P) ----------

const MARK_BTN_STYLE =
  "padding:4px 8px;border:1px solid #c0392b;border-radius:4px;background:#fff;color:#c0392b;cursor:pointer;font-size:12px;font-weight:600;margin:0 2px;white-space:nowrap;flex:0 0 auto;";
const MARK_BTN_GREEN_STYLE = MARK_BTN_STYLE.replace("#c0392b", "#1e8449");
const MARK_BTN_BLUE_STYLE = MARK_BTN_STYLE.replace("#c0392b", "#2a6df4");

function ensureMarkingShortcuts() {
  if (window.__qsMarkingShortcuts) return;
  window.__qsMarkingShortcuts = true;
  document.addEventListener("keydown", (e) => {
    try {
      if (QS.marking.isTypingTarget(e.target)) return;
      if (!QS.marking.findScreen()) return;
      const k = (e.key || "").toLowerCase();
      if (k === "a" || k === "s") {
        e.preventDefault();
        QS.marking.markAll(k === "a").then((r) => {
          if (!r.ok) console.warn("[QuickMark] markAll:", r.message);
          else console.log(`[QuickMark] marked ${r.changed} question(s) ${k === "a" ? "correct" : "wrong"}`);
        });
      } else if (k === "c") {
        e.preventDefault();
        enterCommentMode();
      }
    } catch (err) {
      /* never throw into the page */
    }
  });
}

// ---------- Quick Mark: manual calibration (corner clicks) ----------

function enterCalibrationMode() {
  try {
    const screen = QS.marking.findScreen();
    const page = QS.marking.findPageComp(screen);
    if (!screen || !page || !page.model) return;
    if (window.__qsCalibMode) return;
    window.__qsCalibMode = true;
    const img = page.model.imgSize || {};
    if (!Number(img.width) || !Number(img.height)) {
      window.__qsCalibMode = false;
      console.warn("[QuickMark] calibration: no image size on this page");
      return;
    }
    const hint = document.createElement("div");
    hint.id = "qs-calib-hint";
    hint.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;background:#8e44ad;color:#fff;padding:6px 14px;border-radius:16px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.25);";
    let first = null;
    const onClick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!first) {
        first = { x: ev.clientX, y: ev.clientY };
        hint.textContent = "Now click the BOTTOM-RIGHT corner of the page (Esc cancels)";
        return;
      }
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      const cal = QS.marking.applyManualCalibration(page, first.x, first.y, ev.clientX, ev.clientY, img.width, img.height);
      hint.remove();
      window.__qsCalibMode = false;
      if (cal) {
        console.log(
          `[QuickMark] manual calibration: scale (${cal.sx.toFixed(4)}, ${cal.sy.toFixed(4)}), offset (${cal.ox}, ${cal.oy})px — comment placement uses it`
        );
      } else {
        console.warn("[QuickMark] calibration failed");
      }
    };
    const onKey = (ev) => {
      if (ev.key === "Escape") {
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        hint.remove();
        window.__qsCalibMode = false;
        console.log("[QuickMark] calibration cancelled");
      }
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    hint.textContent = "Click the TOP-LEFT corner of the page (Esc cancels)";
    document.body.appendChild(hint);
    console.log("[QuickMark] calibration mode — click the page corners");
  } catch (err) {
    window.__qsCalibMode = false;
    console.warn("[QuickMark] calibration:", err);
  }
}

// ---------- Quick Mark: comment mode (HUD + live preview + font controls) ----------

const QS_COMMENT_STYLES = [
  { name: "Cursive", font: '"Comic Sans MS", "Comic Sans", cursive' },
  { name: "Print", font: '"Arial", "Helvetica", sans-serif' },
  { name: "Bold", font: '"Arial Black", "Arial", sans-serif' },
];
const QS_COMMENT_SIZES = [24, 32, 40, 48, 56, 64, 72];
let commentUI = null; // {hud, input, sizeLabel, styleBtn, preview, sizeIdx, styleIdx, lastX, lastY, page}

function previewScale() {
  const page = commentUI && commentUI.page;
  if (!page) return { sx: 1, sy: 1 };
  const cal = QS.marking.getCalibration(page);
  const sx = cal && cal.sx > 0 ? Number(cal.sx) : Number(page.scaleX) > 0 ? Number(page.scaleX) : 1;
  const sy = cal && cal.sy > 0 ? Number(cal.sy) : Number(page.scaleY) > 0 ? Number(page.scaleY) : 1;
  return { sx, sy };
}

function updateCommentPreview() {
  if (!commentUI) return;
  const text = commentUI.input.value;
  if (!text.trim()) {
    commentUI.preview.style.display = "none";
    commentUI.sizeLabel.textContent = QS_COMMENT_SIZES[commentUI.sizeIdx];
    commentUI.styleBtn.textContent = QS_COMMENT_STYLES[commentUI.styleIdx].name;
    return;
  }
  const { sx, sy } = previewScale();
  const size = QS_COMMENT_SIZES[commentUI.sizeIdx];
  const family = QS_COMMENT_STYLES[commentUI.styleIdx].font;
  // render the ACTUAL ink the placement will produce: same rasterizer, same
  // runs, drawn at the screen scale — the preview IS the placed ink
  const runs = QS.marking.rasterizeTextToRuns(text, 0, 0, size, family);
  let w = 1;
  let h = 1;
  for (const run of runs) {
    for (const cell of run.cs) {
      const p = cell.split("|");
      const px = Number(p[0]) * sx;
      const py = Number(p[1]) * sy;
      if (px > w) w = px;
      if (py > h) h = py;
    }
  }
  const canvas = commentUI.preview;
  canvas.width = Math.ceil(w) + 2;
  canvas.height = Math.ceil(h) + 2;
  QS.marking.drawRunsOnCanvas(canvas, runs, sx, sy);
  canvas.style.display = "block";
  commentUI.sizeLabel.textContent = size;
  commentUI.styleBtn.textContent = QS_COMMENT_STYLES[commentUI.styleIdx].name;
}

function positionCommentPreview() {
  if (!commentUI) return;
  const x = commentUI.lastX !== undefined ? commentUI.lastX : window.innerWidth / 2;
  const y = commentUI.lastY !== undefined ? commentUI.lastY : window.innerHeight / 2;
  commentUI.preview.style.left = x + 12 + "px";
  commentUI.preview.style.top = y + 12 + "px";
}

function exitCommentMode() {
  if (!commentUI) return;
  const ui = commentUI;
  commentUI = null;
  if (ui.hud && ui.hud.parentNode) ui.hud.parentNode.removeChild(ui.hud);
  if (ui.preview && ui.preview.parentNode) ui.preview.parentNode.removeChild(ui.preview);
}

function enterCommentMode() {
  try {
    const screen = QS.marking.findScreen();
    const page = QS.marking.findPageComp(screen);
    if (!screen || !page) return;
    if (commentUI) return; // already active
    // AUTO calibrate first: measure the page canvas element — its rect IS
    // the page box (top-left = ink 0,0), so scale + offset are exact with
    // no clicks. A MANUAL corner calibration overrides everything.
    const existing = QS.marking.getCalibration(page);
    if (!existing || !existing.manual) {
      const auto = QS.marking.autoCalibratePage(page);
      if (auto) {
        console.log(
          `[QuickMark] auto calibration: scale (${auto.sx.toFixed(4)}, ${auto.sy.toFixed(4)}), offset (${auto.ox}, ${auto.oy})px`
        );
      } else {
        // fallback: empirical check-icon calibration
        const cal = QS.marking.calibratePage(page);
        if (cal) {
          console.log(`[QuickMark] calibration: offset (${cal.ox}, ${cal.oy})px` + (cal.sx ? `, scale verified ${cal.sx}` : ""));
        } else {
          console.warn("[QuickMark] calibration: no page canvas or icon match — falling back to container math");
        }
      }
    }
    const ui = (commentUI = {
      sizeIdx: 2, // 40px default
      styleIdx: 0, // Cursive
      lastX: undefined,
      lastY: undefined,
      page,
    });
    // the HUD panel (top center): input + size + style
    const hud = document.createElement("div");
    hud.id = "qs-comment-hud";
    hud.style.cssText =
      "position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:99999;background:#fff;border:1px solid #2a6df4;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);padding:8px 10px;display:flex;align-items:center;gap:6px;font-size:12px;";
    const input = document.createElement("textarea");
    input.rows = 2;
    input.placeholder = "Type a comment — Enter for a new line, click or Ctrl+Enter to place, Esc cancels";
    input.style.cssText =
      "width:230px;padding:5px 8px;border:1px solid #bbb;border-radius:4px;font-size:13px;resize:none;font-family:inherit;line-height:1.3;";
    input.addEventListener("input", updateCommentPreview);
    const mkBtn = (label, title, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = title;
      b.textContent = label;
      b.style.cssText =
        "padding:4px 9px;border:1px solid #2a6df4;border-radius:4px;background:#fff;color:#2a6df4;cursor:pointer;font-size:12px;font-weight:600;";
      b.addEventListener("click", fn);
      return b;
    };
    const sizeDown = mkBtn("A−", "Smaller text", () => {
      ui.sizeIdx = Math.max(0, ui.sizeIdx - 1);
      updateCommentPreview();
      input.focus();
    });
    const sizeLabel = document.createElement("span");
    sizeLabel.style.cssText = "min-width:26px;text-align:center;font-weight:600;";
    const sizeUp = mkBtn("A+", "Bigger text", () => {
      ui.sizeIdx = Math.min(QS_COMMENT_SIZES.length - 1, ui.sizeIdx + 1);
      updateCommentPreview();
      input.focus();
    });
    const styleBtn = mkBtn("", "Font style", () => {
      ui.styleIdx = (ui.styleIdx + 1) % QS_COMMENT_STYLES.length;
      updateCommentPreview();
      input.focus();
    });
    hud.appendChild(input);
    hud.appendChild(sizeDown);
    hud.appendChild(sizeLabel);
    hud.appendChild(sizeUp);
    hud.appendChild(styleBtn);
    ui.hud = hud;
    ui.input = input;
    ui.sizeLabel = sizeLabel;
    ui.styleBtn = styleBtn;
    document.body.appendChild(hud);
    // the live preview — a CANVAS rendering the actual rasterized runs at
    // screen scale: what you see is EXACTLY the ink that will be placed
    // (same rasterizer, same strokes, same color)
    const preview = document.createElement("canvas");
    preview.id = "qs-comment-preview";
    preview.style.cssText = "position:fixed;z-index:99998;pointer-events:none;opacity:.55;";
    ui.preview = preview;
    document.body.appendChild(preview);
    updateCommentPreview();
    // mousemove: track the cursor + move the preview (capture; ignore the HUD)
    const onMove = (ev) => {
      if (!commentUI) return;
      if (ev.target && (ev.target.id === "qs-comment-hud" || ev.target.closest && ev.target.closest("#qs-comment-hud"))) return;
      ui.lastX = ev.clientX;
      ui.lastY = ev.clientY;
      positionCommentPreview();
    };
    document.addEventListener("mousemove", onMove, true);
    // click on the worksheet: place at the exact ink point. The PREVIEW box
    // is the source of truth — whatever the preview shows at the cursor is
    // what lands there (preview rect → ink), so what you see is what you get.
    const onClick = (ev) => {
      if (!commentUI) return;
      if (ev.target && (ev.target.id === "qs-comment-hud" || (ev.target.closest && ev.target.closest("#qs-comment-hud")))) return;
      ev.preventDefault();
      ev.stopPropagation();
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      const text = input.value.trim();
      const pr = preview.getBoundingClientRect();
      const ink = QS.marking.screenToInk(pr.left, pr.top, ui.page);
      exitCommentMode();
      if (!ink || !text) return;
      QS.marking
        .addTypedComment(text, Math.max(0, Math.round(ink.x)), Math.max(0, Math.round(ink.y)), {
          fontSize: QS_COMMENT_SIZES[ui.sizeIdx],
          fontFamily: QS_COMMENT_STYLES[ui.styleIdx].font,
        })
        .then((r) => {
          if (!r.ok) console.warn("[QuickMark] comment:", r.message);
          else console.log(`[QuickMark] comment placed: "${text}" (${r.strokes} strokes)`);
        });
    };
    // Enter (with Ctrl/Cmd) places at the last cursor position; plain Enter
    // is a newline in the textarea; Esc cancels
    const onKey = (ev) => {
      if (!commentUI) return;
      if (ev.key === "Escape") {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        exitCommentMode();
      } else if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        ev.stopPropagation();
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        const text = input.value.trim();
        // place at the PREVIEW box (the thing the user is looking at), not
        // the raw cursor — the preview sits 12px below-right of the cursor
        const pr = preview.getBoundingClientRect();
        const ink = QS.marking.screenToInk(pr.left, pr.top, ui.page);
        exitCommentMode();
        if (!ink || !text) return;
        QS.marking
          .addTypedComment(text, Math.max(0, Math.round(ink.x)), Math.max(0, Math.round(ink.y)), {
            fontSize: QS_COMMENT_SIZES[ui.sizeIdx],
            fontFamily: QS_COMMENT_STYLES[ui.styleIdx].font,
          })
          .then((r) => {
            if (!r.ok) console.warn("[QuickMark] comment:", r.message);
            else console.log(`[QuickMark] comment placed: "${text}" (${r.strokes} strokes)`);
          });
      }
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    input.focus();
    console.log("[QuickMark] comment mode — type, move the mouse to position the preview, click or Enter to place");
  } catch (err) {
    commentUI = null;
    console.warn("[QuickMark] comment mode:", err);
  }
}

function bootMarking() {
  try {
    if (markingToolbarInjected) {
      // the screen can close and reopen per set — detect the toolbar re-appearing
      if (document.getElementById("qs-mark-toolbar")) return;
      markingToolbarInjected = false;
    }
    const toolbar = document.querySelector("app-grading-toolbar");
    if (!toolbar || !QS.marking.findScreen()) return;
    if (document.getElementById("qs-mark-toolbar")) return;
    markingToolbarInjected = true;
    ensureMarkingShortcuts();
    const mk = (label, style, title, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "qs-mark-btn";
      b.textContent = label;
      b.title = title;
      b.style.cssText = style;
      b.addEventListener("click", async () => {
        const r = await fn();
        if (r && !r.ok) console.warn("[QuickMark]", r.message);
        else if (r && r.changed !== undefined) console.log(`[QuickMark] marked ${r.changed} question(s)`);
      });
      return b;
    };
    const all = mk("✓ All correct", MARK_BTN_GREEN_STYLE, "Mark all answers on this page correct (A)", () => QS.marking.markAll(true));
    const none = mk("✗ All wrong", MARK_BTN_STYLE, "Mark all answers on this page wrong (S)", () => QS.marking.markAll(false));
    const pen = mk("✎ Comment", MARK_BTN_BLUE_STYLE, "Type a comment on this page (C)", () => {
      enterCommentMode();
      return { ok: true };
    });
    const calib = mk("⇱ Calibrate", MARK_BTN_STYLE.replace("#c0392b", "#8e44ad"), "Manually calibrate comment placement: click the page's top-left then bottom-right corners", () => {
      enterCalibrationMode();
      return { ok: true };
    });
    const erase = mk("🗑 Erase all ink", MARK_BTN_STYLE.replace("#c0392b", "#b9770e"), "Clear ALL red ink on this page (typed comments + pen marks)", () =>
      QS.marking.clearPageRedInk()
    );
    // our buttons live in a wrapping container, placed BELOW the whole
    // native control stack (attached to worksheet-tool, the container that
    // holds the toolbar box + zoom + pager + display switches)
    const wrap = document.createElement("div");
    wrap.id = "qs-mark-toolbar";
    wrap.style.cssText =
      "display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:6px 2px 0;flex:0 0 auto;max-width:100%;";
    wrap.appendChild(all);
    wrap.appendChild(none);
    wrap.appendChild(pen);
    wrap.appendChild(calib);
    wrap.appendChild(erase);
    const tool = toolbar.closest(".worksheet-tool") || toolbar.parentElement;
    if (tool) tool.appendChild(wrap);
    else toolbar.appendChild(wrap);
    // position below the toolbar box and re-place whenever it resizes
    // (open/close) — the box can be recreated by Angular, so a slow interval
    // backs up the ResizeObserver
    positionQuickMarkToolbar();
    if (window.ResizeObserver) {
      try {
        const ro = new ResizeObserver(() => positionQuickMarkToolbar());
        const box = toolbar.querySelector(".grading-toolbar-box") || toolbar;
        ro.observe(box);
        ro.observe(toolbar);
      } catch (e) {
        /* best-effort */
      }
    }
    if (!window.__qsToolbarPinger) {
      window.__qsToolbarPinger = setInterval(positionQuickMarkToolbar, 1000);
    }
    console.log("[QuickMark] marking toolbar injected");
  } catch (err) {
    console.warn("[QuickMark] boot failed:", err);
  }
}
