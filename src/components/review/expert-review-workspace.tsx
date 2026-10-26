"use client";

import { useEffect, useState } from "react";
import { OutlineReviewTasks } from "./outline-review-tasks";
import { AdminQuestionReview } from "./admin-question-review";
import { ReviewConfirmations } from "./review-confirmations";
import { OutlineAssignmentModal } from "./outline-assignment-modal";

type ReviewTask = {
  questionId: string;
  questionVersionId: string;
  status: string;
  assignmentId: string;
  questionNo: string;
  occupationName: string;
  levelLabel: string;
  assessmentMode: "theory" | "skill";
  questionType: string;
  pointName: string;
  stem: string;
  assignedAt: string;
  content?: {
    options?: {
      key?: string;
      content?: string;
      text?: string;
      isCorrect?: boolean;
    }[];
  };
  answer?: unknown;
  analysis?: string | null;
  code: string;
  level: string;
  type: string;
  point: string;
};

type ApiResponse<T> = {
  data?: T;
  error?: { message?: string };
};

async function readJson<T>(response: Response): Promise<ApiResponse<T>> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return { error: { message: `服务返回异常（HTTP ${response.status}）。` } };
  }
  return response.json() as Promise<ApiResponse<T>>;
}

export function ExpertReviewWorkspace({
  role,
}: Readonly<{ role: "admin" | "expert" }>) {
  if (role === "admin") return <AdminReviewWorkspace />;
  return <ExpertTaskWorkspace />;
}

function ExpertTaskWorkspace() {
  const [taskTab, setTaskTab] = useState<"outlines" | "questions">("outlines");
  const [editing, setEditing] = useState<ReviewTask | null>(null);
  const [page, setPage] = useState(1);
  const [tasks, setTasks] = useState<ReviewTask[]>([]);
  const [selected, setSelected] = useState<ReviewTask | null>(null);
  const [stage, setStage] = useState("initial");
  const [alignmentScore, setAlignmentScore] = useState("pending");
  const [decision, setDecision] = useState("returned");
  const [comment, setComment] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState("");
  const [summary, setSummary] = useState({
    pending: 0,
    returned: 0,
    approved: 0,
  });
  const load = async () => {
    const response = await fetch("/api/v1/expert/reviews");
    const payload = await readJson<{
      tasks: Array<Omit<ReviewTask, "code" | "level" | "type" | "point">>;
      summary: { pending: number; returned: number; approved: number };
    }>(response);
    if (!response.ok) {
      setNotice(payload.error?.message ?? "审定任务加载失败。");
      return;
    }
    setTasks(
      (payload.data?.tasks ?? []).map(
        (task: Omit<ReviewTask, "code" | "level" | "type" | "point">) => ({
          ...task,
          code: task.questionNo,
          level: task.levelLabel,
          type: task.questionType,
          point: task.pointName,
        }),
      ),
    );
    setSummary(payload.data?.summary ?? { pending: 0, returned: 0, approved: 0 });
  };
  useEffect(() => {
    void load();
  }, []);
  const submit = async () => {
    if (!selected || !confirmed || !comment.trim()) return;
    const response = await fetch("/api/v1/expert/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assignmentId: selected.assignmentId,
        stage,
        alignment:
          alignmentScore === "1" || alignmentScore === "2"
            ? "not_aligned"
            : alignmentScore === "3"
              ? "partially_aligned"
              : "aligned",
        alignmentScore,
        decision,
        comment,
        confirmed,
      }),
    });
    const payload = await readJson<Record<string, never>>(response);
    if (!response.ok) {
      setNotice(payload.error?.message ?? "提交审定结果失败。");
      return;
    }
    setTasks(
      tasks.filter((task) => task.assignmentId !== selected.assignmentId),
    );
    setSelected(null);
    setComment("");
    setConfirmed(false);
    setNotice(
      `已登记 ${selected.questionNo} 的${decision === "approved" ? "通过" : "退回修订"}意见，试题状态已更新。`,
    );
    await load();
  };
  return (
    <section>
      <div className="flex gap-8 border-b border-[#e2e6ee]">
        <span className="relative px-1 pb-4 text-[17px] font-medium text-[#3f60e8]">
          审核任务
          <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-[#3f60e8]" />
        </span>
      </div>
      <div className="pt-12">
        <h1 className="m-0 text-[30px] font-semibold text-[#293242]">
          专家审定
        </h1>
        <p className="m-0 mt-3 text-[16px] text-[#7b879a]">
          先审核本人细目表，经管理员确认后，再审核对应试题。
        </p>
        {notice ? (
          <p className="mt-6 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-5 py-4 text-[#4265d4]">
            {notice}
          </p>
        ) : null}
        <p className="mt-10 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-6 py-5 text-[#6687b6]">
          ⓘ
          仅展示分配给本人的任务。试题修订保存后重新审核；审核通过后交由管理员确认。
        </p>
        <div className="mt-8 grid grid-cols-1 overflow-hidden rounded-[18px] border border-[#e0e6f0] bg-white md:grid-cols-4">
          <Metric
            label="等待审定"
            value={summary.pending}
            hint="已分配且待审定"
          />
          <Metric
            label="退回修订"
            value={summary.returned}
            hint="本人已登记退回意见"
          />
          <Metric
            label="已审定"
            value={summary.approved}
            hint="本人已登记通过意见"
          />
          <Metric label="任务专家" value="1" hint="当前登录专家" />
        </div>
        <div className="mt-8 grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
          <nav className="rounded-2xl border border-[#e0e6f0] bg-white p-3" aria-label="专家审核任务类型">
            {(["outlines", "questions"] as const).map((value) => <button key={value} className={`mb-2 w-full rounded-lg p-4 text-left text-sm ${taskTab === value ? "border border-[#d6e3ff] bg-[#edf3ff] font-semibold text-[#405fe7]" : "text-[#607493]"}`} onClick={() => setTaskTab(value)}>{value === "outlines" ? "细目表审核任务" : "试题审核任务"}</button>)}
          </nav>
        {taskTab === "outlines" ? <OutlineReviewTasks role="expert" /> : <section className="overflow-hidden rounded-[20px] border border-[#e0e6f0] bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
            <h2 className="m-0 text-xl font-semibold text-[#293242]">
              试题审核任务
            </h2>
            <span className="rounded-lg bg-[#edf4ff] px-3 py-2 text-sm text-[#557aa9]">
              {tasks.length}道
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[1080px] w-full text-left">
              <thead className="bg-[#f7f9fc] text-[#8b99ad]">
                <tr>
                  {[
                    "试题编号",
                    "职业名称",
                    "技能等级",
                    "考核方式",
                    "题型",
                    "状态",
                    "操作",
                  ].map((label) => (
                    <th className="px-6 py-5 font-medium" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tasks.slice((page - 1) * 20, page * 20).map((task) => (
                  <tr
                    className="border-t border-[#e6ebf3]"
                    key={task.assignmentId}
                  >
                    <td className="px-6 py-5 text-[#6689b6]">
                      {task.questionNo}
                      <p className="m-0 mt-2 text-sm text-[#7185a5]">
                        {task.pointName}
                      </p>
                    </td>
                    <td className="px-6 py-5 text-[#30415e]">
                      {task.occupationName}
                    </td>
                    <td className="px-6 py-5 text-[#30415e]">
                      {task.levelLabel}
                    </td>
                    <td className="px-6 py-5 text-[#30415e]">
                      {task.assessmentMode === "theory"
                        ? "理论知识"
                        : "操作技能"}
                    </td>
                    <td className="px-6 py-5 text-[#30415e]">
                      {task.questionType}
                    </td>
                    <td className="max-w-[360px] px-6 py-5 leading-7 text-[#30415e]">
                      {task.status === "approved" ? "待管理员确认" : task.status === "stored" ? "已确认入库" : task.status === "returned" ? "退回修订" : "待审核"}
                    </td>
                    <td className="px-6 py-5">
                      <button
                        className="rounded-xl bg-[#405fe7] px-4 py-2.5 text-sm font-medium text-white"
                        onClick={() => {
                          setSelected(task);
                          setStage("initial");
                          setAlignmentScore("pending");
                          setDecision("returned");
                          setComment("");
                          setConfirmed(false);
                        }}
                        type="button"
                      >
                        {["pending_review", "returned"].includes(task.status) ? "审核" : "查看"}
                      </button>
                      <button className="ml-2 rounded-xl border border-[#d6e0ef] px-4 py-2.5 text-sm disabled:opacity-40" disabled={!["pending_review", "returned"].includes(task.status)} onClick={() => setEditing(task)}>编辑修订</button>
                    </td>
                  </tr>
                ))}
                {!tasks.length ? (
                  <tr>
                    <td
                      className="px-6 py-14 text-center text-[#7185a5]"
                      colSpan={7}
                    >
                      当前没有待审定试题。
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <p className="p-5 text-sm text-[#8293a9]">第 {page}/{Math.max(1, Math.ceil(tasks.length / 20))} 页 · 共 {tasks.length} 道
            <button className="ml-4 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <button className="ml-4 disabled:opacity-40" disabled={page >= Math.ceil(tasks.length / 20)} onClick={() => setPage(page + 1)}>下一页</button>
          </p>
        </section>}
        </div>
      </div>
      {selected ? (
        <ReviewModal
          comment={comment}
          confirmed={confirmed}
          decision={decision}
          alignmentScore={alignmentScore}
          stage={stage}
          onClose={() => setSelected(null)}
          onComment={setComment}
          onConfirm={setConfirmed}
          onDecision={setDecision}
          onAlignmentScore={setAlignmentScore}
          onStage={setStage}
          onSubmit={() => void submit()}
          task={selected}
        />
      ) : null}
      {editing ? <AdminQuestionReview role="expert" task={{ ...editing, id: editing.questionId, versionId: editing.questionVersionId }} onClose={() => setEditing(null)} onSaved={() => { setNotice("修订已保存为新版本，请重新审核，通过后交管理员确认。"); void load(); }} /> : null}
    </section>
  );
}

type AssignableQuestion = {
  id: string;
  questionNo: string;
  occupationName: string;
  levelLabel: string;
  assessmentMode: "theory" | "skill";
  questionType: string;
  stem: string;
  assignedExpertName: string | null;
};

type ReviewExpert = {
  id: string;
  name: string;
  username: string;
  contact: string;
};

type AdminReviewTask = Omit<AssignableQuestion, "assignedExpertName"> & {
  expertName: string;
  assignmentId: string;
  assignedAt: string;
  content?: ReviewTask["content"];
  answer?: unknown;
  analysis?: string | null;
  versionId: string;
  status: string;
  canAdminReview: boolean;
};

function AdminReviewWorkspace() {
  const [tab, setTab] = useState<"tasks" | "assign" | "confirm">("tasks");
  const [taskTab, setTaskTab] = useState<"outlines" | "questions">("outlines");
  const [editing, setEditing] = useState<AdminReviewTask | null>(null);
  const [page, setPage] = useState(1);
  const [tasks, setTasks] = useState<AdminReviewTask[]>([]);
  const [summary, setSummary] = useState({
    pending: 0,
    returned: 0,
    approved: 0,
    expertCount: 0,
  });
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<AdminReviewTask | null>(null);

  const load = async () => {
    const response = await fetch("/api/v1/review/assignments");
    const payload = await readJson<{
      reviewTasks?: AdminReviewTask[];
      summary?: { pending: number; returned: number; approved: number; expertCount: number };
    }>(response);
    if (!response.ok) {
      setNotice(payload.error?.message ?? "审核任务加载失败。");
      return;
    }
    setTasks(payload.data?.reviewTasks ?? []);
    setSummary(
      payload.data?.summary ?? {
        pending: 0,
        returned: 0,
        approved: 0,
        expertCount: 0,
      },
    );
  };
  useEffect(() => {
    void load();
  }, []);
  return (
    <section>
      <div className="flex gap-8 border-b border-[#e2e6ee]">
        <button
          className={`relative px-1 pb-4 text-[17px] ${tab === "tasks" ? "font-medium text-[#3f60e8]" : "text-[#7b879a]"}`}
          onClick={() => setTab("tasks")}
          type="button"
        >
          审核任务
          {tab === "tasks" ? (
            <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-[#3f60e8]" />
          ) : null}
        </button>
        <button
          className={`relative px-1 pb-4 text-[17px] ${tab === "assign" ? "font-medium text-[#3f60e8]" : "text-[#7b879a]"}`}
          onClick={() => setTab("assign")}
          type="button"
        >
          分配任务
          {tab === "assign" ? (
            <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-[#3f60e8]" />
          ) : null}
        </button>
        <button className={`relative px-1 pb-4 text-[17px] ${tab === "confirm" ? "font-medium text-[#3f60e8]" : "text-[#7b879a]"}`} onClick={() => setTab("confirm")} type="button">
          审核确定
          {tab === "confirm" ? <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-[#3f60e8]" /> : null}
        </button>
      </div>
      {tab === "tasks" ? (
        <div className="pt-12">
          <h1 className="m-0 text-[30px] font-semibold text-[#293242]">
            专家审定
          </h1>
          <p className="m-0 mt-3 text-[16px] text-[#7b879a]">
            先审核细目表并由管理员确认，再进行试题编制及审定。
          </p>
          {notice ? (
            <p className="mt-6 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-5 py-4 text-[#4265d4]">
              {notice}
            </p>
          ) : null}
          <div className="mt-8 grid grid-cols-1 overflow-hidden rounded-[18px] border border-[#e0e6f0] bg-white md:grid-cols-4">
            <Metric
              label="等待审定"
              value={summary.pending}
              hint="已分配且待审定"
            />
            <Metric
              label="退回修订"
              value={summary.returned}
              hint="已登记退回意见"
            />
            <Metric
              label="已审定"
              value={summary.approved}
              hint="已登记通过意见"
            />
            <Metric
              label="任务专家"
              value={summary.expertCount}
              hint="当前分配范围内专家"
            />
          </div>
          <div className="mt-8 grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
            <nav className="rounded-2xl border border-[#e0e6f0] bg-white p-3" aria-label="审核任务类型">
              {(["outlines", "questions"] as const).map((value) => <button key={value} className={`mb-2 w-full rounded-lg p-4 text-left text-sm ${taskTab === value ? "border border-[#d6e3ff] bg-[#edf3ff] font-semibold text-[#405fe7]" : "text-[#607493]"}`} onClick={() => setTaskTab(value)}>{value === "outlines" ? "细目表审核任务" : "试题审核任务"}</button>)}
            </nav>
            {taskTab === "outlines" ? <OutlineReviewTasks role="admin" /> : <section className="overflow-hidden rounded-[20px] border border-[#e0e6f0] bg-white shadow-card">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
              <h2 className="m-0 text-xl font-semibold text-[#293242]">
                试题审核任务
              </h2>
              <span className="rounded-lg bg-[#edf4ff] px-3 py-2 text-sm text-[#557aa9]">
                {tasks.length}道
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[1080px] w-full text-left">
                <thead className="bg-[#f7f9fc] text-[#8b99ad]">
                  <tr>
                    {[
                      "试题编号",
                      "职业名称",
                      "技能等级",
                      "考核方式",
                      "题型",
                      "审定状态",
                      "操作",
                    ].map((label) => (
                      <th className="px-6 py-5 font-medium" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tasks.slice((page - 1) * 20, page * 20).map((task) => (
                    <tr className="border-t border-[#e6ebf3]" key={task.id}>
                      <td className="px-6 py-5 text-[#6689b6]">
                        {task.questionNo}
                      </td>
                      <td className="px-6 py-5 text-[#30415e]">
                        {task.occupationName}
                      </td>
                      <td className="px-6 py-5 text-[#30415e]">
                        {task.levelLabel}
                      </td>
                      <td className="px-6 py-5 text-[#30415e]">
                        {task.assessmentMode === "theory"
                          ? "理论知识"
                          : "操作技能"}
                      </td>
                      <td className="px-6 py-5 text-[#30415e]">
                        {task.questionType}
                      </td>
                      <td className="px-6 py-5">
                        <span className="rounded bg-[#fff4df] px-2.5 py-1.5 text-sm text-[#a96f13]">
                          {task.status === "approved" ? "待管理员确认" : task.status === "returned" ? "退回修订" : task.status === "stored" ? "已确认入库" : "待审定"}
                        </span>
                      </td>
                      <td className="px-6 py-5">
                        <div className="flex flex-wrap gap-2"><button
                          className="rounded-xl bg-[#405fe7] px-4 py-2.5 text-sm font-medium text-white"
                          onClick={() => setSelected(task)}
                          type="button"
                        >
                          审核
                        </button>
                        <button className="rounded-xl border border-[#d6e0ef] px-4 py-2.5 text-sm disabled:opacity-40" title={!task.canAdminReview ? "已分配给专家，管理员不能审核" : ""} disabled={!task.canAdminReview || !["pending_review", "returned"].includes(task.status)} onClick={() => setEditing(task)}>编辑修订</button>
                        {task.status === "approved" ? <button className="rounded-xl border border-[#d6e0ef] px-4 py-2.5 text-sm" onClick={() => setTab("confirm")}>前往审核确定</button> : null}</div>
                      </td>
                    </tr>
                  ))}
                  {!tasks.length ? (
                    <tr>
                      <td
                        className="px-6 py-14 text-center text-[#7185a5]"
                        colSpan={7}
                      >
                        当前没有已分配的试题审核任务。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <p className="m-0 px-7 py-5 text-sm text-[#8293a9]">
              第 {page} / {Math.max(1, Math.ceil(tasks.length / 20))} 页 · 共 {tasks.length} 道
              <button className="ml-4 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
              <button className="ml-4 disabled:opacity-40" disabled={page >= Math.ceil(tasks.length / 20)} onClick={() => setPage(page + 1)}>下一页</button>
            </p>
          </section>}
          </div>
        </div>
      ) : (
        tab === "assign" ? <AssignmentContent /> : <ReviewConfirmations />
      )}
      {selected ? (
        <AdminReviewPreviewModal
          onClose={() => setSelected(null)}
          task={selected}
        />
      ) : null}
      {editing ? <AdminQuestionReview task={editing} onClose={() => setEditing(null)} onSaved={() => { setNotice("管理员代审已提交，通过后请确认入库。"); void load(); }} /> : null}
    </section>
  );
}

function AssignmentContent() {
  const [outlineExpert, setOutlineExpert] = useState<ReviewExpert | null>(null);
  const [experts, setExperts] = useState<ReviewExpert[]>([]);
  const [questions, setQuestions] = useState<AssignableQuestion[]>([]);
  const [expertId, setExpertId] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [occupation, setOccupation] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const response = await fetch("/api/v1/review/assignments");
    const payload = await readJson<{
      experts: ReviewExpert[];
      questions: AssignableQuestion[];
    }>(response);
    if (!response.ok) {
      setNotice(payload.error?.message ?? "待分配任务加载失败。");
      return;
    }
    setExperts(payload.data?.experts ?? []);
    setQuestions(payload.data?.questions ?? []);
  };
  useEffect(() => {
    void load();
  }, []);

  const available = questions.filter(
    (question) =>
      !question.assignedExpertName &&
      (!occupation || question.occupationName === occupation),
  );
  const occupations = [
    ...new Set(questions.map((question) => question.occupationName)),
  ];
  const toggle = (questionId: string) =>
    setSelectedIds((current) =>
      current.includes(questionId)
        ? current.filter((id) => id !== questionId)
        : [...current, questionId],
    );
  const toggleAll = () =>
    setSelectedIds((current) =>
      current.length === available.length
        ? []
        : available.map((question) => question.id),
    );
  const submit = async () => {
    if (!expertId || !selectedIds.length || saving) return;
    setSaving(true);
    const response = await fetch("/api/v1/review/assignments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expertId, questionIds: selectedIds }),
    });
    const payload = await readJson<{ assigned: number }>(response);
    setSaving(false);
    if (!response.ok) {
      setNotice(payload.error?.message ?? "审核任务分配失败。");
      return;
    }
    setNotice(`已向所选专家分配 ${payload.data?.assigned ?? 0} 道审核任务。`);
    setSelectedIds([]);
    await load();
  };

  return (
    <div className="pt-12">
      <div className="flex items-start justify-between gap-5">
        <div>
          <h1 className="m-0 text-[30px] font-semibold text-[#293242]">
            分配任务
          </h1>
          <p className="m-0 mt-3 text-[16px] text-[#7b879a]">
            按职业名称、考核方式、技能等级和试题，为审核专家批量分配任务。
          </p>
        </div>
        <button
          className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-[#4e6484]"
          onClick={() => void load()}
          type="button"
        >
          刷新列表
        </button>
      </div>
      {notice ? (
        <p className="mt-6 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-5 py-4 text-[#4265d4]">
          {notice}
        </p>
      ) : null}
      <section className="mt-12 overflow-hidden rounded-[18px] border border-[#e0e6f0] bg-white">
        <table className="w-full text-left">
          <thead className="bg-[#f7f9fc] text-[#8b99ad]">
            <tr>
              {["专家名称", "账号", "所属单位", "联系方式", "操作"].map(
                (label) => (
                  <th className="px-6 py-5 font-medium" key={label}>
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {experts.map((expert) => (
              <tr className="border-t border-[#e6ebf3]" key={expert.id}>
                <td className="px-6 py-6 text-[#30415e]">{expert.name}</td>
                <td className="px-6 py-6 text-[#30415e]">{expert.username}</td>
                <td className="px-6 py-6 text-[#30415e]">当前项目专家</td>
                <td className="px-6 py-6 text-[#30415e]">{expert.contact}</td>
                <td className="px-6 py-6">
                  <button
                    className="rounded-xl bg-[#405fe7] px-4 py-2.5 text-sm font-medium text-white"
                    onClick={() => setExpertId(expert.id)}
                    type="button"
                  >
                    {expertId === expert.id ? "已选择试题" : "分配试题"}
                  </button>
                  <button className="ml-3 rounded-xl border border-[#d5e0ef] bg-white px-4 py-2.5 text-sm text-[#4e6484]" onClick={() => setOutlineExpert(expert)}>分配细目表</button>
                </td>
              </tr>
            ))}
            {!experts.length ? (
              <tr>
                <td
                  className="px-6 py-12 text-center text-[#7185a5]"
                  colSpan={5}
                >
                  暂无可用专家，请先在账号管理中创建专家账号。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <p className="m-0 px-7 py-5 text-sm text-[#8293a9]">
          共 {experts.length} 位专家
        </p>
      </section>
      {outlineExpert ? <OutlineAssignmentModal expert={outlineExpert} onClose={() => setOutlineExpert(null)} /> : null}
      {expertId ? (
        <section className="mt-8 rounded-[18px] border border-[#e0e6f0] bg-white p-7">
          <div className="grid gap-5 md:grid-cols-[1fr_auto]">
            <label className="text-[#6680a5]">
              职业名称
              <select
                className="mt-2 h-12 w-full rounded-xl border border-[#cbdaf0] bg-white px-4 text-[#385578]"
                onChange={(event) => {
                  setOccupation(event.target.value);
                  setSelectedIds([]);
                }}
                value={occupation}
              >
                <option value="">全部职业</option>
                {occupations.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="mb-0 mt-6 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-5 py-4 text-[#6687b6]">
            仅“待审定”且尚未分配的试题可创建任务。已分配试题会锁定，不能重复新增。
          </p>
        </section>
      ) : null}
      {expertId ? (
        <section className="mt-8 overflow-hidden rounded-[20px] border border-[#e0e6f0] bg-white shadow-card">
          <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
            <div>
              <h2 className="m-0 text-xl font-semibold text-[#293242]">
                待分配试题
              </h2>
              <p className="m-0 mt-2 text-sm text-[#7185a5]">
                已选 {selectedIds.length} 道，可分配 {available.length} 道
              </p>
            </div>
            <button
              className="rounded-xl bg-[#405fe7] px-5 py-3 text-white disabled:bg-[#9aaaf0]"
              disabled={!expertId || !selectedIds.length || saving}
              onClick={() => void submit()}
              type="button"
            >
              {saving ? "保存中..." : `保存分配（${selectedIds.length}）`}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[1040px] w-full text-left">
              <thead className="bg-[#f7f9fc] text-[#8b99ad]">
                <tr>
                  <th className="px-6 py-5">
                    <input
                      checked={
                        available.length > 0 &&
                        selectedIds.length === available.length
                      }
                      onChange={toggleAll}
                      type="checkbox"
                    />
                  </th>
                  {[
                    "试题编号",
                    "职业名称",
                    "技能等级",
                    "考核方式",
                    "题型",
                    "试题内容",
                    "状态",
                  ].map((label) => (
                    <th className="px-6 py-5 font-medium" key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {questions
                  .filter(
                    (question) =>
                      !occupation || question.occupationName === occupation,
                  )
                  .map((question) => {
                    const assignable = !question.assignedExpertName;
                    return (
                      <tr
                        className="border-t border-[#e6ebf3]"
                        key={question.id}
                      >
                        <td className="px-6 py-5">
                          <input
                            checked={selectedIds.includes(question.id)}
                            disabled={!assignable}
                            onChange={() => toggle(question.id)}
                            type="checkbox"
                          />
                        </td>
                        <td className="px-6 py-5 text-[#6689b6]">
                          {question.questionNo}
                        </td>
                        <td className="px-6 py-5 text-[#30415e]">
                          {question.occupationName}
                        </td>
                        <td className="px-6 py-5 text-[#30415e]">
                          {question.levelLabel}
                        </td>
                        <td className="px-6 py-5 text-[#30415e]">
                          {question.assessmentMode === "theory"
                            ? "理论知识"
                            : "操作技能"}
                        </td>
                        <td className="px-6 py-5 text-[#30415e]">
                          {question.questionType}
                        </td>
                        <td className="max-w-[330px] px-6 py-5 text-[#30415e]">
                          {question.stem}
                        </td>
                        <td className="px-6 py-5 text-sm">
                          {assignable ? (
                            <span className="rounded bg-[#eaf8f2] px-2 py-1 text-[#358b70]">
                              未分配
                            </span>
                          ) : (
                            <span className="rounded bg-[#f3f6fb] px-2 py-1 text-[#7185a5]">
                              已分配给 {question.assignedExpertName}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                {!questions.length ? (
                  <tr>
                    <td
                      className="px-6 py-14 text-center text-[#7185a5]"
                      colSpan={8}
                    >
                      暂无待审定试题。
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function AssignmentPanel({ onOpen }: Readonly<{ onOpen: () => void }>) {
  return (
    <div className="pt-12">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="m-0 text-[30px] font-semibold text-[#293242]">
            分配任务
          </h1>
          <p className="m-0 mt-3 text-[16px] text-[#7b879a]">
            按职业名称、考核方式、技能等级和试题，为审核专家批量分配任务。
          </p>
        </div>
        <button
          className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-[#4e6484]"
          type="button"
        >
          刷新列表
        </button>
      </div>
      <section className="mt-12 overflow-hidden rounded-[18px] border border-[#e0e6f0] bg-white">
        <table className="w-full text-left">
          <thead className="bg-[#f7f9fc] text-[#8b99ad]">
            <tr>
              {["专家名称", "性别", "所属单位", "联系方式", "操作"].map(
                (label) => (
                  <th className="px-6 py-5 font-medium" key={label}>
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-6 py-6 text-[#30415e]">李主任</td>
              <td className="px-6 py-6 text-[#30415e]">男</td>
              <td className="px-6 py-6 text-[#30415e]">
                现代职业教育研究院（体验）
              </td>
              <td className="px-6 py-6 text-[#30415e]">体验账号</td>
              <td className="px-6 py-6">
                <button
                  className="rounded-xl bg-[#405fe7] px-4 py-2.5 text-sm font-medium text-white"
                  onClick={onOpen}
                  type="button"
                >
                  分配
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="m-0 px-7 py-5 text-sm text-[#8293a9]">共 1 位专家</p>
      </section>
    </div>
  );
}

export function AssignmentModal({
  onClose,
  onSave,
}: Readonly<{ onClose: () => void; onSave: () => void }>) {
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) =>
    setSelected(
      selected.includes(id)
        ? selected.filter((item) => item !== id)
        : [...selected, id],
    );
  const available = [
    {
      id: "q1",
      text: "实施职业质量责任时，符合本任务要求的做法是（）。",
      meta: "四级 / 中级工 · B 单项选择题 · Q4-0001",
    },
    {
      id: "q2",
      text: "作业完成后应依据任务要求检查结果，并如实记录发现的问题。",
      meta: "四级 / 中级工 · C 判断题 · Q4-0017",
    },
  ];
  return (
    <div
      aria-labelledby="assignment-title"
      aria-modal="true"
      className="fixed inset-0 z-[210] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
      role="dialog"
    >
      <div className="flex max-h-[94vh] w-full max-w-[1620px] flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
          <h2
            className="m-0 text-[26px] font-semibold text-[#293242]"
            id="assignment-title"
          >
            分配审核任务
          </h2>
          <button
            className="text-3xl text-[#6f8099]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-9">
          <h3 className="m-0 text-xl text-[#30415e]">
            李主任{" "}
            <span className="ml-3 text-base font-normal text-[#7185a5]">
              现代职业教育研究院（体验）
            </span>
          </h3>
          <section className="mt-6 rounded-xl border border-[#d5e4fc] bg-[#f1f6ff] p-5 text-[#5276a8]">
            <strong>仅未分配且待审定的试题可新增分配</strong>
            <p className="mb-0 mt-3">
              分配范围 26 题　可分配待审定 16 题　已分配 10 题
            </p>
            <p className="mb-0 mt-2">
              已分配题显示对应专家并禁选；其他状态不能新增分配。
            </p>
          </section>
          <div className="mt-6 grid gap-7 lg:grid-cols-[280px_1fr]">
            <aside className="rounded-xl border border-[#dfe6f0]">
              <h4 className="m-0 border-b border-[#dfe6f0] px-5 py-5 text-lg text-[#30415e]">
                职业名称{" "}
                <span className="text-sm font-normal text-[#7185a5]">
                  可多选
                </span>
              </h4>
              {[
                "茶艺师",
                "车工",
                "电工",
                "工业机器人系统操作员",
                "命题业务规范（样例）",
                "汽车维修工",
              ].map((name) => (
                <label
                  className={`flex cursor-pointer items-center gap-4 px-5 py-4 ${name === "车工" ? "bg-[#e9f2ff]" : ""}`}
                  key={name}
                >
                  <input defaultChecked={name === "车工"} type="checkbox" />
                  <span>
                    <strong className="block text-[#30415e]">{name}</strong>
                    <small className="text-[#7185a5]">
                      {name === "车工" ? "共 10 题 · 新增 2 题" : "未选择"}
                    </small>
                  </span>
                </label>
              ))}
            </aside>
            <main>
              <div className="flex items-center justify-between">
                <h3 className="m-0 text-2xl text-[#30415e]">车工</h3>
                <span className="text-[#5276a8]">
                  共 10 题 · 本次新增 {selected.length} 题
                </span>
              </div>
              <section className="mt-5 rounded-xl border border-[#dfe6f0] p-5">
                <strong className="text-[#30415e]">考核方式</strong>
                <select className="ml-5 h-12 rounded-xl border border-[#cbdaf0] bg-white px-4 text-[#385578]">
                  <option>全部</option>
                  <option>理论知识</option>
                  <option>操作技能</option>
                </select>
                <p className="mb-0 mt-3 text-sm text-[#7185a5]">
                  全部：五级至一级，可跨考核方式配置等级。
                </p>
              </section>
              <fieldset className="mt-5 rounded-xl border border-[#dfe6f0] p-5">
                <legend className="px-2 font-semibold text-[#30415e]">
                  技能等级（可多选）
                </legend>
                <div className="grid gap-4 md:grid-cols-2">
                  {[
                    "五级 / 初级工 · 可分配 2 / 共 4 题",
                    "四级 / 中级工 · 可分配 4 / 共 7 题",
                    "三级 / 高级工 · 可分配 3 / 共 5 题",
                    "二级 / 技师 · 可分配 4 / 共 5 题",
                    "一级 / 高级技师 · 可分配 3 / 共 5 题",
                  ].map((label) => (
                    <label className="text-[#4a668b]" key={label}>
                      <input className="mr-3" defaultChecked type="checkbox" />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="mt-5 rounded-xl border border-[#dfe6f0] p-5">
                <legend className="px-2 font-semibold text-[#30415e]">
                  题型（不勾选表示全部题型）
                </legend>
                <div className="flex flex-wrap gap-x-7 gap-y-4 text-[#6381a8]">
                  {[
                    "A 填空题",
                    "B 单项选择题",
                    "D 多项选择题",
                    "C 判断题",
                    "E 简答(计算题)",
                    "F 论述题",
                    "I 案例分析题",
                    "G 操作技能",
                  ].map((label) => (
                    <label key={label}>
                      <input className="mr-2" type="checkbox" />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="mt-5 rounded-xl border border-[#dfe6f0] p-5">
                <legend className="px-2 font-semibold text-[#30415e]">
                  试题范围
                </legend>
                <label className="block text-[#5276a8]">
                  <input
                    className="mr-3"
                    defaultChecked
                    type="radio"
                    name="scope"
                  />
                  指定试题（可多选）
                </label>
                <label className="mt-4 block text-[#5276a8]">
                  <input className="mr-3" type="radio" name="scope" />
                  全部当前可分配题（仅待审定）
                </label>
              </fieldset>
              <p className="mt-5 rounded-xl bg-[#f3f6fb] px-5 py-4 text-[#54729c]">
                符合条件 <strong>26</strong> 题　可分配待审定{" "}
                <strong>16</strong> 题　已分配 <strong>10</strong> 题　本次新增{" "}
                <strong>{selected.length}</strong> 题
              </p>
              <div className="rounded-xl border border-[#dfe6f0]">
                {available.map((item) => (
                  <label
                    className="flex cursor-pointer gap-4 border-b border-[#e7ecf3] p-5 last:border-b-0"
                    key={item.id}
                  >
                    <input
                      checked={selected.includes(item.id)}
                      onChange={() => toggle(item.id)}
                      type="checkbox"
                    />
                    <span>
                      <small className="text-[#7185a5]">
                        {item.meta} · 待审定
                      </small>
                      <strong className="mt-2 block font-normal text-[#30415e]">
                        {item.text}
                      </strong>
                      <span className="mt-2 inline-block rounded bg-[#eaf8f2] px-2 py-1 text-sm text-[#358b70]">
                        未分配　可分配
                      </span>
                    </span>
                  </label>
                ))}
                <div className="bg-[#f5f7fb] p-5 text-[#8192a9]">
                  ☑ 五级 / 初级工 · B 单项选择题 · SL-WF-001 · 待审定
                  <br />
                  <span className="ml-7">
                    本专家已分配，保留已有任务，不会重复新增。
                  </span>
                </div>
              </div>
            </main>
          </div>
          <p className="mt-6 rounded-xl border border-[#d5e4fc] bg-[#f1f6ff] px-5 py-4 text-[#426a9e]">
            已选 1 个职业 · 当前共 10 道试题 · 本次新增 {selected.length} 题
          </p>
        </div>
        <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
          <button
            className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
            onClick={onClose}
            type="button"
          >
            关闭
          </button>
          <button
            className="rounded-xl bg-[#405fe7] px-5 py-3 text-base font-medium text-white"
            onClick={onSave}
            type="button"
          >
            保存全部分配
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .format(date)
        .replace(/\//g, "-");
}

function AdminReviewPreviewModal({
  task,
  onClose,
}: Readonly<{ task: AdminReviewTask; onClose: () => void }>) {
  const options = task.content?.options ?? [];
  return (
    <div
      aria-labelledby="admin-review-title"
      aria-modal="true"
      className="fixed inset-0 z-[200] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
      role="dialog"
    >
      <div className="flex max-h-[94vh] w-full max-w-[810px] flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
          <h2
            className="m-0 text-[26px] font-semibold text-[#293242]"
            id="admin-review-title"
          >
            试题审定
          </h2>
          <button
            className="text-3xl text-[#6f8099]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-9">
          <div className="flex flex-wrap gap-3">
            <span className="rounded-md bg-[#edf4ff] px-3 py-2 text-sm text-[#5279a9]">
              {task.questionType}
            </span>
            <span className="rounded-md bg-[#edf4ff] px-3 py-2 text-sm text-[#5279a9]">
              {task.levelLabel}
            </span>
            <span className="rounded-md bg-[#fff4df] px-3 py-2 text-sm text-[#a96f13]">
              待审定
            </span>
            <span className="rounded-md bg-[#edf4ff] px-3 py-2 text-sm text-[#5279a9]">
              当前版本
            </span>
          </div>
          <article className="mt-6 rounded-xl border border-[#dbe4f0] p-6">
            <p className="m-0 text-sm text-[#7391b7]">
              {task.questionNo} · 已分配给 {task.expertName}
            </p>
            <h3 className="mb-6 mt-5 text-xl leading-9 text-[#293242]">
              {task.stem}
            </h3>
            {options.map((option, index) => (
              <div
                className={`mt-3 rounded-lg border px-4 py-4 ${option.isCorrect ? "border-[#a6d9ca] bg-[#effaf6] text-[#287d65]" : "border-[#dfe6ef] text-[#34445d]"}`}
                key={option.key ?? index}
              >
                {option.key ?? String.fromCharCode(65 + index)}　
                {option.content ?? option.text ?? ""}
              </div>
            ))}
            <div className="mt-5 rounded-xl bg-[#f4f7fb] p-5 text-[#36465d]">
              <strong>答案 / 参考答案</strong>
              <p className="mb-0 mt-2">
                {typeof task.answer === "string"
                  ? task.answer
                  : JSON.stringify(task.answer ?? "未提供")}
              </p>
              <strong className="mt-5 block">解析</strong>
              <p className="mb-0 mt-2 leading-7">
                {task.analysis || "当前版本未填写答案解析。"}
              </p>
            </div>
          </article>
          <p className="mt-5 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-5 py-4 leading-7 text-[#6687b6]">
            本题已分配给“{task.expertName}”，分配时间为{" "}
            {formatDateTime(task.assignedAt)}
            。管理员可通过任务列表的“编辑修订”入口代审，实际操作者将独立留痕。
          </p>
          <section className="mt-7">
            <h3 className="m-0 text-lg text-[#293242]">审定责任</h3>
            <p className="mb-0 mt-3 rounded-xl border border-[#f2dcae] bg-[#fff9eb] p-5 leading-7 text-[#a0783c]">
              管理员代审不冒用专家身份。审核通过后仍须管理员确认，修订内容保存新版本并保留历史意见。
            </p>
          </section>
        </div>
        <div className="flex justify-end border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
          <button
            className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
            onClick={onClose}
            type="button"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
}: Readonly<{ label: string; value: string | number; hint: string }>) {
  return (
    <div className="border-b border-[#e0e6f0] px-7 py-6 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
      <p className="m-0 text-[#7185a5]">{label}</p>
      <strong className="mt-2 block text-4xl text-[#293242]">{value}</strong>
      <p className="m-0 mt-2 text-sm text-[#8192a9]">{hint}</p>
    </div>
  );
}

function ReviewModal({
  task,
  stage,
  alignmentScore,
  decision,
  comment,
  confirmed,
  onDecision,
  onStage,
  onAlignmentScore,
  onComment,
  onConfirm,
  onSubmit,
  onClose,
}: Readonly<{
  task: ReviewTask;
  stage: string;
  alignmentScore: string;
  decision: string;
  comment: string;
  confirmed: boolean;
  onDecision: (value: string) => void;
  onStage: (value: string) => void;
  onAlignmentScore: (value: string) => void;
  onComment: (value: string) => void;
  onConfirm: (value: boolean) => void;
  onSubmit: () => void;
  onClose: () => void;
}>) {
  return (
    <div
      aria-labelledby="review-title"
      aria-modal="true"
      className="fixed inset-0 z-[200] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
      role="dialog"
    >
      <div className="flex max-h-[94vh] w-full max-w-[810px] flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
          <h2
            className="m-0 text-[26px] font-semibold text-[#293242]"
            id="review-title"
          >
            试题审定
          </h2>
          <button
            className="text-3xl text-[#6f8099]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-9">
          <div className="flex flex-wrap gap-3">
            <span className="rounded-md bg-[#edf4ff] px-3 py-2 text-sm text-[#5279a9]">
              {task.type}
            </span>
            <span className="rounded-md bg-[#edf4ff] px-3 py-2 text-sm text-[#5279a9]">
              {task.level}
            </span>
            <span className="rounded-md bg-[#fff4df] px-3 py-2 text-sm text-[#a96f13]">
              {task.status === "approved" ? "待管理员确认" : task.status === "stored" ? "已确认入库" : task.status === "returned" ? "退回修订" : "待审定"}
            </span>
            <span className="rounded-md bg-[#edf4ff] px-3 py-2 text-sm text-[#5279a9]">
              当前版本
            </span>
            <span className="rounded-md bg-[#edf4ff] px-3 py-2 text-sm text-[#5279a9]">
              {task.point}
            </span>
          </div>
          <article className="mt-6 rounded-xl border border-[#dbe4f0] p-6">
            <p className="m-0 text-sm text-[#7391b7]">
              {task.code} · {task.point}
            </p>
            <h3 className="mb-6 mt-5 text-xl leading-9 text-[#293242]">
              {task.stem}
            </h3>
            {(task.content?.options ?? []).map((option, index) => (
              <div
                className={`mt-3 rounded-lg border px-4 py-4 ${option.isCorrect ? "border-[#a6d9ca] bg-[#effaf6] text-[#287d65]" : "border-[#dfe6ef] text-[#34445d]"}`}
                key={option.key ?? index}
              >
                {option.key ?? String.fromCharCode(65 + index)}　
                {option.content ?? option.text ?? ""}
              </div>
            ))}
            <div className="mt-5 rounded-xl bg-[#f4f7fb] p-5 text-[#36465d]">
              <strong>答案 / 参考答案</strong>
              <p className="mb-0 mt-2">
                {typeof task.answer === "string"
                  ? task.answer
                  : JSON.stringify(task.answer ?? "未提供")}
              </p>
              <strong className="mt-5 block">解析</strong>
              <p className="mb-0 mt-2 leading-7">
                {task.analysis || "当前版本未填写答案解析。"}
              </p>
            </div>
          </article>
          <p className="mt-5 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-5 py-4 leading-7 text-[#6687b6]">
            ⓘ
            本次将以当前登录专家身份登记初审意见；提交后将写入审定记录、试题状态事件与审计日志。
          </p>
          <h3 className="mt-8 text-lg text-[#293242]">登记专家审定意见</h3>
          <fieldset disabled={task.status !== "pending_review"}>
          <div className="grid gap-5 md:grid-cols-2">
            <label className="text-[#6680a5]">
              审核 / 校对阶段
              <select
                className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] bg-white px-4 text-[#385578]"
                onChange={(event) => onStage(event.target.value)}
                value={stage}
              >
                <option value="initial">初审</option>
                <option value="recheck">复审</option>
                <option value="standard_editing">规范编辑</option>
                <option value="first_check">一校</option>
                <option value="second_check">二校</option>
                <option value="third_check">三校</option>
                <option value="final">终审</option>
              </select>
            </label>
            <label className="text-[#6680a5]">
              题目与考评点一致性
              <select
                className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] bg-white px-4 text-[#385578]"
                onChange={(event) => onAlignmentScore(event.target.value)}
                value={alignmentScore}
              >
                <option value="pending">待专家判定</option>
                <option value="1">1 差</option>
                <option value="2">2 较差</option>
                <option value="3">3 中</option>
                <option value="4">4 较好</option>
                <option value="5">5 好</option>
              </select>
            </label>
            <label className="text-[#6680a5]">
              当前版本审定结论
              <select
                className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] bg-white px-4 text-[#385578]"
                onChange={(event) => onDecision(event.target.value)}
                value={decision}
              >
                <option value="returned">退回修订</option>
                <option value="approved">同意通过</option>
              </select>
            </label>
          </div>
          <label className="mt-5 block text-[#6680a5]">
            具体审核意见 / 修改要求
            <textarea
              className="mt-2 h-32 w-full rounded-xl border border-[#cbdaf0] p-4 text-[#385578]"
              onChange={(event) => onComment(event.target.value)}
              value={comment}
            />
          </label>
          <label className="mt-5 flex items-center gap-3 text-[#6680a5]">
            <input
              checked={confirmed}
              className="h-5 w-5 accent-[#4265ef]"
              onChange={(event) => onConfirm(event.target.checked)}
              type="checkbox"
            />
            意见已由该专家实际给出，据实登记
          </label>
          <p className="text-[#7185a5]">
            试题{task.code} · 当前版本；修订后须重新审核。
          </p>
          </fieldset>
          <h3 className="mt-7 text-lg text-[#293242]">终审入库检查</h3>
          <p className="rounded-xl border border-[#f2dcae] bg-[#fff9eb] p-5 leading-7 text-[#a0783c]">
            {task.status === "approved" ? "专家已审核通过，等待管理员确认。" : task.status === "stored" ? "管理员已确认入库。" : task.status === "returned" ? "已退回修订，请通过编辑修订保存新版本后重新审核。" : "专家审核通过后，必须由管理员确认方可入库。"}
          </p>
        </div>
        <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
          <button
            className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
            onClick={onClose}
            type="button"
          >
            关闭
          </button>
          <button
            className="rounded-xl bg-[#405fe7] px-5 py-3 text-base font-medium text-white disabled:bg-[#9aaaf0]"
            disabled={
              task.status !== "pending_review" || !comment.trim() || !confirmed || alignmentScore === "pending"
            }
            onClick={onSubmit}
            type="button"
          >
            提交审定
          </button>
          <button
            className="rounded-xl border border-[#e1e7ef] bg-white px-5 py-3 text-base text-[#a7b2c2]"
            disabled
            type="button"
          >
            管理员确认入库
          </button>
        </div>
      </div>
    </div>
  );
}
