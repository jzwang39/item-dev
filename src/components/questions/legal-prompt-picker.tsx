"use client";

import React from "react";
import type { LegalConfig } from "@/modules/authoring/legal-contracts";
import { legalTopics } from "@/modules/authoring/legal-topics";
import { hasLegalSourceConfig, legalSourceStatus } from "./legal-config-status";

type Props = {
  topics: LegalConfig[];
  selectedIds: string[];
  previewId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onManage: () => void;
};

export function LegalPromptPicker({ topics, selectedIds, previewId, disabled, onSelect, onManage }: Props) {
  const preview = topics.find((topic) => topic.id === previewId) ?? topics[0];
  const title = (topic: LegalConfig) => topic.documentTitle || legalTopics.find((item) => item.id === topic.id)?.title || topic.id;
  const unverified = topics.filter((topic) => selectedIds.includes(topic.id) && !topic.confirmed);

  return <section className="space-y-4" aria-label="命题提示词选择">
    {preview ? <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <label htmlFor="legal-prompt-preview" className="font-medium text-[#293242]">当前预览：{title(preview)} · v{preview.revision}</label>
        <button className="text-[#4265d4] disabled:opacity-40" disabled={disabled} onClick={onManage} type="button">管理提示词及原文</button>
      </div>
      <textarea id="legal-prompt-preview" aria-label="已保存的命题提示词" readOnly rows={9} value={preview.prompt} className="w-full rounded-lg border border-[#d5e0ef] bg-white px-4 py-3 text-sm leading-7 text-[#30415e]" />
      <details className="text-sm text-[#607694]">
        <summary className="cursor-pointer">原文依据 · {legalSourceStatus(preview)}</summary>
        <div className="mt-2 space-y-2 rounded-lg bg-[#f7f9fd] p-3">
          <p>版本：{preview.documentVersion || "未配置"}　施行日期：{preview.effectiveDate || "未配置"}</p>
          <p className="break-all">权威出处：{preview.sourceUrl || "未配置"}</p>
          <p>允许范围：{legalTopics.find((topic) => topic.id === preview.id)?.scope}</p>
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap">{preview.fullText || "尚未配置正式原文。"}</pre>
        </div>
      </details>
    </div> : null}
    <div className="space-y-2">
      <p className="m-0 text-sm text-[#4265d4]">提示词管理 · {topics.length} 个主题 · 已选 {selectedIds.length} 个（可多选）</p>
      <div className="flex flex-wrap gap-2">
        {topics.map((topic, index) => {
          const selected = selectedIds.includes(topic.id);
          return <button key={topic.id} type="button" disabled={disabled} aria-pressed={selected} onClick={() => onSelect(topic.id)}
            className={`rounded-lg border px-3 py-2 text-left text-sm disabled:opacity-40 ${selected ? "border-[#3f60e8] bg-[#eef2ff] text-[#3f60e8]" : "border-[#d5e0ef] bg-white text-[#4e6484]"}`}>
            {index + 1}. {title(topic)}{selected ? "（已选）" : ""}
          </button>;
        })}
      </div>
    </div>
    {unverified.length ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" role="status">
      {unverified.every(hasLegalSourceConfig)
        ? `所选原文已配置，但尚未确认核验：${unverified.map(title).join("、")}。请在管理中勾选“已核对权威原文、版本及施行状态”并保存。`
        : `所选提示词的正式原文尚未核验：${unverified.map(title).join("、")}。请补全配置并勾选核验确认后保存。`}
      <button className="ml-2 underline disabled:opacity-40" disabled={disabled} onClick={onManage} type="button">前往配置并核验</button>
    </div> : null}
    <p className="m-0 text-sm text-[#607694]">使用所选主题的已保存提示词及原文命题，每主题 2 道（1 单选＋1 判断）；生成后待审核，通过并确认后入库。</p>
  </section>;
}
