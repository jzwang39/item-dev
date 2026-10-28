"use client";
import { useState } from "react";
import { ScoreRubric } from "@/components/questions/score-rubric";

export type EditableReviewTask = {
  id: string; assignmentId?: string | null; versionId: string; questionNo: string;
  questionType: string; stem: string; analysis?: string | null; answer?: unknown;
  content?: { options?: Array<{ key?: string; content?: string; text?: string }> };
  scoreRubric?: unknown;
};

export function AdminQuestionReview({ task, onClose, onSaved, role = "admin" }: Readonly<{
  task: EditableReviewTask; onClose: () => void; onSaved: () => void; role?: "admin" | "expert";
}>) {
  const [stem, setStem] = useState(task.stem);
  const [options, setOptions] = useState((task.content?.options ?? []).map((option, index) => ({
    key: option.key ?? String.fromCharCode(65 + index), content: option.content ?? option.text ?? "",
  })));
  const originalAnswers = task.answer && typeof task.answer === "object" ? (task.answer as { answers?: string[] }).answers : null;
  const practical = task.questionType === "实操题";
  const [answer, setAnswer] = useState(originalAnswers?.join(practical ? "\n" : "、") ?? (typeof task.answer === "string" ? task.answer : ""));
  const [analysis, setAnalysis] = useState(task.analysis ?? "");
  const [opinion, setOpinion] = useState("");
  const [decision, setDecision] = useState("approved");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/review/questions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questionId: task.id, assignmentId: task.assignmentId, versionId: task.versionId, action: role === "expert" ? "revise" : "review",
          stem, options, answers: answer.split(practical ? /\n+/ : /[、,，]/).map((value) => value.trim()).filter(Boolean), analysis, opinion, decision,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "提交失败。");
      onSaved(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "提交失败。"); }
    finally { setBusy(false); }
  };
  const field = "mt-2 w-full rounded-lg border border-[#cbdaf0] p-3 text-[#34445d]";
  return <div className="fixed inset-0 z-[200] grid place-items-center bg-[#263548]/55 p-4" role="dialog" aria-modal="true" aria-label={role === "expert" ? "专家编辑修订" : "管理员编辑修订与代审"}>
    <div className="flex max-h-[92vh] w-full max-w-[810px] flex-col overflow-hidden rounded-2xl bg-white">
      <div className="border-b px-6 py-5"><h2 className="text-xl font-semibold">编辑修订与审定 · {task.questionNo}</h2></div>
      <div className="overflow-y-auto p-6">
        <p className="mb-5 rounded-lg bg-[#fff7e7] p-4 text-sm text-[#a6711f]">{role === "expert" ? "仅修订本人分配试题，保存新版本后在列表重新审核。审核通过后交由管理员确认，不直接入库。" : "以当前管理员身份代审并留痕。通过后进入待管理员确认，不直接入库；修改内容将保存新版本。"}</p>
        <label className="block">题干<textarea className={`${field} h-28`} value={stem} onChange={(event) => setStem(event.target.value)} /></label>
        {options.map((option, index) => <label key={option.key} className="mt-4 block">选项 {option.key}<input className={field} value={option.content} onChange={(event) => setOptions((current) => current.map((value, i) => i === index ? { ...value, content: event.target.value } : value))} /></label>)}
        <label className="mt-4 block">{practical ? "参考操作步骤（每行一步）" : "答案（多个答案以顿号分隔）"}
          {practical ? <textarea className={`${field} h-40`} value={answer} onChange={(event) => setAnswer(event.target.value)} />
            : <input className={field} value={answer} onChange={(event) => setAnswer(event.target.value)} />}
        </label>
        <label className="mt-4 block">解析<textarea className={`${field} h-28`} value={analysis} onChange={(event) => setAnalysis(event.target.value)} /></label>
        <ScoreRubric value={task.scoreRubric} />
        {role === "admin" ? <label className="mt-4 block">审定结论<select className={field} value={decision} onChange={(event) => setDecision(event.target.value)}><option value="approved">同意通过，待管理员确认</option><option value="returned">退回修订</option></select></label> : null}
        <label className="mt-4 block">{role === "expert" ? "修订说明" : "审定意见"}<textarea className={`${field} h-24`} value={opinion} onChange={(event) => setOpinion(event.target.value)} /></label>
        <label className="mt-4 flex gap-3"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{role === "expert" ? "我确认以本人专家身份据实修订" : "我确认以管理员身份据实修订并代审"}</label>
        {error ? <p role="alert" className="mt-4 text-red-600">{error}</p> : null}
      </div>
      <div className="flex justify-end gap-3 border-t p-5">
        <button disabled={busy} className="rounded-lg border px-4 py-2" onClick={onClose}>取消</button>
        <button disabled={busy || !confirmed || !opinion.trim() || !stem.trim() || !answer.trim() || !analysis.trim()} className="rounded-lg bg-[#405fe7] px-4 py-2 text-white disabled:opacity-50" onClick={() => void submit()}>{busy ? "提交中..." : role === "expert" ? "保存修订，重新审核" : "保存修订并提交审定"}</button>
      </div>
    </div>
  </div>;
}
