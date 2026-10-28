"use client";

import { useEffect, useRef, useState } from "react";
import { legalTopics } from "@/modules/authoring/legal-topics";
import type { LegalConfig } from "@/modules/authoring/legal-contracts";
import { jsonRequest } from "./legal-agent-request";
import { LegalPromptPicker } from "./legal-prompt-picker";
import { hasLegalSourceConfig, legalSourceStatus } from "./legal-config-status";
import { LegalDialogFooter } from "./legal-dialog-footer";

type Job = { id: string; status: string; target_count: number; generated_count: number; error_message: string | null };
type State = { config: { revision: number; topics: LegalConfig[] }; jobs: Job[] };
const endpoint = "/api/v1/questions/legal-agent";
const buttonBase = "rounded-lg border px-4 py-2.5 text-sm disabled:opacity-40";
const button = `${buttonBase} border-[#d5e0ef] bg-white text-[#4e6484]`;
const primary = `${buttonBase} border-[#3f60e8] bg-[#3f60e8] text-white hover:bg-[#3454d4]`;
const field = "w-full rounded-lg border border-[#d5e0ef] bg-white px-3 py-2 text-sm text-[#293242]";

export function LegalAgent({ onCompleted }: Readonly<{ onCompleted: () => void }>) {
  const [modal, setModal] = useState<"job" | "prompts" | null>(null);
  const [managingFromJob, setManagingFromJob] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [submitting, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const busy = submitting || loading;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [watchId, setWatchId] = useState("");
  const requestLock = useRef(false);
  const loadingRequest = useRef<AbortController | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const close = () => {
    if (submitting) return;
    loadingRequest.current?.abort();
    loadingRequest.current = null;
    setLoading(false); requestLock.current = false;
    setModal(null); opener.current?.focus();
  };
  useEffect(() => () => loadingRequest.current?.abort(), []);

  const open = async (mode: "job" | "prompts", target: HTMLButtonElement) => {
    if (requestLock.current) return;
    const controller = new AbortController();
    loadingRequest.current = controller;
    opener.current = target;
    setModal(mode); setManagingFromJob(false); setState(null); setLoading(true); requestLock.current = true; setError("");
    try {
      const data = await jsonRequest(endpoint, { signal: controller.signal }, 30_000) as State;
      if (loadingRequest.current !== controller) return;
      setState(data); setJobs(data.jobs);
      setSelectedTopics([]); setPreviewId(data.config.topics[0]?.id ?? "");
      const active = data.jobs.find((job) => ["queued", "running"].includes(job.status));
      setWatchId(active?.id ?? "");
    } catch (cause) {
      if (loadingRequest.current === controller) setError(String((cause as Error).message));
    } finally {
      // A cancelled request must not unlock or overwrite a newly opened dialog.
      if (loadingRequest.current === controller) {
        loadingRequest.current = null; setLoading(false); requestLock.current = false;
      }
    }
  };
  useEffect(() => {
    if (!modal) return;
    dialog.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        loadingRequest.current?.abort(); loadingRequest.current = null;
        setLoading(false); requestLock.current = false; setModal(null); opener.current?.focus();
      }
      if (event.key === "Tab") {
        const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary") ?? []).filter((element) => element.getClientRects().length);
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [modal, submitting]);
  useEffect(() => {
    if (!watchId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await jsonRequest(`${endpoint}?view=jobs`, undefined, 30_000) as { jobs: Job[] };
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
      setState({ ...state, config });
      const awaitingConfirmation = config.topics.filter((topic: LegalConfig) => !topic.confirmed && hasLegalSourceConfig(topic));
      setNotice(awaitingConfirmation.length
        ? `配置已保存；${awaitingConfirmation.map((topic: LegalConfig) => topic.documentTitle).join("、")}尚未勾选核验确认，暂不能命题。`
        : "提示词及原文配置已保存，已生成试题的旧快照保持不变。");
      setModal(managingFromJob ? "job" : null);
      if (!managingFromJob) opener.current?.focus();
    } catch (cause) { setError(`保存失败：${(cause as Error).message} 当前修改尚未保存，请修正后重试。`); }
    finally { setBusy(false); requestLock.current = false; }
  };
  const managePrompts = () => {
    if (busy) return;
    setError(""); setManagingFromJob(true); setModal("prompts");
  };
  const generate = async () => {
    if (!state || !selectedTopics.length || requestLock.current) return;
    if (state.config.topics.some((topic) => selectedTopics.includes(topic.id) && !topic.confirmed)) {
      setError("请先在提示词管理中配置并核验所选主题的正式原文。"); return;
    }
    requestLock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const job = await jsonRequest(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicIds: selectedTopics, instructions, revision: state.config.revision }) });
      setWatchId(job.id); setModal(null); opener.current?.focus(); setNotice("后台命题已启动，全部通过原文检查后加入待审核列表。");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); requestLock.current = false; }
  };
  const active = jobs.find((job) => job.id === watchId);
  const hasUnverifiedSelection = state?.config.topics.some((topic) => selectedTopics.includes(topic.id) && !topic.confirmed) ?? false;
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
        <header className="flex shrink-0 items-center justify-between border-b border-[#e1e7f0] px-6 py-5">
          <h2 id="legal-dialog-title" className="m-0 text-lg font-semibold">{modal === "job" ? "法律法规智能体命题" : "法律法规 · 提示词管理"}</h2>
          <button aria-label="关闭弹窗" className={button} disabled={submitting} onClick={close} type="button">关闭</button>
        </header>
        <div className="min-h-0 space-y-4 overflow-y-auto px-6 py-5">
          {error && !state && !busy ? <button className={button} onClick={(event) => void open(modal, opener.current ?? event.currentTarget)} type="button">重新加载</button> : null}
          {busy ? <p className="text-sm text-[#607694]" role="status">{loading ? "加载中..." : "处理中..."}</p> : null}
          {modal === "prompts" ? <>
            <p className="text-sm text-[#7b879a]">按主题编辑提示词并上传或粘贴正式原文。原文配置须经管理员核验；保存后版本化留痕，已生成试题保留原快照。</p>
            {state?.config.topics.map((topic, index) => <details key={topic.id} open={managingFromJob ? topic.id === previewId : index === 0} className="rounded-xl border border-[#d5e0ef] p-4">
              <summary className="cursor-pointer font-medium">{index + 1}. {legalTopics.find((item) => item.id === topic.id)?.title} <small className="text-[#7b879a]">v{topic.revision} · {legalSourceStatus(topic)}</small></summary>
              <div className="mt-4 space-y-3">
                <label className="block text-sm">提示词<textarea className={`${field} mt-2`} disabled={busy} rows={7} maxLength={12000} value={topic.prompt} onChange={(event) => update(topic.id, { prompt: event.target.value })} /></label>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-sm">正式文件名称<input className={field} disabled={busy} value={topic.documentTitle} onChange={(event) => update(topic.id, { documentTitle: event.target.value })} /></label>
                  <label className="text-sm">版本／标准编号及年份<input className={field} disabled={busy} value={topic.documentVersion} onChange={(event) => update(topic.id, { documentVersion: event.target.value })} /></label>
                  <label className="text-sm">施行日期<input className={field} disabled={busy} type="date" value={topic.effectiveDate} onChange={(event) => update(topic.id, { effectiveDate: event.target.value })} /></label>
                  <label className="text-sm">权威原文链接<input className={field} disabled={busy} type="url" placeholder="https://…gov.cn/…" value={topic.sourceUrl} onChange={(event) => update(topic.id, { sourceUrl: event.target.value })} /></label>
                </div>
                {topic.id === "law-1" ? <p className="text-sm text-[#607694]">民法典于2020年5月28日通过，2021年1月1日施行；版本建议填写“2020年通过文本”。</p> : null}
                <label className="block text-sm">上传正式原文（PDF／DOCX／TXT）<input className="mt-2 block" disabled={busy} type="file" accept=".pdf,.docx,.txt" onChange={(event) => void upload(topic.id, event.target.files?.[0])} /></label>
                <label className="block text-sm">完整原文<textarea className={`${field} mt-2`} disabled={busy} rows={6} maxLength={300000} value={topic.fullText} onChange={(event) => update(topic.id, { fullText: event.target.value })} placeholder="需包括正式名称、第一章及第二章边界；个人所得税法须包括第1—2条。不要粘贴演示素材或模型生成的原文。" /></label>
                <label className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${!topic.confirmed && hasLegalSourceConfig(topic) ? "border-amber-200 bg-amber-50 text-amber-800" : "border-[#d5e0ef]"}`}><input type="checkbox" disabled={busy} checked={topic.confirmed} onChange={(event) => update(topic.id, { confirmed: event.target.checked })} />已核对权威原文、版本及施行状态，确认是现行有效文本（勾选并保存后才可命题）。</label>
              </div>
            </details>)}
          </> : <>
            {state ? <LegalPromptPicker topics={state.config.topics} selectedIds={selectedTopics} previewId={previewId} disabled={busy}
              onSelect={(id) => {
                setPreviewId(id);
                setSelectedTopics((old) => old.includes(id) ? old.filter((selected) => selected !== id) : [...old, id]);
              }} onManage={managePrompts} /> : null}
            <details className="text-sm">
              <summary className="cursor-pointer text-[#607694]">补充命题要求（可选）</summary>
              <textarea aria-label="补充命题要求" className={`${field} mt-2`} disabled={busy} rows={3} maxLength={12000} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="补充知识点侧重，不可更改原文范围和每法规2道的规则。" />
            </details>
          </>}
        </div>
        <LegalDialogFooter error={error}>
          <button className={button} disabled={submitting} onClick={close} type="button">取消</button>
          {modal === "prompts" ? <button className={primary} disabled={busy || !state} onClick={() => void save()} type="button">{managingFromJob ? "保存并返回命题" : "保存提示词及原文"}</button>
            : <button className={primary} disabled={busy || !state || Boolean(watchId) || !selectedTopics.length || hasUnverifiedSelection} onClick={() => void generate()} type="button">开始命题 · {selectedTopics.length * 2}道</button>}
        </LegalDialogFooter>
      </div>
    </div> : null}
  </div>;
}
