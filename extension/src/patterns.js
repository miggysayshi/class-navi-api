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
  /**
   * True when every block size is a full 10-page block (10, 20, 30, …).
   * Custom-split days (5-5, 4-3-3, 2-2-2-2-2, mixed) fail this — they are
   * already formatted and must be skipped, never re-flattened.
   */
  function isFullTenBlocks(blockSizes) {
    return blockSizes.length > 0 && blockSizes.every((s) => s >= 10 && s % 10 === 0);
  }
  /**
   * Repeat the pattern to fill a full-10 block (pattern sum 10 → once, sum 5 →
   * twice, …). Returns the expanded size list, or null when the pattern sum
   * does not divide the block size evenly (e.g. sum 7 in a 10-block).
   */
  function expandForBlock(blockSize, pattern) {
    const sum = patternSum(pattern);
    if (sum <= 0 || blockSize % sum !== 0) return null;
    const reps = blockSize / sum;
    const out = [];
    for (let r = 0; r < reps; r++) for (const b of pattern) out.push(b);
    return out;
  }
  return { parsePattern, patternSum, isValidPattern, groupPatternsBySum, expandAcrossDays, isFullTenBlocks, expandForBlock };
})();
