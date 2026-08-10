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
const mo = new MutationObserver(() => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    const panel = document.querySelector(".options.setting-options");
    if (panel && panel !== currentPanel) {
      currentPanel = panel;
      boot();
    }
    bootMarking();
  }, 250);
});
mo.observe(document.documentElement, { childList: true, subtree: true });

// ---------- Quick Mark: marking screen (ATD0020P) ----------

const MARK_BTN_STYLE =
  "padding:4px 8px;border:1px solid #c0392b;border-radius:4px;background:#fff;color:#c0392b;cursor:pointer;font-size:12px;font-weight:600;margin:0 2px;";
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
  const sx = page && Number(page.scaleX) > 0 ? Number(page.scaleX) : 1;
  const sy = page && Number(page.scaleY) > 0 ? Number(page.scaleY) : 1;
  return { sx, sy };
}

function updateCommentPreview() {
  if (!commentUI) return;
  const text = commentUI.input.value.trim() || "Aa";
  const { sx } = previewScale();
  commentUI.preview.textContent = text;
  const s = QS_COMMENT_STYLES[commentUI.styleIdx];
  commentUI.preview.style.font = `${QS_COMMENT_SIZES[commentUI.sizeIdx] * sx}px ${s.font}`;
  commentUI.preview.style.display = text ? "block" : "none";
  commentUI.sizeLabel.textContent = QS_COMMENT_SIZES[commentUI.sizeIdx];
  commentUI.styleBtn.textContent = s.name;
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
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type a comment — click or Enter to place, Esc cancels";
    input.style.cssText = "width:230px;padding:5px 8px;border:1px solid #bbb;border-radius:4px;font-size:13px;";
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
    // the live preview overlay — follows the cursor, shows the exact text,
    // font, size, and color at the exact placement scale
    const preview = document.createElement("div");
    preview.id = "qs-comment-preview";
    preview.style.cssText =
      "position:fixed;z-index:99998;pointer-events:none;color:#e74c3c;opacity:.55;white-space:pre;line-height:1.35;";
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
    // click on the worksheet: place at the exact ink point
    const onClick = (ev) => {
      if (!commentUI) return;
      if (ev.target && (ev.target.id === "qs-comment-hud" || (ev.target.closest && ev.target.closest("#qs-comment-hud")))) return;
      ev.preventDefault();
      ev.stopPropagation();
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      const text = input.value.trim();
      const ink = QS.marking.screenToInk(ev.clientX, ev.clientY, ui.page);
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
    // Enter places at the last cursor position; Esc cancels
    const onKey = (ev) => {
      if (!commentUI) return;
      if (ev.key === "Escape") {
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        exitCommentMode();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        ev.stopPropagation();
        document.removeEventListener("mousemove", onMove, true);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", onKey, true);
        const text = input.value.trim();
        const x = ui.lastX !== undefined ? ui.lastX : window.innerWidth / 2;
        const y = ui.lastY !== undefined ? ui.lastY : window.innerHeight / 2;
        const ink = QS.marking.screenToInk(x, y, ui.page);
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
      const tb = document.querySelector("app-grading-toolbar");
      if (!tb || tb.querySelector(".qs-mark-btn")) return;
      markingToolbarInjected = false;
    }
    const toolbar = document.querySelector("app-grading-toolbar");
    if (!toolbar || !QS.marking.findScreen()) return;
    if (toolbar.querySelector(".qs-mark-btn")) return;
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
    toolbar.appendChild(all);
    toolbar.appendChild(none);
    toolbar.appendChild(pen);
    console.log("[QuickMark] marking toolbar injected");
  } catch (err) {
    console.warn("[QuickMark] boot failed:", err);
  }
}
