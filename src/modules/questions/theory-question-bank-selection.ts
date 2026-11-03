export type TheoryQuestionBankSelectionRow = {
  pointCode: string | null;
  questionType: string;
  questionNo: string;
  storedAt: Date | string | null;
};

function exportBucket(questionType: string) {
  if (/单.*选/.test(questionType)) return "single";
  if (/判断/.test(questionType)) return "judgement";
  return "other";
}

function limitForBucket(bucket: ReturnType<typeof exportBucket>) {
  if (bucket === "single") return 4;
  if (bucket === "judgement") return 2;
  return Number.POSITIVE_INFINITY;
}

function storedAtValue(value: TheoryQuestionBankSelectionRow["storedAt"]) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function compareRows(a: TheoryQuestionBankSelectionRow, b: TheoryQuestionBankSelectionRow) {
  const pointCompare = String(a.pointCode ?? "").localeCompare(String(b.pointCode ?? ""), "zh-Hans-CN");
  if (pointCompare !== 0) return pointCompare;
  const bucketCompare = exportBucket(a.questionType).localeCompare(exportBucket(b.questionType));
  if (bucketCompare !== 0) return bucketCompare;
  const storedCompare = storedAtValue(b.storedAt) - storedAtValue(a.storedAt);
  if (storedCompare !== 0) return storedCompare;
  return b.questionNo.localeCompare(a.questionNo, "en");
}

export function limitTheoryQuestionBankRows<T extends TheoryQuestionBankSelectionRow>(rows: T[]) {
  const counts = new Map<string, number>();
  return [...rows]
    .sort(compareRows)
    .filter((row) => {
      const bucket = exportBucket(row.questionType);
      const key = `${row.pointCode ?? ""}::${bucket}`;
      const next = (counts.get(key) ?? 0) + 1;
      if (next > limitForBucket(bucket)) return false;
      counts.set(key, next);
      return true;
    });
}
