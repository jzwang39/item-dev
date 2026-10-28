export function ScoreRubric({ value }: Readonly<{ value?: unknown }>) {
  if (!value || typeof value !== "object") return null;
  const rubric = value as { totalScore?: number; criteria?: Array<{ item: string; score: number; standard: string }> };
  if (!Array.isArray(rubric.criteria)) return null;
  return <div className="mt-4 text-sm text-[#50627e]">
    <strong>评分标准草稿（总分 {rubric.totalScore} 分，须人工审定）</strong>
    <ul className="mt-2 space-y-2">{rubric.criteria.map((item, index) =>
      <li key={index}>{item.item} · {item.score} 分：{item.standard}</li>)}</ul>
  </div>;
}
