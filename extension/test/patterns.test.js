// test/patterns.test.js
import { test, expect } from "bun:test";
await import("../src/patterns.js");
const { parsePattern, patternSum, isValidPattern, groupPatternsBySum, expandAcrossDays, isFullTenBlocks, expandForBlock } =
  globalThis.QS.patterns;

test("parsePattern parses and validates", () => {
  expect(parsePattern("4-3-3")).toEqual([4, 3, 3]);
  expect(parsePattern("10")).toEqual([10]);
  expect(parsePattern("4,3,3")).toEqual([4, 3, 3]);
  expect(parsePattern("0-3")).toBeNull();
  expect(parsePattern("4-3-x")).toBeNull();
  expect(parsePattern("4--3")).toBeNull();
  expect(parsePattern("")).toBeNull();
});

test("patternSum sums blocks", () => {
  expect(patternSum([4, 3, 3])).toBe(10);
  expect(patternSum([10])).toBe(10);
});

test("isValidPattern accepts only comma/hyphen separated positive ints", () => {
  expect(isValidPattern("4-3-3")).toBe(true);
  expect(isValidPattern("4,3,3")).toBe(true);
  expect(isValidPattern("4 3 3")).toBe(false);
  expect(isValidPattern("4-0")).toBe(false);
  expect(isValidPattern("4,,3")).toBe(false);
  expect(isValidPattern("4-3-3-")).toBe(false);
});

test("groupPatternsBySum groups and orders by sum", () => {
  const groups = groupPatternsBySum(["10", "5-5", "4-3-3", "5", "3-2"]);
  expect(groups.map((g) => g.sum)).toEqual([5, 10]);
  expect(groups[1].patterns).toEqual(["10", "5-5", "4-3-3"]); // insertion order
});

test("groupPatternsBySum skips invalid entries", () => {
  const groups = groupPatternsBySum(["4-3-3", "nope", "0-3", ""]);
  expect(groups.map((g) => g.sum)).toEqual([10]);
  expect(groups[0].patterns).toEqual(["4-3-3"]);
});

test("expandAcrossDays repeats pattern to cover N days", () => {
  expect(expandAcrossDays([4, 3, 3], 6)).toEqual([4, 3, 3, 4, 3, 3]);
  expect(expandAcrossDays([4, 3, 3], 2)).toEqual([4, 3]);
});

test("isFullTenBlocks — only days made of full 10-page blocks qualify", () => {
  expect(isFullTenBlocks([10])).toBe(true);
  expect(isFullTenBlocks([10, 20])).toBe(true);
  expect(isFullTenBlocks([40])).toBe(true);
  expect(isFullTenBlocks([])).toBe(false);
  expect(isFullTenBlocks([5])).toBe(false); // 5-5 style day
  expect(isFullTenBlocks([4, 3, 3])).toBe(false); // already 4-3-3
  expect(isFullTenBlocks([2, 2, 2, 2, 2])).toBe(false); // already 2-2-2-2-2
  expect(isFullTenBlocks([10, 5])).toBe(false); // mixed
  expect(isFullTenBlocks([15])).toBe(false); // not a multiple of 10
});

test("expandForBlock fills a full-10 block by repeating the pattern", () => {
  expect(expandForBlock(10, [4, 3, 3])).toEqual([4, 3, 3]);
  expect(expandForBlock(20, [4, 3, 3])).toEqual([4, 3, 3, 4, 3, 3]);
  expect(expandForBlock(30, [4, 3, 3])).toEqual([4, 3, 3, 4, 3, 3, 4, 3, 3]);
  expect(expandForBlock(10, [3, 2])).toEqual([3, 2, 3, 2]);
  expect(expandForBlock(10, [5, 5])).toEqual([5, 5]);
  expect(expandForBlock(20, [5])).toEqual([5, 5, 5, 5]);
  expect(expandForBlock(10, [7])).toBeNull(); // 10 % 7 !== 0
  expect(expandForBlock(10, [4, 4])).toBeNull(); // 8 does not divide 10
});
