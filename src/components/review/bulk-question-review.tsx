"use client";

import { useState } from "react";
import { BULK_REVIEW_LIMIT, canBulkConfirmQuestion, canBulkReviewQuestion } from "@/modules/authoring/bulk-question-review";

type BulkReviewTask = {
  id: string; versionId: string; questionNo: string; stem: string;
  canAdminReview: boolean; status: string; occupationName: string; levelLabel: string;
  confirmedAt: string | null;
  content?: { options?: Array<{ key?: string; content?: string; text?: string }> };
  answer?: unknown; analysis?: string | null;
};

export function BulkQuestionReview({ tasks, selectedIds, onSelection, onBusy, onCompleted }: Readonly<{
  tasks: BulkReviewTask[];
  selectedIds: string[];
  onSelection: (ids: string[]) => void;
  onBusy: (busy: boolean) => void;
  onCompleted: (notice: string) => Promise<void>;
}>) {
  const [open, setOpen] = useState(false);
  const [operation, setOperation] = useState<"review" | "confirm">("review");
  const [confirmed, setConfirmed] = useState(false);
  const [opinion, setOpinion] = useState("管理员批量审核，同意通过。");
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const eligible = tasks.filter(canBulkReviewQuestion);
  const confirmable = tasks.filter(canBulkConfirmQuestion);
  const reviewSelected = eligible.filter((task) => selectedIds.includes(task.id));
  const confirmSelected = confirmable.filter((task) => selectedIds.includes(task.id));
  const selected = operation === "confirm" ? confirmSelected : reviewSelected;
  const label = operation === "confirm" ? "确认" : "审核";
  const openModal = (action: "review" | "confirm") => {
    setOperation(action); setOpen(true); setConfirmed(false); setError(""); setPage(1); setCompleted(0);
    setOpinion(action === "confirm" ? "管理员批量确认试题审定结果。" : "管理员批量审核，同意通过。");
  };
  const button = "rounded-lg border border-[#d6e0ef] px-4 py-2 text-sm text-[#4e6484] disabled:opacity-40";

  const submit = async () => {
    if (busy || !confirmed || !selected.length || !opinion.trim()) return;
    setBusy(true);
    onBusy(true);
    setError("");
    setCompleted(0);
    const reviewedIds = new Set<string>();
    try {
      for (let offset = 0; offset < selected.length; offset += BULK_REVIEW_LIMIT) {
        const chunk = selected.slice(offset, offset + BULK_REVIEW_LIMIT);
        const response = await fetch("/api/v1/review/questions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: operation === "confirm" ? "bulk_confirm" : "bulk_approve", confirmed: true, opinion,
            questions: chunk.map((task) => ({ questionId: task.id, versionId: task.versionId })),
          }),
        });
        const payload = await response.json() as { data?: { reviewed?: number; confirmedCount?: number }; error?: { message?: string } };
        const count = operation === "confirm" ? payload.data?.confirmedCount : payload.data?.reviewed;
        if (!response.ok || count !== chunk.length) {
          throw new Error(payload.error?.message ?? `批量${label}提交失败，请刷新列表后核对状态。`);
        }
        chunk.forEach((task) => reviewedIds.add(task.id));
        setCompleted(reviewedIds.size);
      }
      onSelection(selectedIds.filter((id) => !reviewedIds.has(id)));
      setOpen(false);
      await onCompleted(operation === "confirm"
        ? `已批量确认 ${reviewedIds.size} 道试题，可前往“题库管理”执行终审入库。`
        : `已批量同意 ${reviewedIds.size} 道试题，请完成管理员确认。`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "批量审核失败。";
      setError(`已完成 ${reviewedIds.size} 道，其余未继续提交。${detail}`);
      setPage(1);
      onSelection(selectedIds.filter((id) => !reviewedIds.has(id)));
      await onCompleted(`批量${label}已完成 ${reviewedIds.size} 道。${detail}`);
    } finally {
      setBusy(false);
      onBusy(false);
      setConfirmed(false);
    }
  };

  return <>
    <div className="flex flex-wrap items-center gap-3 border-b border-[#e5e9f0] px-6 py-4">
      <span className="text-sm text-[#607493]">已选 {reviewSelected.length + confirmSelected.length} 道</span>
      <button className={button} disabled={busy || !eligible.length} onClick={() => onSelection(eligible.map((task) => task.id))}>选择全部可审核试题（{eligible.length}）</button>
      <button className={button} disabled={busy || !selectedIds.length} onClick={() => onSelection([])}>清空选择</button>
      <button
        className="rounded-lg bg-[#405fe7] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        disabled={busy || !reviewSelected.length}
        onClick={() => openModal("review")}
      >批量审核并同意</button>
      <button className={button} disabled={busy || !confirmable.length} onClick={() => onSelection(confirmable.map((task) => task.id))}>选择全部待确认试题（{confirmable.length}）</button>
      <button className="rounded-lg bg-[#17816a] px-4 py-2 text-sm font-medium text-white disabled:opacity-40" disabled={busy || !confirmSelected.length} onClick={() => openModal("confirm")}>批量确认</button>
      <span className="text-xs text-[#8293a9]">审核与确认分别处理；已确认、已入库试题不可勾选。</span>
    </div>
    {open ? <div className="fixed inset-0 z-[200] grid place-items-center bg-[#263548]/55 p-4" role="dialog" aria-modal="true" aria-labelledby="bulk-question-review-title">
      <div className="flex max-h-[92vh] w-full max-w-[810px] flex-col overflow-hidden rounded-2xl bg-white">
        <div className="border-b px-6 py-5">
          <h2 id="bulk-question-review-title" className="m-0 text-xl font-semibold text-[#293242]">{operation === "confirm" ? "批量确认" : "批量审核并同意"} · {selected.length} 道</h2>
        </div>
        <div className="overflow-y-auto p-6">
          <p className="m-0 rounded-lg bg-[#fff7e7] p-4 text-sm text-[#a6711f]">{operation === "confirm" ? "仅确认已审核通过的当前试题版本，逐题记录管理员身份和确认意见。确认后可执行入库，本次不会直接入库。" : "以当前管理员身份逐题留痕。同意后进入待管理员确认，不直接入库；已分配给专家的试题不参与本次审核。"}</p>
          <div className="mt-4 space-y-3">
            {selected.slice((page - 1) * 20, page * 20).map((task) => <article key={task.id} className="rounded-lg border border-[#e0e6f0] p-3">
              <p className="m-0 text-xs text-[#7185a5]">{task.questionNo} · {task.occupationName} · {task.levelLabel}</p>
              <p className="mb-0 mt-2 text-sm text-[#30415e]">{task.stem}</p>
              <details className="mt-2 text-sm text-[#607493]">
                <summary className="cursor-pointer">查看选项、答案与解析</summary>
                {(task.content?.options ?? []).map((option, index) => <p key={index}>{option.key ?? String.fromCharCode(65 + index)}：{option.content ?? option.text}</p>)}
                <p>答案：{typeof task.answer === "string" ? task.answer : JSON.stringify(task.answer ?? "未提供")}</p>
                <p>解析：{task.analysis || "未提供"}</p>
              </details>
            </article>)}
          </div>
          <div className="mt-4 flex items-center justify-end gap-3 text-sm text-[#7185a5]">
            <span>第 {page} / {Math.max(1, Math.ceil(selected.length / 20))} 页</span>
            <button className={button} disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <button className={button} disabled={busy || page >= Math.ceil(selected.length / 20)} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
          <label className="mt-5 block text-sm text-[#30415e]">统一{label}意见
            <textarea maxLength={4000} disabled={busy} className="mt-2 h-24 w-full rounded-lg border border-[#cbdaf0] p-3" value={opinion} onChange={(event) => setOpinion(event.target.value)} />
          </label>
          <label className="mt-4 flex gap-3 text-sm text-[#30415e]">
            <input type="checkbox" disabled={busy} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            {operation === "confirm" ? "我已核对所选试题的审定结果，确认以管理员身份完成确认。" : "我已核对所选试题、答案与解析，确认以管理员身份批量同意。"}
          </label>
          {busy ? <p role="status" className="mt-4 text-sm text-[#405fe7]">正在分批{label}：{completed} / {selected.length} 道，请勿关闭或刷新页面。</p> : null}
          {error ? <p role="alert" className="mt-4 text-sm text-red-600">{error}</p> : null}
        </div>
        <div className="flex justify-end gap-3 border-t p-5">
          <button className={button} disabled={busy} onClick={() => setOpen(false)}>取消</button>
          <button className="rounded-lg bg-[#405fe7] px-4 py-2 text-sm text-white disabled:opacity-40" disabled={busy || !confirmed || !opinion.trim() || !selected.length} onClick={() => void submit()}>{busy ? "提交中..." : operation === "confirm" ? "确认所选试题" : "同意所选试题"}</button>
        </div>
      </div>
    </div> : null}
  </>;
}
