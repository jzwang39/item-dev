"use client";

import { useEffect, useState } from "react";

type Point = { versionId: string; versionNo: number; occupationName: string; levelCode: string; assessmentMode: string; nodeId: string; status: string; code: string; name: string; opinion: string | null };
type Question = { id: string; versionId: string; questionNo: string; occupationName: string; levelLabel: string; questionType: string; status: string; confirmedAt: string | null; stem: string; content: { options?: { key: string; content: string }[] }; answer: { answers?: string[] }; analysis: string | null; reviewOpinion: string | null };
const levels: Record<string, string> = { level_5: "五级/初级工", level_4: "四级/中级工", level_3: "三级/高级工", level_2: "二级/技师", level_1: "一级/高级技师" };
const button = "rounded-lg border border-[#d6e0ef] px-4 py-2 text-sm disabled:opacity-40";

export function ReviewConfirmations() {
  const [tab, setTab] = useState<"outlines" | "questions">("outlines");
  const [points, setPoints] = useState<Point[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<string | null>(null);
  const load = async () => {
    const responses = await Promise.all([fetch("/api/v1/review/outlines", { cache: "no-store" }), fetch("/api/v1/review/assignments", { cache: "no-store" })]);
    const data = await Promise.all(responses.map((response) => response.json()));
    responses.forEach((response, index) => { if (!response.ok) throw new Error(data[index].error?.message ?? "确认列表加载失败。"); });
    setPoints(data[0].data ?? []);
    setQuestions((data[1].data?.reviewTasks ?? []).filter((question: Question) => ["approved", "stored"].includes(question.status)));
  };
  useEffect(() => { void load().catch((error) => setNotice(error.message)); }, []);
  const act = async (url: string, body: object, message: string) => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "操作失败。");
      await load(); setNotice(message);
    } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败。"); }
    finally { setBusy(false); }
  };
  const versions = [...new Set(points.map((point) => point.versionId))].map((id) => {
    const rows = points.filter((point) => point.versionId === id);
    return { ...rows[0], rows, ready: rows.every((point) => ["awaiting_confirmation", "confirmed"].includes(point.status)), done: rows.every((point) => point.status === "confirmed") };
  }).filter((version) => version.rows.some((point) => ["awaiting_confirmation", "confirmed"].includes(point.status)));
  const count = tab === "outlines" ? versions.length : questions.length;
  return <div className="pt-10">
    <h1 className="text-[30px] font-semibold">审核确定</h1>
    <p className="mt-3 text-[#7b879a]">细目表全部确认后可用于命题；试题确认后再单独执行入库。</p>
    {notice ? <p role="status" className="mt-5 rounded-lg bg-[#edf3ff] p-4">{notice}</p> : null}
    <div className="mt-7 grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
      <nav className="rounded-xl border bg-white p-3">{(["outlines", "questions"] as const).map((value) => <button className={`mb-2 w-full rounded-lg p-4 text-left ${tab === value ? "bg-[#edf3ff] text-[#405fe7]" : ""}`} key={value} onClick={() => { setTab(value); setPage(1); }}>{value === "outlines" ? "细目表信息确认" : "试题信息确认"}</button>)}</nav>
      <section className="overflow-hidden rounded-xl border bg-white">
        <h2 className="border-b p-5 font-semibold">{tab === "outlines" ? "细目表信息确认" : "试题信息确认"}</h2>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-[#f7f9fc] text-[#8293a9]"><tr>{(tab === "outlines" ? ["职业 / 版本", "技能等级", "考核方式", "考评点数", "状态", "操作"] : ["试题编号", "职业", "技能等级", "题型", "状态", "操作"]).map((label) => <th className="p-4 font-normal" key={label}>{label}</th>)}</tr></thead>
          <tbody>{tab === "outlines" ? versions.slice((page - 1) * 20, page * 20).map((version) => <tr className="border-b" key={version.versionId}>
            <td className="p-4">{version.occupationName} · V{version.versionNo}</td><td className="p-4">{levels[version.levelCode]}</td><td className="p-4">{version.assessmentMode === "theory" ? "理论知识" : "操作技能"}</td><td className="p-4">{version.rows.length}</td><td className="p-4">{version.done ? "已确认，可用于命题" : version.ready ? "待管理员确认" : "尚未全部审核通过"}</td>
            <td className="flex gap-2 p-4"><button className={button} onClick={() => setView(version.rows.map((point) => `${point.code} ${point.name}：${point.status === "confirmed" ? "已确认" : point.status === "awaiting_confirmation" ? "待确认" : "未通过"}\n审核意见：${point.opinion ?? "未提交"}`).join("\n\n"))}>查看</button><button className={button} disabled={busy || !version.ready || version.done} onClick={() => { if (window.confirm("确认本版本全部考评点并允许后续命题？")) void act("/api/v1/review/outlines", { versionId: version.versionId, action: "confirm", opinion: "管理员确认细目表，可用于命题。" }, "细目表已全部确认，可用于命题。"); }}>确认</button></td>
          </tr>) : questions.slice((page - 1) * 20, page * 20).map((question) => <tr className="border-b" key={question.id}>
            <td className="p-4">{question.questionNo}</td><td className="p-4">{question.occupationName}</td><td className="p-4">{question.levelLabel}</td><td className="p-4">{question.questionType}</td><td className="p-4">{question.status === "stored" ? "已入库" : question.confirmedAt ? "已确认，待入库" : "待管理员确认"}</td>
            <td className="flex gap-2 p-4"><button className={button} onClick={() => setView([question.stem, ...(question.content?.options ?? []).map((option) => `${option.key}. ${option.content}`), `答案：${question.answer?.answers?.join("、") ?? "未填写"}`, `解析：${question.analysis ?? ""}`, `审核意见：${question.reviewOpinion ?? "未提交"}`].join("\n\n"))}>查看</button><button className={button} disabled={busy || !!question.confirmedAt || question.status === "stored"} onClick={() => { if (window.confirm("确认当前试题审定结果？确认后可执行入库。")) void act("/api/v1/review/questions", { questionId: question.id, versionId: question.versionId, action: "confirm", opinion: "管理员确认试题审定结果。" }, "试题已确认，请执行入库。"); }}>确认</button>{question.confirmedAt && question.status !== "stored" ? <button className={`${button} bg-[#405fe7] text-white`} disabled={busy} onClick={() => { if (window.confirm("将已确认试题正式入库？")) void act("/api/v1/review/questions", { questionId: question.id, versionId: question.versionId, action: "store", opinion: "管理员将已确认试题入库。" }, "试题已入库。"); }}>入库</button> : null}</td>
          </tr>)}{!count ? <tr><td colSpan={6} className="p-10 text-center">暂无审核通过的待确认信息。</td></tr> : null}</tbody>
        </table></div>
        <p className="p-5 text-sm text-[#8293a9]">第 {page}/{Math.max(1, Math.ceil(count / 20))} 页 · 共 {count} 条<button className="ml-4 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><button className="ml-4 disabled:opacity-40" disabled={page >= Math.ceil(count / 20)} onClick={() => setPage(page + 1)}>下一页</button></p>
      </section>
    </div>
    {view !== null ? <div className="fixed inset-0 z-[200] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="查看审核信息"><div className="max-h-[80vh] w-full max-w-3xl overflow-auto rounded-xl bg-white p-6"><h2 className="font-semibold">审核信息</h2><pre className="my-5 whitespace-pre-wrap font-sans text-sm">{view}</pre><button className={button} onClick={() => setView(null)}>关闭</button></div></div> : null}
  </div>;
}
