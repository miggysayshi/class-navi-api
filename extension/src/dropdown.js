// src/dropdown.js — classic script; injects uniform + pattern options into the
// worksheets-per-study dropdown panel; removes options no longer offered;
// attaches to globalThis.QS
var QS = globalThis.QS || (globalThis.QS = {});
QS.dropdown = (function () {
  // Keys the app natively offers that we never inject: 10 = the app's default;
  // 5 = removed from the dropdown ENTIRELY (user request 2026-08-11 — we break
  // 10-page blocks into session segments; a uniform 5-page block is not offered).
  const NATIVE_KEYS = new Set([10, 5]);
  const HIDDEN_KEYS = new Set([5]);

  /** Single-number patterns → native worksheet options. Returns count injected. */
  function injectUniformOptions(patterns) {
    try {
      const list = QS.angular.findMinWorksheetCountList();
      if (!list) return 0;
      const existing = new Set(list.map((o) => Number(o.key)));
      let count = 0;
      for (const raw of patterns) {
        const blocks = QS.patterns.parsePattern(raw);
        if (!blocks || blocks.length !== 1) continue;
        const key = blocks[0];
        if (NATIVE_KEYS.has(key) || existing.has(key)) continue; // dedupe
        list.push({ value: `${key} worksheets per study`, key });
        count++;
      }
      return count;
    } catch (err) {
      // never throw into the page
      console.warn("[QuickSet] injectUniformOptions failed:", err);
      return 0;
    }
  }

  /**
   * Remove uniform options we no longer offer from the app's list, and reset
   * the selection back to the default (10) if it pointed at a removed key —
   * otherwise newly generated blocks would silently keep the removed size.
   * User request 2026-08-11: "5 worksheets per study" is gone entirely.
   * Never throws.
   */
  function pruneUniformOptions() {
    try {
      const comp = QS.angular.findWorksheetCountComp();
      if (!comp) return;
      const list = comp.minWorksheetUnitCountList;
      if (Array.isArray(list)) {
        for (let i = list.length - 1; i >= 0; i--) {
          if (HIDDEN_KEYS.has(Number(list[i] && list[i].key))) list.splice(i, 1);
        }
      }
      if (HIDDEN_KEYS.has(Number(comp.minWorksheetUnitCount))) {
        comp.minWorksheetUnitCount = 10; // the app's default
      }
    } catch (err) {
      // never throw into the page
      console.warn("[QuickSet] pruneUniformOptions failed:", err);
    }
  }

  /** Multi-number patterns → "Study pattern" section inside the same panel. */
  function injectPatternSection(patterns, onPick) {
    try {
      const panel = document.querySelector(".options.setting-options");
      if (!panel || document.querySelector(".qs-pattern-section")) return false;
      // splits only: multi-number patterns break a 10-page block into sessions
      const splits = patterns.filter((raw) => (QS.patterns.parsePattern(raw) || []).length > 1);
      const section = document.createElement("div");
      section.className = "qs-pattern-section setting-options";
      section.style.cssText = "padding:8px 12px;border-top:1px solid #d9e2e6;";
      const label = document.createElement("div");
      // Wording (user 2026-08-11): "Study pattern" — the buttons break a
      // 10-page block into session segments (e.g. 4-3-3).
      label.textContent = "Study pattern:";
      label.className = "qs-pattern-label setting-options";
      label.style.cssText = "font-size:11px;color:#5b7a86;margin:6px 0 4px;";
      section.appendChild(label);
      const row = document.createElement("div");
      row.className = "qs-pattern-row setting-options";
      row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
      let busy = false;
      const allBtns = [];
      for (const raw of splits) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = raw;
        // "setting-options" in the class is REQUIRED: the app's onMousedown
        // closes the dropdown unless the target's class contains it — without
        // this, the panel dies on mousedown and our click never fires
        btn.className = "qs-pattern-btn setting-options";
        btn.style.cssText =
          "padding:3px 10px;border:1px solid #2a6df4;border-radius:12px;background:#fff;color:#2a6df4;cursor:pointer;font-size:12px;";
        btn.addEventListener("click", async () => {
          if (busy) return;
          busy = true;
          try {
            for (const b of allBtns) b.disabled = true;
            if (typeof onPick === "function") await onPick(raw);
          } finally {
            busy = false;
            for (const b of allBtns) b.disabled = false;
          }
        });
        allBtns.push(btn);
        row.appendChild(btn);
      }
      section.appendChild(row);
      panel.appendChild(section);
      return true;
    } catch (err) {
      // never throw into the page
      console.warn("[QuickSet] injectPatternSection failed:", err);
      return false;
    }
  }

  /**
   * Show/update the progress bar inside the pattern section while days are
   * being reshaped. done/total = day index out of total; label = the pattern.
   */
  function setPatternProgress(progress) {
    try {
      const section = document.querySelector(".qs-pattern-section");
      if (!section) return;
      let bar = section.querySelector(".qs-pattern-progress");
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "qs-pattern-progress setting-options";
        bar.style.cssText =
          "margin-top:8px;border:1px solid #d9e2e6;border-radius:4px;height:18px;position:relative;background:#f2f6f8;overflow:hidden;";
        const fill = document.createElement("div");
        fill.className = "qs-pattern-progress-fill";
        fill.style.cssText =
          "height:100%;width:0%;background:#2a6df4;transition:width .25s ease;";
        const txt = document.createElement("div");
        txt.className = "qs-pattern-progress-text";
        txt.style.cssText =
          "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:#1c3a5e;";
        bar.appendChild(fill);
        bar.appendChild(txt);
        section.appendChild(bar);
      }
      const done = Math.max(0, Math.min(progress.total || 1, progress.done || 0));
      const total = progress.total || 1;
      bar.querySelector(".qs-pattern-progress-fill").style.width = `${Math.round((done / total) * 100)}%`;
      bar.querySelector(".qs-pattern-progress-text").textContent =
        `${progress.label || ""} — day ${done} of ${total}`;
    } catch (err) {
      /* best-effort */
    }
  }

  /** Remove the progress bar. */
  function clearPatternProgress() {
    try {
      const bar = document.querySelector(".qs-pattern-progress");
      if (bar) bar.remove();
    } catch (err) {
      /* best-effort */
    }
  }

  return { injectUniformOptions, pruneUniformOptions, injectPatternSection, setPatternProgress, clearPatternProgress };
})();
