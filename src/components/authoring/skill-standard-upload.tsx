"use client";

import { useEffect, useState } from "react";
import type { SkillStandardData } from "@/modules/blueprints/skill-standard";

export type ImportedSkillStandard = SkillStandardData & {
  sourceName: string; versionNo: number; versionId?: string; structureVersions?: Record<string, string>;
};
type StandardSource = { id: string; name: string; original_name: string };
const button = "rounded-lg bg-[#3f60e8] px-4 py-3 text-sm font-medium text-white disabled:opacity-50";

export function SkillStandardUpload({ occupationId, onChange, onLoadingChange, onLoadError }: {
  occupationId: string; onChange: (data: ImportedSkillStandard | null) => void;
  onLoadingChange?: (loading: boolean) => void;
  onLoadError?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<StandardSource[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [sourceId, setSourceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<ImportedSkillStandard | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    onLoadingChange?.(true);
    onLoadError?.(""); setError("");
    onChange(null); setSources([]); setOpen(false); setPreview(null); setFile(null); setSourceId("");
    fetch(`/api/v1/authoring/occupations/${occupationId}/skill-standard`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message || "标准加载失败。");
        onChange(body.data.current); setSources(body.data.standards);
      }).catch((cause) => {
        if (!controller.signal.aborted) { setError(cause.message); onLoadError?.(cause.message); }
      })
      .finally(() => { if (!controller.signal.aborted) onLoadingChange?.(false); });
    return () => controller.abort();
  }, [occupationId, onChange, onLoadingChange, onLoadError]);

  async function submit(save: boolean) {
    setBusy(true); setError("");
    try {
      const form = new FormData();
      if (file) form.set("file", file);
      else if (sourceId) form.set("sourceVersionId", sourceId);
      form.set("preview", String(!save));
      const response = await fetch(`/api/v1/authoring/occupations/${occupationId}/skill-standard`, { method: "POST", body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "标准识别失败。");
      if (save) { onChange(body.data); onLoadError?.(""); setOpen(false); }
      else setPreview(body.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "标准识别失败。");
    } finally { setBusy(false); }
  }

  return <>
    <button type="button" className={button} onClick={() => { setOpen(true); setError(""); }}>上传国家职业标准</button>
    {error && !open ? <span role="alert" className="text-sm text-red-600">{error}</span> : null}
    {open ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#25344a]/45 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby="skill-upload-title" className="max-h-[90vh] w-full max-w-[900px] overflow-auto rounded-2xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b p-6">
          <h2 id="skill-upload-title" className="font-semibold">选择文件 · 识别技能要求权重表</h2>
          <button type="button" aria-label="关闭" disabled={busy} onClick={() => setOpen(false)}>×</button>
        </header>
        <div className="space-y-4 p-6 text-sm text-[#344157]">
          <h3 className="font-semibold">直接上传国家职业标准（PDF / DOCX / TXT）</h3>
          <p>识别技能要求权重表及操作技能考评内容结构，支持 30MB 以内文件。</p>
          <input type="file" accept=".pdf,.docx,.txt" disabled={busy} onChange={(event) => {
            setFile(event.target.files?.[0] ?? null); setSourceId(""); setPreview(null);
          }} />
          <h3 className="font-semibold">或者，从资料依据选择标准</h3>
          <label className="flex items-center gap-3">国家职业标准文件
            <select className="rounded-lg border p-2" value={sourceId} disabled={busy || !!file} onChange={(event) => { setSourceId(event.target.value); setPreview(null); }}>
              <option value="">请选择文件</option>
              {sources.map((source) => <option value={source.id} key={source.id}>{source.name} · {source.original_name}</option>)}
            </select>
          </label>
          {file ? <button className="text-[#3f60e8]" disabled={busy} type="button" onClick={() => { setFile(null); setPreview(null); }}>改用资料依据</button> : null}
          {!sources.length ? <p className="text-orange-600">当前职业没有已解析的国家职业标准，可直接上传或前往“资料依据”上传解析。</p> : null}
          <h3 className="font-semibold">第二步 · 识别与核对</h3>
          <p>识别后展示只读结果，确认保存后，同一职业的理论知识和操作技能共用该标准。无法可靠识别的字段显示“待核对”。</p>
          {error ? <p role="alert" className="text-red-600">{error}</p> : null}
          {preview ? <div className="space-y-4">
            <SkillWeightMatrix data={preview} />
            <SkillStructureMatrix data={preview} />
          </div> : null}
        </div>
        <footer className="flex justify-end gap-3 border-t bg-[#fafbfe] p-6">
          <button type="button" disabled={busy} className="rounded-lg border px-4 py-2" onClick={() => setOpen(false)}>取消</button>
          <button type="button" className={button} disabled={busy || (!file && !sourceId)} onClick={() => void submit(!!preview)}>
            {busy ? (preview ? "保存中..." : "提取中...") : preview ? "确认保存" : "识别权重表"}
          </button>
        </footer>
      </section>
    </div> : null}
  </>;
}

export function SkillWeightMatrix({ data }: { data: SkillStandardData }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[1000px] border-collapse text-center text-sm">
    <thead className="bg-[#fafbfe] text-[#8a98ae]">
      <tr><th rowSpan={2} className="p-4">项目分类</th><th rowSpan={2} className="p-4">技能项目 / 职业功能</th>
        {Array.from(new Set(data.columns.map((column) => column.levelCode))).map((level) => <th className="p-4 font-medium" key={level} colSpan={data.columns.filter((column) => column.levelCode === level).length}>{data.columns.find((column) => column.levelCode === level)?.label}（%）</th>)}
      </tr>
      <tr>{data.columns.map((column) => <th key={column.key} className="p-4 font-medium">{column.direction}</th>)}</tr>
    </thead>
    <tbody className="text-[#344157]">{data.items.map((item, index) => <tr key={item.name} className="border-t border-[#e8ecf3]">
      {index === 0 ? <td rowSpan={data.items.length} className="bg-[#f4f7fd] p-4">技能要求</td> : null}
      <td className="p-4 text-left">{item.name}</td>
      {data.columns.map((column) => <td key={column.key} className="p-4">{item.columnWeights[column.key] ?? "—"}</td>)}
    </tr>)}
      <tr className="border-t bg-[#fafbfe]"><td colSpan={2} className="p-4">合计</td>{data.columns.map((column) => <td key={column.key} className="p-4">{data.items.reduce((sum, item) => sum + (item.columnWeights[column.key] ?? 0), 0)}%</td>)}</tr>
    </tbody>
  </table></div>;
}

export function SkillStructureMatrix({ data }: { data: SkillStandardData }) {
  const directions = Array.from(new Set(data.columns.map((column) => column.direction))).filter((direction) => direction !== "通用");
  const [selected, setSelected] = useState("");
  const direction = directions.includes(selected) ? selected : directions[0] ?? "通用";
  const scopes = data.scopes.filter((scope) => scope.column.direction === direction || scope.column.direction === "通用");
  return <div>
    {scopes.some((scope) => scope.assessmentRules?.timeEvidence || scope.assessmentRules?.methodEvidence) ? (
      <div className="bg-[#f2f6ff] px-6 py-3 text-sm leading-7 text-[#55729a]">
        {Array.from(new Set(scopes.flatMap((scope) => [
          scope.assessmentRules?.timeEvidence, scope.assessmentRules?.methodEvidence,
        ]).filter(Boolean))).map((evidence) => <p className="m-0" key={evidence}>原文规定：{evidence}</p>)}
        <p className="m-0">总时长下限不等于各范围考试时间；选考方式与分项时间需管理员确认。</p>
      </div>
    ) : null}
    {directions.length ? <div className="flex gap-2 p-5 text-sm">职业方向：{directions.map((item) => <button type="button" key={item} onClick={() => setSelected(item)} className={`rounded-lg border px-3 py-2 ${item === direction ? "bg-[#3f60e8] text-white" : "bg-white"}`}>{item}</button>)}</div> : null}
    {data.warnings.map((warning) => <p className="bg-[#f2f6ff] px-6 py-3 text-sm text-[#55729a]" key={warning}>{warning}</p>)}
    <div className="overflow-x-auto"><table className="w-full min-w-[1100px] border-collapse text-center text-sm">
      <thead className="bg-[#fafbfe] text-[#8a98ae]"><tr><th className="p-4">技能等级</th><th className="p-4">考评要求</th>{data.items.map((item) => <th className="p-4 font-medium" key={item.name}>{item.name}</th>)}<th className="p-4">合计</th></tr></thead>
      <tbody>{scopes.flatMap((scope) => ["选考方式", "考核权重（%）", "考试时间（min）", "考核方式"].map((label, index) => <tr key={`${scope.column.key}-${index}`} className="border-t border-[#e8ecf3] text-[#344157]">
        {index === 0 ? <td rowSpan={4} className="bg-[#fafbfe] p-4">{scope.column.label}<br />{scope.column.direction}</td> : null}
        <td className="bg-[#fafbfe] p-4 text-[#8a98ae]">{label}</td>
        {data.items.map((item) => {
          const row = scope.rows.find((entry) => entry.name === item.name);
          const value = row ? [row.selection, `${row.score}`, row.minutes, row.method][index] : "—";
          return <td key={item.name} className="p-4">{value === "required" ? "必考" : value === "optional" ? "选考" : value ?? "待核对"}</td>;
        })}
        <td className="p-4">{index === 0 ? `${scope.rows.length}项` : index === 1 ? "100%" : index === 2 ? (scope.totalMinutes === null
          ? scope.assessmentRules?.minimumMinutes ? `不少于${scope.assessmentRules.minimumMinutes}分钟（原文）` : "待核对"
          : `${scope.totalMinutes}分钟（已配置）`) : "—"}</td>
      </tr>))}</tbody>
    </table></div>
  </div>;
}
