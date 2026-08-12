// src/aggregate.js — classic script; per-level study-session averages shown in
// the editor header (user request 2026-08-11): avg pages + avg time per
// studied session, rendered in the free strip right of the app's "Default"
// view button (.progress-model-select-selected-view). Attaches to
// globalThis.QS.
var QS = globalThis.QS || (globalThis.QS = {});

QS.aggregate = (function () {
  /** Median of a numeric array (average of the two middles when even). */
  function median(values) {
    if (!values || values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Averages + medians over STUDIED sessions only (DownloadFlg "1") — only
   * they carry completion times. Pages = block size; time = the app's own
   * CompleteTime field (seconds; FirstCompleteTime is the first-sitting time,
   * CompleteTime the whole session). Time stats use only records that have a
   * time. Returns null when there is no studied session.
   */
  function compute(records) {
    const studied = (records || []).filter((u) => String(u && u.DownloadFlg) === "1");
    if (studied.length === 0) return null;
    const pageSizes = [];
    const times = [];
    for (const u of studied) {
      const from = Number(u.WorksheetNOFrom);
      const to = Number(u.WorksheetNOTo);
      if (Number.isFinite(from) && Number.isFinite(to)) pageSizes.push(to - from + 1);
      const t = Number(u.CompleteTime);
      if (Number.isFinite(t) && t > 0) times.push(t);
    }
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    return {
      studied: studied.length,
      avgPages: pageSizes.length > 0 ? sum(pageSizes) / pageSizes.length : null,
      medPages: median(pageSizes),
      avgTimeSec: times.length > 0 ? sum(times) / times.length : null,
      medTimeSec: median(times),
    };
  }

  /** Seconds → "47m" / "1h 5m"; null/NaN → "—". */
  function fmtTime(sec) {
    if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return "—";
    const total = Math.round(Number(sec) / 60);
    if (total >= 60) return `${Math.floor(total / 60)}h ${total % 60}m`;
    return `${total}m`;
  }

  /** Pages → one decimal, no trailing .0 ("3" / "3.5"); null/NaN → "—". */
  function fmtPages(p) {
    if (p === null || p === undefined || !Number.isFinite(Number(p))) return "—";
    return String(Math.round(Number(p) * 10) / 10);
  }

  /**
   * Records source: the page comp's own StudyUnitInfoList carries the full
   * API objects (CompleteTime included) — use them when present. Fall back to
   * a proxy fetch only when times are absent.
   */
  function resolveRecords(comp) {
    const src =
      comp && comp.curStudentStudyInfo && Array.isArray(comp.curStudentStudyInfo.StudyUnitInfoList)
        ? comp.curStudentStudyInfo.StudyUnitInfoList
        : null;
    if (src && src.some((u) => u && u.CompleteTime !== null && u.CompleteTime !== undefined)) {
      return { records: src, source: "in-page" };
    }
    return { records: null, source: "proxy" };
  }

  /**
   * Recompute + (re)position the header readout. Cheap when nothing changed:
   * a student/level key guards the work, so level switches trigger exactly
   * one refetch. Never throws.
   */
  async function updateDisplay(root) {
    try {
      const comp = QS.blocks.findPageComp(root);
      if (!comp) {
        const gone = document.getElementById("qs-aggregate");
        if (gone) gone.remove();
        window.__qsAggKey = null;
        return;
      }
      const key = `${comp.curStudentInfo && comp.curStudentInfo.StudentID}:${comp.curSubjectCD}:${comp.curWorksheetCD}`;
      if (window.__qsAggKey === key) return; // already showing this level
      window.__qsAggKey = key;
      let records = null;
      let source = "in-page";
      const src = resolveRecords(comp);
      if (src.records) {
        records = src.records;
      } else if (comp.proxy && typeof comp.proxy.getStudyResultInfoList === "function") {
        const params = QS.blocks.fetchParams ? QS.blocks.fetchParams(comp) : null;
        if (params) {
          const resp = await comp.proxy.getStudyResultInfoList(params);
          if (resp && resp.Result && resp.Result.ResultCode === 0 && resp.StudyUnitInfoList) {
            records = resp.StudyUnitInfoList;
            source = "proxy";
          }
        }
      }
      const agg = compute(records);
      if (agg) {
        console.log(
          `[QuickSet] aggregate (${source}): ${agg.studied} studied, avg ${fmtPages(agg.avgPages)} pg (med ${fmtPages(agg.medPages)}), avg ${fmtTime(agg.avgTimeSec)} (med ${fmtTime(agg.medTimeSec)}) per session`
        );
      }
      render(agg, comp);
    } catch (e) {
      /* never throw */
    }
  }

  function render(agg, comp) {
    let chip = document.getElementById("qs-aggregate");
    if (!agg) {
      if (chip) chip.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement("div");
      chip.id = "qs-aggregate";
      // two rows (headers + values) × four columns — 32px tall (border-box)
      // like the controls around it; vertical centering happens in
      // positionChip (anchored to the .menu-bar toolbar band)
      chip.style.cssText =
        "position:fixed;z-index:99990;display:grid;grid-template-columns:repeat(4,auto);column-gap:14px;row-gap:0;align-items:center;justify-items:center;align-content:center;box-sizing:border-box;height:32px;padding:0 12px;background:#fff;border:1px solid #d9e2e6;border-radius:6px;font-size:12px;color:#1c3a5e;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.08);";
      document.body.appendChild(chip);
    }
    chip.textContent = "";
    const level = comp && comp.curWorksheetCD ? comp.curWorksheetCD : "";
    const cell = (text, isHeader) => {
      const s = document.createElement("span");
      s.textContent = text;
      if (isHeader) {
        s.style.cssText = "font-size:9px;line-height:1;color:#8aa5b0;text-transform:uppercase;letter-spacing:.4px;";
      } else {
        s.style.cssText = "line-height:1.2;";
      }
      return s;
    };
    const headers = ["pg avg", "pg med", "time avg", "time med"];
    const values = [fmtPages(agg.avgPages), fmtPages(agg.medPages), fmtTime(agg.avgTimeSec), fmtTime(agg.medTimeSec)];
    for (const h of headers) chip.appendChild(cell(h, true));
    for (const v of values) chip.appendChild(cell(v, false));
    chip.title = `${agg.studied} studied session(s) on this level${level ? ` (${level})` : ""}`;
    positionChip(chip);
  }

  /** Anchor the chip right of the "Default" button, vertically centered on
   * the toolbar band (.menu-bar) — the same row as the level switcher, the
   * Include-Correction toggle and the Default selector. */
  function positionChip(chip) {
    try {
      const btn = document.querySelector(".progress-model-select-selected-view");
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      chip.style.left = `${Math.round(r.right + 14)}px`;
      const bar = document.querySelector(".menu-bar");
      if (bar) {
        const b = bar.getBoundingClientRect();
        const h = chip.offsetHeight || 32;
        chip.style.top = `${Math.round(b.top + (b.height - h) / 2)}px`;
      } else {
        chip.style.top = `${Math.round(r.top)}px`;
      }
    } catch (e) {
      /* never throw */
    }
  }

  return { compute, fmtTime, fmtPages, updateDisplay, positionChip };
})();
