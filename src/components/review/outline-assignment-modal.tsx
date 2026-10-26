"use client";

import { useEffect, useState } from "react";

type Point = {
  versionId: string; versionNo: number; occupationName: string; levelCode: string;
  assessmentMode: string; expertId: string | null; status: string;
};
const levels: Record<string, string> = {
  level_5: "五级/初级工", level_4: "四级/中级工", level_3: "三级/高级工", level_2: "二级/技师", level_1: "一级/高级技师",
};

export function OutlineAssignmentModal({ expert, onClose }: Readonly<{
  expert: { id: string; name: string }; onClose: () => void;
}>) {
  const [points, setPoints] = useState<Point[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void fetch("/api/v1/review/outlines", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "细目表加载失败。");
      if (active) setPoints(payload.data ?? []);
    }).catch((error) => { if (active) setNotice(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [expert.id]);
  const versions = [...new Set(points.map((point) => point.versionId))].map((id) => {
    const rows = points.filter((point) => point.versionId === id);
    const assigned = rows.some((point) => point.expertId);
    const approved = rows.some((point) => ["awaiting_confirmation", "confirmed"].includes(point.status));
    return { ...rows[0], count: rows.length, available: !assigned && !approved,
      label: assigned ? "已分配给专家" : approved ? "已审核通过，不可分配" : "未分配" };
  }).filter((version) => `${version.occupationName}${levels[version.levelCode] ?? version.levelCode}`.includes(search.trim()));
  const save = async () => {
    setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/v1/review/outlines", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expertId: expert.id, versionIds: selected }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "分配失败。");
      onClose();
    } catch (error) { setNotice(error instanceof Error ? error.message : "分配失败。"); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 z-[200] grid place-items-center bg-[#263548]/50 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="分配细目表审核">
    <div className="flex max-h-[90vh] w-full max-w-[900px] flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
      <div className="flex items-center justify-between border-b px-6 py-5"><h2 className="text-lg font-semibold">分配细目表审核</h2><button aria-label="关闭分配细目表" disabled={busy} onClick={onClose}>×</button></div>
      <div className="min-h-0 overflow-y-auto p-6">
        <p className="font-medium">{expert.name}</p>
        <p className="mt-2 text-sm text-[#8293a9]">可跨职业、等级多选。已分配或已审核通过的版本不可重复分配；不改变试题分配范围。</p>
        <label className="mt-5 flex items-center gap-3 text-sm">搜索职业或等级<input className="rounded-lg border p-3" placeholder="输入职业名称或技能等级" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        {notice ? <p role="alert" className="mt-3 text-red-600">{notice}</p> : null}
        <table className="mt-4 w-full text-left text-sm"><thead className="bg-[#f7f9fc] text-[#8293a9]"><tr>{["选择", "职业名称 / 版本", "技能等级", "考核方式", "考评点数", "分配状态"].map((label) => <th className="p-3 font-normal" key={label}>{label}</th>)}</tr></thead>
          <tbody>{versions.map((version) => <tr className="border-b" key={version.versionId}>
            <td className="p-3"><input type="checkbox" aria-label={`选择${version.occupationName}V${version.versionNo}${levels[version.levelCode]}`} disabled={busy || !version.available} checked={selected.includes(version.versionId)} onChange={() => setSelected((ids) => ids.includes(version.versionId) ? ids.filter((id) => id !== version.versionId) : [...ids, version.versionId])} /></td>
            <td className="p-3">{version.occupationName} · V{version.versionNo}</td><td className="p-3">{levels[version.levelCode]}</td><td className="p-3">{version.assessmentMode === "theory" ? "理论知识" : "操作技能"}</td><td className="p-3">{version.count}</td><td className="p-3">{version.label}</td>
          </tr>)}{!versions.length ? <tr><td colSpan={6} className="p-8 text-center">{loading ? "加载中..." : "没有匹配的细目表。"}</td></tr> : null}</tbody>
        </table><p className="mt-5 text-sm text-[#8293a9]">已选择 {selected.length} 份</p>
      </div>
      <div className="flex justify-end gap-3 border-t bg-[#fafbfe] px-6 py-5"><button disabled={busy} className="rounded-lg border px-4 py-2" onClick={onClose}>关闭</button><button disabled={busy || !selected.length} className="rounded-lg bg-[#405fe7] px-4 py-2 text-white disabled:opacity-50" onClick={() => void save()}>{busy ? "保存中..." : "保存分配"}</button></div>
    </div>
  </div>;
}
