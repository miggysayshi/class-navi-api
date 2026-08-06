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

function enterCommentMode() {
  try {
    const screen = QS.marking.findScreen();
    if (!screen) return;
    if (window.__qsCommentMode) return; // already picking a spot
    window.__qsCommentMode = true;
    console.log("[QuickMark] comment mode — click a spot on the worksheet (Esc to cancel)");
    const onClick = (ev) => {
      window.__qsCommentMode = false;
      document.removeEventListener("click", onClick, true);
      hideCommentHint();
      // map the click to page-image coordinates
      const canvas = document.querySelector("app-worksheet-page canvas");
      const page = QS.marking.findPageComp(screen);
      if (!canvas || !page || !page.model) return;
      const rect = canvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / (page.model.zoomRatio || 1);
      const y = (ev.clientY - rect.top) / (page.model.zoomRatio || 1);
      showCommentInput(canvas, ev.clientX, ev.clientY, x, y);
    };
    document.addEventListener("click", onClick, true);
    showCommentHint();
    const cancel = (ev) => {
      if (ev.key === "Escape") {
        window.__qsCommentMode = false;
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("keydown", cancel, true);
        hideCommentHint();
      }
    };
    document.addEventListener("keydown", cancel, true);
  } catch (err) {
    window.__qsCommentMode = false;
    console.warn("[QuickMark] comment mode:", err);
  }
}

function showCommentHint() {
  let hint = document.getElementById("qs-comment-hint");
  if (!hint) {
    hint = document.createElement("div");
    hint.id = "qs-comment-hint";
    hint.textContent = "Click a spot on the worksheet to place the comment (Esc cancels)";
    hint.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;background:#2a6df4;color:#fff;padding:6px 14px;border-radius:16px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.25);";
    document.body.appendChild(hint);
  }
}

function hideCommentHint() {
  const hint = document.getElementById("qs-comment-hint");
  if (hint) hint.remove();
}

function showCommentInput(anchor, clientX, clientY, x, y) {
  try {
    const input = document.createElement("input");
    input.id = "qs-comment-input";
    input.type = "text";
    input.placeholder = "Type a comment… Enter to place, Esc to cancel";
    input.style.cssText =
      "position:fixed;z-index:99999;left:" + Math.min(clientX, window.innerWidth - 280) + "px;top:" +
      (clientY - 44 < 0 ? clientY + 14 : clientY - 44) + "px;width:260px;padding:6px 10px;border:1px solid #2a6df4;border-radius:4px;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,.2);";
    document.body.appendChild(input);
    input.focus();
    const done = async (ev) => {
      if (ev.key !== "Enter" && ev.key !== "Escape") return;
      document.removeEventListener("keydown", done, true);
      const text = input.value.trim();
      input.remove();
      hideCommentHint();
      if (ev.key === "Enter" && text) {
        const r = await QS.marking.addTypedComment(text, Math.max(0, Math.round(x)), Math.max(0, Math.round(y)));
        if (!r.ok) console.warn("[QuickMark] comment:", r.message);
        else console.log(`[QuickMark] comment placed: "${text}"`);
      }
    };
    document.addEventListener("keydown", done, true);
  } catch (err) {
    console.warn("[QuickMark] comment input:", err);
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
