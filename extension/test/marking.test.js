// test/marking.test.js — pure logic for the Quick Mark marking-screen features
import { test, expect } from "bun:test";
await import("../src/marking.js");
const { markPageQuestions, rightCodeFor, isTypingTarget, buildTextItem } = globalThis.QS.marking;

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

test("buildTextItem produces the SDK text item with ordered numbering", () => {
  const ink = { is: [{ t: 0 }, { t: 2 }] };
  const item = buildTextItem(ink, 1, "Great work!", 120, 80);
  expect(item.st.tp).toBe(23); // InkPenType.Old_KesText
  expect(item.t).toBe(3); // one past the max existing item number
  expect(item.kmn.tx).toBe("Great work!");
  expect(item.kmn.tr).toBe(1); // page index
  expect(item.kmn.txtRect).toEqual({ x: 120, y: 80, width: 88, height: 20 }); // 11 chars * 8
});

test("buildTextItem handles empty inks and zero items", () => {
  const item = buildTextItem({ is: [] }, 0, "hi", 0, 0);
  expect(item.t).toBe(0);
  expect(item.kmn.txtRect.x).toBe(0);
  const item2 = buildTextItem(null, 0, "hi", 10, 10);
  expect(item2.t).toBe(0);
  expect(item2.kmn.txtRect.width).toBeGreaterThanOrEqual(40);
});
