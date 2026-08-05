// src/patterns.js — classic script; pure logic; attaches to globalThis.QS
var QS = globalThis.QS || (globalThis.QS = {});
QS.patterns = (function () {
  function parsePattern(raw) {
    if (typeof raw !== "string") return null;
    const parts = raw.trim().split(/[-,]/).map((s) => s.trim());
    if (parts.length === 0) return null;
    const nums = [];
    for (const p of parts) {
      if (!/^[1-9]\d*$/.test(p)) return null;
      nums.push(Number(p));
    }
    return nums;
  }
  function patternSum(blocks) {
    return blocks.reduce((a, b) => a + b, 0);
  }
  function isValidPattern(raw) {
    return parsePattern(raw) !== null;
  }
  function groupPatternsBySum(patternStrings) {
    const bySum = new Map();
    for (const raw of patternStrings) {
      const blocks = parsePattern(raw);
      if (!blocks) continue;
      const sum = patternSum(blocks);
      if (!bySum.has(sum)) bySum.set(sum, []);
      bySum.get(sum).push(raw);
    }
    return [...bySum.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sum, patterns]) => ({ sum, patterns }));
  }
  function expandAcrossDays(blocks, dayCount) {
    const out = [];
    for (let i = 0; i < dayCount; i++) out.push(blocks[i % blocks.length]);
    return out;
  }
  return { parsePattern, patternSum, isValidPattern, groupPatternsBySum, expandAcrossDays };
})();
