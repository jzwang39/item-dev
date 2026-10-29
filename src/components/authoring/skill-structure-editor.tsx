"use client";

import { useState } from "react";
import type { ImportedSkillStandard } from "./skill-standard-upload";
import { applyStructureEdit, type StructureEdit } from "@/modules/blueprints/skill-structures/standard-edit";

type DraftRow = { code: string; name: string; score: number; selection: string; minutes: string; method: string };

export function SkillStructureEditor({ data, occupationId, onSaved }: {
  data: ImportedSkillStandard; occupationId: string; onSaved: (data: ImportedSkillStandard) => void;
}) {
  const [open, setOpen] = useState(false);
  const [scopeKey, setScopeKey] = useState("");
  const [minutes, setMinutes] = useState("");
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const scope = data.scopes.find((item) => item.column.key === scopeKey);
  const load = (key: string) => {
    const selected = data.scopes.find((item) => item.column.key === key);
    if (!selected) return;
    setScopeKey(key);
    setMinutes(selected.totalMinutes === null ? "" : String(selected.totalMinutes));
    setRows(selected.rows.map((row) => ({ ...row,
      selection: row.selection === "required" ? "必考" : row.selection === "optional" ? "选考" : row.selection ?? "",
      minutes: row.minutes === null ? "" : String(row.minutes), method: row.method ?? "" })));
    setError("");
  };
  const update = (index: number, field: "selection" | "minutes" | "method", value: string) =>
    setRows((current) => current.map((row, i) => i === index ? { ...row, [field]: value } : row));
  async function save() {
    if (!scope) return;
    setError("");
    const input = {
      standardVersionId: data.versionId ?? "", structureVersionId: data.structureVersions?.[scope.column.levelCode] ?? "",
      scopeKey, totalMinutes: Number(minutes),
      rows: rows.map((row) => ({ ...row, minutes: Number(row.minutes) })),
    } as StructureEdit;
    if (!minutes || rows.some((row) => !row.selection || !row.minutes || !row.method.trim())) {
      setError("请完整填写总考试时间、选考方式、各范围时间和考核方式。"); return;
    }
    try { applyStructureEdit(scope, input); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "内容结构不完整。"); return; }
    setSaving(true);
    try {
      const response = await fetch(`/api/v1/authoring/occupations/${occupationId}/skill-standard`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      const body = await response.json();
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "保存失败。");
      onSaved(body.data); setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "内容结构保存失败。");
    } finally { setSaving(false); }
  }
  return <>
    <button type="button" className="rounded-lg bg-[#3f60e8] px-5 py-3 text-sm text-white"
      onClick={() => { load(data.scopes[0]?.column.key ?? ""); setOpen(true); }}>维护内容结构</button>
    {open ? <div className="fixed inset-0 z-[100] grid place-items-center bg-[#263548]/50 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby="structure-edit-title"
        className="flex max-h-[90vh] w-full max-w-[1100px] flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b p-6">
          <h2 id="structure-edit-title" className="m-0 text-xl font-semibold">维护操作技能考评内容结构</h2>
          <button type="button" aria-label="关闭内容结构" disabled={saving} onClick={() => setOpen(false)}>×</button>
        </header>
        <fieldset disabled={saving} className="m-0 min-h-0 space-y-5 overflow-auto border-0 p-6">
          <div className="flex flex-wrap items-end gap-5">
            <label className="text-sm">技能等级 / 方向
              <select className="ml-3 rounded-lg border p-3" value={scopeKey} onChange={(event) => load(event.target.value)}>
                {data.scopes.map((item) => <option key={item.column.key} value={item.column.key}>{item.column.label} · {item.column.direction}</option>)}
              </select>
            </label>
            <label className="text-sm">总考试时间（分钟）
              <input className="ml-3 w-28 rounded-lg border p-3" type="number" min={scope?.assessmentRules?.minimumMinutes ?? 1}
                value={minutes} onChange={(event) => setMinutes(event.target.value)} placeholder="待确认" />
            </label>
          </div>
          {scope?.assessmentRules ? <div className="rounded-lg bg-[#f2f6ff] p-4 text-sm leading-7 text-[#55729a]">
            {scope.assessmentRules.timeEvidence ? <p className="m-0">原文时间规定：{scope.assessmentRules.timeEvidence}。这是总时长下限，不是每项时间。</p> : null}
            {scope.assessmentRules.methodEvidence ? <p className="m-0">原文考核方式：{scope.assessmentRules.methodEvidence}。</p> : null}
          </div> : null}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-left text-sm">
              <thead><tr>{["考评范围", "权重（%）", "选考方式", "时间（分钟）", "考核方式"].map((title) => <th className="p-3" key={title}>{title}</th>)}</tr></thead>
              <tbody>{rows.map((row, index) => <tr key={row.code} className="border-t">
                <td className="p-3">{row.name}</td><td className="p-3">{row.score}</td>
                <td className="p-3"><select aria-label={`${row.name}选考方式`} className="rounded border p-2" value={row.selection} onChange={(event) => update(index, "selection", event.target.value)}>
                  <option value="">待确认</option><option value="必考">必考</option><option value="选考">选考</option>
                </select></td>
                <td className="p-3"><input aria-label={`${row.name}时间`} type="number" min={1} className="w-24 rounded border p-2" value={row.minutes} placeholder="待确认" onChange={(event) => update(index, "minutes", event.target.value)} /></td>
                <td className="p-3"><input aria-label={`${row.name}考核方式`} className="w-full rounded border p-2" value={row.method} placeholder="待确认" onChange={(event) => update(index, "method", event.target.value)} /></td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="m-0 text-sm text-[#718098]">各范围时间合计：{rows.reduce((sum, row) => sum + (Number(row.minutes) || 0), 0)} 分钟。保存仅更新当前等级和方向，管理员配置不视为国家标准原文。</p>
        </fieldset>
        <footer className="border-t bg-[#fafbfe] p-6">
          {error ? <p role="alert" className="mt-0 text-sm text-red-600">{error}</p> : null}
          <div className="flex justify-end gap-3">
            <button type="button" disabled={saving} className="rounded-lg border px-5 py-3" onClick={() => setOpen(false)}>取消</button>
            <button type="button" disabled={saving} className="rounded-lg bg-[#3f60e8] px-5 py-3 text-white disabled:opacity-50" onClick={() => void save()}>{saving ? "保存中..." : "保存新版本"}</button>
          </div>
        </footer>
      </section>
    </div> : null}
  </>;
}
