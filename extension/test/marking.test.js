// test/marking.test.js — pure logic for the Quick Mark marking-screen features
import { test, expect } from "bun:test";
await import("../src/marking.js");
const { markPageQuestions, rightCodeFor, isTypingTarget, buildRedCommentItems, computeInk, computeManualCalibration, rasterizeTextToRuns } = globalThis.QS.marking;

// a realistic gradingResultData slice (from the live sample, 2026-08-05)
function samplePage() {
  return {
    PageNumber: 0,
    QuestionMarks: [
      {
        AnswerRectMarks: [],
        AnswerRightList: [{ AutoRight: 1, ManualRight: 0, Right: 0 }],
        QuestionData: { QuestionNumber: 1, QuestionScore: 5 },
      },
      {
        AnswerRectMarks: [],
        AnswerRightList: [{ AutoRight: 0, ManualRight: 1, Right: 1 }, { AutoRight: 1, ManualRight: 0, Right: 0 }],
        QuestionData: { QuestionNumber: 2, QuestionScore: 5 },
      },
    ],
  };
}

test("rightCodeFor maps correct/wrong to qr codes", () => {
  expect(rightCodeFor(true)).toBe(2); // qr.Right
  expect(rightCodeFor(false)).toBe(1); // qr.Incorrect
});

test("markPageQuestions marks every question on the page (overwrite), last attempt only", () => {
  const data = { FullScore: 100, PageMarks: [samplePage(), { PageNumber: 1, QuestionMarks: [] }] };
  const changed = markPageQuestions(data, 0, 2); // all correct
  const marks = data.PageMarks[0].QuestionMarks;
  expect(changed).toBe(2);
  // q1: single attempt, AutoRight untouched
  expect(marks[0].AnswerRightList[0]).toEqual({ AutoRight: 1, ManualRight: 2, Right: 2 });
  // q2: two attempts — only the LAST one changes
  expect(marks[1].AnswerRightList[0]).toEqual({ AutoRight: 0, ManualRight: 1, Right: 1 });
  expect(marks[1].AnswerRightList[1]).toEqual({ AutoRight: 1, ManualRight: 2, Right: 2 });
});

test("markPageQuestions marks wrong (code 1)", () => {
  const data = { FullScore: 100, PageMarks: [samplePage()] };
  markPageQuestions(data, 0, 1);
  const q1 = data.PageMarks[0].QuestionMarks[0].AnswerRightList[0];
  expect(q1).toEqual({ AutoRight: 1, ManualRight: 1, Right: 1 });
});

test("markPageQuestions handles missing/empty pieces without throwing", () => {
  expect(markPageQuestions({ PageMarks: [] }, 0, 2)).toBe(0);
  expect(markPageQuestions(null, 0, 2)).toBe(0);
  expect(markPageQuestions({ PageMarks: [{ PageNumber: 0, QuestionMarks: [{ AnswerRightList: [] }] }] }, 0, 2)).toBe(0);
  expect(markPageQuestions({ PageMarks: [{ PageNumber: 0, QuestionMarks: [{ AnswerRightList: null }] }] }, 0, 2)).toBe(0);
});

test("markPageQuestions only touches the requested page", () => {
  const p0 = samplePage();
  const p1 = samplePage();
  p1.PageNumber = 1;
  const data = { PageMarks: [p0, p1] };
  markPageQuestions(data, 1, 2);
  // page 0 untouched (still unmarked), page 1 marked
  expect(data.PageMarks[0].QuestionMarks[0].AnswerRightList[0].Right).toBe(0);
  expect(data.PageMarks[1].QuestionMarks[0].AnswerRightList[0].Right).toBe(2);
});

test("isTypingTarget guards shortcuts while typing", () => {
  const input = { tagName: "INPUT" };
  const textarea = { tagName: "TEXTAREA" };
  const editable = { tagName: "DIV", isContentEditable: true };
  const body = { tagName: "BODY" };
  expect(isTypingTarget(input)).toBe(true);
  expect(isTypingTarget(textarea)).toBe(true);
  expect(isTypingTarget(editable)).toBe(true);
  expect(isTypingTarget(body)).toBe(false);
});

test("buildRedCommentItems produces SDK-format stroke items with red pen", () => {
  // cells: "x|y|t" strings (3-part form → the loader applies the stationery width)
  const items = buildRedCommentItems([
    { cs: ["10|20|0", "15|20|1"], width: 100 },
    { cs: ["10|30|2"], width: 40 },
  ], 2, 5);
  expect(items.length).toBe(2);
  const it = items[0];
  expect(it.st.tp).toBe(0); // Old_BallpointPen — renders in any ink layer
  expect(it.st.col).toBe("#FF0000"); // the red pen
  expect(it.st.w).toBe(1);
  expect(it.t).toBe(5); // item numbering continues
  expect(it.cs).toEqual(["10|20|0", "15|20|1"]);
  expect(items[1].t).toBe(6);
  expect(items[1].cs).toEqual(["10|30|2"]);
});

test("buildRedCommentItems ignores empty runs and starts numbering from the ink", () => {
  const items = buildRedCommentItems([{ cs: [] }, { cs: ["1|1|0"] }], 1, 3);
  expect(items.length).toBe(1);
  expect(items[0].t).toBe(3);
});

test("computeInk inverts the app's scale with the container origin", () => {
  const rect = { left: 120, top: 60 };
  // app: screen = floor(ink * scale); scale 1.5 → ink 100 lands at 120 + 150
  const ink = computeInk(270, 210, rect, 1.5, 1.5);
  expect(ink.x).toBe(100);
  expect(ink.y).toBe(100);
  // zero-safe scales fall back to 1
  const ink2 = computeInk(130, 70, rect, 0, 0);
  expect(ink2.x).toBe(10);
  expect(ink2.y).toBe(10);
});

test("rasterizeTextToRuns produces x|y|t cells from a fake canvas bitmap", () => {
  const width = 14; // measureText(10) + 4
  const height = 55; // ceil(36 * 1.4) + 4
  // a fake canvas: opaque pixels in rows 2 and 6, columns 3-6 (a mini "glyph")
  const pixels = new Uint8ClampedArray(width * height * 4);
  const opaque = (row, col) => {
    const i = (row * width + col) * 4;
    pixels[i + 3] = 255;
  };
  for (let c = 3; c <= 6; c++) {
    opaque(2, c);
    opaque(6, c);
  }
  const fakeCtx = {
    font: "",
    measureText: () => ({ width: 10 }),
    fillText: () => {},
    getImageData: () => ({ data: pixels }),
  };
  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: () => fakeCtx,
  };
  const runs = rasterizeTextToRuns("ab", 100, 200, 36, '"Arial"', () => fakeCanvas);
  expect(runs.length).toBe(2); // two opaque rows
  const rowCells = runs.map((r) => r.cs);
  for (const cells of rowCells) {
    for (const cell of cells) {
      const [x, y] = cell.split("|").map(Number);
      expect([101, 102, 103, 104]).toContain(x); // col 3-6 + offset 100 − 2px margin
      expect([200, 204]).toContain(y); // base 200 + row 2 or 6 − 2px margin
    }
  }
  // every cell carries a time component (x|y|t)
  expect(rowCells[0][0].split("|").length).toBe(3);
});

test("computeManualCalibration derives scale + offset from two corner clicks", () => {
  // image 1000×1400; clicks at screen (150, 80) and (1150, 1340);
  // container origin (100, 40) → offset = click1 − origin
  const cal = computeManualCalibration(150, 80, 1150, 1340, 1000, 1400, 100, 40);
  expect(cal.ox).toBe(50);
  expect(cal.oy).toBe(40);
  expect(cal.sx).toBeCloseTo(1.0, 6); // (1150−150)/1000
  expect(cal.sy).toBeCloseTo(0.9, 6); // (1340−80)/1400
  expect(cal.manual).toBe(true);
});

test("computeManualCalibration round-trips through computeInk", () => {
  // clicks at (200,150) and (1400,1150); image 1200×1000; container (100,50)
  const cal = computeManualCalibration(200, 150, 1400, 1150, 1200, 1000, 100, 50);
  // the second click must map back to ink (1200, 1000)
  const ink = computeInk(1400, 1150, { left: 100, top: 50 }, cal.sx, cal.sy);
  expect(ink.x).toBeCloseTo(1200, 4);
  expect(ink.y).toBeCloseTo(1000, 4);
});
