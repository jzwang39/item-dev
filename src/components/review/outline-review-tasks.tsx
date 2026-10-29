"use client";

import { useEffect, useState } from "react";

type Point = {
  versionId: string; versionNo: number; occupationName: string; levelCode: string;
  assessmentMode: string; nodeId: string; code: string; name: string; status: string;
  opinion: string | null; expertName: string | null; assignedAt: string | null;
  weight: string | null; importance: string | null; isCurrent: number;
  expertId: string | null;
};
const labels: Record<string, string> = {
  pending: "待审核", returned: "退回修订", awaiting_confirmation: "待管理员确认", confirmed: "已确认",
  level_5: "五级/初级工", level_4: "四级/中级工", level_3: "三级/高级工", level_2: "二级/技师", level_1: "一级/高级技师",
};
const button = "rounded-lg border border-[#d6e0ef] bg-white px-3 py-2 text-sm text-[#47618a] disabled:opacity-40";

export function OutlineReviewTasks({ role }: Readonly<{ role: "admin" | "expert" }>) {
  const [points, setPoints] = useState<Point[]>([]);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Point | null>(null);
  const [opinion, setOpinion] = useState("");
  const [decision, setDecision] = useState("approve");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [experts, setExperts] = useState<Array<{ id: string; name: string }>>([]);
  const [expertId, setExpertId] = useState("");
  const load = async () => {
    try {
      const response = await fetch("/api/v1/review/outlines", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "细目表加载失败。");
      setPoints(data.data ?? []);
    } catch (error) { setNotice(error instanceof Error ? error.message : "加载失败。"); }
  };
  useEffect(() => {
    void load();
    if (role === "admin") void fetch("/api/v1/review/assignments").then((res) => res.json()).then((data) => setExperts(data.data?.experts ?? [])).catch(() => undefined);
  }, [role]);
  const act = async (id: string, action: string, nodeId?: string, comment?: string) => {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/v1/review/outlines", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId: id, nodeId, action, opinion: comment ?? "管理员代审，同意通过。", expertId: expertId || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "操作失败。");
      setNotice(`已处理 ${data.data.changed} 个考评点。`);
      setEditing(null);
      await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败。"); }
    finally { setBusy(false); }
  };
  const exportOutline = async (id: string) => {
    setExportingId(id);
    setNotice("");
    try {
      const response = await fetch(`/api/v1/review/outlines/export?versionId=${encodeURIComponent(id)}`, {
        cache: "no-store", signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message ?? "细目表导出失败。");
      }
      const blob = await response.blob();
      const encoded = response.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''(.+)$/)?.[1];
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = encoded ? decodeURIComponent(encoded) : "评价要素细目表.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setNotice(error instanceof Error && error.name === "TimeoutError" ? "导出超时，请重试。" : error instanceof Error ? error.message : "细目表导出失败。");
    } finally { setExportingId(null); }
  };
  const versions = [...new Set(points.map((point) => point.versionId))].map((id) => {
    const rows = points.filter((point) => point.versionId === id);
    return { ...rows[0], rows, assigned: rows.some((point) => point.expertId) };
  });
  const current = points.filter((point) => point.versionId === versionId);
  const pages = Math.max(1, Math.ceil(current.length / 20));
  const adminLocked = role === "admin" && current.some((point) => point.expertId);
  return (
    <section className="overflow-hidden rounded-[18px] border border-[#e0e6f0] bg-white">
      <div className="border-b border-[#e5e9f0] px-6 py-5 font-semibold text-[#293242]">细目表审核任务</div>
      {notice ? <p role="alert" className="mx-5 rounded-lg bg-[#f2f7ff] p-3 text-[#4265d4]">{notice}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-[#f7f9fc] text-[#8b99ad]"><tr>{["职业名称 / 版本", "技能等级", "考核方式", "考评点数", "审核专家", ...(role === "expert" ? ["分配时间"] : []), "进度", "操作"].map((text) => <th key={text} className="p-4 font-medium">{text}</th>)}</tr></thead>
          <tbody>{versions.map((version) => (
            <tr className="border-t border-[#e6ebf3]" key={version.versionId}>
              <td className="p-4">{version.occupationName}<p className="mt-1 text-[#8293a9]">V{version.versionNo} · {version.isCurrent ? "当前版本" : "历史版本"}</p></td>
              <td className="p-4">{labels[version.levelCode] ?? version.levelCode}</td>
              <td className="p-4">{version.assessmentMode === "theory" ? "理论知识" : "操作技能"}</td>
              <td className="p-4">{version.rows.length}</td>
              <td className="p-4">{[...new Set(version.rows.map((point) => point.expertName ?? "未分配"))].join("、")}</td>
              {role === "expert" ? <td className="p-4">{version.assignedAt ? new Date(version.assignedAt).toLocaleString("zh-CN", { hour12: false }) : "未记录"}</td> : null}
              <td className="p-4">待审核 {version.rows.filter((point) => point.status === "pending").length}<br />待确认 {version.rows.filter((point) => point.status === "awaiting_confirmation").length}<br />已确认 {version.rows.filter((point) => point.status === "confirmed").length}<br />退回 {version.rows.filter((point) => point.status === "returned").length}</td>
              <td className="p-4"><div className="flex flex-wrap gap-2">
                <button className={button} disabled={busy} onClick={() => { setVersionId(version.versionId); setPage(1); }}>{role === "expert" ? version.rows.some((point) => ["pending", "returned"].includes(point.status)) ? "审核" : "查看" : "审核 / 查看"}</button>
                {role === "admin" ? <>
                  <button className={button} disabled={busy || version.assigned || !version.rows.some((point) => ["pending", "returned"].includes(point.status))} onClick={() => { if (window.confirm("按版本批量同意全部未通过考评点，进入待管理员确认？")) void act(version.versionId, "approve"); }}>全部审核通过</button>
                  <button className={button} disabled={busy || !version.rows.some((point) => point.status === "awaiting_confirmation") || version.rows.some((point) => !["awaiting_confirmation", "confirmed"].includes(point.status))} onClick={() => { if (window.confirm("确认本版本全部考评点，允许用于后续出题？")) void act(version.versionId, "confirm"); }}>确认</button>
                  <button className={button} disabled={busy || exportingId !== null || !version.rows.every((point) => point.status === "confirmed")} title={version.rows.every((point) => point.status === "confirmed") ? "导出本版本细目表 Excel" : "全部考评点确认后方可导出"} onClick={() => void exportOutline(version.versionId)}>{exportingId === version.versionId ? "导出中..." : "导出"}</button>
                </> : null}
              </div></td>
            </tr>
          ))}{!versions.length ? <tr><td colSpan={role === "expert" ? 8 : 7} className="p-10 text-center text-[#8293a9]">暂无细目表审核任务。</td></tr> : null}</tbody>
        </table>
      </div>
      {versionId ? (
        <div className="fixed inset-0 z-[190] grid place-items-center bg-[#263548]/55 p-4" role="dialog" aria-modal="true" aria-label="细目表逐考评点审核">
          <div className="flex max-h-[90vh] w-full max-w-[1150px] flex-col rounded-2xl bg-white">
            <div className="flex items-center justify-between border-b p-5"><h2 className="font-semibold">细目表审核 · V{current[0]?.versionNo}</h2><button disabled={busy} className={button} onClick={() => setVersionId(null)}>关闭</button></div>
            <div className="overflow-y-auto p-5">
              {notice ? <p role="alert" className="mb-4 text-[#4265d4]">{notice}</p> : null}
              {role === "admin" ? <div className="mb-5 flex flex-wrap gap-3">
                <select aria-label="细目表审核专家" className={button} value={expertId} onChange={(event) => setExpertId(event.target.value)}><option value="">选择审核专家</option>{experts.map((expert) => <option key={expert.id} value={expert.id}>{expert.name}</option>)}</select>
                <button className={button} disabled={busy || !expertId || adminLocked || current.some((point) => ["awaiting_confirmation", "confirmed"].includes(point.status))} onClick={() => void act(versionId, "assign")}>分配本版本</button>
                <button className={button} disabled={busy || adminLocked || !current.some((point) => ["pending", "returned"].includes(point.status))} onClick={() => { if (window.confirm("代审本版本全部未通过考评点，并进入待管理员确认？")) void act(versionId, "approve"); }}>全部审核通过</button>
                <button className={button} disabled={busy || !current.length || current.some((point) => !["awaiting_confirmation", "confirmed"].includes(point.status))} onClick={() => { if (window.confirm("确认本版本全部考评点，允许用于后续出题？")) void act(versionId, "confirm"); }}>确认全部考评点</button>
              </div> : null}
              <table className="w-full text-left text-sm"><thead className="bg-[#f7f9fc]"><tr>{["考评点代码", "名称", "审核状态", "意见", "操作"].map((text) => <th className="p-3" key={text}>{text}</th>)}</tr></thead>
                <tbody>{current.slice((page - 1) * 20, page * 20).map((point) => <tr key={point.nodeId} className="border-t">
                  <td className="p-3">{point.code}</td><td className="p-3">{point.name}</td><td className="p-3">{labels[point.status]}</td><td className="max-w-[220px] p-3">{point.opinion ?? "未填写"}</td>
                  <td className="p-3"><div className="flex flex-wrap gap-2">
                    <button className={button} disabled={busy || adminLocked || !["pending", "returned"].includes(point.status)} onClick={() => { setEditing(point); setOpinion(point.opinion ?? ""); setDecision("approve"); }}>审核</button>
                    <button className={button} disabled={busy || adminLocked || !["pending", "returned"].includes(point.status)} onClick={() => void act(versionId, "approve", point.nodeId, role === "admin" ? "管理员代审，同意通过。" : "专家审核，同意通过。")}>同意</button>
                    {role === "admin" ? <button className={button} disabled={busy || point.status !== "awaiting_confirmation"} onClick={() => void act(versionId, "confirm", point.nodeId)}>确认</button> : null}
                  </div></td>
                </tr>)}</tbody>
              </table>
              <div className="mt-5 flex justify-end gap-3"><button className={button} disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span className="p-2">第{page}/{pages}页 · 每页20条</span><button className={button} disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button></div>
            </div>
          </div>
        </div>
      ) : null}
      {editing ? <div className="fixed inset-0 z-[210] grid place-items-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="考评点审核意见">
        <div className="w-full max-w-xl rounded-2xl bg-white p-6">
          <h3 className="text-lg font-semibold">{editing.code} · {editing.name}</h3>
          <p className="mt-3 text-sm text-[#8293a9]">权重：{editing.weight ?? "未设置"} · 重要程度：{editing.importance ?? "未设置"}</p>
          <select aria-label="考评点审核结论" className={`${button} mt-5 w-full`} value={decision} onChange={(event) => setDecision(event.target.value)}><option value="approve">同意通过</option><option value="return">退回修订</option></select>
          <textarea aria-label="考评点审核意见" className="mt-4 h-32 w-full rounded-lg border p-3" value={opinion} onChange={(event) => setOpinion(event.target.value)} placeholder="审核意见 / 修订要求" />
          {notice ? <p role="alert" className="text-red-600">{notice}</p> : null}
          <div className="mt-4 flex justify-end gap-3"><button disabled={busy} className={button} onClick={() => setEditing(null)}>取消</button><button className={button} disabled={busy || !opinion.trim()} onClick={() => void act(editing.versionId, decision, editing.nodeId, opinion)}>{busy ? "提交中..." : "提交审核意见"}</button></div>
        </div>
      </div> : null}
    </section>
  );
}
