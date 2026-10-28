"use client";

import { useEffect, useRef, useState } from "react";
import { legalTopics } from "@/modules/authoring/legal-topics";
import type { LegalConfig } from "@/modules/authoring/legal-contracts";

type Target = { id: string; occupation_id: string; occupation_name: string; level_code: string; node_code: string; name: string };
type Job = { id: string; status: string; target_count: number; generated_count: number; error_message: string | null };
type State = { config: { revision: number; topics: LegalConfig[] }; targets: Target[]; jobs: Job[] };
const endpoint = "/api/v1/questions/legal-agent";
const buttonBase = "rounded-lg border px-4 py-2.5 text-sm disabled:opacity-40";
const button = `${buttonBase} border-[#d5e0ef] bg-white text-[#4e6484]`;
const primary = `${buttonBase} border-[#3f60e8] bg-[#3f60e8] text-white hover:bg-[#3454d4]`;
const field = "w-full rounded-lg border border-[#d5e0ef] bg-white px-3 py-2 text-sm text-[#293242]";
const levelLabel: Record<string, string> = { level_5: "五级／初级工", level_4: "四级／中级工", level_3: "三级／高级工" };

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? "法律法规命题操作失败。");
  return body.data;
}

export function LegalAgent({ onCompleted }: Readonly<{ onCompleted: () => void }>) {
  const [modal, setModal] = useState<"job" | "prompts" | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [occupation, setOccupation] = useState("");
  const [level, setLevel] = useState("level_4");
  const [nodeId, setNodeId] = useState("");
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [instructions, setInstructions] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [watchId, setWatchId] = useState("");
  const requestLock = useRef(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const close = () => { if (!busy) { setModal(null); opener.current?.focus(); } };

  const open = async (mode: "job" | "prompts", target: HTMLButtonElement) => {
    if (requestLock.current) return;
    opener.current = target;
    setModal(mode); setBusy(true); requestLock.current = true; setError("");
    try {
      const data = await jsonRequest(endpoint) as State;
      setState(data); setJobs(data.jobs); setAcknowledged(false);
      const first = data.targets[0];
      if (!occupation && first) { setOccupation(first.occupation_id); setLevel(first.level_code); setNodeId(first.id); }
      setSelectedTopics(data.config.topics.filter((topic) => topic.confirmed).map((topic) => topic.id));
      const active = data.jobs.find((job) => ["queued", "running"].includes(job.status));
      if (active) setWatchId(active.id);
    } catch (cause) { setError(String((cause as Error).message)); }
    finally { setBusy(false); requestLock.current = false; }
  };
  useEffect(() => {
    if (!modal) return;
    dialog.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { setModal(null); opener.current?.focus(); }
      if (event.key === "Tab") {
        const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary") ?? []).filter((element) => element.getClientRects().length);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [modal, busy]);
  useEffect(() => {
    if (!watchId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await jsonRequest(`${endpoint}?view=jobs`) as { jobs: Job[] };
        if (stopped) return;
        setJobs(data.jobs);
        const job = data.jobs.find((item) => item.id === watchId);
        if (job?.status === "succeeded") {
          setWatchId(""); setNotice(`已生成${job.target_count}道法律法规试题，已加入待审核列表。`); onCompleted(); return;
        }
        if (job?.status === "failed") {
          setWatchId(""); setError(`法规命题失败，未保存任何试题：${job.error_message}`); return;
        }
      } catch (cause) { if (!stopped) setError((cause as Error).message); }
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [watchId, onCompleted]);

  const update = (id: string, changes: Partial<LegalConfig>) => {
    setState((old) => old ? { ...old, config: { ...old.config, topics: old.config.topics.map((topic) =>
      topic.id === id ? { ...topic, ...changes, ...(Object.keys(changes).some((key) => key !== "prompt" && key !== "confirmed") ? { confirmed: false } : {}) } : topic) } } : old);
  };
  const upload = async (id: string, file?: File) => {
    if (!file || requestLock.current) return;
    requestLock.current = true; setBusy(true); setError("");
    try {
      const form = new FormData(); form.set("file", file);
      const data = await jsonRequest(endpoint, { method: "POST", body: form });
      update(id, { fullText: data.text, confirmed: false });
      setNotice(`已提取${file.name}，请核对版本、施行日期和权威出处后保存。`);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); requestLock.current = false; }
  };
  const save = async () => {
    if (!state || requestLock.current) return;
    requestLock.current = true; setBusy(true); setError("");
    try {
      const config = await jsonRequest(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.config) });
      setState({ ...state, config }); setNotice("提示词及原文配置已保存，已生成试题的旧快照保持不变。"); setModal(null); opener.current?.focus();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); requestLock.current = false; }
  };
  const generate = async () => {
    if (!state || !acknowledged || requestLock.current) return;
    requestLock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const job = await jsonRequest(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeId, topicIds: selectedTopics, instructions, revision: state.config.revision }) });
      setWatchId(job.id); setModal(null); opener.current?.focus(); setNotice("后台命题已启动，全部通过原文检查后加入待审核列表。");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); requestLock.current = false; }
  };
  const targets = state?.targets.filter((target) => target.occupation_id === occupation && target.level_code === level) ?? [];
  const active = jobs.find((job) => job.id === watchId);
  const occupations = [...new Map(state?.targets.map((target) => [target.occupation_id, target.occupation_name]) ?? []).entries()];
  return <div className="mt-7">
    <div className="flex flex-wrap items-center gap-3">
      <button className={primary} disabled={busy} onClick={(event) => void open("job", event.currentTarget)} type="button">法律法规智能体命题</button>
      <button className={button} disabled={busy} onClick={(event) => void open("prompts", event.currentTarget)} type="button">提示词管理</button>
      {watchId ? <span className="text-sm text-[#526b91]" role="status">法规命题中：{active?.generated_count ?? 0}／{active?.target_count ?? "?"} 道（核验中，尚未保存）</span> : null}
    </div>
    {notice ? <p className="text-sm text-[#4265d4]" role="status">{notice}</p> : null}
    {!modal && error ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}
    {modal ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#17263e]/40 p-4">
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="legal-dialog-title" className="flex max-h-[90vh] w-full max-w-[940px] flex-col rounded-2xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-[#e1e7f0] px-6 py-5">
          <h2 id="legal-dialog-title" className="m-0 text-lg font-semibold">{modal === "job" ? "法律法规智能体命题" : "法律法规 · 提示词管理"}</h2>
          <button aria-label="关闭弹窗" className={button} disabled={busy} onClick={close} type="button">关闭</button>
        </header>
        <div className="space-y-4 overflow-y-auto px-6 py-5">
          {error ? <p className="text-sm text-red-600" role="alert">{error}</p> : null}
          {busy ? <p className="text-sm text-[#607694]" role="status">处理中...</p> : null}
          {modal === "prompts" ? <>
            <p className="text-sm text-[#7b879a]">按主题编辑提示词并上传或粘贴正式原文。原文配置须经管理员核验；保存后版本化留痕，已生成试题保留原快照。</p>
            {state?.config.topics.map((topic, index) => <details key={topic.id} open={index === 0} className="rounded-xl border border-[#d5e0ef] p-4">
              <summary className="cursor-pointer font-medium">{index + 1}. {legalTopics.find((item) => item.id === topic.id)?.title} <small className="text-[#7b879a]">v{topic.revision} · {topic.confirmed ? "原文已核验" : "待配置原文"}</small></summary>
              <div className="mt-4 space-y-3">
                <label className="block text-sm">提示词<textarea className={`${field} mt-2`} disabled={busy} rows={7} maxLength={12000} value={topic.prompt} onChange={(event) => update(topic.id, { prompt: event.target.value })} /></label>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-sm">正式文件名称<input className={field} disabled={busy} value={topic.documentTitle} onChange={(event) => update(topic.id, { documentTitle: event.target.value })} /></label>
                  <label className="text-sm">版本／标准编号及年份<input className={field} disabled={busy} value={topic.documentVersion} onChange={(event) => update(topic.id, { documentVersion: event.target.value })} /></label>
                  <label className="text-sm">施行日期<input className={field} disabled={busy} type="date" value={topic.effectiveDate} onChange={(event) => update(topic.id, { effectiveDate: event.target.value })} /></label>
                  <label className="text-sm">权威原文链接<input className={field} disabled={busy} type="url" placeholder="https://…gov.cn/…" value={topic.sourceUrl} onChange={(event) => update(topic.id, { sourceUrl: event.target.value })} /></label>
                </div>
                <label className="block text-sm">上传正式原文（PDF／DOCX／TXT）<input className="mt-2 block" disabled={busy} type="file" accept=".pdf,.docx,.txt" onChange={(event) => void upload(topic.id, event.target.files?.[0])} /></label>
                <label className="block text-sm">完整原文<textarea className={`${field} mt-2`} disabled={busy} rows={6} maxLength={300000} value={topic.fullText} onChange={(event) => update(topic.id, { fullText: event.target.value })} placeholder="需包括正式名称、第一章及第二章边界；个人所得税法须包括第1—2条。不要粘贴演示素材或模型生成的原文。" /></label>
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy} checked={topic.confirmed} onChange={(event) => update(topic.id, { confirmed: event.target.checked })} />已核对权威原文、版本及施行状态，确认是现行有效文本。</label>
              </div>
            </details>)}
          </> : <>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm">职业<select className={field} disabled={busy} value={occupation} onChange={(event) => { setOccupation(event.target.value); setNodeId(""); }}>
                <option value="">选择职业</option>{occupations.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select></label>
              <label className="text-sm">技能等级<select className={field} disabled={busy} value={level} onChange={(event) => { setLevel(event.target.value); setNodeId(""); }}>{Object.entries(levelLabel).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
            </div>
            <label className="block text-sm">法律法规考评点<select className={field} disabled={busy} value={nodeId} onChange={(event) => setNodeId(event.target.value)}><option value="">选择考评点</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.node_code} · {target.name}</option>)}</select></label>
            {!targets.length ? <p className="text-sm text-amber-700">该范围暂无法律法规考评点，请先维护并确认细目表。</p> : null}
            <p className="text-sm text-[#607694]">每个已选法规生成2道题（1单选＋1判断），仅依据允许章条。缺少原文、引用不匹配或独立核验失败时不保存；仍须专家人工审定。</p>
            <div className="grid gap-2 md:grid-cols-2">{state?.config.topics.map((topic) => <label key={topic.id} className={`flex gap-2 rounded-lg border p-3 text-sm ${topic.confirmed ? "border-[#d5e0ef]" : "border-[#edf0f6] text-[#9aa4b5]"}`}>
              <input type="checkbox" disabled={busy || !topic.confirmed} checked={selectedTopics.includes(topic.id)} onChange={(event) => setSelectedTopics((old) => event.target.checked ? [...old, topic.id] : old.filter((id) => id !== topic.id))} />
              <span>{legalTopics.find((item) => item.id === topic.id)?.title}{!topic.confirmed ? "（先配置原文）" : ""}</span>
            </label>)}</div>
            <label className="block text-sm">补充命题要求<textarea className={`${field} mt-2`} disabled={busy} rows={4} maxLength={12000} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="补充知识点侧重，不可更改原文范围和每法规2道的规则。" /></label>
            <details className="text-sm"><summary className="cursor-pointer text-[#4265d4]">查看所选法规的提示词与允许范围</summary>{selectedTopics.map((id) => <pre key={id} className="whitespace-pre-wrap rounded-lg bg-[#f7f9fd] p-3 text-sm">{state?.config.topics.find((topic) => topic.id === id)?.prompt}</pre>)}</details>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} />已确认法规与考评点相关，生成结果仍需人工核验。</label>
          </>}
        </div>
        <footer className="flex justify-end gap-3 border-t border-[#e1e7f0] px-6 py-4">
          <button className={button} disabled={busy} onClick={close} type="button">取消</button>
          {modal === "prompts" ? <button className={primary} disabled={busy || !state} onClick={() => void save()} type="button">保存提示词及原文</button>
            : <button className={primary} disabled={busy || Boolean(watchId) || !nodeId || !selectedTopics.length || !acknowledged} onClick={() => void generate()} type="button">开始命题 · {selectedTopics.length * 2}道</button>}
        </footer>
      </div>
    </div> : null}
  </div>;
}
