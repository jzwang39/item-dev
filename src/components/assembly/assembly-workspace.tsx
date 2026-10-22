"use client";

import { useEffect, useState } from "react";

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
  snapshot_json: { paperCount: number; structureVersionId: string };
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
  items: {
    item_no: number;
    question_no_snapshot: string;
    question_type: string;
    stem_snapshot: string;
    content_snapshot_json: {
      options?: { key: string; text?: string; content?: string }[];
    };
    answer_snapshot_json: unknown;
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
const initialSections = [
  { questionType: "A 填空题", itemCount: 0, scorePerItem: 1 },
  { questionType: "B 单项选择题", itemCount: 80, scorePerItem: 1 },
  { questionType: "D 多项选择题", itemCount: 0, scorePerItem: 1 },
  { questionType: "C 判断题", itemCount: 20, scorePerItem: 1 },
  { questionType: "E 简答(计算题)", itemCount: 0, scorePerItem: 5 },
  { questionType: "F 论述题", itemCount: 0, scorePerItem: 10 },
  { questionType: "I 案例分析题", itemCount: 0, scorePerItem: 10 },
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
  const execute = async (id: string) => {
    const response = await fetch("/api/v1/assembly", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "execute", planId: id }),
    });
    const body = await response.json();
    if (response.ok && body.data.executed)
      onNotice(`组卷完成，已生成 ${body.data.paperIds.length} 套试卷。`);
    else if (response.ok)
      onNotice(
        `题库检查未通过：${body.data.gaps.map((gap: { questionType: string; shortage: number }) => `${gap.questionType}缺${gap.shortage}道`).join("；")}`,
      );
    else onNotice(body.error?.message ?? "执行组卷失败。");
    await onRefresh();
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
                    ? "题库不足"
                    : "待完善"}
              </span>
            </div>
            <p className="text-[#7185a5]">
              关联结构：{item.structure_name} · {item.paper_count}套 ·{" "}
              {labels[item.level_code]} ·{" "}
              {item.assessment_mode === "theory" ? "理论知识" : "操作技能"}
            </p>
            <div className="flex flex-wrap gap-3">
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
                className="rounded-xl bg-[#405fe7] px-4 py-2 text-white"
                onClick={() => void execute(item.id)}
                type="button"
              >
                执行组卷
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
  return (
    <>
      <p className="mt-10 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-6 py-5 text-[#6687b6]">
        ⓘ
        试卷正文与答案及评分标准分别查看、下载。正式组卷仅使用已入库试题，题库不足时不得生成空白试卷。
      </p>
      <section className="mt-7 rounded-[18px] border border-[#e0e6f0] bg-white">
        <header className="flex items-center justify-between border-b border-[#e5e9f0] p-8">
          <div>
            <h2 className="m-0 text-xl text-[#293242]">第三步 · 试卷成果</h2>
            <p className="mb-0 mt-3 text-[#7185a5]">
              点击“查看完整试卷”可逐题阅读一整套试卷。
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
                <button
                  className="rounded-xl bg-[#405fe7] px-5 py-3 text-white"
                  onClick={() => void onView(paper.id)}
                  type="button"
                >
                  查看完整试卷
                </button>
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
  const [sections, setSections] = useState(
    initialSnapshot?.sections ?? initialSections,
  );
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
                  key={row.questionType}
                >
                  <td className="p-4 text-[#30415e]">{row.questionType}</td>
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
                  {sections.map((item) => (
                    <th
                      className="border-b border-r border-[#dce5f0] p-4 font-medium"
                      key={item.questionType}
                    >
                      {item.questionType}
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
                  {sections.map((item) => (
                    <td
                      className="border-r border-b border-[#dce5f0] p-4"
                      key={item.questionType}
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
                  {sections.map((item) => (
                    <td
                      className="border-r border-b border-[#dce5f0] p-4"
                      key={item.questionType}
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
                  {sections.map((item) => (
                    <td
                      className="border-r border-[#dce5f0] p-4"
                      key={item.questionType}
                    >
                      {item.itemCount * item.scorePerItem}
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
          <div className="rounded-lg bg-[#f2f7ff] p-4 text-[#6687b6]">
            使用范围：正式组卷，仅已审定题目。
          </div>
        </div>
        <p className="mt-6 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] p-5 text-[#6687b6]">
          保存后按结构题型自动生成各套试卷的题量槽位。执行时会检查已审定题库，题库不足只输出缺口，不生成空白试卷。
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
      <div className="space-y-6">
        {paper.items.map((item) => {
          const answer =
            typeof item.answer_snapshot_json === "string"
              ? item.answer_snapshot_json
              : JSON.stringify(item.answer_snapshot_json);
          return (
            <article
              className="rounded-xl border border-[#e0e6f0] p-6"
              key={item.item_no}
            >
              <p className="m-0 text-sm text-[#7185a5]">
                第 {item.item_no} 题 · {item.question_type} · {item.score} 分 ·{" "}
                {item.question_no_snapshot}
              </p>
              <h3 className="mb-0 mt-3 text-lg leading-8 text-[#293242]">
                {item.stem_snapshot}
              </h3>
              {(item.content_snapshot_json?.options ?? []).map((option) => (
                <p
                  className="mb-0 mt-3 rounded-lg border border-[#e4eaf3] px-4 py-3 text-[#40506a]"
                  key={option.key}
                >
                  {option.key}. {option.text ?? option.content ?? ""}
                </p>
              ))}
              <p className="mb-0 mt-4 rounded-lg bg-[#f4f7fb] px-4 py-3 text-[#526681]">
                答案：{answer}
              </p>
            </article>
          );
        })}
      </div>
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
    <div className="fixed inset-0 z-[200] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]">
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
