// test/aggregate.test.js
import { test, expect } from "bun:test";
await import("../src/patterns.js");
await import("../src/day-blocks.js"); // manifest order — aggregate reads QS.blocks
await import("../src/aggregate.js");
const { compute, fmtTime, fmtPages } = globalThis.QS.aggregate;

const studied = (from, to, time) => ({
  WorksheetNOFrom: from,
  WorksheetNOTo: to,
  CompleteTime: time,
  DownloadFlg: "1",
});
const assigned = (from, to) => ({
  WorksheetNOFrom: from,
  WorksheetNOTo: to,
  DownloadFlg: "0",
});

test("compute averages + medians over studied sessions only", () => {
  const agg = compute([studied(1, 4, 1200), studied(5, 7, 1800), assigned(8, 17)]);
  expect(agg.studied).toBe(2);
  expect(agg.avgPages).toBe(3.5); // (4 + 3) / 2 — the assigned 10-pager is excluded
  expect(agg.medPages).toBe(3.5); // even count → average of the two middles
  expect(agg.avgTimeSec).toBe(1500);
  expect(agg.medTimeSec).toBe(1500);
});

test("compute medians handle odd counts (middle value wins)", () => {
  const agg = compute([
    studied(1, 3, 1000),
    studied(4, 7, 2000),
    studied(8, 17, 3000),
  ]);
  expect(agg.avgPages).toBeCloseTo(5.667, 2);
  expect(agg.medPages).toBe(4); // sorted [3, 4, 10]
  expect(agg.avgTimeSec).toBe(2000);
  expect(agg.medTimeSec).toBe(2000); // sorted [1000, 2000, 3000]
});

test("compute returns null with no studied sessions", () => {
  expect(compute([assigned(1, 10)])).toBeNull();
  expect(compute([])).toBeNull();
  expect(compute(null)).toBeNull();
});

test("compute tolerates missing times (pages stats still computed)", () => {
  const agg = compute([studied(1, 10, null), studied(1, 5, 900)]);
  expect(agg.avgPages).toBe(7.5);
  expect(agg.medPages).toBe(7.5);
  expect(agg.avgTimeSec).toBe(900);
  expect(agg.medTimeSec).toBe(900);
});

test("fmtTime formats minutes and hours", () => {
  expect(fmtTime(0)).toBe("0m");
  expect(fmtTime(2798)).toBe("47m");
  expect(fmtTime(3600)).toBe("1h 0m");
  expect(fmtTime(5400)).toBe("1h 30m");
  expect(fmtTime(null)).toBe("—");
  expect(fmtTime(undefined)).toBe("—");
});

test("fmtPages rounds to one decimal without trailing zero", () => {
  expect(fmtPages(3)).toBe("3");
  expect(fmtPages(3.45)).toBe("3.5");
  expect(fmtPages(7.5)).toBe("7.5");
  expect(fmtPages(0)).toBe("0");
  expect(fmtPages(null)).toBe("—");
});
