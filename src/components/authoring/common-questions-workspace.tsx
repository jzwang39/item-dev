"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ExecutionProgress } from "./execution-progress";
import { selectCommonTask } from "./common-task-selection";

type Group = { id: string; occupation_name: string; version_no: number | null; question_count: number; generation_status: string | null };
type Counts = { key: string; single: number; multiple: number; judgement: number };
type Item = { question_id: string; current_version_id: string; question_no: string; current_status: string; stem: string;
  suspended?: number; confirmed?: number; content_json: { options?: Array<{ key: string; content: string }> };
  answer_json: { answers?: string[] }; analysis_text: string };
type GenerationRecord = { id: string; questionNo: string; point: string; questionType: string; stem: string; status: string };
type GenerationError = { id: string; code: string; type?: string; attempts: number; remaining?: number; error: string };
type Detail = { id: string; rowVersion: number; quota: Counts[]; currentReleaseId: string | null; generationPlanId: string | null;
  basis: { points: Array<{ key: string; name: string }>; scopes: Record<string, { occupation: string }> };
  coverage: Array<{ key: string; type: string; count: number; target: number }>;
  releases: Array<{ id: string; version_no: number; published_at: string }>; total: number; questions: Item[];
  generation: { job: {
    status: string; generated: number; target: number; completedBatches: number; totalBatches: number;
    activity?: { recentErrors: Array<{ code: string; attempts: number; error: string }> };
    failedUnits?: GenerationError[];
  } | null } | null };
const api = "/api/v1/authoring/common-questions";
const button = "rounded-lg border border-[#d6dce5] bg-white px-3 py-2 text-sm disabled:opacity-40";
const labels: Record<string, string> = { draft: "草稿", pending_review: "待审核", returned: "退回", approved: "已审定", stored: "已入库", archived: "已归档" };
const jobLabels: Record<string, string> = { queued: "排队中", running: "生成中", partial: "部分失败", succeeded: "已完成", stopped: "已停止，成果保留", cancelled: "已终止" };

export function CommonQuestionsWorkspace() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [occupations, setOccupations] = useState<Array<{ id: string; name: string }>>([]);
  const [occupationId, setOccupationId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [quota, setQuota] = useState<Counts[]>([]);
  const [page, setPage] = useState(1);
  const [candidates, setCandidates] = useState(false);
  const [selection, setSelection] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [configOpen, setConfigOpen] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [records, setRecords] = useState<GenerationRecord[]>([]);
  const [quotaPage, setQuotaPage] = useState(1);
  const loadSequence = useRef(0);

  const read = useCallback(async <T,>(url: string): Promise<T> => {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30000) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message ?? "加载失败");
    return payload.data as T;
  }, []);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const list = await read<Group[]>(api);
    if (sequence !== loadSequence.current) return;
    setGroups(list);
    const selected = selectCommonTask(list, groupId || new URL(window.location.href).searchParams.get("groupId"));
    if (selected !== groupId) {
      setGroupId(selected);
      if (selected) return;
    }
    if (selected) {
      const data = await read<Detail>(`${api}?groupId=${selected}&page=${page}&view=${candidates ? "candidates" : "members"}`);
      if (sequence !== loadSequence.current) return;
      setDetail(data);
      if (!configOpen) setQuota(data.quota.map((point) => ({
        ...point, multiple: 0, judgement: point.multiple > 0 && point.judgement === 0 ? 2 : point.judgement,
      })));
      if (recordsOpen && data.generationPlanId) {
        const result = await read<{ questions: GenerationRecord[] }>(`/api/v1/authoring/plans/${data.generationPlanId}`);
        if (sequence !== loadSequence.current) return;
        setRecords(result.questions);
      }
    }
    setLoading(false);
  }, [read, groupId, page, candidates, configOpen, recordsOpen]);
  useEffect(() => {
    void read<Array<{ id: string; name: string }>>("/api/v1/authoring/occupations").then(setOccupations).catch((error: Error) => setMessage(error.message));
  }, [read]);
  useEffect(() => { void load().catch((error: Error) => { setMessage(error.message); setLoading(false); }); }, [load]);
  useEffect(() => {
    if (!groupId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("groupId", groupId);
    window.history.replaceState(null, "", url);
  }, [groupId]);
  useEffect(() => {
    if (busy) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { await load(); }
      catch (error) { if (!disposed) setMessage(error instanceof Error ? error.message : "加载失败"); }
      if (!disposed) timer = setTimeout(refresh, 5000);
    };
    timer = setTimeout(refresh, 5000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [detail?.generation?.job?.status, load, busy]);
  async function act(body: Record<string, unknown>, confirmation?: string, endpoint = api) {
    if (busy || (confirmation && !window.confirm(confirmation))) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId, ...body }), signal: AbortSignal.timeout(30000) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "操作失败");
      if (body.action === "create") {
        loadSequence.current++;
        setGroupId(payload.data.id); setDetail(null); setLoading(true); setPage(1); setConfigOpen(false);
      }
      setSelection([]);
      setMessage(body.action === "suspend" ? `已统一停用。关联历史试卷${payload.data.affectedPapers?.length ?? 0}套，原试卷内容保留，影响范围已留痕。` : "操作已完成，记录已保留。");
      if (body.action !== "create") await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败，请刷新核对结果。"); }
    finally { setBusy(false); }
  }
  function itemAction(item: Item, action: "reopen" | "suspend") {
    const opinion = window.prompt(action === "reopen" ? "填写统一修订原因，新版发布前仍使用原已发布题：" : "填写统一停用原因，五四三级将同时停止抽取该题：");
    if (!opinion?.trim()) return;
    void act({ action, questionId: item.question_id, versionId: item.current_version_id, opinion, confirmed: true },
      action === "reopen" ? "确认创建待审新版本？修改完成后须重新审核、确认、入库并统一发布。" : "确认统一停用？不更改历史试卷；请在公共题组补齐缺额。");
  }
  const active = ["queued", "running"].includes(detail?.generation?.job?.status ?? "");
  const recentErrors = detail?.generation?.job?.activity?.recentErrors ?? [];
  const failedUnits = detail?.generation?.job?.failedUnits ?? [];
  return <section className="space-y-5">
    <div className="flex items-center justify-between"><h1 className="text-2xl font-semibold">基本要求公共题组</h1><Link href="/workspace/authoring">返回智能命题</Link></div>
    <p className="text-sm text-slate-500">五四三级共用一套题和发布版本，统一审核修改；各等级仍按自己的权重与试卷结构抽题。</p>
    {message && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
      <p className="m-0 whitespace-pre-line">{message}</p>
      {message.includes("细目表尚未全部审核") && <Link className="mt-2 inline-block underline" href="/workspace/review">前往细目表审核任务</Link>}
    </div>}
    <div className="flex flex-wrap gap-3 rounded-xl border bg-white p-4">
      <select aria-label="选择公共题组" className={button} disabled={busy} value={groupId} onChange={(event) => {
        loadSequence.current++;
        setGroupId(event.target.value); setDetail(null); setLoading(true); setPage(1); setQuotaPage(1); setSelection([]); setConfigOpen(false); setMessage("");
      }}><option value="" disabled>选择公共题组</option>{groups.map((group) => <option key={group.id} value={group.id}>
        {group.occupation_name} · {group.generation_status ? jobLabels[group.generation_status] : "未开始"} · {group.version_no ? `V${group.version_no}` : "未发布"} · {group.question_count}题
      </option>)}</select>
      <select aria-label="创建题组的职业" className={button} value={occupationId} onChange={(event) => setOccupationId(event.target.value)}>
        <option value="">选择职业</option>{occupations.map((occupation) => <option key={occupation.id} value={occupation.id}>{occupation.name}</option>)}
      </select>
      <button className={button} disabled={busy || !occupationId} onClick={() => void act({ action: "create", occupationId })}>创建公共题组</button>
    </div>
    {loading && <p role="status" className="text-sm text-slate-500">正在加载公共题组与任务进度...</p>}
    {detail && <div className="space-y-5">
      <div className="rounded-xl border bg-white p-5">
        <h2 className="text-lg font-semibold">{detail.basis.scopes.level_5.occupation} · 公共基本要求</h2>
        <p className="text-sm">当前发布：{detail.currentReleaseId ? `V${detail.releases.find((release) => release.id === detail.currentReleaseId)?.version_no}` : "未发布"}；
          公共配额完成 {detail.coverage.reduce((sum, item) => sum + Math.min(item.count, item.target), 0)} / {detail.quota.reduce((sum, item) => sum + item.single + item.judgement, 0)} 题</p>
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={busy} onClick={() => { setQuota(detail.quota.map((point) => ({
            ...point, multiple: 0, judgement: point.multiple > 0 && point.judgement === 0 ? 2 : point.judgement,
          }))); setConfigOpen(!configOpen); }}>统一配额</button>
          <button className={button} disabled={busy || active} onClick={() => void act({ action: "generate", retry: detail.generation?.job?.status === "partial" })}>{busy ? "处理中..." : "生成 / 补齐公共题"}</button>
          <button className={button} disabled={busy || !detail.generationPlanId || detail.generation?.job?.status === "stopped"} onClick={() => void act({ action: "stop", confirmed: true }, "确认停止公共生成并保留全部成果？不会停止各等级其他知识要求的生成。")}>停止生成，保留成果</button>
          <button className={button} disabled={busy || !detail.generationPlanId} onClick={() => void act({ action: "terminate", confirmed: true }, "确认终止公共任务？只清理本次新生成且未经审核的草稿，选用旧题及已审核、已发布题保留。")}>终止公共任务</button>
          <button className={button} disabled={busy || active} onClick={() => void act({ action: "publish", rowVersion: detail.rowVersion, confirmed: true }, "确认统一发布？所有题目必须已审核、确认入库；五四三级的新组卷统一采用本版，历史试卷不变。")}>统一发布</button>
          <button className={button} disabled={busy || active} onClick={() => void act({ action: "sync_basis", confirmed: true }, "确认核对最新五四三级细目表？仅来源和内容未变时同步对应关系，发生变化将拒绝沿用。")}>核对细目表对应关系</button>
        </div>
        <div className="mt-4 rounded-xl border border-[#d6e3ff] bg-[#f6f8ff] p-4">
          <p className="mb-3 text-sm">公共任务：{detail.generation?.job ? jobLabels[detail.generation.job.status] ?? "待核对" : "未开始"}</p>
          <ExecutionProgress generated={detail.generation?.job?.generated ?? detail.coverage.reduce((sum, item) => sum + Math.min(item.count, item.target), 0)}
            target={detail.generation?.job?.target ?? detail.quota.reduce((sum, item) => sum + item.single + item.judgement, 0)}
            started={Boolean(detail.generation?.job) || detail.total > 0} completedLabel="已有 / 已生成" />
          {detail.generation?.job && <p className="mt-3 text-sm text-slate-500">
            已完成 {detail.generation.job.completedBatches} / {detail.generation.job.totalBatches} 批 · {active ? "每5秒自动更新，离开页面不影响生成" : "任务记录保留"} ·{" "}
            <button className="underline" onClick={() => setRecordsOpen((open) => !open)}>{recordsOpen ? "收起逐题生成记录" : "查看逐题生成记录"}</button>
          </p>}
          {(recentErrors.length > 0 || failedUnits.length > 0) && <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <p className="font-medium">生成异常记录（自动刷新后保留，便于排查）</p>
            {recentErrors.map((error, index) => <p className="mt-2 whitespace-pre-wrap break-words" key={`recent-${error.code}-${index}`}>
              处理中：{error.code} · 已尝试 {error.attempts} 次 · {error.error}
            </p>)}
            {failedUnits.map((error) => <p className="mt-2 whitespace-pre-wrap break-words" key={error.id}>
              未完成：{error.code}{error.type ? ` · ${error.type}` : ""} · 缺 {error.remaining ?? 0} 题 · 已尝试 {error.attempts} 次 · {error.error}
            </p>)}
          </div>}
          {recordsOpen && <div className="mt-3 rounded-lg border bg-white p-3">
            <p className="text-sm font-medium">本公共任务已保存试题：{records.length} 道</p>
            {records.map((record) => <p className="my-2 text-sm" key={record.id}>
              {record.point} · {record.questionType} · {record.questionNo} · {record.status}：{record.stem}
            </p>)}
            {!records.length && <p className="text-sm text-slate-500">暂未保存试题，生成中的请求完成后会自动显示。</p>}
          </div>}
        </div>
        {detail.quota.some((point) => point.multiple > 0) && <p className="mt-3 text-sm text-amber-700">
          当前任务沿用旧的多选配额。公共题现改为单选、判断题；请终止本任务，保存新配额后重新生成。
        </p>}
        {configOpen && <div className="mt-4 overflow-x-auto">
          <p className="text-sm">公共配额独立于等级权重，默认单选4、判断2，可逐点修改。已发布题组的配额只允许扩充。</p>
          <table className="w-full text-sm"><thead><tr><th>考评点</th><th>单选</th><th>判断</th></tr></thead>
            <tbody>{quota.slice((quotaPage - 1) * 20, quotaPage * 20).map((item) => <tr key={item.key} className="border-t">
              <td className="p-2">{detail.basis.points.find((point) => point.key === item.key)?.name}</td>
              {(["single", "judgement"] as const).map((type) => <td key={type} className="p-2"><input className="w-20 rounded border p-2" disabled={busy || active}
                aria-label={`${item.key}-${type}`} type="number" min={0} max={100} value={item[type]} onChange={(event) =>
                  setQuota((current) => current.map((point) => point.key === item.key ? { ...point, [type]: Number(event.target.value) } : point))} /></td>)}
            </tr>)}</tbody></table>
          <div className="mt-3 flex gap-2"><button className={button} disabled={quotaPage === 1} onClick={() => setQuotaPage(quotaPage - 1)}>上一页</button>
            <span>{quotaPage}/{Math.max(1, Math.ceil(quota.length / 20))}页</span><button className={button} disabled={quotaPage * 20 >= quota.length} onClick={() => setQuotaPage(quotaPage + 1)}>下一页</button>
            <button className={button} disabled={busy || active} onClick={() => void act({ action: "configure", quota, rowVersion: detail.rowVersion })}>保存统一配额</button></div>
        </div>}
      </div>
      <div className="rounded-xl border bg-white p-5">
        <div className="flex flex-wrap gap-3">
          <button className={button} onClick={() => { setCandidates(false); setPage(1); setSelection([]); }}>公共试题</button>
          <button className={button} onClick={() => { setCandidates(true); setPage(1); setSelection([]); }}>选择历史基本要求题</button>
          {candidates && <button className={button} disabled={busy || !selection.length || active} onClick={() => void act({ action: "adopt", confirmed: true,
            selections: selection.map((item) => ({ questionId: item.question_id, versionId: item.current_version_id })) }, "确认将所选旧题纳入公共题组？复用原题ID和审核记录，不复制三份；未审核题仍须审核。")}>选用 {selection.length} 题</button>}
          <Link className={button} href="/workspace/review">统一分配与审核</Link><Link className={button} href="/workspace/questions">确认后入库</Link>
        </div>
        <p className="text-sm text-slate-500">{candidates ? "仅列出与冻结细目表对应的历史基本要求题；选用前核对内容及适用性。" : "这里显示正在维护的版本；新版本发布前，组卷仍使用上一发布版。"} 共{detail.total}题，每页20题。</p>
        {detail.questions.map((item) => <article key={item.question_id} className="my-3 rounded-lg border p-4">
          <div className="flex gap-3">{candidates && <input aria-label={`选用${item.question_no}`} type="checkbox" checked={selection.some((row) => row.question_id === item.question_id)}
            onChange={(event) => setSelection((current) => event.target.checked ? [...current, item] : current.filter((row) => row.question_id !== item.question_id))} />}
            <strong>{item.stem}</strong></div>
          <p className="text-xs text-slate-500">{item.question_no} · {labels[item.current_status] ?? item.current_status}{item.suspended ? " · 已统一停用" : ""}</p>
          {item.content_json.options?.map((option) => <p className="text-sm" key={option.key}>{option.key}. {option.content}</p>)}
          <p className="text-sm">答案：{item.answer_json.answers?.join("、")}</p><p className="text-sm">解析：{item.analysis_text}</p>
          {!candidates && <div className="flex gap-2">
            {item.current_status === "draft" && <button disabled={busy} className={button} onClick={() => void act({ questionId: item.question_id }, "确认已人工核查该公共题，可以提交审核？", "/api/v1/questions")}>提交统一审核</button>}
            {["approved", "stored"].includes(item.current_status) && !item.suspended && <button disabled={busy || active} className={button} onClick={() => itemAction(item, "reopen")}>发起统一修订</button>}
            {!item.suspended && <button disabled={busy || active} className={button} onClick={() => itemAction(item, "suspend")}>统一停用</button>}
          </div>}
        </article>)}
        <div className="flex items-center gap-3"><button className={button} disabled={page === 1 || busy} onClick={() => { setPage(page - 1); setSelection([]); }}>上一页</button>
          <span>{page}/{Math.max(1, Math.ceil(detail.total / 20))}页</span><button className={button} disabled={page * 20 >= detail.total || busy} onClick={() => { setPage(page + 1); setSelection([]); }}>下一页</button></div>
      </div>
      <details className="rounded-xl border bg-white p-4"><summary>发布记录</summary>{detail.releases.map((release) =>
        <p key={release.id} className="text-sm">V{release.version_no} · {String(release.published_at)} · {release.id}</p>)}</details>
    </div>}
  </section>;
}
