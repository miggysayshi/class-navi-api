// test/patterns.test.js
import { test, expect } from "bun:test";
await import("../src/patterns.js");
const { parsePattern, patternSum, isValidPattern, groupPatternsBySum, expandAcrossDays } =
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
