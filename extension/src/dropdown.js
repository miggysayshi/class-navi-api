// src/dropdown.js — classic script; injects uniform + pattern options into the
// worksheets-per-study dropdown panel; attaches to globalThis.QS
var QS = globalThis.QS || (globalThis.QS = {});
QS.dropdown = (function () {
  const NATIVE_KEYS = new Set([10, 5]);

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

  /** Multi-number patterns → "Page pattern" section inside the same panel. */
  function injectPatternSection(patterns, onPick) {
    try {
      const panel = document.querySelector(".options.setting-options");
      if (!panel || document.querySelector(".qs-pattern-section")) return false;
      const groups = QS.patterns.groupPatternsBySum(
        patterns.filter((raw) => (QS.patterns.parsePattern(raw) || []).length > 1), // splits only
      );
      const section = document.createElement("div");
      section.className = "qs-pattern-section";
      section.style.cssText = "padding:8px 12px;border-top:1px solid #d9e2e6;";
      for (const g of groups) {
        const label = document.createElement("div");
        label.textContent = `${g.sum} pages / day`;
        label.style.cssText = "font-size:11px;color:#5b7a86;margin:6px 0 4px;";
        section.appendChild(label);
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
        for (const raw of g.patterns) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = raw;
          btn.className = "qs-pattern-btn";
          btn.style.cssText =
            "padding:3px 10px;border:1px solid #2a6df4;border-radius:12px;background:#fff;color:#2a6df4;cursor:pointer;font-size:12px;";
          btn.addEventListener("click", () => {
            if (typeof onPick === "function") onPick(raw);
          });
          row.appendChild(btn);
        }
        section.appendChild(row);
      }
      panel.appendChild(section);
      return true;
    } catch (err) {
      // never throw into the page
      console.warn("[QuickSet] injectPatternSection failed:", err);
      return false;
    }
  }

  return { injectUniformOptions, injectPatternSection };
})();
