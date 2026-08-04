/**
 * RPC method registry extracted from the Class-Navi JS bundle.
 * Each method maps to its owning screen ID (controller) — useful for
 * permission/debugging context. Exact param/response field shapes are
 * pending a HAR capture; until then params are open records.
 */

export interface MethodSpec {
  name: string;
  screenId: string;
  /** Read-only data fetch (vs. a register/update/delete action). */
  readOnly: boolean;
}

const RAW: Array<[string, string, boolean]> = [
  // --- reads ---
  ["GetAnnounce", "ATE0010P", true],
  ["GetAssistantInfoList", "ATX0040P", true],
  ["GetAssistantNumberingList", "ATX0041P", true],
  ["GetCenterAllStudentList", "ATE0010P", true],
  ["GetCenterInfoList", "ATX0050P", true],
  ["GetCenterStudentNumberingList", "ATE0010P", true],
  ["GetClassNoteList", "ATG0030P", true],
  ["GetContentID", "ATD0013P", true],
  ["GetInstructorInfo", "ATX0010P", true],
  ["GetKidsStudentList", "ATX0035P", true],
  ["GetMasterInfo", "ATE0010P", true],
  ["GetMessageList", "ATG0010P", true],
  ["GetPaperStudyInfoList", "ATD0011P", true],
  ["GetPastClassScoreDetailInfo", "ATD0020P", true],
  ["GetPastClassSoundRecordInfo", "ATD0020P", true],
  ["GetPastClassStudyResultInfoList", "ATD0010P", true],
  ["GetPastClassTestScoreList", "ATE0010P", true],
  ["GetProfileImage", "ATX0060P", true],
  ["GetProgressGoal", "ATE0010P", true],
  ["GetReportBDownloadAvailableDate", "ATE0030P", true],
  ["GetScoreDetailInfo", "ATD0020P", true],
  ["GetSoundRecordInfo", "ATD0020P", true],
  ["GetStudentKarteList", "ATD0013P", true],
  ["GetStudentLogList", "ATE0010P", true],
  ["GetStudentMemoFile", "ATD0013P", true],
  ["GetStudentMemoList", "ATD0013P", true],
  ["GetStudentStatus", "ATE0010P", true],
  ["GetStudyObjectiveInfo", "ATE0010P", true],
  ["GetStudyResultInfoList", "ATD0010P", true],
  ["GetStudyWorksheetCommentList", "ATD0010P", true],
  ["GetTargetGoal", "ATE0010P", true],
  ["GetTestScoreList", "ATE0010P", true],
  ["GetTotalStudentNum", "ATE0010P", true],
  // --- writes ---
  ["CsvOutput", "ATE0030P", false],
  ["VariousCsvOutput", "ATE0030P", false],
  ["DeleteKidsStudentLinkage", "ATE0010P", false],
  ["DeleteMessage", "ATG0010P", false],
  ["DeletePastClassStudySetInfo", "ATD0010P", false],
  ["RegisterAssistantInfo", "ATX0041P", false],
  ["RegisterCenterAccessLog", "ATX0050P", false],
  ["RegisterClassNoteInfo", "ATG0030P", false],
  ["RegisterClassNoteReaction", "ATG0030P", false],
  ["RegisterEvaluationGradingLog", "ATD0020P", false],
  ["RegisterKidsStudentLinkage", "ATE0040P", false],
  ["RegisterMessage", "ATG0010P", false],
  ["RegisterPaperStudyInfo", "ATD0012P", false],
  ["RegisterPaperStudyTestInfo", "ATD0012P", false],
  ["RegisterPastClassScore", "ATD0020P", false],
  ["RegisterPastClassStartScore", "ATD0020P", false],
  ["RegisterPastClassStudyDataReplayLog", "ATD0020P", false],
  ["RegisterPastClassTestScore", "ATD0020P", false],
  ["RegisterProgressGoal", "ATE0010P", false],
  ["RegisterScore", "ATD0020P", false],
  ["RegisterStartScore", "ATD0020P", false],
  ["RegisterStudentAccount", "ATX0031P", false],
  ["RegisterStudentKarteInfo", "ATD0013P", false],
  ["RegisterStudyDataReplayLog", "ATD0020P", false],
  ["RegisterStudyObjectiveInfo", "ATE0010P", false],
  ["RegisterStudySetInfo", "ATD0010P", false],
  ["RegisterStudyWorksheetCommentList", "ATD0010P", false],
  ["RegisterTargetGoal", "ATE0010P", false],
  ["RegisterTestScore", "ATD0020P", false],
  ["UpdateAssistantInfo", "ATX0040P", false],
  ["UpdateAttentionFlg", "ATE0010P", false],
  ["UpdateGradingResultInvalidFlg", "ATD0010P", false],
  ["UpdateInstructorNickname", "ATX0060P", false],
  ["UpdateInstructorPassword", "ATX0040P", false],
  ["UpdateProfileImage", "ATX0060P", false],
  ["UpdateStudentAccount", "ATX0030P", false],
];

export const METHODS: MethodSpec[] = RAW.map(([name, screenId, readOnly]) => ({
  name,
  screenId,
  readOnly,
}));

export const METHOD_NAMES: string[] = METHODS.map((m) => m.name);

const BY_NAME = new Map(METHODS.map((m) => [m.name, m]));

export function isKnownMethod(name: string): boolean {
  return BY_NAME.has(name);
}
