"use client";

import { useEffect, useRef, useState } from "react";
import type { WeightedSection } from "@/modules/assembly/weight-policy";
import { paperFormat, type PaperPresentation } from "@/modules/documents/paper-presentation";
import { PaperSamplePreview } from "./paper-sample-preview";

type WeightPreview = {
  valid: boolean; message: string; excluded: number; paperCount: number; fingerprint: string;
  basis: { versionId: string; versionNo: number; direction: string };
  ranges: Array<{ key: string; category: string; name: string; weight: number; targetScore: number; available: number; byType: Array<{ type: string; available: number }> }>;
  sections: WeightedSection[]; suggestion: WeightedSection[] | null; suggestionError: string;
};

type Occupation = { id: string; name: string; code: string };
type Structure = {
  id: string;
  name: string;
  current_version_id: string;
  occupation_id: string;
  occupation_name: string;
  level_code: string;
  assessment_mode: string;
  duration_minutes: number;
  total_items: number;
  total_score: number;
  snapshot_json: { sections?: typeof initialSections };
  updated_at: string;
};
type Plan = {
  id: string;
  name: string;
  status: string;
  current_version_id: string;
  occupation_name: string;
  level_code: string;
  assessment_mode: string;
  structure_name: string;
  paper_count: number;
  updated_at: string;
};
type PlanDetail = {
  id: string;
  name: string;
  status: string;
  occupation_name: string;
  level_code: string;
  assessment_mode: string;
  structure_name: string;
  paper_structure_version_id: string;
  total_items: number;
  total_score: number;
  snapshot_json: { paperCount: number; structureVersionId: string; weightDirection?: string };
  slots: {
    slot_no: number;
    section_no: number;
    question_type: string;
    required_count: number;
  }[];
};
type AssemblyData = {
  occupations: Occupation[];
  structures: Structure[];
  plans: Plan[];
  paperCount: number;
  papers: Paper[];
};
type Paper = {
  id: string;
  paper_no: string;
  title: string;
  generated_at: string;
  plan_name: string;
  occupation_name: string;
  level_code: string;
  assessment_mode: string;
  item_count: number;
};
type PaperDetail = Omit<Paper, "item_count"> & {
  presentation?: PaperPresentation;
  duration_minutes: number;
  weightValidation?: {
    basis: { versionNo: number; direction: string };
    ranges: Array<{ key: string; name: string; weight: number; targetScore: number; actualScore: number }>;
  };
  items: {
    item_no: number;
    section_no: number;
    question_no_snapshot: string;
    question_type: string;
    stem_snapshot: string;
    content_snapshot_json: {
      options?: { key: string; text?: string; content?: string }[];
    };
    answer_snapshot_json: unknown;
    score_rubric_snapshot_json: unknown;
    score: number;
  }[];
};
const labels: Record<string, string> = {
  level_5: "五级 / 初级工",
  level_4: "四级 / 中级工",
  level_3: "三级 / 高级工",
  level_2: "二级 / 技师",
  level_1: "一级 / 高级技师",
};
const practicalSection = {
  questionType: "实操题",
  itemCount: 0,
  scorePerItem: 100,
};
const initialSections: WeightedSection[] = [
  { questionType: "A 填空题", itemCount: 0, scorePerItem: 1 },
  { questionType: "B 单项选择题", itemCount: 80, scorePerItem: 1 },
  { questionType: "D 多项选择题", itemCount: 0, scorePerItem: 1 },
  { questionType: "C 判断题", itemCount: 20, scorePerItem: 1 },
  { questionType: "E 简答(计算题)", itemCount: 0, scorePerItem: 5 },
  { questionType: "F 论述题", itemCount: 0, scorePerItem: 10 },
  { questionType: "I 案例分析题", itemCount: 0, scorePerItem: 10 },
  practicalSection,
];

export function AssemblyWorkspace() {
  const [data, setData] = useState<AssemblyData>({
    occupations: [],
    structures: [],
    plans: [],
    paperCount: 0,
    papers: [],
  });
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [openStructure, setOpenStructure] = useState(false);
  const [openPlan, setOpenPlan] = useState(false);
  const [notice, setNotice] = useState("");
  const [viewStructure, setViewStructure] = useState<Structure | null>(null);
  const [planStructure, setPlanStructure] = useState<Structure | null>(null);
  const [editingStructure, setEditingStructure] = useState<Structure | null>(
    null,
  );
  const [planDetail, setPlanDetail] = useState<PlanDetail | null>(null);
  const [editingPlan, setEditingPlan] = useState<PlanDetail | null>(null);
  const [paperDetail, setPaperDetail] = useState<PaperDetail | null>(null);
  const load = async () => {
    const response = await fetch("/api/v1/assembly");
    const body = await response.json();
    if (response.ok) setData(body.data);
    else setNotice(body.error?.message ?? "加载失败。");
  };
  useEffect(() => {
    void load();
  }, []);
  const summaries = [
    data.structures.length,
    data.plans.length,
    data.paperCount,
  ];
  return (
    <section>
      <h1 className="m-0 text-[30px] font-semibold text-[#293242]">智能组卷</h1>
      <p className="m-0 mt-3 text-[16px] text-[#7b879a]">
        依据国家职业标准先确定试卷结构，再编制组卷计划，执行组卷后可查看完整试卷及答案评分标准。
      </p>
      <div className="mt-12 grid gap-4 md:grid-cols-3">
        {(["试卷结构", "组卷计划", "试卷成果"] as const).map((name, index) => (
          <button
            className={`rounded-xl border p-7 text-left ${step === index + 1 ? "border-[#b9cbfb] bg-[#f0f4ff]" : "border-[#e0e6f0] bg-white"}`}
            key={name}
            onClick={() => setStep((index + 1) as 1 | 2 | 3)}
            type="button"
          >
            <span className="mr-4 inline-grid h-10 w-10 place-items-center rounded-full border border-[#91a9d5]">
              {index + 1}
            </span>
            <strong className="text-lg text-[#526b91]">{name}</strong>
            <p className="mb-0 mt-2 text-[#8495ad]">
              {summaries[index]}
              {index === 0 ? "个结构" : index === 1 ? "个计划" : "套试卷"}
            </p>
          </button>
        ))}
      </div>
      {notice ? (
        <p className="mt-6 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-5 py-4 text-[#4265d4]">
          {notice}
        </p>
      ) : null}
      {step === 1 ? (
        <StepOne
          structures={data.structures}
          onCreate={() => setOpenStructure(true)}
          onEdit={setEditingStructure}
          onNext={() => setStep(2)}
          onPlan={(structure) => {
            setPlanStructure(structure);
            setOpenPlan(true);
          }}
          onView={setViewStructure}
        />
      ) : step === 2 ? (
        <StepTwo
          plans={data.plans}
          structures={data.structures}
          onCreate={() => setOpenPlan(true)}
          onNext={() => setStep(3)}
          onNotice={setNotice}
          onRefresh={load}
          onShow={async (id) => {
            const response = await fetch(`/api/v1/assembly?planId=${id}`);
            const body = await response.json();
            if (response.ok) setPlanDetail(body.data);
            else setNotice(body.error?.message ?? "加载计划失败。");
          }}
          onEdit={async (id) => {
            const response = await fetch(`/api/v1/assembly?planId=${id}`);
            const body = await response.json();
            if (response.ok) setEditingPlan(body.data);
          }}
          onViewStructure={async (id) => {
            const response = await fetch(`/api/v1/assembly?planId=${id}`);
            const body = await response.json();
            const structure = data.structures.find(
              (item) =>
                item.current_version_id ===
                body.data?.paper_structure_version_id,
            );
            if (response.ok && structure) setViewStructure(structure);
            else setNotice("未找到该计划关联的试卷结构。");
          }}
        />
      ) : (
        <StepThree
          papers={data.papers}
          onBack={() => setStep(2)}
          onView={async (id) => {
            const response = await fetch(`/api/v1/assembly?paperId=${id}`);
            const body = await response.json();
            if (response.ok) setPaperDetail(body.data);
            else setNotice(body.error?.message ?? "加载试卷失败。");
          }}
        />
      )}
      {openStructure || editingStructure ? (
        <StructureModal
          editingStructure={editingStructure}
          occupations={data.occupations}
          onClose={() => {
            setOpenStructure(false);
            setEditingStructure(null);
          }}
          onSaved={async () => {
            setOpenStructure(false);
            setEditingStructure(null);
            setStep(2);
            await load();
          }}
        />
      ) : null}
      {openPlan || editingPlan ? (
        <PlanModal
          editingPlan={editingPlan}
          initialStructure={planStructure}
          structures={data.structures}
          onClose={() => {
            setOpenPlan(false);
            setPlanStructure(null);
            setEditingPlan(null);
          }}
          onSaved={async () => {
            setOpenPlan(false);
            setPlanStructure(null);
            setEditingPlan(null);
            setStep(2);
            await load();
          }}
        />
      ) : null}
      {viewStructure ? (
        <StructureDetailModal
          onCreatePlan={(structure) => {
            setViewStructure(null);
            setPlanStructure(structure);
            setOpenPlan(true);
          }}
          structure={viewStructure}
          onClose={() => setViewStructure(null)}
        />
      ) : null}
      {planDetail ? (
        <PlanBookModal
          detail={planDetail}
          onClose={() => setPlanDetail(null)}
        />
      ) : null}
      {paperDetail ? (
        <PaperPreviewModal
          paper={paperDetail}
          onClose={() => setPaperDetail(null)}
        />
      ) : null}
    </section>
  );
}

function StepOne({
  structures,
  onCreate,
  onEdit,
  onNext,
  onPlan,
  onView,
}: Readonly<{
  structures: Structure[];
  onCreate: () => void;
  onEdit: (structure: Structure) => void;
  onNext: () => void;
  onPlan: (structure: Structure) => void;
  onView: (structure: Structure) => void;
}>) {
  return (
    <section className="mt-10 rounded-[18px] border border-[#e0e6f0] bg-white">
      <header className="flex items-center justify-between border-b border-[#e5e9f0] p-8">
        <div>
          <h2 className="m-0 text-xl text-[#293242]">第一步 · 试卷结构</h2>
          <p className="mb-0 mt-3 text-[#7185a5]">
            确定职业、等级、考核方式、考试时间、题型、题量及配分。
          </p>
        </div>
        <button
          className="rounded-xl bg-[#405fe7] px-5 py-3 text-white"
          onClick={onCreate}
          type="button"
        >
          ＋ 新建试卷结构
        </button>
      </header>
      <div className="p-8">
        {structures.map((item) => (
          <div
            className="mb-4 flex flex-wrap items-center justify-between gap-5 rounded-xl border border-[#e0e6f0] p-5"
            key={item.id}
          >
            <div>
              <strong className="text-[#30415e]">{item.name}</strong>
              <p className="mb-0 mt-3 text-[#7185a5]">
                {labels[item.level_code]} ·{" "}
                {item.assessment_mode === "theory" ? "理论知识" : "操作技能"} ·{" "}
                {item.duration_minutes}分钟 · {item.total_items}题 /{" "}
                {item.total_score}分
              </p>
              <p className="mb-0 mt-2 text-sm text-[#7185a5]">
                最后修改时间：
                {item.updated_at ? (
                  <time dateTime={item.updated_at}>
                    {new Date(item.updated_at).toLocaleString("zh-CN", {
                      year: "numeric", month: "2-digit", day: "2-digit",
                      hour: "2-digit", minute: "2-digit", second: "2-digit",
                      hour12: false,
                    })}
                  </time>
                ) : "暂无记录"}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                className="rounded-xl border border-[#d5e0ef] px-4 py-2 text-[#4e6484]"
                onClick={() => onView(item)}
                type="button"
              >
                查看结构
              </button>
              <button
                className="rounded-xl border border-[#d5e0ef] px-4 py-2 text-[#4e6484]"
                onClick={() => onEdit(item)}
                type="button"
              >
                修改
              </button>
              <button
                className="rounded-xl bg-[#405fe7] px-4 py-2 text-white"
                onClick={() => onPlan(item)}
                type="button"
              >
                以此结构建计划
              </button>
            </div>
          </div>
        ))}
        {!structures.length ? (
          <p className="py-10 text-center text-[#8495ad]">尚未建立试卷结构。</p>
        ) : (
          <button
            className="rounded-xl border border-[#d5e0ef] px-5 py-3 text-[#4e6484]"
            onClick={onNext}
            type="button"
          >
            进入组卷计划
          </button>
        )}
      </div>
    </section>
  );
}
function StepTwo({
  plans,
  structures,
  onCreate,
  onNext,
  onNotice,
  onRefresh,
  onShow,
  onEdit,
  onViewStructure,
}: Readonly<{
  plans: Plan[];
  structures: Structure[];
  onCreate: () => void;
  onNext: () => void;
  onNotice: (text: string) => void;
  onRefresh: () => Promise<void>;
  onShow: (id: string) => Promise<void>;
  onEdit: (id: string) => Promise<void>;
  onViewStructure: (id: string) => Promise<void>;
}>) {
  const [executingPlanId, setExecutingPlanId] = useState<string | null>(null);
  const executionPending = useRef(false);
  const [weightPreview, setWeightPreview] = useState<{ planId: string; data: WeightPreview } | null>(null);
  const [checkingPlanId, setCheckingPlanId] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState(false);
  const checkingPending = useRef(false);
  const checkWeights = async (id: string) => {
    if (checkingPending.current || executionPending.current) return;
    checkingPending.current = true;
    setCheckingPlanId(id);
    try {
      const response = await fetch("/api/v1/assembly", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "weight_preview", planId: id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "权重校验失败。");
      setWeightPreview({ planId: id, data: body.data });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "权重校验失败。");
    } finally {
      checkingPending.current = false;
      setCheckingPlanId(null);
    }
  };
  const confirmAdjustment = async () => {
    if (!weightPreview || checkingPending.current) return;
    checkingPending.current = true;
    setAdjusting(true);
    try {
      const response = await fetch("/api/v1/assembly", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "weight_adjust", planId: weightPreview.planId, fingerprint: weightPreview.data.fingerprint }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "确认调整失败。");
      onNotice(body.data.message);
      setWeightPreview(null);
      await onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "确认调整失败。");
      setWeightPreview(null);
    } finally {
      checkingPending.current = false;
      setAdjusting(false);
    }
  };
  const execute = async (id: string) => {
    if (executionPending.current || checkingPending.current) return;
    executionPending.current = true;
    setExecutingPlanId(id);
    try {
      const response = await fetch("/api/v1/assembly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "execute", planId: id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "执行组卷失败。");
      if (body.data.executed)
        onNotice(`组卷完成，本次新增 ${body.data.paperIds.length} 套试卷${body.data.presentation ? `，已采用《${body.data.presentation.format.sampleName}》样式` : ""}，历史成果已保留。`);
      else {
        onNotice(body.data.message ?? "权重校验未通过，未生成试卷。");
        if (body.data.validation) setWeightPreview({ planId: id, data: body.data.validation });
      }
      await onRefresh();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "执行组卷失败，请重试。");
    } finally {
      executionPending.current = false;
      setExecutingPlanId(null);
    }
  };
  const remove = async (id: string) => {
    if (!window.confirm("确定删除该组卷计划吗？")) return;
    const response = await fetch("/api/v1/assembly", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", planId: id }),
    });
    if (response.ok) await onRefresh();
  };
  const download = async (item: Plan) => {
    const response = await fetch(`/api/v1/assembly?planId=${item.id}`);
    const body = await response.json();
    if (!response.ok) return;
    const detail = body.data as PlanDetail;
    const text = [
      `组卷计划书：${detail.name}`,
      `关联结构：${detail.structure_name}`,
      `组卷套数：${detail.snapshot_json.paperCount}`,
      "",
      "题型需求：",
      ...detail.slots.map(
        (slot) => `${slot.question_type}：${slot.required_count}道`,
      ),
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${item.name}-组卷计划书.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="mt-10 rounded-[18px] border border-[#e0e6f0] bg-white">
      <header className="flex items-center justify-between border-b border-[#e5e9f0] p-8">
        <div>
          <h2 className="m-0 text-xl text-[#293242]">第二步 · 组卷计划书</h2>
          <p className="mb-0 mt-3 text-[#7185a5]">
            按试卷结构为每套试卷分配题型与题量；执行时仅抽取已入库题目。
          </p>
        </div>
        <div className="flex gap-3">
          <button
            className="rounded-xl border border-[#d5e0ef] px-4 py-3 text-[#4e6484]"
            onClick={onNext}
            type="button"
          >
            查看试卷成果
          </button>
          <button
            className="rounded-xl bg-[#405fe7] px-5 py-3 text-white disabled:bg-[#aab7e8]"
            disabled={!structures.length}
            onClick={onCreate}
            type="button"
          >
            ＋ 新建组卷计划
          </button>
        </div>
      </header>
      <div className="p-8">
        {plans.map((item) => (
          <div className="mb-4 border-b border-[#e4eaf3] pb-7" key={item.id}>
            <div className="flex flex-wrap items-center gap-3">
              <strong className="text-lg text-[#30415e]">{item.name}</strong>
              <span className="rounded bg-[#fff4df] px-2 py-1 text-sm text-[#a96f13]">
                {item.status === "completed"
                  ? "已完成"
                  : item.status === "incomplete"
                    ? "校验未通过"
                    : "待完善"}
              </span>
            </div>
            <p className="text-[#7185a5]">
              关联结构：{item.structure_name} · {item.paper_count}套 ·{" "}
              {labels[item.level_code]} ·{" "}
              {item.assessment_mode === "theory" ? "理论知识" : "操作技能"}
            </p>
            <p className="mb-3 text-sm text-[#7185a5]">
              最后修改时间：
              {item.updated_at ? (
                <time dateTime={item.updated_at}>
                  {new Date(item.updated_at).toLocaleString("zh-CN", {
                    year: "numeric", month: "2-digit", day: "2-digit",
                    hour: "2-digit", minute: "2-digit", second: "2-digit",
                    hour12: false,
                  })}
                </time>
              ) : "暂无记录"}
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                className="rounded-xl border border-[#d5e0ef] px-4 py-2 text-[#4e6484] disabled:opacity-50"
                disabled={Boolean(executingPlanId || checkingPlanId || adjusting)}
                onClick={() => void checkWeights(item.id)}
                type="button"
              >
                {checkingPlanId === item.id ? "校验中..." : "权重校验 / 调整结构"}
              </button>
              <button
                className="rounded-xl border border-[#d5e0ef] px-4 py-2 text-[#4e6484]"
                onClick={() => void onShow(item.id)}
                type="button"
              >
                查看计划书
              </button>
              <button
                className="rounded-xl border border-[#d5e0ef] px-4 py-2 text-[#4e6484]"
                onClick={() => void onViewStructure(item.id)}
                type="button"
              >
                查看对应结构
              </button>
              <button
                className="rounded-xl border border-[#d5e0ef] px-4 py-2 text-[#4e6484]"
                onClick={() => void onEdit(item.id)}
                type="button"
              >
                编辑计划
              </button>
              <button
                className="rounded-xl border border-[#d5e0ef] px-4 py-2 text-[#4e6484]"
                onClick={() => void download(item)}
                type="button"
              >
                ⇩ 下载计划书
              </button>
              <button
                className="rounded-xl bg-[#405fe7] px-4 py-2 text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={Boolean(executingPlanId || checkingPlanId || adjusting)}
                onClick={() => void execute(item.id)}
                type="button"
              >
                {executingPlanId === item.id ? "组卷中..." : "执行组卷"}
              </button>
              <button
                className="rounded-xl border border-[#f1c5c5] px-4 py-2 text-[#c85a5a]"
                onClick={() => void remove(item.id)}
                type="button"
              >
                删除计划
              </button>
            </div>
          </div>
        ))}
        {!plans.length ? (
          <p className="py-10 text-center text-[#8495ad]">
            保存试卷结构后建立组卷计划。
          </p>
        ) : null}
      </div>
      {weightPreview ? (
        <Dialog title="范围权重校验与结构调整" onClose={() => { if (!adjusting) setWeightPreview(null); }}>
          <p className={`rounded-xl p-4 ${weightPreview.data.valid ? "bg-[#edf8f0] text-[#32764b]" : "bg-[#fff4df] text-[#a96f13]"}`}>
            {weightPreview.data.message}
          </p>
          <p className="text-sm text-[#7185a5]">
            权重表 V{weightPreview.data.basis.versionNo} · 方向：{weightPreview.data.basis.direction} ·
            每套100分，共{weightPreview.data.paperCount}套。未明确归属、跨范围或评分标准无效的试题已排除{weightPreview.data.excluded}道。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead><tr><th className="p-3">范围</th><th>权重</th><th>每套目标分数</th><th>可用库存（全部套数共享）</th></tr></thead>
              <tbody>{weightPreview.data.ranges.map((range) => (
                <tr key={range.key} className="border-t border-[#e4eaf3]">
                  <td className="p-3">{range.category} · {range.name}</td><td>{range.weight}%</td><td>{range.targetScore}分</td>
                  <td>{range.byType.map((item) => `${item.type} ${item.available}道`).join("；")}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          {weightPreview.data.suggestion ? (
            <>
              <h3 className="mt-6 font-semibold">建议调整结构（尚未保存）</h3>
              <p className="text-sm text-[#7185a5]">
                原结构{weightPreview.data.sections.reduce((sum, row) => sum + row.itemCount, 0)}题；
                建议结构{weightPreview.data.suggestion.reduce((sum, row) => sum + row.itemCount, 0)}题，100分。
                确认后新建结构并保存本计划新版本，保留旧结构和历史成果；实操评分项仅在试卷中同比换算，不修改原题。
              </p>
              <p className="text-sm text-[#7185a5]">原配置：{weightPreview.data.sections.map((row) => `${row.questionType} ${row.itemCount}题 × ${row.scorePerItem}分`).join("；")}</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead><tr><th className="p-3">范围</th><th>题型</th><th>题量</th><th>每题分值</th><th>配分</th></tr></thead>
                  <tbody>{weightPreview.data.suggestion.map((row, index) => (
                    <tr key={index} className="border-t border-[#e4eaf3]">
                      <td className="p-3">{weightPreview.data.ranges.find((range) => range.key === row.rangeKey)?.name}</td>
                      <td>{row.questionType}</td><td>{row.itemCount}</td><td>{row.scorePerItem}</td>
                      <td>{Number((row.itemCount * row.scorePerItem).toFixed(2))}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </>
          ) : weightPreview.data.suggestionError ? <p className="mt-4 text-[#c44c4c]">{weightPreview.data.suggestionError}</p> : null}
          <div className="mt-7 flex justify-end gap-3">
            <button type="button" disabled={adjusting} onClick={() => setWeightPreview(null)} className="rounded-xl border px-5 py-3">关闭</button>
            {weightPreview.data.suggestion ? (
              <button type="button" disabled={adjusting} onClick={() => void confirmAdjustment()} className="rounded-xl bg-[#405fe7] px-5 py-3 text-white disabled:opacity-50">
                {adjusting ? "保存中..." : "确认调整并保存，暂不组卷"}
              </button>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
function StepThree({
  papers,
  onBack,
  onView,
}: Readonly<{
  papers: Paper[];
  onBack: () => void;
  onView: (id: string) => Promise<void>;
}>) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadNotice, setDownloadNotice] = useState("");
  const download = async (paper: Paper, kind: "paper" | "answers") => {
    setDownloading(`${paper.id}:${kind}`);
    setDownloadNotice("");
    try {
      const response = await fetch(`/api/v1/assembly/download?paperId=${encodeURIComponent(paper.id)}&kind=${kind}`);
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error?.message ?? "下载失败。");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${paper.title.replace(/[\\/:*?"<>|]/g, "_")}-${kind === "paper" ? "试卷" : "答案及评分标准"}.docx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setDownloadNotice(error instanceof Error ? error.message : "下载失败。"); }
    finally { setDownloading(null); }
  };
  return (
    <>
      <p className="mt-10 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-6 py-5 text-[#6687b6]">
        ⓘ
        试卷正文与答案及评分标准分别查看、下载。正式组卷仅使用已入库试题，题库不足时不得生成空白试卷。
      </p>
      {downloadNotice ? <p role="alert" className="mt-4 rounded-xl bg-[#fff4df] p-4 text-[#a96f13]">{downloadNotice}</p> : null}
      <section className="mt-7 rounded-[18px] border border-[#e0e6f0] bg-white">
        <header className="flex items-center justify-between border-b border-[#e5e9f0] p-8">
          <div>
            <h2 className="m-0 text-xl text-[#293242]">第三步 · 试卷成果</h2>
            <p className="mb-0 mt-3 text-[#7185a5]">
              可查看完整试卷，分别下载 Word 试卷和答案及评分标准。
            </p>
          </div>
          <button
            className="rounded-xl bg-[#405fe7] px-5 py-3 text-white"
            onClick={onBack}
            type="button"
          >
            去检查并执行组卷
          </button>
        </header>
        {papers.length ? (
          <div className="divide-y divide-[#e8edf4]">
            {papers.map((paper) => (
              <div
                className="flex flex-wrap items-center justify-between gap-5 px-8 py-6"
                key={paper.id}
              >
                <div>
                  <p className="m-0 text-lg font-semibold text-[#30415e]">
                    {paper.title}
                  </p>
                  <p className="mb-0 mt-2 text-sm text-[#7185a5]">
                    {paper.paper_no} · {paper.occupation_name} ·{" "}
                    {labels[paper.level_code]} ·{" "}
                    {paper.assessment_mode === "theory"
                      ? "理论知识"
                      : "操作技能"}{" "}
                    · {paper.item_count} 道题
                  </p>
                  <p className="mb-0 mt-2 text-sm text-[#94a2b7]">
                    生成时间：{formatDateTime(paper.generated_at)} · 组卷计划：
                    {paper.plan_name}
                  </p>
                </div>
                <div className="flex flex-wrap gap-3"><button
                  className="rounded-xl bg-[#405fe7] px-5 py-3 text-white"
                  onClick={() => void onView(paper.id)}
                  type="button"
                >
                  查看完整试卷
                </button>
                <button className="rounded-xl bg-[#405fe7] px-5 py-3 text-white disabled:opacity-50" disabled={downloading !== null} onClick={() => void download(paper, "paper")} type="button">{downloading === `${paper.id}:paper` ? "生成中..." : "下载试卷"}</button>
                <button className="rounded-xl border border-[#d6e0ef] px-5 py-3 text-[#526681] disabled:opacity-50" disabled={downloading !== null} onClick={() => void download(paper, "answers")} type="button">{downloading === `${paper.id}:answers` ? "生成中..." : "下载答案及评分标准"}</button></div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid min-h-[260px] place-items-center p-10 text-center text-[#8293a9]">
            <div>
              <p className="text-5xl">▤</p>
              <strong className="text-lg">尚未生成试卷</strong>
              <p>请先建立结构和计划，通过检查后执行组卷。</p>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function StructureModal({
  occupations,
  editingStructure,
  onClose,
  onSaved,
}: Readonly<{
  occupations: Occupation[];
  editingStructure: Structure | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}>) {
  const initialSnapshot = editingStructure?.snapshot_json;
  const [name, setName] = useState(editingStructure?.name ?? "");
  const [occupationId, setOccupationId] = useState(
    editingStructure?.occupation_id ?? "",
  );
  const [levelCode, setLevelCode] = useState(
    editingStructure?.level_code ?? "level_4",
  );
  const [assessmentMode, setAssessmentMode] = useState<"theory" | "skill">(
    (editingStructure?.assessment_mode as "theory" | "skill") ?? "theory",
  );
  const [durationMinutes, setDurationMinutes] = useState(
    editingStructure?.duration_minutes ?? 90,
  );
  const [sections, setSections] = useState(() => {
    const saved = initialSnapshot?.sections ?? initialSections;
    return saved.some((row) => row.questionType === practicalSection.questionType)
      ? saved.map((row) => ({ ...row }))
      : [...saved.map((row) => ({ ...row })), { ...practicalSection }];
  });
  const [error, setError] = useState("");
  const totalItems = sections.reduce((sum, row) => sum + row.itemCount, 0);
  const totalScore = sections.reduce(
    (sum, row) => sum + row.itemCount * row.scorePerItem,
    0,
  );
  const update = (
    index: number,
    key: "itemCount" | "scorePerItem",
    value: number,
  ) =>
    setSections(
      sections.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [key]: Math.max(0, value) } : row,
      ),
    );
  useEffect(() => {
    if (!occupationId && occupations[0]) {
      setOccupationId(occupations[0].id);
      setName(`${occupations[0].name}四级理论知识试卷结构`);
    }
  }, [occupationId, occupations]);
  const save = async () => {
    if (!name.trim()) {
      setError("请填写结构名称。");
      return;
    }
    if (!occupationId) {
      setError("请选择职业。");
      return;
    }
    if (!durationMinutes || durationMinutes < 1) {
      setError("考试时间必须大于 0 分钟。");
      return;
    }
    setError("");
    const response = await fetch("/api/v1/assembly", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "structure",
        structureId: editingStructure?.id,
        name: name.trim(),
        occupationId,
        levelCode,
        assessmentMode,
        durationMinutes,
        sections,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error?.message ?? "保存失败。");
      return;
    }
    await onSaved();
  };
  const inputClass =
    "mt-2 h-12 w-full rounded-lg border border-[#cbdaf0] bg-white px-4 text-base text-[#385578] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]";
  return (
    <Dialog
      title={editingStructure ? "修改试卷结构" : "建立试卷结构"}
      onClose={onClose}
    >
      <>
        <div className="grid gap-x-8 gap-y-6 md:grid-cols-2">
          <Field
            label="结构名称"
            value={name}
            onChange={setName}
            placeholder="如：车工四级 / 中级工理论试卷结构"
          />
          <label className="block text-base text-[#527098]">
            职业
            <select
              className={inputClass}
              value={occupationId}
              onChange={(e) => setOccupationId(e.target.value)}
            >
              <option value="">请选择职业</option>
              {occupations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-base text-[#527098]">
            等级
            <select
              className={inputClass}
              value={levelCode}
              onChange={(e) => setLevelCode(e.target.value)}
            >
              {Object.entries(labels).map(([key, value]) => (
                <option key={key} value={key}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-base text-[#527098]">
            试卷类别
            <select
              className={inputClass}
              value={assessmentMode}
              onChange={(e) =>
                setAssessmentMode(e.target.value as "theory" | "skill")
              }
            >
              <option value="theory">理论知识</option>
              <option value="skill">操作技能</option>
            </select>
          </label>
          <Field
            label="考试时间（分钟）"
            value={String(durationMinutes)}
            onChange={(value) => setDurationMinutes(Number(value))}
            type="number"
          />
          <label className="block text-base text-[#527098]">
            快速填写结构
            <select
              className={inputClass}
              onChange={(e) => {
                if (e.target.value === "standard")
                  setSections(initialSections.map((row) => ({ ...row })));
              }}
            >
              <option value="">手工填写</option>
              <option value="standard">B 单项选择题80道 + C 判断题20道</option>
            </select>
          </label>
        </div>
        <div className="mt-8 overflow-x-auto rounded-xl border border-[#dfe6f0]">
          <table className="w-full min-w-[680px] text-left">
            <thead className="bg-[#f4f7fb] text-[#7185a5]">
              <tr>
                <th className="p-4">题型</th>
                <th className="p-4">题量</th>
                <th className="p-4">每题分值</th>
                <th className="p-4">配分</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((row, index) => (
                <tr
                  className="border-t border-[#e4eaf3]"
                  key={`${index}-${row.questionType}`}
                >
                  <td className="p-4 text-[#30415e]">{row.questionType}{row.rangeKey ? <small className="block text-[#7185a5]">范围：{row.rangeKey}</small> : null}</td>
                  <td className="p-4">
                    <input
                      className="h-10 w-36 rounded-lg border border-[#cbdaf0] px-3 text-[#385578]"
                      min={0}
                      onChange={(e) =>
                        update(index, "itemCount", Number(e.target.value))
                      }
                      type="number"
                      value={row.itemCount}
                    />
                  </td>
                  <td className="p-4">
                    <input
                      className="h-10 w-36 rounded-lg border border-[#cbdaf0] px-3 text-[#385578]"
                      min={0}
                      step="0.01"
                      onChange={(e) =>
                        update(index, "scorePerItem", Number(e.target.value))
                      }
                      type="number"
                      value={row.scorePerItem}
                    />
                  </td>
                  <td className="p-4 font-medium text-[#30415e]">
                    {row.itemCount * row.scorePerItem}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-5 text-[#7185a5]">
          {totalItems}题 / {totalScore}
          分。二级、一级理论知识常规为46题、100分；47题选答结构须另行处理。
        </p>
        {error ? <p className="text-[#c44c4c]">{error}</p> : null}
        <div className="mt-7 flex justify-end gap-3">
          <button
            className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-[#4e6484]"
            onClick={onClose}
            type="button"
          >
            取消
          </button>
          <button
            className="rounded-xl bg-[#405fe7] px-5 py-3 text-white"
            onClick={() => void save()}
            type="button"
          >
            保存结构，下一步
          </button>
        </div>
      </>
    </Dialog>
  );
}

function StructureDetailModal({
  structure,
  onClose,
  onCreatePlan,
}: Readonly<{
  structure: Structure;
  onClose: () => void;
  onCreatePlan: (structure: Structure) => void;
}>) {
  const sections = structure.snapshot_json?.sections ?? [];
  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-[210] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
      role="dialog"
    >
      <div className="flex max-h-[94vh] w-full max-w-[1255px] flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
          <h2 className="m-0 text-[26px] font-semibold text-[#293242]">
            试卷结构
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
          <h3 className="m-0 text-[24px] font-semibold text-[#293242]">
            {structure.name}
          </h3>
          <p className="mb-0 mt-4 text-lg text-[#7185a5]">
            {labels[structure.level_code]} ·{" "}
            {structure.assessment_mode === "theory" ? "理论知识" : "操作技能"} ·{" "}
            {structure.duration_minutes}分钟 · 满分{structure.total_score}分
          </p>
          <div className="mt-8 overflow-x-auto border border-[#dce5f0]">
            <table className="min-w-[940px] w-full border-collapse text-center">
              <thead className="bg-[#f4f7fb] text-[#7185a5]">
                <tr>
                  <th className="border-b border-r border-[#dce5f0] p-4">
                    题型
                  </th>
                  {sections.map((item, index) => (
                    <th
                      className="border-b border-r border-[#dce5f0] p-4 font-medium"
                      key={index}
                    >
                      {item.questionType}
                      {item.rangeKey ? <small className="block">范围：{item.rangeKey}</small> : null}
                    </th>
                  ))}
                  <th className="border-b border-[#dce5f0] p-4">合计</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border-r border-b border-[#dce5f0] bg-[#f8fafc] p-4 text-[#7185a5]">
                    题量
                  </td>
                  {sections.map((item, index) => (
                    <td
                      className="border-r border-b border-[#dce5f0] p-4"
                      key={index}
                    >
                      {item.itemCount}
                    </td>
                  ))}
                  <td className="border-b border-[#dce5f0] p-4">
                    {structure.total_items}
                  </td>
                </tr>
                <tr>
                  <td className="border-r border-b border-[#dce5f0] bg-[#f8fafc] p-4 text-[#7185a5]">
                    每题分值
                  </td>
                  {sections.map((item, index) => (
                    <td
                      className="border-r border-b border-[#dce5f0] p-4"
                      key={index}
                    >
                      {item.scorePerItem}
                    </td>
                  ))}
                  <td className="border-b border-[#dce5f0] p-4">—</td>
                </tr>
                <tr>
                  <td className="border-r border-[#dce5f0] bg-[#f8fafc] p-4 text-[#7185a5]">
                    配分
                  </td>
                  {sections.map((item, index) => (
                    <td
                      className="border-r border-[#dce5f0] p-4"
                      key={index}
                    >
                      {Number((item.itemCount * item.scorePerItem).toFixed(2))}
                    </td>
                  ))}
                  <td className="p-4">{structure.total_score}</td>
                </tr>
              </tbody>
            </table>
          </div>
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
            onClick={() => onCreatePlan(structure)}
            type="button"
          >
            → 以此结构建计划
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanModal({
  structures,
  initialStructure,
  editingPlan,
  onClose,
  onSaved,
}: Readonly<{
  structures: Structure[];
  initialStructure: Structure | null;
  editingPlan: PlanDetail | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}>) {
  const [name, setName] = useState(
    editingPlan?.name ??
      (initialStructure ? `${initialStructure.name}组卷计划` : ""),
  );
  const [structureVersionId, setStructureVersionId] = useState(
    editingPlan?.paper_structure_version_id ??
      initialStructure?.current_version_id ??
      structures[0]?.current_version_id ??
      "",
  );
  const [paperCount, setPaperCount] = useState(
    editingPlan?.snapshot_json.paperCount ?? 2,
  );
  const [weightDirection, setWeightDirection] = useState(editingPlan?.snapshot_json.weightDirection ?? "");
  const [error, setError] = useState("");
  const save = async () => {
    const response = await fetch("/api/v1/assembly", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "plan",
        planId: editingPlan?.id,
        name,
        structureVersionId,
        paperCount,
        weightDirection,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error?.message ?? "保存失败。");
      return;
    }
    await onSaved();
  };
  return (
    <Dialog
      title={editingPlan ? "编辑组卷计划" : "建立组卷计划"}
      onClose={onClose}
    >
      <>
        <div className="grid gap-5 md:grid-cols-2">
          <Field
            label="计划名称"
            value={name}
            onChange={setName}
            placeholder="如：车工四级 / 中级工理论组卷计划"
          />
          <label className="text-[#527098]">
            关联试卷结构
            <select
              className="mt-2 h-12 w-full rounded-lg border border-[#cbdaf0] px-4"
              value={structureVersionId}
              onChange={(e) => setStructureVersionId(e.target.value)}
            >
              {structures.map((item) => (
                <option
                  key={item.current_version_id}
                  value={item.current_version_id}
                >
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="组卷套数（1至10套）"
            value={String(paperCount)}
            onChange={(value) => setPaperCount(Number(value))}
            type="number"
          />
          <Field label="职业方向（单方向可留空）" value={weightDirection} onChange={setWeightDirection} placeholder="填写权重表中的完整方向名称" />
          <div className="rounded-lg bg-[#f2f7ff] p-4 text-[#6687b6]">
            使用范围：正式组卷，仅已审定题目。
          </div>
        </div>
        <p className="mt-6 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] p-5 text-[#6687b6]">
          每套试卷按范围分数占比严格匹配权重，仅抽取已入库且范围归属明确的试题。不满足时阻止组卷，可查看调整建议，确认保存后再执行。
        </p>
        {error ? <p className="text-[#c44c4c]">{error}</p> : null}
        <div className="mt-7 flex justify-end gap-3">
          <button onClick={onClose} type="button">
            取消
          </button>
          <button
            className="rounded-xl bg-[#405fe7] px-5 py-3 text-white"
            onClick={() => void save()}
            type="button"
          >
            保存计划草稿
          </button>
        </div>
      </>
    </Dialog>
  );
}

function PlanBookModal({
  detail,
  onClose,
}: Readonly<{ detail: PlanDetail; onClose: () => void }>) {
  const summary = Array.from(
    new Map(
      detail.slots.map((slot) => [
        slot.question_type,
        detail.slots
          .filter((row) => row.question_type === slot.question_type)
          .reduce((sum, row) => sum + row.required_count, 0),
      ]),
    ).entries(),
  );
  return (
    <Dialog title="组卷计划书" onClose={onClose}>
      <>
        <h3 className="m-0 text-2xl text-[#293242]">{detail.name}</h3>
        <p className="mt-3 text-[#7185a5]">
          {detail.structure_name} · {labels[detail.level_code]} ·{" "}
          {detail.snapshot_json.paperCount}套 · 仅已审定题
        </p>
        <table className="mt-6 w-full border-collapse overflow-hidden rounded-xl border border-[#dfe6f0]">
          <thead className="bg-[#f4f7fb] text-[#7185a5]">
            <tr>
              <th className="p-4 text-left">题型</th>
              <th className="p-4 text-left">每套题量</th>
              <th className="p-4 text-left">总需求</th>
            </tr>
          </thead>
          <tbody>
            {summary.map(([type, total]) => (
              <tr className="border-t border-[#e4eaf3]" key={type}>
                <td className="p-4">{type}</td>
                <td className="p-4">
                  {Number(total) / detail.snapshot_json.paperCount}
                </td>
                <td className="p-4">{total}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-6 text-[#7185a5]">
          计划总题量：{detail.total_items * detail.snapshot_json.paperCount}{" "}
          道；满分：{detail.total_score} 分/套。
        </p>
        <div className="mt-7 flex justify-end">
          <button
            className="rounded-xl border border-[#d5e0ef] px-5 py-3 text-[#4e6484]"
            onClick={onClose}
            type="button"
          >
            关闭
          </button>
        </div>
      </>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}>) {
  return (
    <label className="block text-base text-[#527098]">
      {label}
      <input
        className="mt-2 h-12 w-full rounded-lg border border-[#cbdaf0] bg-white px-4 text-base text-[#385578] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
        value={value}
      />
    </label>
  );
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}

function PaperPreviewModal({
  paper,
  onClose,
}: Readonly<{ paper: PaperDetail; onClose: () => void }>) {
  const [kind, setKind] = useState<"paper" | "answers">("paper");
  const format = paper.presentation?.format ?? paperFormat(paper.assessment_mode);
  return (
    <Dialog title={paper.title} onClose={onClose}>
      <div className="mb-6 rounded-xl bg-[#f4f7fb] px-5 py-4 text-[#526681]">
        <p className="m-0">
          {paper.paper_no} · {paper.occupation_name} ·{" "}
          {labels[paper.level_code]} ·{" "}
          {paper.assessment_mode === "theory" ? "理论知识" : "操作技能"}
        </p>
        <p className="mb-0 mt-2 text-sm text-[#8293a9]">
          生成时间：{formatDateTime(paper.generated_at)} · 组卷计划：
          {paper.plan_name}
        </p>
      </div>
      {paper.weightValidation?.ranges ? (
        <div className="mb-6 rounded-xl border border-[#d7e5fb] p-4 text-sm text-[#526681]">
          <strong>范围配分核验 · 权重表V{paper.weightValidation.basis.versionNo} · {paper.weightValidation.basis.direction}</strong>
          {paper.weightValidation.ranges.map((range) => (
            <p key={range.key}>{range.name}：权重{range.weight}%，目标{range.targetScore}分，实际{range.actualScore}分</p>
          ))}
        </div>
      ) : null}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        {(["paper", "answers"] as const).map((value) => (
          <button key={value} type="button" onClick={() => setKind(value)} className={`rounded-lg border px-4 py-2 ${kind === value ? "border-[#405fe7] bg-[#405fe7] text-white" : "border-[#d7e2f5] text-[#526681]"}`}>
            {value === "paper" ? "考生试卷" : "答案及评分标准"}
          </button>
        ))}
        <span className="text-sm text-[#7185a5]">样式：{format.sampleName}</span>
      </div>
      <PaperSamplePreview paper={paper} kind={kind} />
    </Dialog>
  );
}

function Dialog({
  title,
  onClose,
  children,
}: Readonly<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}>) {
  return (
    <div aria-modal="true" role="dialog" aria-label={title} className="fixed inset-0 z-[200] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]">
      <div className="max-h-[94vh] w-full max-w-[1255px] overflow-y-auto rounded-[22px] bg-white p-9 shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
        <div className="mb-7 flex justify-between border-b border-[#e5e9f0] pb-5">
          <h2 className="m-0 text-2xl">{title}</h2>
          <button className="text-3xl" onClick={onClose} type="button">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
