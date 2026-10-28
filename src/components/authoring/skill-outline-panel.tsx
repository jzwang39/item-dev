"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GeneratedSkillPoint } from "@/modules/blueprints/skill-outline-generation";
import { isSkillGenerationLevel } from "@/modules/blueprints/skill-generation-policy";

const levels = [
  ["level_5", "五级 / 初级工"], ["level_4", "四级 / 中级工"], ["level_3", "三级 / 高级工"], ["level_2", "二级 / 技师"], ["level_1", "一级 / 高级技师"],
];
type Textbook = { sourceId: string; sourceVersionId: string; originalName: string; chapterCount: number; createdAt: string };
type Version = { versionId: string; versionNo: number; levelCode: string; points: GeneratedSkillPoint[]; sourceName?: string };
type Job = { id: string; status: string; totalBatches: number; completedBatches: number; generatedPointCount: number; errorMessage: string | null };
type State = { textbooks: Textbook[]; versions: Version[]; jobs: Job[] };
const primaryButton = "rounded-lg bg-[#3f60e8] px-4 py-3 text-sm text-white disabled:opacity-50";

export function SkillOutlinePanel({ occupationId, occupationName, level, onLevelChange, standardReady, standardError, onGenerated, refreshVersion, onEdit }: {
  occupationId: string; occupationName: string; level: string; onLevelChange: (value: string) => void;
  standardReady: boolean | null; standardError?: string; onGenerated: () => void;
  refreshVersion: number; onEdit: (point: GeneratedSkillPoint) => void;
}) {
  const [mode, setMode] = useState<"textbook" | "model">("textbook");
  const [state, setState] = useState<State>({ textbooks: [], versions: [], jobs: [] });
  const [target, setTarget] = useState(40);
  const [busy, setBusy] = useState<"upload" | "start" | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [direction, setDirection] = useState("");
  const [historyId, setHistoryId] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const previousJob = useRef<string>("");
  const endpoint = `/api/v1/authoring/occupations/${occupationId}/skill-outline-generation`;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(endpoint, { signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message || "教材与生成任务读取失败。");
    setState(body.data);
    return body.data as State;
  }, [endpoint]);
  useEffect(() => {
    const controller = new AbortController();
    setState({ textbooks: [], versions: [], jobs: [] }); setHistoryId(""); setDirection(""); setError(""); previousJob.current = "";
    void refresh(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [refresh, refreshVersion]);
  const running = state.jobs.find((job) => ["queued", "running"].includes(job.status));
  const runningId = running?.id;
  useEffect(() => {
    if (!runningId) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void refresh(controller.signal).then((result) => {
        const job = result.jobs.find((item) => item.id === runningId);
        if (job?.status === "succeeded" && previousJob.current !== job.id) {
          previousJob.current = job.id; setHistoryId(""); onGenerated();
        }
      }).catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    }, 3000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [runningId, refresh, onGenerated]);
  const versions = state.versions.filter((version) => version.levelCode === level);
  const current = versions.find((version) => version.versionId === historyId) ?? versions[0];
  const directions = Array.from(new Set(current?.points.map((point) => point.direction || "通用") ?? []));
  const selectedDirection = directions.includes(direction) ? direction : directions[0] ?? "全部方向";
  const points = current?.points.filter((point) => (point.direction || "通用") === selectedDirection) ?? [];
  const pages = Math.max(1, Math.ceil(points.length / 20));
  const actualPage = Math.min(page, pages);
  const displayed = points.slice((actualPage - 1) * 20, actualPage * 20);
  useEffect(() => { setPage(1); }, [level, selectedDirection, current?.versionId]);

  async function upload(file: File) {
    setBusy("upload"); setError("");
    try {
      const form = new FormData(); form.set("file", file);
      const response = await fetch(endpoint, { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "教材上传失败。");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "教材上传失败。"); }
    finally { setBusy(null); if (input.current) input.current.value = ""; }
  }
  async function start() {
    setBusy("start"); setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate", mode, targetQuestions: target }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "生成任务创建失败。");
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "生成任务创建失败。"); }
    finally { setBusy(null); }
  }
  function ratio(group: GeneratedSkillPoint[]) {
    return ["X", "Y", "Z"].map((importance) => {
      const count = group.filter((point) => (point.importanceCode || (point.importance === "critical" ? "X" : point.importance === "high" ? "Y" : "Z")) === importance).length;
      return `${importance}:${group.length ? Math.round(count / group.length * 100) : 0}%`;
    }).join(" / ");
  }
  return <div className="space-y-5 px-8 py-6 text-sm">
    <p className="text-[#8390a5]">{occupationName} · {selectedDirection} · {levels.find((item) => item[0] === level)?.[1]}</p>
    <div className="flex gap-6 text-[#6f7f96]">{[["textbook", "有教材"], ["model", "无教材"]].map(([value, label]) =>
      <label key={value} className="flex items-center gap-2"><input type="radio" name={`skill-mode-${occupationId}`} value={value} checked={mode === value} disabled={!!busy || !!running} onChange={() => setMode(value as typeof mode)} />{label}</label>,
    )}</div>
    {mode === "textbook" ? <div className="space-y-3">
      <input ref={input} type="file" accept=".pdf,.docx,.txt" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      <button type="button" disabled={!!busy || !!running} className="rounded-lg border border-[#dfe5ef] px-4 py-3 text-[#60708a] disabled:opacity-50" onClick={() => input.current?.click()}>{busy === "upload" ? "解析中..." : "上传教材"}</button>
      <span className="ml-2 text-[#8390a5]">支持 PDF、DOCX、TXT</span>
      {state.textbooks[0] ? <p className="text-[#60708a]">最新教材：{state.textbooks[0].originalName} · {state.textbooks[0].chapterCount} 个章节
        <a className="ml-3 text-[#3f60e8]" target="_blank" rel="noreferrer" href={`/api/v1/authoring/sources/${state.textbooks[0].sourceId}/content?mode=file`}>查看原件</a>
      </p> : null}
      {state.textbooks.length > 1 ? <details className="text-[#60708a]"><summary>历史教材版本</summary>{state.textbooks.slice(1).map((book) => <p key={book.sourceVersionId}><a target="_blank" rel="noreferrer" href={`/api/v1/authoring/sources/${book.sourceId}/content?mode=file`}>{book.originalName} · {new Date(book.createdAt).toLocaleString("zh-CN")}</a></p>)}</details> : null}
    </div> : null}
    <label className="flex items-center gap-3 text-[#60708a]">每等级目标题量
      <input aria-label="每等级目标题量" className="w-20 rounded-lg border p-2" type="number" min={30} max={50} value={target} disabled={!!busy || !!running} onChange={(event) => setTarget(Number(event.target.value))} />
      <span className="text-[#8390a5]">30～50题</span>
    </label>
    <button type="button" className={primaryButton} disabled={!!busy || !!running || !standardReady || !!standardError || (mode === "textbook" && !state.textbooks.length) || !Number.isInteger(target) || target < 30 || target > 50} onClick={() => void start()}>
      {busy === "start" ? "创建任务中..." : running ? "生成中..." : mode === "textbook" ? "生成细目表" : "AI大模型生成"}
    </button>
    <p className="text-xs text-[#8390a5]">仅生成五级、四级、三级的全部适用方向；{mode === "textbook"
      ? "每个教材独立知识点生成1个鉴定点"
      : "每条三级技能要求保留1个鉴定点，每项二级工作内容、一级职业功能各增加1个综合鉴定点"}。每等级题量均匀分配，鉴定点多于题量时部分为0题。</p>
    {standardReady === null && !standardError ? <p role="status" className="text-[#60708a]">正在读取本职业共用的国家职业标准...</p> : null}
    {standardError ? <p role="alert" className="text-red-600">职业标准读取或同步失败，请查看第一步错误信息。已上传的原件无需重复上传。</p> : null}
    {standardReady === false && !standardError ? <p className="text-orange-600">本职业尚无已确认的国家职业标准，可在理论知识或操作技能任一流程上传并确认。</p> : null}
    {running ? <div role="status" className="space-y-2 text-[#60708a]"><p>已完成 {running.completedBatches}/{running.totalBatches} 批，生成 {running.generatedPointCount} 个鉴定点</p><progress className="w-full" max={running.totalBatches || 1} value={running.completedBatches} /></div> : null}
    {state.jobs[0]?.status === "failed" ? <p role="alert" className="text-red-600">最近一次生成失败，未发布任何不完整版本：{state.jobs[0].errorMessage}</p> : null}
    {error ? <p role="alert" className="text-red-600">{error}</p> : null}
    <div className="flex flex-wrap gap-2">{levels.map(([code, label]) => <button type="button" key={code} className={`rounded-lg border px-3 py-2 text-xs ${level === code ? "bg-[#3f60e8] text-white" : "text-[#60708a]"}`} onClick={() => { setHistoryId(""); onLevelChange(code); }}>{label}</button>)}</div>
    {directions.length > 1 ? <div className="flex gap-2">{directions.map((item) => <button type="button" key={item} className={`rounded-lg border px-3 py-2 ${item === selectedDirection ? "bg-[#3f60e8] text-white" : "text-[#60708a]"}`} onClick={() => setDirection(item)}>{item}</button>)}</div> : null}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-semibold text-[#293242]">{occupationName}（{levels.find((item) => item[0] === level)?.[1]}）操作技能考评要素细目表</h3>
      {versions.length ? <select aria-label="细目表版本" className="rounded-lg border p-2 text-[#60708a]" value={current?.versionId ?? ""} onChange={(event) => setHistoryId(event.target.value)}>{versions.map((version, index) => <option key={version.versionId} value={version.versionId}>V{version.versionNo}{index === 0 ? "（最新）" : "（历史）"}</option>)}</select> : null}
    </div>
    <p className="text-xs text-[#8390a5]">职业：{occupationName}　等级：{levels.find((item) => item[0] === level)?.[1]}　鉴定方式：操作技能　版本：{current ? `V${current.versionNo}` : "暂无"}　页码：{actualPage}</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[1300px] border-collapse text-sm text-[#344157]">
      <thead className="bg-[#fafbfe] text-xs text-[#8a98ae]">
        <tr><th colSpan={3} className="p-4 text-left font-medium">考评范围一级</th><th colSpan={4} className="p-4 text-left font-medium">考评范围二级</th><th colSpan={5} className="p-4 text-left font-medium">鉴定点</th></tr>
        <tr>{["代码 / 重要程度比例", "名称", "鉴定比重", "代码 / 重要程度比例", "名称", "鉴定比重", "选考方式", "代码", "名称", "重要程度", "试题量", "操作"].map((label, index) => <th className="p-4 text-left font-medium" key={`${label}-${index}`}>{label}</th>)}</tr>
      </thead>
      <tbody>{displayed.length ? displayed.map((point, index) => {
        const primary = displayed.filter((item) => item.level1Code === point.level1Code);
        const secondary = displayed.filter((item) => item.level1Code === point.level1Code && item.level2Code === point.level2Code);
        const firstPrimary = index === 0 || displayed[index - 1].level1Code !== point.level1Code;
        const firstSecondary = firstPrimary || displayed[index - 1].level2Code !== point.level2Code;
        return <tr key={point.code} className="border-t border-[#e8ecf3]">
          {firstPrimary ? <>
            <td rowSpan={primary.length} className="p-4">{point.level1Code}<p className="mt-1 whitespace-nowrap text-xs text-[#8390a5]">{ratio(points.filter((item) => item.level1Code === point.level1Code))}</p></td>
            <td rowSpan={primary.length} className="p-4">{point.level1Name}</td><td rowSpan={primary.length} className="p-4">{point.level1Weight ?? point.weight}%</td>
          </> : null}
          {firstSecondary ? <>
            <td rowSpan={secondary.length} className="p-4">{point.level2Code}<p className="mt-1 whitespace-nowrap text-xs text-[#8390a5]">{ratio(points.filter((item) => item.level1Code === point.level1Code && item.level2Code === point.level2Code))}</p></td>
            <td rowSpan={secondary.length} className="p-4">{point.level2Name}</td><td rowSpan={secondary.length} className="p-4">{point.level2Weight ?? point.weight}%</td><td rowSpan={secondary.length} className="p-4">{point.selection || "待核对"}</td>
          </> : null}
          <td className="p-4">{String(point.ordinal).padStart(3, "0")}<p className="mt-1 text-xs text-[#8390a5]">{point.level1Code}-{point.level2Code}-{String(point.ordinal).padStart(3, "0")}</p></td>
          <td className="p-4" title={point.sourceKnowledgePoint ? `${point.sourceKnowledgePoint.locator}\n来源条目：${point.sourceKnowledgePoint.name}\n原文：${point.sourceKnowledgePoint.evidence}` : undefined}>{point.name}
            {point.sourceStandardRequirement?.nodeKind === "work_content" ? <p className="mt-1 text-xs text-[#8390a5]">二级工作内容综合</p> : null}
            {point.sourceStandardRequirement?.nodeKind === "occupational_function" ? <p className="mt-1 text-xs text-[#8390a5]">一级职业功能综合</p> : null}
          </td><td className="p-4">{point.importanceCode ?? (point.importance === "critical" ? "X" : point.importance === "high" ? "Y" : "Z")}</td><td className="p-4">{point.targetCount}</td>
          <td className="p-4">{current?.versionId === versions[0]?.versionId ? <button type="button" className="rounded-lg border px-3 py-2 text-xs" disabled={!!running} onClick={() => onEdit(point)}>编辑</button> : "只读"}</td>
        </tr>;
      }) : <tr><td colSpan={12} className="p-6 text-[#8390a5]">{isSkillGenerationLevel(level)
        ? "当前等级、方向尚无细目表，请选择有教材或无教材模式后生成。"
        : "当前等级、方向尚无历史细目表，本次不生成该技能等级。"}</td></tr>}</tbody>
    </table></div>
    <div className="flex items-center justify-between text-[#60708a]"><span>共 {points.length} 个鉴定点 · 目标 {points.reduce((sum, point) => sum + point.targetCount, 0)} 题 · 每页20条</span><div className="flex items-center gap-3"><button type="button" disabled={actualPage <= 1} onClick={() => setPage(actualPage - 1)}>上一页</button><span>{actualPage}/{pages}</span><button type="button" disabled={actualPage >= pages} onClick={() => setPage(actualPage + 1)}>下一页</button></div></div>
  </div>;
}
