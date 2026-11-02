"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

type Progress = { groupId: string; target: number; available: number; ready: boolean; versionNo: number | null };
export function CommonPlanProgress({ planId }: { planId: string }) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/api/v1/authoring/plans/${planId}/generate`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? "公共进度加载失败");
        if (!cancelled) { setProgress(body.data.common ?? null); setError(""); }
      } catch (reason) { if (!cancelled) setError(reason instanceof Error ? reason.message : "公共进度加载失败"); }
    }
    setProgress(null);
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [planId]);
  if (error) return <p role="alert" className="text-sm text-amber-700">{error}</p>;
  if (!progress) return null;
  return <div className="mt-4 rounded-xl border bg-white p-4 text-sm">
    <strong>基本要求公共部分：{progress.available}/{progress.target}题已发布可用</strong>
    <p>{progress.ready ? `已关联公共V${progress.versionNo}，不重复生成、不重复审核。` : "等待公共题组补齐并审核发布；本等级其他知识要求可继续生成，整体计划尚未完成。"}</p>
    <Link href={`/workspace/common-questions?groupId=${progress.groupId}`}>进入公共题组查看与统一处理</Link>
  </div>;
}
