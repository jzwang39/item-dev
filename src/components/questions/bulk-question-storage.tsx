"use client";

import { useState } from "react";
import { BULK_STORAGE_LIMIT, type StorageCandidate } from "@/modules/authoring/question-storage-policy";

export function BulkQuestionStorage({ selected, loading, onSelection, onSelectAll, onBusy, onCompleted }: Readonly<{
  selected: StorageCandidate[];
  loading: boolean;
  onSelection: (questions: StorageCandidate[]) => void;
  onSelectAll: () => Promise<void>;
  onBusy: (busy: boolean) => void;
  onCompleted: (notice: string) => Promise<void>;
}>) {
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [opinion, setOpinion] = useState("管理员批量终审入库。");
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const button = "rounded-lg border border-[#d5e0ef] px-4 py-2 text-sm text-[#4e6484] disabled:opacity-40";
  const selectAll = async () => {
    setSelecting(true);
    setError("");
    try { await onSelectAll(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "选择待入库试题失败。"); }
    finally { setSelecting(false); }
  };
  const submit = async () => {
    if (busy || !confirmed || !opinion.trim() || !selected.length) return;
    setBusy(true);
    onBusy(true);
    setError("");
    setCompleted(0);
    const storedIds = new Set<string>();
    try {
      for (let offset = 0; offset < selected.length; offset += BULK_STORAGE_LIMIT) {
        const chunk = selected.slice(offset, offset + BULK_STORAGE_LIMIT);
        const response = await fetch("/api/v1/questions", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "bulk_store", confirmed: true, opinion,
            questions: chunk.map((question) => ({ questionId: question.id, versionId: question.versionId })),
          }),
        });
        const body = await response.json() as { data?: { storedCount: number }; error?: { message?: string } };
        if (!response.ok || body.data?.storedCount !== chunk.length) {
          throw new Error(body.error?.message ?? "入库提交失败，请刷新后核对状态。");
        }
        chunk.forEach((question) => storedIds.add(question.id));
        setCompleted(storedIds.size);
      }
      onSelection([]);
      setOpen(false);
      await onCompleted(`已批量终审入库 ${storedIds.size} 道试题。`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "批量入库失败。";
      onSelection(selected.filter((question) => !storedIds.has(question.id)));
      setPage(1);
      setError(`已完成 ${storedIds.size} 道，其余未继续提交。${message}`);
      await onCompleted(`已入库 ${storedIds.size} 道。${message}`);
    } finally {
      setBusy(false);
      onBusy(false);
      setConfirmed(false);
    }
  };
  return <>
    <div className="flex flex-wrap items-center gap-3 border-b border-[#e6ebf3] px-5 py-4">
      <span className="text-sm text-[#607493]">已选 {selected.length} 道</span>
      <button className={button} disabled={loading || busy || selecting} onClick={() => void selectAll()}>{selecting ? "选择中..." : "选择当前检索范围全部可入库试题"}</button>
      <button className={button} disabled={busy || selecting || !selected.length} onClick={() => onSelection([])}>清空选择</button>
      <button className="rounded-lg border border-[#a6dccf] bg-[#edf9f5] px-4 py-2 text-sm text-[#17816a] disabled:opacity-40"
        disabled={loading || busy || selecting || !selected.length}
        onClick={() => { setOpen(true); setPage(1); setError(""); setConfirmed(false); setCompleted(0); }}
      >批量终审入库</button>
      <span className="text-xs text-[#8293a9]">仅已审定且已完成管理员确认的试题可选。</span>
      {!open && error ? <p role="alert" className="m-0 w-full text-sm text-red-600">{error}</p> : null}
    </div>
    {open ? <div className="fixed inset-0 z-[200] grid place-items-center bg-[#263548]/55 p-4" role="dialog" aria-modal="true" aria-labelledby="bulk-storage-title">
      <div className="flex max-h-[92vh] w-full max-w-[720px] flex-col overflow-hidden rounded-2xl bg-white">
        <div className="border-b px-6 py-5"><h2 id="bulk-storage-title" className="m-0 text-xl font-semibold text-[#293242]">批量终审入库 · {selected.length} 道</h2></div>
        <div className="overflow-y-auto p-6">
          <p className="m-0 rounded-lg bg-[#f2f7ff] p-4 text-sm text-[#526b91]">逐题检查当前版本和管理员确认记录，入库后保留审核历史与实际操作者留痕。每批最多 {BULK_STORAGE_LIMIT} 道，异常时停止后续批次。</p>
          <div className="mt-4 space-y-2">
            {selected.slice((page - 1) * 20, page * 20).map((question) => <p key={question.id} className="m-0 rounded-lg border border-[#e0e6f0] p-3 text-sm text-[#30415e]">{question.questionNo}</p>)}
          </div>
          <div className="mt-4 flex items-center justify-end gap-3 text-sm text-[#7185a5]">
            <span>第 {page} / {Math.max(1, Math.ceil(selected.length / 20))} 页</span>
            <button className={button} disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <button className={button} disabled={busy || page >= Math.ceil(selected.length / 20)} onClick={() => setPage(page + 1)}>下一页</button>
          </div>
          <label className="mt-5 block text-sm text-[#30415e]">入库意见
            <textarea className="mt-2 h-24 w-full rounded-lg border border-[#cbdaf0] p-3" maxLength={4000} disabled={busy} value={opinion} onChange={(event) => setOpinion(event.target.value)} />
          </label>
          <label className="mt-4 flex gap-3 text-sm text-[#30415e]"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />我确认所选试题已完成审核及管理员确认，同意终审入库。</label>
          {busy ? <p role="status" className="mt-4 text-sm text-[#17816a]">正在入库：{completed} / {selected.length} 道，请勿关闭或刷新页面。</p> : null}
          {error ? <p role="alert" className="mt-4 text-sm text-red-600">{error}</p> : null}
        </div>
        <div className="flex justify-end gap-3 border-t p-5">
          <button className={button} disabled={busy} onClick={() => setOpen(false)}>取消</button>
          <button className="rounded-lg bg-[#17816a] px-4 py-2 text-sm text-white disabled:opacity-40" disabled={busy || !confirmed || !opinion.trim() || !selected.length} onClick={() => void submit()}>{busy ? "入库中..." : "确认批量入库"}</button>
        </div>
      </div>
    </div> : null}
  </>;
}
