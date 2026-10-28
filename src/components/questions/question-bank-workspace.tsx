"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BulkQuestionStorage } from "./bulk-question-storage";
import { LegalAgent } from "./legal-agent";
import { canStoreQuestion, type StorageCandidate } from "@/modules/authoring/question-storage-policy";

type AssessmentMode = "theory" | "skill";
type Question = {
  id: string;
  questionNo: string;
  occupationName: string;
  occupationCode: string;
  levelCode: string;
  levelLabel: string;
  assessmentMode: AssessmentMode;
  questionType: string;
  status: string;
  versionId: string | null;
  confirmed: boolean;
  difficulty: string | null;
  createdAt: string;
  stem: string;
  content: unknown;
  answer: unknown;
  analysis: string | null;
  pointCodes: string;
  pointNames: string;
};
type FilterOption = {
  levelCode: string;
  assessmentMode: AssessmentMode;
  questionType: string;
};
type ResultScope = {
  occupationId: string;
  occupationName: string;
  occupationCode: string;
  levelCode: string;
  levelLabel: string;
  assessmentMode: AssessmentMode;
  questionCount: number;
};

const modeLabel: Record<AssessmentMode, string> = {
  theory: "理论知识",
  skill: "操作技能",
};
const statusLabel: Record<string, string> = {
  draft: "草稿",
  pending_review: "待审定",
  returned: "退回修订",
  approved: "已审定",
  stored: "已入库",
  archived: "已归档",
};

function getOptions(content: unknown) {
  if (!content || typeof content !== "object" || Array.isArray(content))
    return [];
  const value = (content as Record<string, unknown>).options;
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === "string")
      return { key: String.fromCharCode(65 + index), text: item };
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      return {
        key: String(
          row.key ?? row.optionKey ?? String.fromCharCode(65 + index),
        ),
        text: String(row.content ?? row.text ?? ""),
      };
    }
    return { key: String.fromCharCode(65 + index), text: "" };
  });
}

function getAnswer(answer: unknown) {
  if (typeof answer === "string") return answer;
  if (answer && typeof answer === "object") {
    const value = answer as Record<string, unknown>;
    return String(value.answer ?? value.correctAnswer ?? value.value ?? "—");
  }
  return "—";
}

export function QuestionBankWorkspace({
  readOnly = false,
}: Readonly<{ readOnly?: boolean }>) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [options, setOptions] = useState<FilterOption[]>([]);
  const [activeTab, setActiveTab] = useState<"search" | "results">("search");
  const [resultScopes, setResultScopes] = useState<ResultScope[]>([]);
  const [selectedResult, setSelectedResult] = useState<ResultScope | null>(
    null,
  );
  const [assessmentMode, setAssessmentMode] = useState<"" | AssessmentMode>("");
  const [levelCode, setLevelCode] = useState("");
  const [questionType, setQuestionType] = useState("");
  const [status, setStatus] = useState("");
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Question | null>(null);
  const [submitTarget, setSubmitTarget] = useState<Question | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Question | null>(null);
  const [storageTarget, setStorageTarget] = useState<Question | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [questionPage, setQuestionPage] = useState(1);
  const [questionTotal, setQuestionTotal] = useState(0);
  const [storageSelection, setStorageSelection] = useState<StorageCandidate[]>([]);
  const [bulkStorageBusy, setBulkStorageBusy] = useState(false);
  const requestSequence = useRef(0);
  const filterSequence = useRef("");
  const questionPageSize = 20;

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (assessmentMode) params.set("assessmentMode", assessmentMode);
    if (levelCode) params.set("levelCode", levelCode);
    if (questionType) params.set("questionType", questionType);
    if (status) params.set("status", status);
    if (keyword.trim()) params.set("keyword", keyword.trim());
    return params.toString();
  }, [assessmentMode, levelCode, questionType, status, keyword]);
  filterSequence.current = queryString;

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/questions?${queryString}&page=${questionPage}&pageSize=${questionPageSize}`, { cache: "no-store" });
      const body = await response.json();
      if (sequence !== requestSequence.current) return;
      if (!response.ok)
        throw new Error(body.error?.message ?? "题库加载失败。");
      setQuestions(body.data);
      setOptions(body.options);
      const total = Number(body.total ?? body.data.length);
      setQuestionTotal(total);
      setQuestionPage((current) => Math.min(current, Math.max(1, Math.ceil(total / questionPageSize))));
      setStorageSelection((selection) => selection.filter((candidate) => {
        const current = (body.data as Question[]).find((question) => question.id === candidate.id);
        return !current || (canStoreQuestion(current) && current.versionId === candidate.versionId);
      }));
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setQuestions([]);
      setQuestionTotal(0);
      setNotice(error instanceof Error ? error.message : "题库加载失败。");
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [queryString, questionPage]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setQuestionPage(1);
    setStorageSelection([]);
  }, [queryString]);
  useEffect(() => {
    setLevelCode("");
    setQuestionType("");
  }, [assessmentMode]);
  useEffect(() => {
    if (activeTab !== "results" || resultScopes.length) return;
    void (async () => {
      try {
        const response = await fetch("/api/v1/questions?view=results");
        const body = await response.json();
        if (!response.ok)
          throw new Error(body.error?.message ?? "成果范围加载失败。");
        setResultScopes(body.data);
      } catch (error) {
        setNotice(
          error instanceof Error ? error.message : "成果范围加载失败。",
        );
      }
    })();
  }, [activeTab, resultScopes.length]);

  const availableOptions = options.filter(
    (option) => !assessmentMode || option.assessmentMode === assessmentMode,
  );
  const levels = Array.from(
    new Map(
      availableOptions.map((option) => [option.levelCode, option]),
    ).values(),
  );
  const types = Array.from(
    new Set(
      availableOptions
        .filter((option) => !levelCode || option.levelCode === levelCode)
        .map((option) => option.questionType),
    ),
  );
  const scope = assessmentMode
    ? `${modeLabel[assessmentMode]}，${levels.length ? "已配置适用等级" : "暂无适用等级"}`
    : "全部考核方式，一级至五级";
  const questionPageCount = Math.max(
    1,
    Math.ceil(questionTotal / questionPageSize),
  );
  const visibleQuestions = loading ? [] : questions;
  const selectableQuestions = visibleQuestions.filter(canStoreQuestion);
  const allPageSelected = selectableQuestions.length > 0 && selectableQuestions.every((question) => storageSelection.some((candidate) => candidate.id === question.id));
  const candidateFor = (question: Question): StorageCandidate => ({ id: question.id, versionId: question.versionId!, questionNo: question.questionNo });
  const selectAllStorage = async () => {
    const filters = queryString;
    const response = await fetch(`/api/v1/questions?${filters}&view=storage-candidates`, { cache: "no-store" });
    const body = await response.json() as { data?: StorageCandidate[]; error?: { message?: string } };
    if (filters !== filterSequence.current) return;
    if (!response.ok || !body.data) throw new Error(body.error?.message ?? "待入库试题加载失败。");
    setStorageSelection(body.data);
    if (!body.data.length) setNotice("当前检索范围暂无已确认的待入库试题。");
  };

  const submit = async () => {
    if (!submitTarget) return;
    try {
      const response = await fetch("/api/v1/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: submitTarget.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "提交失败。");
      setNotice(`已提交 ${submitTarget.questionNo} 至专家审定待分配流程。`);
      setSubmitTarget(null);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "提交失败。");
    }
  };
  const remove = async () => {
    if (!deleteTarget) return;
    try {
      const response = await fetch("/api/v1/questions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: deleteTarget.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "删除失败。");
      setNotice(`已删除草稿试题 ${deleteTarget.questionNo}。`);
      setDeleteTarget(null);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "删除失败。");
    }
  };
  const store = async () => {
    if (!storageTarget) return;
    try {
      const response = await fetch("/api/v1/questions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: storageTarget.id }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message ?? "终审入库失败。");
      setNotice(`已将 ${storageTarget.questionNo} 终审入库。`);
      setStorageTarget(null);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "终审入库失败。");
    }
  };

  return (
    <section>
      <div className="flex gap-8 border-b border-[#e2e6ee]">
        <button
          className={`relative border-0 bg-transparent px-1 pb-4 text-[17px] ${activeTab === "search" ? "font-medium text-[#3f60e8]" : "text-[#9aa4b5]"}`}
          onClick={() => setActiveTab("search")}
          type="button"
        >
          题库检索
          {activeTab === "search" ? (
            <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-[#3f60e8]" />
          ) : null}
        </button>
        {!readOnly ? (
          <button
            className={`relative border-0 bg-transparent px-1 pb-4 text-[17px] ${activeTab === "results" ? "font-medium text-[#3f60e8]" : "text-[#9aa4b5]"}`}
            onClick={() => setActiveTab("results")}
            type="button"
          >
            成果下载
            {activeTab === "results" ? (
              <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-[#3f60e8]" />
            ) : null}
          </button>
        ) : null}
      </div>
      {activeTab === "search" ? (
        <div className="pt-12">
          <h1 className="m-0 text-[30px] font-semibold text-[#293242]">
            题库检索
          </h1>
          <p className="m-0 mt-3 text-[16px] text-[#7b879a]">
            默认展示全部职业试题；选择考核方式后，技能等级和题型按规则联动。
          </p>
          {!readOnly ? <LegalAgent onCompleted={load} /> : null}
          {notice ? (
            <p className="mt-6 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-5 py-4 text-[#4265d4]">
              {notice}
            </p>
          ) : null}
          <div className="mt-12 grid gap-4 lg:grid-cols-[1fr_1fr_1fr_1fr_1.8fr]">
            <Filter
              label="考核方式"
              value={assessmentMode}
              onChange={(value) =>
                setAssessmentMode(value as "" | AssessmentMode)
              }
            >
              <option value="">全部</option>
              <option value="theory">理论知识</option>
              <option value="skill">操作技能</option>
            </Filter>
            <Filter label="技能等级" value={levelCode} onChange={setLevelCode}>
              <option value="">全部适用等级</option>
              {levels.map((item) => (
                <option key={item.levelCode} value={item.levelCode}>
                  {item.levelCode === "generic" ? "通用" : `${item.levelCode.replace("level_", "")}级`}
                </option>
              ))}
            </Filter>
            <Filter
              label="题型"
              value={questionType}
              onChange={setQuestionType}
            >
              <option value="">全部适用题型</option>
              {types.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Filter>
            <Filter label="状态" value={status} onChange={setStatus}>
              <option value="">全部状态</option>
              {Object.entries(statusLabel).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Filter>
            <label className="block text-[#6680a5]">
              关键词
              <input
                className="mt-3 h-14 w-full rounded-xl border border-[#dfe5ef] bg-white px-4 text-[#385578] outline-none placeholder:text-[#aab6c8]"
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索职业名称、题干、编号、考评点名称或代码"
                value={keyword}
              />
            </label>
          </div>
          <p className="mt-7 text-[#8497b3]">检索范围：{scope}</p>
          <section className="mt-12 overflow-hidden rounded-[18px] border border-[#e0e6f0] bg-white shadow-card">
            {!readOnly ? <BulkQuestionStorage
              key={queryString}
              selected={storageSelection}
              loading={loading}
              onSelection={setStorageSelection}
              onSelectAll={selectAllStorage}
              onBusy={setBulkStorageBusy}
              onCompleted={async (message) => { setNotice(message); setResultScopes([]); await load(); }}
            /> : null}
            <div className="overflow-x-auto">
              <table className="min-w-[1300px] w-full text-left">
                <thead className="bg-[#f7f9fc] text-[#8b99ad]">
                  <tr>
                    {!readOnly ? <th className="px-5 py-5">
                      <input
                        type="checkbox" aria-label="全选当前页可入库试题"
                        checked={allPageSelected} disabled={loading || bulkStorageBusy || !selectableQuestions.length}
                        onChange={(event) => setStorageSelection((selection) => event.target.checked
                          ? [...new Map([...selection, ...selectableQuestions.map(candidateFor)].map((candidate) => [candidate.id, candidate])).values()]
                          : selection.filter((candidate) => !selectableQuestions.some((question) => question.id === candidate.id)))}
                      />
                    </th> : null}
                    {[
                      "试题 / 题型",
                      "题目",
                      "职业名称",
                      "技能等级",
                      "考核方式",
                      "考评点代码",
                      "考评点",
                      "状态",
                      "操作",
                    ].map((item) => (
                      <th className="px-5 py-5 font-medium" key={item}>
                        {item}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleQuestions.map((question) => (
                    <tr className="border-t border-[#e6ebf3]" key={question.id}>
                      {!readOnly ? <td className="px-5 py-5">
                        <input
                          type="checkbox" aria-label={`选择入库试题 ${question.questionNo}`}
                          checked={storageSelection.some((candidate) => candidate.id === question.id)}
                          disabled={loading || bulkStorageBusy || !canStoreQuestion(question)}
                          title={!canStoreQuestion(question) ? "仅已审定并经管理员确认的试题可入库" : ""}
                          onChange={(event) => setStorageSelection((selection) => event.target.checked
                            ? [...selection.filter((candidate) => candidate.id !== question.id), candidateFor(question)]
                            : selection.filter((candidate) => candidate.id !== question.id))}
                        />
                      </td> : null}
                      <td className="px-5 py-5 align-top">
                        <span className="text-[#6689b6]">
                          {question.questionNo}
                        </span>
                        <p className="m-0 mt-2 text-sm text-[#7185a5]">
                          {question.questionType}
                        </p>
                      </td>
                      <td className="max-w-[290px] px-5 py-5 leading-7 text-[#30415e]">
                        {question.stem}
                      </td>
                      <td className="px-5 py-5 text-[#30415e]">
                        {question.occupationName}
                      </td>
                      <td className="px-5 py-5 text-[#30415e]">
                        {question.levelLabel}
                      </td>
                      <td className="px-5 py-5 text-[#30415e]">
                        {modeLabel[question.assessmentMode]}
                      </td>
                      <td className="px-5 py-5 text-[#6689b6]">
                        {question.pointCodes}
                      </td>
                      <td className="px-5 py-5 text-[#30415e]">
                        {question.pointNames}
                      </td>
                      <td className="px-5 py-5">
                        <span
                          className={`rounded-lg px-3 py-2 text-sm ${
                            question.status === "draft"
                              ? "bg-[#edf4ff] text-[#4265d4]"
                              : question.status === "pending_review"
                                ? "bg-[#fff4df] text-[#a96f13]"
                                : "bg-[#f1f4f8] text-[#687b96]"
                          }`}
                        >
                          {question.status === "approved" && !question.confirmed ? "待管理员确认" : statusLabel[question.status] ?? question.status}
                        </span>
                      </td>
                      <td className="px-5 py-5">
                        <div className="flex gap-2">
                          <button
                            className="rounded-xl bg-[#405fe7] px-4 py-2.5 text-sm font-medium text-white"
                            onClick={() => setSelected(question)}
                            type="button"
                          >
                            打开
                          </button>
                          {!readOnly && question.status === "draft" ? (
                            <>
                              <button
                                className="rounded-xl border border-[#b9cff8] bg-[#edf4ff] px-4 py-2.5 text-sm text-[#4265d4]"
                                onClick={() => setSubmitTarget(question)}
                                type="button"
                              >
                                提审
                              </button>
                              <button
                                className="rounded-xl border border-[#fecaca] bg-[#fff7f7] px-4 py-2.5 text-sm text-[#dc5b68]"
                                onClick={() => setDeleteTarget(question)}
                                type="button"
                              >
                                删除
                              </button>
                            </>
                          ) : null}
                          {!readOnly && question.status === "approved" ? (
                            <button
                              className="rounded-xl border border-[#a6dccf] bg-[#edf9f5] px-4 py-2.5 text-sm text-[#17816a]"
                              disabled={bulkStorageBusy || !canStoreQuestion(question)}
                              title={!question.confirmed ? "请先在审核确定中完成管理员确认" : ""}
                              onClick={() => setStorageTarget(question)}
                              type="button"
                            >
                              终审入库
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!loading && !questions.length ? (
                    <tr>
                      <td
                        className="px-6 py-16 text-center text-[#7185a5]"
                        colSpan={readOnly ? 9 : 10}
                      >
                        未找到符合条件的试题。
                      </td>
                    </tr>
                  ) : null}
                  {loading ? (
                    <tr>
                      <td
                        className="px-6 py-16 text-center text-[#7185a5]"
                        colSpan={readOnly ? 9 : 10}
                      >
                        正在加载题库...
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {!loading && questions.length ? (
              <div className="flex items-center justify-between border-t border-[#e6ebf3] px-5 py-5 text-sm text-[#7185a5]">
                <span>
                  共 {questionTotal} 道试题，当前第 {questionPage} /{" "}
                  {questionPageCount} 页
                </span>
                <div className="flex gap-3">
                  <button
                    className="rounded-lg border border-[#d5e0ef] bg-white px-4 py-2 text-[#4e6484] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={questionPage === 1}
                    onClick={() => setQuestionPage((page) => page - 1)}
                    type="button"
                  >
                    上一页
                  </button>
                  <button
                    className="rounded-lg border border-[#d5e0ef] bg-white px-4 py-2 text-[#4e6484] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={questionPage === questionPageCount}
                    onClick={() => setQuestionPage((page) => page + 1)}
                    type="button"
                  >
                    下一页
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : (
        <ResultDownloads scopes={resultScopes} onOpen={setSelectedResult} />
      )}
      {selected ? (
        <QuestionModal question={selected} onClose={() => setSelected(null)} />
      ) : null}
      {submitTarget ? (
        <SubmitModal
          question={submitTarget}
          onCancel={() => setSubmitTarget(null)}
          onSubmit={() => void submit()}
        />
      ) : null}
      {deleteTarget ? (
        <DeleteModal
          question={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onDelete={() => void remove()}
        />
      ) : null}
      {storageTarget ? (
        <FinalStorageModal
          question={storageTarget}
          onCancel={() => setStorageTarget(null)}
          onConfirm={() => void store()}
        />
      ) : null}
      {selectedResult ? (
        <ResultModal
          scope={selectedResult}
          onClose={() => setSelectedResult(null)}
        />
      ) : null}
    </section>
  );
}

function ResultDownloads({
  scopes,
  onOpen,
}: Readonly<{ scopes: ResultScope[]; onOpen: (scope: ResultScope) => void }>) {
  return (
    <div className="pt-12">
      <h1 className="m-0 text-[30px] font-semibold text-[#293242]">成果下载</h1>
      <p className="m-0 mt-3 text-[16px] text-[#7b879a]">
        按职业与技能等级查看适用的考核方式成果文件，并选择下载。
      </p>
      <section className="mt-12 overflow-hidden rounded-[18px] border border-[#e0e6f0] bg-white shadow-card">
        <div className="overflow-x-auto">
          <table className="min-w-[900px] w-full text-left">
            <thead className="bg-[#f7f9fc] text-[#526988]">
              <tr>
                {["职业名称", "职业编码", "技能等级", "操作"].map((item) => (
                  <th className="px-7 py-6 text-lg font-semibold" key={item}>
                    {item}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scopes.map((scope) => (
                <tr
                  className="border-t border-[#e6ebf3]"
                  key={`${scope.occupationId}-${scope.levelCode}-${scope.assessmentMode}`}
                >
                  <td className="px-7 py-7 text-xl text-[#30415e]">
                    {scope.occupationName}
                  </td>
                  <td className="px-7 py-7 text-xl text-[#30415e]">
                    {scope.occupationCode || "待维护"}
                  </td>
                  <td className="px-7 py-7 text-xl text-[#30415e]">
                    {scope.levelLabel}
                  </td>
                  <td className="px-7 py-7">
                    <button
                      className={`rounded-xl border px-6 py-3 text-lg font-medium ${scope.assessmentMode === "theory" ? "border-[#b7cdf7] bg-[#edf4ff] text-[#1d62d9]" : "border-[#9edfd1] bg-[#e7f8f4] text-[#008c70]"}`}
                      onClick={() => onOpen(scope)}
                      type="button"
                    >
                      {modeLabel[scope.assessmentMode]}（{scope.questionCount}）
                    </button>
                  </td>
                </tr>
              ))}
              {!scopes.length ? (
                <tr>
                  <td
                    className="px-7 py-16 text-center text-[#7185a5]"
                    colSpan={4}
                  >
                    当前项目尚未配置职业、技能等级和考核方式范围。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      {scopes.length ? (
        <p className="mt-7 text-[#8497b3]">
          成果文件仅统计已审定试题；未审定、退回修订或草稿试题不会被作为正式考试成果导出。
        </p>
      ) : null}
    </div>
  );
}

function ResultModal({
  scope,
  onClose,
}: Readonly<{ scope: ResultScope; onClose: () => void }>) {
  const isTheory = scope.assessmentMode === "theory";
  const files = isTheory
    ? [
        `${scope.occupationName}（${scope.levelLabel.split(" / ")[0]}）理论知识题库`,
        `${scope.occupationName}（${scope.levelLabel.split(" / ")[0]}）理论知识考评要素细目表`,
      ]
    : [
        "操作技能考核试题（含评分标准）",
        "《操作技能考评内容结构表》",
        "《操作技能考评要素细目表》",
      ];
  const formats = isTheory ? ["Excel", "Excel"] : ["Excel", "Word", "Excel"];
  const downloadUrl = (file: "question-bank" | "outline") =>
    `/api/v1/questions?view=download&occupationId=${encodeURIComponent(scope.occupationId)}&levelCode=${encodeURIComponent(scope.levelCode)}&assessmentMode=${scope.assessmentMode}&file=${file}`;
  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-[220] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
      role="dialog"
    >
      <div className="w-full max-w-[1255px] overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-7">
          <h2 className="m-0 text-[26px] font-semibold text-[#293242]">
            {modeLabel[scope.assessmentMode]} · 成果文件下载
          </h2>
          <button
            className="text-3xl text-[#6f8099]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="p-9">
          <div className="flex flex-wrap gap-3">
            {[
              `职业：${scope.occupationName}`,
              `职业编码：${scope.occupationCode || "待维护"}`,
              `技能等级：${scope.levelLabel}`,
              `试题数量：${scope.questionCount}`,
            ].map((item) => (
              <span
                className="rounded-xl bg-[#f2f5fb] px-4 py-3 text-lg text-[#60799d]"
                key={item}
              >
                {item}
              </span>
            ))}
          </div>
          <p className="mt-8 text-lg text-[#5d759a]">
            {modeLabel[scope.assessmentMode]}
            成果文件清单。点击对应的“下载文件”生成当前职业和等级的文件。
          </p>
          <table className="w-full overflow-hidden text-left">
            <thead className="bg-[#f5f7fb] text-[#60799d]">
              <tr>
                {["序号", "成果文件名称", "格式", "操作"].map((item) => (
                  <th className="px-4 py-5 text-lg font-medium" key={item}>
                    {item}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {files.map((file, index) => {
                const downloadable =
                  scope.questionCount > 0 && (isTheory || index !== 1);
                const fileKey = index === 0 ? "question-bank" : "outline";
                return (
                  <tr className="border-b border-[#e6ebf3]" key={file}>
                    <td className="px-4 py-6 text-lg text-[#30415e]">
                      {index + 1}
                    </td>
                    <td className="px-4 py-6 text-lg text-[#30415e]">{file}</td>
                    <td className="px-4 py-6 text-lg text-[#30415e]">
                      {formats[index]}
                    </td>
                    <td className="px-4 py-6">
                      {downloadable ? (
                        <a
                          className="rounded-xl border border-[#b9cff8] bg-[#edf4ff] px-4 py-2 text-lg text-[#4265d4] no-underline"
                          href={downloadUrl(fileKey)}
                        >
                          下载文件
                        </a>
                      ) : (
                        <button
                          className="rounded-xl border border-[#dce5f0] bg-white px-4 py-2 text-lg text-[#a4b1c3] disabled:cursor-not-allowed disabled:opacity-60"
                          disabled
                          type="button"
                        >
                          下载文件
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {scope.questionCount === 0 ? (
            <p className="mb-0 mt-8 text-lg text-[#d26916]">
              当前职业和等级暂无该考核方式的已审定试题，文件下载暂不可用。
            </p>
          ) : (
            <p className="mb-0 mt-8 text-lg text-[#6680a5]">
              题库与细目表将由已审定题库记录和当前维护数据实时生成；操作技能结构表须维护正式
              Word 模板后开放。
            </p>
          )}
          <p className="mb-0 mt-6 text-base leading-8 text-[#8293a9]">
            说明：文件由当前题库记录生成；考评要素和评分标准只使用已维护的数据，不会虚构未维护的正式标准内容。未经审定的试题不能作为正式考试成果。
          </p>
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

function Filter({
  label,
  value,
  onChange,
  children,
}: Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}>) {
  return (
    <label className="block text-[#6680a5]">
      {label}
      <select
        className="mt-3 h-14 w-full rounded-xl border border-[#dfe5ef] bg-white px-4 text-[#385578] outline-none"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </select>
    </label>
  );
}

function QuestionModal({
  question,
  onClose,
}: Readonly<{ question: Question; onClose: () => void }>) {
  const options = getOptions(question.content);
  return (
    <Modal title={`试题查看 · ${question.questionNo}`} onClose={onClose} wide>
      <h3 className="m-0 text-xl text-[#293242]">试题基本信息</h3>
      <div className="mt-5 grid gap-x-10 md:grid-cols-2">
        {[
          ["试题编号", question.questionNo],
          ["职业名称", question.occupationName],
          ["职业编码", question.occupationCode || "—"],
          ["考核方式", modeLabel[question.assessmentMode]],
          ["技能等级", question.levelLabel],
          ["题型", question.questionType],
          ["试题状态", statusLabel[question.status] ?? question.status],
          ["难度等级", question.difficulty ?? "待评定"],
          ["关联考评点", question.pointNames],
          ["考评点编码", question.pointCodes],
        ].map(([label, value]) => (
          <div className="flex border-b border-[#e3e9f1] py-4" key={label}>
            <span className="w-44 text-[#8295b1]">{label}</span>
            <strong className="font-medium text-[#30415e]">{value}</strong>
          </div>
        ))}
      </div>
      <article className="mt-7 rounded-xl border border-[#dce5f0] p-6">
        <h3 className="m-0 text-xl text-[#293242]">试题内容</h3>
        <div className="mt-6 rounded-xl bg-[#f4f7fb] p-5 font-medium text-[#30415e]">
          题型：{question.questionType}
        </div>
        <p className="mt-3 rounded-xl bg-[#f7f9fc] p-5 leading-8 text-[#30415e]">
          {question.stem}
        </p>
        {options.map((option) => (
          <div
            className="mt-3 rounded-lg border border-[#dfe6ef] px-4 py-4 text-[#34445d]"
            key={option.key}
          >
            {option.key}　{option.text}
          </div>
        ))}
        <div className="mt-5 rounded-xl bg-[#f4f7fb] p-5 text-[#36465d]">
          <strong>标准答案 / 参考答案</strong>
          <p className="mb-0 mt-2">{getAnswer(question.answer)}</p>
          <strong className="mt-5 block">答案解析</strong>
          <p className="mb-0 mt-2 leading-7">
            {question.analysis || "暂无答案解析。"}
          </p>
        </div>
      </article>
      <article className="mt-6 rounded-xl border border-[#dce5f0] p-6">
        <h3 className="m-0 text-xl text-[#293242]">审核意见</h3>
        <p className="mt-5 border-t border-[#e3e9f1] pt-5 text-[#8295b1]">
          当前版本暂无专家审定意见。
        </p>
      </article>
    </Modal>
  );
}

function SubmitModal({
  question,
  onCancel,
  onSubmit,
}: Readonly<{
  question: Question;
  onCancel: () => void;
  onSubmit: () => void;
}>) {
  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-[210] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
      role="dialog"
    >
      <div className="w-full max-w-[810px] overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
          <h2 className="m-0 text-[26px] font-semibold text-[#293242]">
            提交专家审定
          </h2>
          <button
            className="text-3xl text-[#6f8099]"
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="px-9 py-11 text-lg leading-9 text-[#30415e]">
          <p className="m-0">
            试题编号：<strong>{question.questionNo}</strong>
          </p>
          <p className="mb-0 mt-3">
            确认提交后，试题状态更新为“待审定”，并进入专家审定待分配流程。
          </p>
        </div>
        <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
          <button
            className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="rounded-xl bg-[#405fe7] px-5 py-3 text-base font-medium text-white"
            onClick={onSubmit}
            type="button"
          >
            确认提审
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteModal({
  question,
  onCancel,
  onDelete,
}: Readonly<{
  question: Question;
  onCancel: () => void;
  onDelete: () => void;
}>) {
  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-[210] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
      role="dialog"
    >
      <div className="w-full max-w-[810px] overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
          <h2 className="m-0 text-[26px] font-semibold text-[#293242]">
            删除草稿试题
          </h2>
          <button
            className="text-3xl text-[#6f8099]"
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="px-9 py-11 text-lg leading-9 text-[#30415e]">
          <p className="m-0">
            试题编号：<strong>{question.questionNo}</strong>
          </p>
          <p className="mb-0 mt-3">删除后将从当前题库中移除，不能撤销。</p>
        </div>
        <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
          <button
            className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="rounded-xl border border-[#fecaca] bg-[#fff4f4] px-5 py-3 text-base font-medium text-[#dd5b66]"
            onClick={onDelete}
            type="button"
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
}

function FinalStorageModal({
  question,
  onCancel,
  onConfirm,
}: Readonly<{
  question: Question;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const options = getOptions(question.content);
  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-[210] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
      role="dialog"
    >
      <div className="flex max-h-[94vh] w-full max-w-[900px] flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
          <h2 className="m-0 text-[26px] font-semibold text-[#293242]">
            终审入库
          </h2>
          <button
            className="text-3xl text-[#6f8099]"
            onClick={onCancel}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-9">
          <div className="grid gap-x-8 gap-y-3 text-[#526681] md:grid-cols-2">
            <p className="m-0">
              试题编号：
              <strong className="text-[#293242]">{question.questionNo}</strong>
            </p>
            <p className="m-0">
              职业名称：
              <strong className="text-[#293242]">
                {question.occupationName}
              </strong>
            </p>
            <p className="m-0">
              技能等级：
              <strong className="text-[#293242]">{question.levelLabel}</strong>
            </p>
            <p className="m-0">
              考核方式：
              <strong className="text-[#293242]">
                {modeLabel[question.assessmentMode]}
              </strong>
            </p>
            <p className="m-0">
              题型：
              <strong className="text-[#293242]">
                {question.questionType}
              </strong>
            </p>
            <p className="m-0">
              考评点：
              <strong className="text-[#293242]">
                {question.pointCodes || "未关联"} {question.pointNames}
              </strong>
            </p>
          </div>
          <article className="mt-7 rounded-xl border border-[#dbe4f0] p-6">
            <h3 className="m-0 text-xl leading-9 text-[#293242]">
              {question.stem}
            </h3>
            {options.map((option) => (
              <p
                className="mb-0 mt-3 rounded-lg border border-[#e0e7f1] px-4 py-3 text-[#33445d]"
                key={option.key}
              >
                {option.key}. {option.text}
              </p>
            ))}
            <div className="mt-5 rounded-xl bg-[#f4f7fb] p-5 leading-7 text-[#36465d]">
              <strong>答案 / 参考答案</strong>
              <p className="mb-4 mt-2">{getAnswer(question.answer)}</p>
              <strong>解析</strong>
              <p className="mb-0 mt-2">{question.analysis || "未填写解析。"}</p>
            </div>
          </article>
          <p className="mt-5 rounded-xl border border-[#bde4d9] bg-[#effaf6] px-5 py-4 leading-7 text-[#287d65]">
            确认入库后，试题状态将从“已审定”更新为“已入库”，并保留本次终审的完整审计记录。
          </p>
        </div>
        <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
          <button
            className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
            onClick={onCancel}
            type="button"
          >
            取消
          </button>
          <button
            className="rounded-xl bg-[#16806a] px-5 py-3 text-base font-medium text-white"
            onClick={onConfirm}
            type="button"
          >
            确认入库
          </button>
        </div>
      </div>
    </div>
  );
}

function Modal({
  title,
  onClose,
  wide,
  children,
}: Readonly<{
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}>) {
  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-[200] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
      role="dialog"
    >
      <div
        className={`flex max-h-[94vh] w-full ${wide ? "max-w-[1250px]" : "max-w-[810px]"} flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]`}
      >
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
          <h2 className="m-0 text-[26px] font-semibold text-[#293242]">
            {title}
          </h2>
          <button
            className="text-3xl text-[#6f8099]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-9">{children}</div>
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
