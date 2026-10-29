"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { SkillStandardUpload, SkillWeightMatrix, SkillStructureMatrix, type ImportedSkillStandard } from "./skill-standard-upload";
import { SkillOutlinePanel } from "./skill-outline-panel";
import { SkillStructureEditor } from "./skill-structure-editor";
import { ScoreRubric } from "@/components/questions/score-rubric";
import { formatDirectionCode, type OccupationDirection } from "@/modules/authoring/occupations/directions";
import type { TheoryWeightScope } from "@/modules/blueprints/theory-weights/standard";
import { isTheoryOutlineGenerationLevel } from "@/modules/blueprints/theory-outline-generation/policy";

const tabs = ["考评蓝图", "命题任务", "资料依据", "质量检查"] as const;

type AuthoringTab = (typeof tabs)[number];

const tabDescriptions: Record<
  Exclude<AuthoringTab, "考评蓝图">,
  { title: string; description: string }
> = {
  命题任务: {
    title: "命题任务",
    description: "创建、确认并跟踪智能命题计划和批次执行情况。",
  },
  资料依据: {
    title: "资料依据",
    description: "管理职业标准、教材、模板及其他可追溯的命题依据。",
  },
  质量检查: {
    title: "质量检查",
    description: "集中处理退回修订和已保存但尚未重新提审的试题版本。",
  },
};

type Profession = {
  id: string;
  name: string;
  code: string;
  status: "active" | "archived";
  directions: OccupationDirection[];
  nextDirectionNumber: number;
};

type DirectionDraft = { key: string; id?: string; name: string; directionCode?: string };

type TheoryWeightItem = {
  category: string;
  name: string;
  weights: Record<string, number | null>;
};

type TheoryWeightSnapshot = {
  versionId: string;
  versionNo: number;
  sourceName: string;
  usedOcr: boolean;
  importedAt: string;
  items: TheoryWeightItem[];
  scopes?: TheoryWeightScope[];
  requirementScopeCount?: number;
};

type TheoryAssessmentPoint = {
  code: string;
  name: string;
  primaryNo: string;
  primaryName: string;
  primaryWeight?: number | null;
  secondaryNo: string;
  secondaryName: string;
  secondaryWeight?: number | null;
  tertiaryNo: string;
  tertiaryName: string;
  tertiaryWeight?: number | null;
  importance: "low" | "medium" | "high" | "critical" | null;
  importanceCode?: "X" | "Y" | "Z";
  remark: string;
  textbookPage: string;
};

type TheoryOutlineSnapshot = {
  versionId: string;
  versionNo: number;
  sourceName: string;
  importedAt: string;
  points: TheoryAssessmentPoint[];
};

type SkillWeightItem = {
  name: string;
  weights: Record<string, number>;
};

type SkillWeightSnapshot = {
  versionId: string;
  versionNo: number;
  sourceName: string;
  importedAt: string;
  items: SkillWeightItem[];
};

type SkillStructureRow = {
  code: string;
  name: string;
  selection: "required" | "optional";
  score: number;
  minutes: number;
  method: string;
};
type SkillStructureSnapshot = {
  versionId: string;
  versionNo: number;
  name: string;
  levelCode: string;
  ruleBasis: string;
  pathway: string;
  totalMinutes: number;
  rows: SkillStructureRow[];
  importedAt: string;
};
type NewSkillPoint = {
  name: string;
  level1Code: string;
  level1Name: string;
  level2Code: string;
  level2Name: string;
  level3Code: string;
  level3Name: string;
  ordinal: number;
  weight: number;
  importance: "low" | "medium" | "high" | "critical";
  abilityLevel: string;
  targetCount: number;
  selection: string;
  method: string;
  minutes: number;
  standardText: string;
  citation: string;
  knowledgeMaterial: string;
  knowledgePoints: string;
};
type SkillAssessmentPoint = NewSkillPoint & { code: string; range: string };

type OccupationStandard = {
  id: string;
  name: string;
  original_name: string;
};

type Textbook = {
  sourceId: string;
  sourceVersionId: string;
  name: string;
  originalName: string;
  createdAt: string;
  chapterCount: number;
};

type TheoryOutlineGenerationJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  mode: "textbook" | "model";
  totalBatches: number;
  completedBatches: number;
  generatedPointCount: number;
  errorMessage: string | null;
  textbookSourceVersionId: string | null;
  resultBlueprintVersionId: string | null;
  createdAt: string;
  updatedAt: string;
};

const theoryLevels = [
  { value: "level_5", label: "五级 / 初级工" },
  { value: "level_4", label: "四级 / 中级工" },
  { value: "level_3", label: "三级 / 高级工" },
  { value: "level_2", label: "二级 / 技师" },
  { value: "level_1", label: "一级 / 高级技师" },
];

const theoryWeightRows = [
  {
    category: "基本要求",
    item: "职业道德",
    weights: ["5", "5", "5", "5", "5"],
  },
  {
    category: "基本要求",
    item: "基础知识",
    weights: ["20", "20", "20", "15", "15"],
  },
  {
    category: "相关知识要求",
    item: "作业准备",
    weights: ["20", "20", "15", "15", "10"],
  },
  {
    category: "相关知识要求",
    item: "车削加工",
    weights: ["30", "30", "35", "35", "35"],
  },
  {
    category: "相关知识要求",
    item: "质量检验",
    weights: ["15", "15", "15", "15", "15"],
  },
  {
    category: "相关知识要求",
    item: "设备维护",
    weights: ["10", "10", "10", "10", "10"],
  },
  {
    category: "相关知识要求",
    item: "技术管理和培训",
    weights: ["—", "—", "—", "5", "10"],
  },
];

function Arrow() {
  return (
    <span
      aria-hidden
      className="text-xl font-light leading-none text-[#4d70ed]"
    >
      →
    </span>
  );
}

function FlowNode({
  eyebrow,
  title,
}: Readonly<{ eyebrow?: string; title: string }>) {
  return (
    <div className="flex min-h-[54px] min-w-0 flex-1 items-center justify-center rounded-lg border border-[#dce5f4] bg-white px-2 text-center">
      <div>
        {eyebrow ? (
          <p className="m-0 text-[10px] leading-4 text-[#71809a]">{eyebrow}</p>
        ) : null}
        <p className="m-0 mt-0.5 text-[12px] font-semibold leading-5 text-[#2f4d79]">
          {title}
        </p>
      </div>
    </div>
  );
}

function BlueprintFlow({
  title,
  selected,
  nodes,
  onSelect,
}: Readonly<{
  title: string;
  selected: boolean;
  nodes: Array<{ eyebrow?: string; title: string }>;
  onSelect: () => void;
}>) {
  return (
    <article
      className={`rounded-xl border p-3 transition ${selected ? "border-[#7594ff] bg-[#f4f7ff]" : "border-[#dce5f4] bg-[#f8faff]"}`}
    >
      <h3 className="m-0 text-[15px] font-semibold text-[#2f4d79]">{title}</h3>
      <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
        {nodes.map((node, index) => (
          <div
            className="flex min-w-0 flex-1 items-center gap-2"
            key={node.title}
          >
            <FlowNode {...node} />
            {index < nodes.length - 1 ? <Arrow /> : null}
          </div>
        ))}
      </div>
      <button
        className={`mt-3 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
          selected
            ? "border-[#3f60e8] bg-[#3f60e8] text-white hover:bg-[#3354d8]"
            : "border-[#91abed] bg-white text-[#3f60e8] hover:border-[#3f60e8] hover:bg-[#f6f8ff]"
        }`}
        onClick={onSelect}
        type="button"
      >
        {selected ? `已选择${title}流程` : `选择${title}流程`}
      </button>
    </article>
  );
}

function TheoryCompilationWorkspace({
  profession,
  onReturn,
}: Readonly<{
  profession: Profession;
  onReturn: () => void;
}>) {
  const [level, setLevel] = useState("level_4");
  const [weightFileName, setWeightFileName] = useState("");
  const [isWeightImportOpen, setIsWeightImportOpen] = useState(false);
  const [isOutlineImportOpen, setIsOutlineImportOpen] = useState(false);
  const [pendingWeightFile, setPendingWeightFile] = useState<File | null>(null);
  const [pendingOutlineFile, setPendingOutlineFile] = useState<File | null>(
    null,
  );
  const [sourceVersionId, setSourceVersionId] = useState("");
  const [standards, setStandards] = useState<OccupationStandard[]>([]);
  const [weightSnapshot, setWeightSnapshot] =
    useState<TheoryWeightSnapshot | null>(null);
  const [weightDirectionId, setWeightDirectionId] = useState("");
  const [outlineSnapshot, setOutlineSnapshot] =
    useState<TheoryOutlineSnapshot | null>(null);
  const [isLoadingWeights, setIsLoadingWeights] = useState(true);
  const [isLoadingOutline, setIsLoadingOutline] = useState(true);
  const [weightError, setWeightError] = useState("");
  const [outlineError, setOutlineError] = useState("");
  const [isImportingWeights, setIsImportingWeights] = useState(false);
  const [isImportingOutline, setIsImportingOutline] = useState(false);
  const [textbookMode, setTextbookMode] = useState<"textbook" | "model">(
    "textbook",
  );
  const [pendingTextbook, setPendingTextbook] = useState<File | null>(null);
  const [textbooks, setTextbooks] = useState<Textbook[]>([]);
  const [generationJobs, setGenerationJobs] = useState<
    TheoryOutlineGenerationJob[]
  >([]);
  const [isUploadingTextbook, setIsUploadingTextbook] = useState(false);
  const [isLoadingGenerationState, setIsLoadingGenerationState] = useState(true);
  const [isStartingGeneration, setIsStartingGeneration] = useState(false);
  const [outlinePage, setOutlinePage] = useState(1);
  const currentLevel =
    theoryLevels.find((item) => item.value === level) ?? theoryLevels[1];
  const weightScopes = weightSnapshot?.scopes ?? [];
  const directionTabs = weightScopes.some((scope) => scope.directionId)
    ? weightScopes.map((scope) => ({ id: scope.directionId!, name: scope.directionName }))
    : (profession.directions ?? []).map((direction) => ({ id: direction.id, name: direction.name }));
  const selectedWeightScope = weightScopes.find((scope) => scope.directionId === (weightDirectionId || directionTabs[0]?.id));
  const displayRows: TheoryWeightItem[] = directionTabs.length
    ? selectedWeightScope?.items ?? []
    : weightSnapshot?.items ??
    theoryWeightRows.map((row) => ({
      category: row.category,
      name: row.item,
      weights: Object.fromEntries(
        theoryLevels.map((item, index) => [
          item.value,
          row.weights[index] === "—" ? null : Number(row.weights[index]),
        ]),
      ),
    }));
  const weightTotals = Object.fromEntries(theoryLevels.map((weightLevel) => [
    weightLevel.value, displayRows.some((row) => row.weights[weightLevel.value] !== null)
      ? displayRows.reduce((sum, row) => sum + (row.weights[weightLevel.value] ?? 0), 0)
      : null,
  ]));
  const categorySpans = displayRows.reduce<Record<string, number>>(
    (result, row) => {
      result[row.category] = (result[row.category] ?? 0) + 1;
      return result;
    },
    {},
  );

  useEffect(() => {
    const ids = weightSnapshot?.scopes?.filter((scope) => scope.directionId).map((scope) => scope.directionId!) ??
      (profession.directions ?? []).map((direction) => direction.id);
    setWeightDirectionId((current) => ids.includes(current) ? current : ids[0] ?? "");
  }, [weightSnapshot, profession.directions]);

  useEffect(() => {
    let active = true;
    async function loadTheoryWeights() {
      setIsLoadingWeights(true);
      setWeightError("");
      try {
        const response = await fetch(
          `/api/v1/authoring/occupations/${profession.id}/theory-weights`,
        );
        const body = (await response.json()) as {
          data?: {
            current: TheoryWeightSnapshot | null;
            standards: OccupationStandard[];
          };
          error?: { message?: string };
        };
        if (!response.ok || !body.data)
          throw new Error(body.error?.message ?? "理论知识权重表加载失败。");
        if (active) {
          setWeightSnapshot(body.data.current);
          setStandards(body.data.standards);
          setWeightFileName(body.data.current?.sourceName ?? "");
        }
      } catch (error) {
        if (active)
          setWeightError(
            error instanceof Error ? error.message : "理论知识权重表加载失败。",
          );
      } finally {
        if (active) setIsLoadingWeights(false);
      }
    }
    void loadTheoryWeights();
    return () => {
      active = false;
    };
  }, [profession.id]);

  useEffect(() => {
    let active = true;
    async function loadTheoryOutline() {
      setIsLoadingOutline(true);
      setOutlineError("");
      try {
        const response = await fetch(
          `/api/v1/authoring/occupations/${profession.id}/theory-outlines?levelCode=${encodeURIComponent(level)}`,
        );
        const body = (await response.json()) as {
          data?: { current: TheoryOutlineSnapshot | null };
          error?: { message?: string };
        };
        if (!response.ok || !body.data)
          throw new Error(body.error?.message ?? "理论知识细目表加载失败。");
        if (active) setOutlineSnapshot(body.data.current);
      } catch (error) {
        if (active)
          setOutlineError(
            error instanceof Error ? error.message : "理论知识细目表加载失败。",
          );
      } finally {
        if (active) setIsLoadingOutline(false);
      }
    }
    void loadTheoryOutline();
    return () => {
      active = false;
    };
  }, [level, profession.id]);

  const refreshGenerationState = useCallback(async () => {
    const response = await fetch(
      `/api/v1/authoring/occupations/${profession.id}/theory-outline-generation?levelCode=${encodeURIComponent(level)}`,
      { cache: "no-store" },
    );
    const body = (await response.json()) as {
      data?: { textbooks: Textbook[]; jobs: TheoryOutlineGenerationJob[] };
      error?: { message?: string };
    };
    if (!response.ok || !body.data) {
      throw new Error(body.error?.message ?? "教材与生成任务加载失败。");
    }
    setTextbooks(body.data.textbooks);
    setGenerationJobs(body.data.jobs);
    return body.data.jobs;
  }, [level, profession.id]);

  useEffect(() => {
    let active = true;
    setIsLoadingGenerationState(true);
    void refreshGenerationState()
      .catch((error: unknown) => {
        if (active) {
          setOutlineError(
            error instanceof Error ? error.message : "教材与生成任务加载失败。",
          );
        }
      })
      .finally(() => {
        if (active) setIsLoadingGenerationState(false);
      });
    return () => {
      active = false;
    };
  }, [refreshGenerationState]);

  useEffect(() => {
    setOutlinePage(1);
  }, [level, outlineSnapshot?.versionId]);

  async function importWeightTable() {
    if (isImportingWeights || (!pendingWeightFile && !sourceVersionId)) return;
    setWeightError("");
    setIsImportingWeights(true);
    try {
      const formData = new FormData();
      if (pendingWeightFile) formData.set("file", pendingWeightFile);
      if (sourceVersionId) formData.set("sourceVersionId", sourceVersionId);
      const response = await fetch(
        `/api/v1/authoring/occupations/${profession.id}/theory-weights`,
        {
          method: "POST",
          body: formData,
        },
      );
      const body = (await response.json()) as {
        data?: TheoryWeightSnapshot;
        error?: { message?: string };
      };
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? "权重表识别失败。");
      setWeightSnapshot(body.data);
      setWeightFileName(body.data.sourceName);
      setIsWeightImportOpen(false);
    } catch (error) {
      setWeightError(
        error instanceof Error ? error.message : "权重表识别失败。",
      );
    } finally {
      setIsImportingWeights(false);
    }
  }

  async function importOutlineTable() {
    if (!pendingOutlineFile) return;
    setOutlineError("");
    setIsImportingOutline(true);
    try {
      const formData = new FormData();
      formData.set("file", pendingOutlineFile);
      formData.set("levelCode", level);
      const response = await fetch(
        `/api/v1/authoring/occupations/${profession.id}/theory-outlines`,
        {
          method: "POST",
          body: formData,
        },
      );
      const body = (await response.json()) as {
        data?: TheoryOutlineSnapshot;
        error?: { message?: string };
      };
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? "细目表识别失败。");
      setOutlineSnapshot(body.data);
      setIsOutlineImportOpen(false);
    } catch (error) {
      setOutlineError(
        error instanceof Error ? error.message : "细目表识别失败。",
      );
    } finally {
      setIsImportingOutline(false);
    }
  }

  async function uploadTextbook() {
    if (!pendingTextbook || isUploadingTextbook) return;
    setOutlineError("");
    setIsUploadingTextbook(true);
    try {
      const formData = new FormData();
      formData.set("levelCode", level);
      formData.set("file", pendingTextbook);
      const response = await fetch(
        `/api/v1/authoring/occupations/${profession.id}/theory-outline-generation`,
        { method: "POST", body: formData },
      );
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "教材上传失败。");
      setPendingTextbook(null);
      await refreshGenerationState();
    } catch (error) {
      setOutlineError(error instanceof Error ? error.message : "教材上传失败。");
    } finally {
      setIsUploadingTextbook(false);
    }
  }

  async function startOutlineGeneration() {
    if (isStartingGeneration || isUploadingTextbook || isLoadingGenerationState || (textbookMode === "textbook" && pendingTextbook)) return;
    setOutlineError("");
    setIsStartingGeneration(true);
    try {
      const response = await fetch(
        `/api/v1/authoring/occupations/${profession.id}/theory-outline-generation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "generate",
            levelCode: "all",
            mode: textbookMode,
          }),
        },
      );
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "细目表任务创建失败。");
      await refreshGenerationState();
    } catch (error) {
      setOutlineError(
        error instanceof Error ? error.message : "细目表任务创建失败。",
      );
    } finally {
      setIsStartingGeneration(false);
    }
  }

  const activeGeneration = generationJobs.find(
    (job) => job.status === "queued" || job.status === "running",
  );
  const pageSize = 20;
  const totalOutlinePages = outlineSnapshot
    ? Math.max(1, Math.ceil(outlineSnapshot.points.length / pageSize))
    : 1;
  const displayedOutlinePoints = outlineSnapshot?.points.slice(
    (outlinePage - 1) * pageSize,
    outlinePage * pageSize,
  ) ?? [];

  useEffect(() => {
    if (!activeGeneration) return;
    const timer = setInterval(() => {
      void refreshGenerationState()
        .then((jobs) => {
          if (jobs.some((job) => job.status === "queued" || job.status === "running")) return;
          void fetch(
            `/api/v1/authoring/occupations/${profession.id}/theory-outlines?levelCode=${encodeURIComponent(level)}`,
          )
            .then((response) => response.json())
            .then((body: { data?: { current: TheoryOutlineSnapshot | null } }) =>
              setOutlineSnapshot(body.data?.current ?? null),
            );
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [activeGeneration, level, profession.id, refreshGenerationState]);

  return (
    <div className="mt-7">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-1 text-[15px] text-[#466188]">
        <span>
          <strong className="font-semibold text-[#294775]">当前职业：</strong>
          {profession.name}（{profession.code}）
        </span>
        <span aria-hidden>·</span>
        <span>
          <strong className="font-semibold text-[#294775]">考核方式：</strong>
          理论知识
        </span>
        <button
          className="ml-2 rounded-xl bg-[#3f60e8] px-5 py-3 text-sm font-medium text-white shadow-[0_8px_16px_rgba(63,96,232,0.18)] hover:bg-[#3354d8]"
          onClick={onReturn}
          type="button"
        >
          ← 返回职业列表
        </button>
      </div>

      <section className="mt-5 overflow-hidden rounded-[18px] border border-[#e1e6ef] bg-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-5 border-b border-[#e8ecf3] px-8 py-6">
          <div>
            <h2 className="m-0 text-lg font-semibold text-[#293242]">
              第一步 · 理论知识权重表
            </h2>
            <p className="m-0 mt-2 text-sm text-[#6f7f96]">
              权重表按照职业编制，五个等级分别记录百分比。
            </p>
          </div>
          <button
            className="rounded-lg bg-[#3f60e8] px-5 py-3 text-sm font-medium text-white shadow-[0_8px_16px_rgba(63,96,232,0.18)] transition hover:bg-[#3354d8]"
            onClick={() => {
              setPendingWeightFile(null);
              setSourceVersionId("");
              setWeightError("");
              setIsWeightImportOpen(true);
            }}
            disabled={isImportingWeights}
            type="button"
          >
            ▣ 上传文件读取权重表
          </button>
        </div>
        {directionTabs.length ? (
          <div aria-label="职业方向权重" className="flex flex-wrap gap-2 border-b border-[#e8ecf3] px-8 py-3" role="tablist">
            {directionTabs.map((direction) => (
              <button
                aria-selected={direction.id === weightDirectionId}
                aria-controls={`theory-weight-panel-${profession.id}`}
                className={`rounded-lg border px-4 py-2 text-sm font-medium ${direction.id === weightDirectionId
                  ? "border-[#3f60e8] bg-[#3f60e8] text-white"
                  : "border-[#d9e2ef] bg-white text-[#536178] hover:border-[#8ca6ee]"}`}
                id={`theory-weight-tab-${direction.id}`}
                key={direction.id}
                onClick={() => setWeightDirectionId(direction.id)}
                role="tab"
                type="button"
              >
                {direction.name}
              </button>
            ))}
          </div>
        ) : null}
        <p className="m-0 bg-[#f2f6ff] px-8 py-3 text-sm text-[#55729a]">
          {isLoadingWeights
            ? "正在读取当前职业的理论知识权重表与可用职业标准..."
            : weightSnapshot
              ? `当前为第 ${weightSnapshot.versionNo} 版，来源：${weightSnapshot.sourceName}${weightSnapshot.usedOcr ? "（已完成 OCR）" : ""}。导入新标准将创建新版本并全量替换当前项目。`
              : directionTabs.length
                ? "请上传完整国家职业标准，按已配置职业方向匹配权重并保存工作要求层级。"
                : `【离线示例数据 · 非国家职业标准原文】${profession.name}理论知识权重表示例，仅界面体验；上传并成功识别职业国家职业标准后，自动以真实数据替换。`}
        </p>
        {weightFileName ? (
          <p className="m-0 border-b border-[#e8ecf3] px-8 py-3 text-sm text-[#25886a]">
            {weightSnapshot ? "当前版本来源" : "已选择权重表文件"}：
            {weightFileName}
          </p>
        ) : null}
        {weightError && !isWeightImportOpen ? (
          <p className="m-0 border-b border-[#f2dfe2] bg-[#fff8f8] px-8 py-3 text-sm text-[#c6474e]">
            {weightError}
          </p>
        ) : null}
        <div className="overflow-x-auto" id={`theory-weight-panel-${profession.id}`} role={directionTabs.length ? "tabpanel" : undefined}
          aria-labelledby={directionTabs.length && weightDirectionId ? `theory-weight-tab-${weightDirectionId}` : undefined}>
          <table className="min-w-[1000px] w-full border-collapse text-center text-sm">
            <thead className="bg-[#fafbfe] text-[#8a98ae]">
              <tr>
                <th className="px-6 py-4 text-left font-medium">分类</th>
                <th className="px-6 py-4 text-left font-medium">项目</th>
                {theoryLevels.map((item) => (
                  <th className="px-5 py-4 font-medium" key={item.value}>
                    {item.label}（%）
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-[#344157]">
              {!displayRows.length ? (
                <tr><td className="px-6 py-10 text-[#8a98ae]" colSpan={7}>
                  {isLoadingWeights ? "正在读取权重..." : "该方向暂无匹配权重，请重新上传包含该职业方向的完整标准。"}
                </td></tr>
              ) : null}
              {displayRows.map((row, index) => (
                <tr
                  className="border-t border-[#e8ecf3]"
                  key={`${row.category}-${row.name}`}
                >
                  {index === 0 ||
                  displayRows[index - 1]?.category !== row.category ? (
                    <td
                      className="border-r border-[#e0e6f0] bg-[#f4f7fd] px-6 py-5 font-semibold text-[#42608e]"
                      rowSpan={categorySpans[row.category]}
                    >
                      {row.category}
                    </td>
                  ) : null}
                  <td className="px-6 py-5 text-left">{row.name}</td>
                  {theoryLevels.map((weightLevel) => (
                    <td
                      className="px-5 py-5"
                      key={`${row.name}-${weightLevel.value}`}
                    >
                      {row.weights[weightLevel.value] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t border-[#e0e6f0] bg-[#fafbfe] text-[#8a98ae]">
                <td className="px-6 py-4 text-left font-medium" colSpan={2}>
                  各等级权重合计
                </td>
                {theoryLevels.map((item) => (
                  <td className="px-5 py-4" key={item.value}>
                    {weightTotals[item.value] === null ? "—" : `${weightTotals[item.value]}%`}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-7 overflow-hidden rounded-[18px] border border-[#e1e6ef] bg-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-5 border-b border-[#e8ecf3] px-8 py-6">
          <div>
            <h2 className="m-0 text-lg font-semibold text-[#293242]">
              第二步 · 理论知识考评要素细目表
            </h2>
            <p className="m-0 mt-2 text-sm text-[#6f7f96]">
              选择是否有教材后生成完整细目表。
            </p>
          </div>
        </div>
        <div className="space-y-5 px-8 py-6">
          <p className="m-0 text-sm text-[#607694]">
            本次仅生成五级、四级、三级的完整细目表；下方 Tab 用于切换查看。
          </p>
            {textbookMode === "textbook" ? (
              <p className="m-0 text-sm text-[#607694]">
                按权重值 × 2 确定各范围总配额，再按内容量分配到教材章／节和标准三级条目，每等级共 200 个考评点。
                教材公共基础池只生成一次，各等级按配额复用；相关知识要求按对应等级职业标准生成，不使用教材。
              </p>
            ) : (
              <p className="m-0 text-sm text-[#607694]">
                从职业标准提取公共基本要求，按范围权重值 × 2 确定配额，再按内容量比例和最大余数法分配到编号末级条目。
                公共基础池只生成一次，各等级按配额复用；相关知识要求按对应等级权重分配到三级条目。不读取教材，权重合计为 100% 时每级 200 个，任一来源失败整批不发布。
              </p>
            )}
          <div className="flex flex-wrap items-center gap-7 text-sm text-[#536178]">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                checked={textbookMode === "textbook"}
                onChange={() => setTextbookMode("textbook")}
                type="radio"
              />
              有教材
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                checked={textbookMode === "model"}
                onChange={() => setTextbookMode("model")}
                type="radio"
              />
              无教材
            </label>
          </div>
          {textbookMode === "textbook" && !isLoadingGenerationState ? (
            <details open={!textbooks.length}>
              <summary className="cursor-pointer text-sm text-[#3f60e8]">
                {textbooks.length ? "更新教材（可选）" : "首次上传教材"}
              </summary>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label className="cursor-pointer rounded-lg border border-[#d5e0ef] bg-white px-4 py-2.5 text-sm font-medium text-[#4e6484] hover:border-[#8daaf1]">
                上传教材
                <input
                  accept=".pdf,.docx,.txt"
                  className="sr-only"
                  disabled={isUploadingTextbook || isStartingGeneration || Boolean(activeGeneration)}
                  onChange={(event) =>
                    setPendingTextbook(event.target.files?.[0] ?? null)
                  }
                  type="file"
                />
              </label>
              <span className="text-sm text-[#7b8da7]">
                {pendingTextbook?.name || "支持 PDF、DOCX、TXT"}
              </span>
              <button
                className="rounded-lg border border-[#3f60e8] px-4 py-2.5 text-sm font-medium text-[#3f60e8] disabled:cursor-not-allowed disabled:border-[#c7d1ed] disabled:text-[#9aa8c9]"
                disabled={!pendingTextbook || isUploadingTextbook}
                onClick={() => void uploadTextbook()}
                type="button"
              >
                {isUploadingTextbook ? "教材解析中..." : "确认上传"}
              </button>
            </div>
            </details>
          ) : null}
          {textbookMode === "textbook" && isLoadingGenerationState ? (
            <p className="m-0 text-sm text-[#7b8da7]">正在读取最新教材...</p>
          ) : null}
          {textbookMode === "textbook" && textbooks.length ? (
            <div className="rounded-lg bg-[#f7f9fd] px-4 py-3 text-sm text-[#526b91]">
              最新教材：{textbooks[0].originalName}，已拆分 {textbooks[0].chapterCount} 个章/节。
              {textbookMode === "textbook" ? <span> 生成时自动使用，无需重复上传。</span> : null}
              <a
                className="ml-3 text-[#3f60e8] underline"
                href={`/api/v1/authoring/sources/${textbooks[0].sourceId}/content?mode=download`}
                target="_blank"
              >
                查看教材
              </a>
              {textbooks.length > 1 ? (
                <details className="mt-2 text-[#7b8da7]">
                  <summary className="cursor-pointer">查看 {textbooks.length - 1} 个历史教材版本</summary>
                  <div className="mt-2 space-y-1">
                    {textbooks.slice(1).map((textbook) => (
                      <a
                        className="block text-[#3f60e8] underline"
                        href={`/api/v1/authoring/sources/${textbook.sourceId}/content?mode=download`}
                        key={textbook.sourceVersionId}
                        target="_blank"
                      >
                        {textbook.originalName} · {new Date(textbook.createdAt).toLocaleString("zh-CN", { hour12: false })}
                      </a>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          ) : null}
          <button
            className="rounded-lg bg-[#3f60e8] px-5 py-3 text-sm font-medium text-white shadow-[0_8px_16px_rgba(63,96,232,0.18)] transition hover:bg-[#3354d8] disabled:cursor-not-allowed disabled:bg-[#aab8eb]"
            disabled={weightScopes.length > 1 || Boolean(activeGeneration) || isStartingGeneration || isLoadingGenerationState || isUploadingTextbook || (textbookMode === "textbook" && (Boolean(pendingTextbook) || !textbooks.length))}
            onClick={() => void startOutlineGeneration()}
            type="button"
          >
            {activeGeneration
              ? "正在生成五级、四级、三级细目表..."
              : isStartingGeneration
                ? "创建任务中..."
                : textbookMode === "model"
                  ? "AI大模型生成"
                  : "生成细目表"}
          </button>
          {textbookMode === "textbook" && pendingTextbook ? (
            <p className="m-0 text-sm text-[#607694]">请先确认上传所选教材，解析完成后即可生成。</p>
          ) : null}
          {weightScopes.length > 1 ? (
            <p className="m-0 text-sm text-[#607694]">
              权重已按职业方向分别保存。当前细目表生成仅支持职业级，多方向细目表需后续按方向分别接入。
            </p>
          ) : null}
          {activeGeneration ? (
            <div className="max-w-[620px]">
              <div className="flex justify-between text-sm text-[#526b91]">
                  <span>正在按权重配额生成公共基础池和分等级考评点（批次）</span>
                <span>{activeGeneration.completedBatches} / {activeGeneration.totalBatches || "?"} 批</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#e5ebf6]">
                <div
                  className="h-full rounded-full bg-[#3f60e8] transition-all"
                  style={{ width: `${activeGeneration.totalBatches ? activeGeneration.completedBatches / activeGeneration.totalBatches * 100 : 4}%` }}
                />
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 border-t border-[#e8ecf3] pt-5">
            {theoryLevels.filter((item) => isTheoryOutlineGenerationLevel(item.value)).map((item) => (
              <button
                className={`rounded-lg border px-4 py-2 text-sm font-medium ${
                  level === item.value
                    ? "border-[#3f60e8] bg-[#3f60e8] text-white"
                    : "border-[#d9e2ef] bg-white text-[#536178] hover:border-[#8ca6ee]"
                }`}
                key={item.value}
                onClick={() => setLevel(item.value)}
                type="button"
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <p className="m-0 bg-[#f2f6ff] px-8 py-3 text-sm text-[#55729a]">
          {isLoadingOutline
            ? `正在读取${currentLevel.label}的理论知识细目表...`
            : outlineSnapshot
              ? `当前为第 ${outlineSnapshot.versionNo} 版，来源：${outlineSnapshot.sourceName}，已生成 ${outlineSnapshot.points.length} 个考评点。`
              : `当前${currentLevel.label}尚未生成细目表。生成成功后会创建新版本，历史版本将保留追溯。`}
        </p>
        {outlineError ? (
          <p className="m-0 border-b border-[#f2dfe2] bg-[#fff8f8] px-8 py-3 text-sm text-[#c6474e]">
            {outlineError}
          </p>
        ) : null}
        {generationJobs[0]?.status === "failed" ? (
          <p className="m-0 border-b border-[#f2dfe2] bg-[#fff8f8] px-8 py-3 text-sm text-[#c6474e]">
            最近一次生成失败，未发布任何不完整数据：{generationJobs[0].errorMessage || "请检查模型配置后重试。"}
          </p>
        ) : null}
        {generationJobs.filter((job) => job.status === "succeeded").length > 1 ? (
          <details className="border-b border-[#e8ecf3] px-8 py-3 text-sm text-[#607694]">
            <summary className="cursor-pointer">历史细目表版本（默认使用最新成功版本）</summary>
            <div className="mt-2 space-y-1">
              {generationJobs.filter((job) => job.status === "succeeded").slice(1).map((job) => (
                <p className="m-0" key={job.id}>
                  {job.mode === "textbook" ? "教材生成" : "AI 大模型生成"} · {job.generatedPointCount} 个考评点 · {new Date(job.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                </p>
              ))}
            </div>
          </details>
        ) : null}
        {outlineSnapshot ? (
          <div className="overflow-x-auto">
            <table className="min-w-[1500px] w-full border-collapse text-left text-sm">
              <thead className="bg-[#fafbfe] text-xs font-medium text-[#8a98ae]">
                <tr>
                  <th className="px-5 py-4 font-medium">序号</th>
                  <th className="px-5 py-4 font-medium">一级名称/代码</th>
                  <th className="px-5 py-4 font-medium">权重</th>
                  <th className="px-5 py-4 font-medium">二级名称/代码</th>
                  <th className="px-5 py-4 font-medium">权重</th>
                  <th className="px-5 py-4 font-medium">三级名称/代码</th>
                  <th className="px-5 py-4 font-medium">权重</th>
                  <th className="px-5 py-4 font-medium">代码</th>
                  <th className="px-5 py-4 font-medium">名称</th>
                  <th className="px-5 py-4 font-medium">重要程度</th>
                </tr>
              </thead>
              <tbody className="text-[#45536a]">
                {displayedOutlinePoints.map((point, index) => (
                  <tr className="border-t border-[#e8ecf3]" key={point.code}>
                    <td className="px-5 py-4">{(outlinePage - 1) * pageSize + index + 1}</td>
                    <td className="px-5 py-4">{point.primaryName}<small className="block text-[#7587a1]">{point.primaryNo}</small></td>
                    <td className="px-5 py-4 font-semibold text-[#294f99]">{point.primaryWeight ?? "—"}</td>
                    <td className="px-5 py-4">{point.secondaryName}<small className="block text-[#7587a1]">{point.secondaryNo}</small></td>
                    <td className="px-5 py-4 font-semibold text-[#294f99]">{point.secondaryWeight ?? "—"}</td>
                    <td className="px-5 py-4">
                      {point.tertiaryName}<small className="block text-[#7587a1]">{point.tertiaryNo}</small>
                      {point.remark ? <small className="mt-1 block text-amber-700">{point.remark}</small> : null}
                    </td>
                    <td className="px-5 py-4 font-semibold text-[#294f99]">{point.tertiaryWeight ?? "—"}</td>
                    <td className="px-5 py-4 font-medium text-[#3f60e8]">
                      {point.code}
                    </td>
                    <td className="px-5 py-4 font-medium text-[#35435a]">
                      {point.name}
                    </td>
                    <td className="px-5 py-4">
                      {point.importanceCode ?? ({ low: "Z", medium: "Y", high: "Y", critical: "X" } as const)[point.importance ?? "medium"]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalOutlinePages > 1 ? (
              <div className="flex items-center justify-end gap-3 border-t border-[#e8ecf3] px-6 py-4 text-sm text-[#526b91]">
                <button className="rounded border px-3 py-1 disabled:text-[#aab4c4]" disabled={outlinePage === 1} onClick={() => setOutlinePage((page) => page - 1)} type="button">上一页</button>
                <span>第 {outlinePage} / {totalOutlinePages} 页</span>
                <button className="rounded border px-3 py-1 disabled:text-[#aab4c4]" disabled={outlinePage === totalOutlinePages} onClick={() => setOutlinePage((page) => page + 1)} type="button">下一页</button>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {isOutlineImportOpen ? (
        <div
          aria-labelledby="outline-import-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[#263548]/50 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="w-full max-w-[1000px] overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-7">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="outline-import-title"
              >
                选择文件 · 识别理论知识考评要素细目表
              </h2>
              <button
                aria-label="关闭"
                className="grid h-9 w-9 place-items-center rounded-lg border-0 bg-transparent text-[30px] font-light leading-none text-[#718098] hover:bg-[#f5f7fb]"
                onClick={() => setIsOutlineImportOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="space-y-5 px-9 py-8 text-[17px] leading-8 text-[#344157]">
              <div>
                <h3 className="m-0 text-lg font-semibold">
                  上传对应等级的理论知识细目表（.xlsx）
                </h3>
                <p className="m-0 mt-1">
                  当前等级：{currentLevel.label}
                  。系统将读取一级至三级层级、考评点、重要程度、备注和教材页码。
                </p>
                <label className="mt-4 inline-flex cursor-pointer items-center gap-3 text-base text-[#293242]">
                  <span className="rounded border border-[#8e98a9] bg-[#f6f7f9] px-2 py-0.5">
                    浏览...
                  </span>
                  <span>{pendingOutlineFile?.name || "未选择文件。"}</span>
                  <input
                    accept=".xlsx"
                    className="sr-only"
                    onChange={(event) =>
                      setPendingOutlineFile(event.target.files?.[0] ?? null)
                    }
                    type="file"
                  />
                </label>
              </div>
              <div>
                <h3 className="m-0 text-lg font-semibold">识别与版本保存</h3>
                <p className="m-0 mt-1">
                  文件必须包含“一级序号、一级名称、二级序号、二级名称、三级序号、三级名称、考评点序号、考评点名称”列。识别失败不会覆盖现有版本。
                </p>
                <p className="m-0 mt-1 text-sm text-[#8491a4]">
                  导入成功后将创建新版本，并以完整快照替换当前{" "}
                  {currentLevel.label} 的考评点列表；历史版本保留追溯。
                </p>
              </div>
              {outlineError ? (
                <p className="m-0 text-sm text-[#c6474e]">{outlineError}</p>
              ) : null}
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-6 py-3 text-base text-[#536178] hover:border-[#aabcf5] hover:text-[#3f60e8]"
                onClick={() => setIsOutlineImportOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-6 py-3 text-base font-medium text-white transition hover:bg-[#3354d8] disabled:cursor-not-allowed disabled:bg-[#aab8eb]"
                disabled={!pendingOutlineFile || isImportingOutline}
                onClick={() => void importOutlineTable()}
                type="button"
              >
                {isImportingOutline ? "正在识别并保存..." : "识别细目表"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isWeightImportOpen ? (
        <div
          aria-labelledby="weight-import-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[#263548]/50 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="w-full max-w-[1256px] overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-7">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="weight-import-title"
              >
                选择文件 · 识别理论知识权重表
              </h2>
              <button
                aria-label="关闭"
                className="grid h-9 w-9 place-items-center rounded-lg border-0 bg-transparent text-[30px] font-light leading-none text-[#718098] hover:bg-[#f5f7fb]"
                onClick={() => setIsWeightImportOpen(false)}
                disabled={isImportingWeights}
                type="button"
              >
                ×
              </button>
            </div>

            <div className="space-y-3 px-9 py-8 text-[17px] leading-8 text-[#344157]">
              <div>
                <h3 className="m-0 text-lg font-semibold">
                  直接上传国家职业标准（PDF / DOCX / TXT）
                </h3>
                <p className="m-0 mt-1">
                  本地选择文件后按职业方向匹配权重表，同时保存各等级的职业功能、工作内容和技能要求。
                </p>
                <label className="mt-3 inline-flex cursor-pointer items-center gap-3 text-base text-[#293242]">
                  <span className="rounded border border-[#8e98a9] bg-[#f6f7f9] px-2 py-0.5">
                    浏览...
                  </span>
                  <span>{pendingWeightFile?.name || "未选择文件。"}</span>
                  <input
                    accept=".pdf,.docx,.txt"
                    className="sr-only"
                    disabled={isImportingWeights}
                    onChange={(event) => {
                      setPendingWeightFile(event.target.files?.[0] ?? null);
                      setSourceVersionId("");
                    }}
                    type="file"
                  />
                </label>
                <p className="m-0 mt-2 text-sm text-[#8491a4]">
                  {pendingWeightFile
                    ? "文件已选择，确认后将进入识别流程。"
                    : "尚未选择文件"}
                </p>
              </div>

              <div className="pt-1">
                <h3 className="m-0 text-lg font-semibold">
                  或者，从资料依据选择标准
                </h3>
                <p className="m-0 mt-1">
                  从“资料依据”已上传的具体职业标准中选择文件。系统将读取已保存的解析文本，定位“理论知识权重表”并识别项目、五个等级及百分比。
                </p>
                <label className="mt-3 flex items-center gap-3 text-base">
                  <span>国家职业标准文件</span>
                  <select
                    className="h-12 min-w-[230px] rounded-lg border border-[#d8e1ee] bg-white px-3 text-[#526a90] outline-none"
                    disabled={isImportingWeights}
                    onChange={(event) => {
                      setSourceVersionId(event.target.value);
                      setPendingWeightFile(null);
                    }}
                    value={sourceVersionId}
                  >
                    <option value="">请选择文件</option>
                    {standards.map((standard) => (
                      <option key={standard.id} value={standard.id}>
                        {standard.name}（{standard.original_name}）
                      </option>
                    ))}
                  </select>
                </label>
                {!standards.length ? (
                  <p className="m-0 mt-2 text-sm text-[#cf6d15]">
                    当前职业没有可选的具体职业标准，请先到“资料依据”上传并解析。
                  </p>
                ) : null}
              </div>

              <div className="pt-1">
                <h3 className="m-0 text-lg font-semibold">
                  第二步 · 识别与核对
                </h3>
                <p className="m-0 mt-1">
                  点击“识别权重表”后匹配职业方向，并同步提取工作要求层级；全部校验通过后保存新版本。无法识别时不会覆盖已有数据。
                </p>
                <p className="m-0 mt-1 text-sm text-[#8491a4]">
                  说明：PDF 优先提取原文字层；扫描件会调用
                  OCR。各职业方向的适用等级权重须合计为 100%，技能要求层级须完整。
                </p>
              </div>
              {weightError ? (
                <p className="m-0 text-sm text-[#c6474e]">{weightError}</p>
              ) : null}
            </div>

            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-6 py-3 text-base text-[#536178] hover:border-[#aabcf5] hover:text-[#3f60e8]"
                onClick={() => setIsWeightImportOpen(false)}
                disabled={isImportingWeights}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-6 py-3 text-base font-medium text-white transition hover:bg-[#3354d8] disabled:cursor-not-allowed disabled:bg-[#aab8eb]"
                disabled={
                  (!pendingWeightFile && !sourceVersionId) || isImportingWeights
                }
                onClick={() => void importWeightTable()}
                type="button"
              >
                {isImportingWeights ? "正在识别并保存..." : "识别权重表"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SkillCompilationWorkspace({
  profession,
  onReturn,
}: Readonly<{
  profession: Profession;
  onReturn: () => void;
}>) {
  const [level, setLevel] = useState("level_4");
  const [importedStandard, setImportedStandard] = useState<ImportedSkillStandard | null>(null);
  const [isLoadingStandard, setIsLoadingStandard] = useState(true);
  const [standardLoadError, setStandardLoadError] = useState("");
  const [skillWeightSnapshot, setSkillWeightSnapshot] =
    useState<SkillWeightSnapshot | null>(null);
  const [editableSkillWeights, setEditableSkillWeights] = useState<
    SkillWeightItem[]
  >([]);
  const [isWeightEditorOpen, setIsWeightEditorOpen] = useState(false);
  const [isStructureOverviewOpen, setIsStructureOverviewOpen] = useState(false);
  const [isStructureEditorOpen, setIsStructureEditorOpen] = useState(false);
  const [isAssemblyPlanOpen, setIsAssemblyPlanOpen] = useState(false);
  const [isPlanSavedOpen, setIsPlanSavedOpen] = useState(false);
  const [isPlanCheckOpen, setIsPlanCheckOpen] = useState(false);
  const [isMakeupTaskOpen, setIsMakeupTaskOpen] = useState(false);
  const [isPointEditorOpen, setIsPointEditorOpen] = useState(false);
  const [isBlueprintReviewOpen, setIsBlueprintReviewOpen] = useState(false);
  const [reviewOpinion, setReviewOpinion] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [isSavingPoint, setIsSavingPoint] = useState(false);
  const [pointError, setPointError] = useState("");
  const [skillAssessmentPoints, setSkillAssessmentPoints] = useState<
    SkillAssessmentPoint[]
  >([]);
  const [skillRefreshVersion, setSkillRefreshVersion] = useState(0);
  const refreshSkillPoints = useCallback(() => {
    setSkillRefreshVersion((value) => value + 1);
    setBlueprintApproval(null);
  }, []);
  const [editingPointCode, setEditingPointCode] = useState<string | null>(null);
  const [blueprintApproval, setBlueprintApproval] = useState<{
    opinion: string;
    approvedAt: string;
    reviewer: string;
  } | null>(null);
  const [newPoint, setNewPoint] = useState<NewSkillPoint>({
    name: "",
    level1Code: "S",
    level1Name: "操作技能",
    level2Code: "A",
    level2Name: "",
    level3Code: "A",
    level3Name: "",
    ordinal: 1,
    weight: 0,
    importance: "critical",
    abilityLevel: "理解",
    targetCount: 3,
    selection: "必考",
    method: "实操",
    minutes: 30,
    standardText: "",
    citation: "",
    knowledgeMaterial: "未关联",
    knowledgePoints: "",
  });
  const [structureName, setStructureName] = useState("");
  const [structureRuleBasis, setStructureRuleBasis] =
    useState("国家题库开发指南2024.04");
  const [structurePathway, setStructurePathway] =
    useState("实操、模拟、口试及组合");
  const [structureMinutes, setStructureMinutes] = useState(120);
  const [structureRows, setStructureRows] = useState<SkillStructureRow[]>([]);
  const [skillStructureSnapshot, setSkillStructureSnapshot] =
    useState<SkillStructureSnapshot | null>(null);
  const [structureError, setStructureError] = useState("");
  const [isSavingStructure, setIsSavingStructure] = useState(false);
  const [isLoadingSkillWeights, setIsLoadingSkillWeights] = useState(true);
  const [isSavingSkillWeights, setIsSavingSkillWeights] = useState(false);
  const [skillWeightError, setSkillWeightError] = useState("");
  const currentLevel =
    theoryLevels.find((item) => item.value === level) ?? theoryLevels[1];
  const displayedSkillWeights =
    skillWeightSnapshot?.items ?? [];
  const skillWeightTotals = theoryLevels.map((item) =>
    displayedSkillWeights.reduce(
      (total, row) => total + (row.weights[item.value] ?? 0),
      0,
    ),
  );

  useEffect(() => {
    let active = true;
    async function loadSkillWeights() {
      setIsLoadingSkillWeights(true);
      setSkillWeightError("");
      try {
        const response = await fetch(
          `/api/v1/authoring/occupations/${profession.id}/skill-weights`,
        );
        const body = (await response.json()) as {
          data?: { current: SkillWeightSnapshot | null };
          error?: { message?: string };
        };
        if (!response.ok || !body.data)
          throw new Error(
            body.error?.message ?? "职业技能要求权重表加载失败。",
          );
        if (active) setSkillWeightSnapshot(body.data.current);
      } catch (error) {
        if (active)
          setSkillWeightError(
            error instanceof Error
              ? error.message
              : "职业技能要求权重表加载失败。",
          );
      } finally {
        if (active) setIsLoadingSkillWeights(false);
      }
    }
    void loadSkillWeights();
    return () => {
      active = false;
    };
  }, [profession.id]);

  useEffect(() => {
    let active = true;
    async function loadSkillStructure() {
      try {
        const response = await fetch(
          `/api/v1/authoring/occupations/${profession.id}/skill-structures?levelCode=${encodeURIComponent(level)}`,
        );
        const body = (await response.json()) as {
          data?: { current: SkillStructureSnapshot | null };
          error?: { message?: string };
        };
        if (!response.ok || !body.data)
          throw new Error(body.error?.message ?? "操作技能内容结构加载失败。");
        if (active) setSkillStructureSnapshot(body.data.current);
      } catch (error) {
        if (active)
          setStructureError(
            error instanceof Error
              ? error.message
              : "操作技能内容结构加载失败。",
          );
      }
    }
    void loadSkillStructure();
    return () => {
      active = false;
    };
  }, [profession.id, level]);

  useEffect(() => {
    let active = true;
    async function loadBlueprintApproval() {
      const response = await fetch(
        `/api/v1/authoring/occupations/${profession.id}/skill-blueprint-review?levelCode=${encodeURIComponent(level)}`,
      );
      const body = (await response.json()) as {
        data?: { opinion: string; approvedAt: string; reviewer: string } | null;
      };
      if (active && response.ok) setBlueprintApproval(body.data ?? null);
    }
    void loadBlueprintApproval();
    return () => {
      active = false;
    };
  }, [profession.id, level, skillAssessmentPoints.length, skillRefreshVersion]);

  useEffect(() => {
    let active = true;
    async function loadSkillAssessmentPoints() {
      try {
        const response = await fetch(
          `/api/v1/authoring/occupations/${profession.id}/skill-assessment-points?levelCode=${encodeURIComponent(level)}`,
        );
        const body = (await response.json()) as {
          data?: { points: SkillAssessmentPoint[] };
          error?: { message?: string };
        };
        if (!response.ok || !body.data)
          throw new Error(body.error?.message ?? "操作技能考评点加载失败。");
        if (active) setSkillAssessmentPoints(body.data.points);
      } catch (error) {
        if (active)
          setPointError(
            error instanceof Error ? error.message : "操作技能考评点加载失败。",
          );
      }
    }
    void loadSkillAssessmentPoints();
    return () => {
      active = false;
    };
  }, [profession.id, level, skillRefreshVersion]);

  function updateWeightItem(
    index: number,
    field: "name" | string,
    value: string,
  ) {
    setEditableSkillWeights((items) =>
      items.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        return field === "name"
          ? { ...item, name: value }
          : {
              ...item,
              weights: {
                ...item.weights,
                [field]: value === "" ? 0 : Number(value),
              },
            };
      }),
    );
  }

  async function saveWeightTable() {
    setSkillWeightError("");
    setIsSavingSkillWeights(true);
    try {
      const response = await fetch(
        `/api/v1/authoring/occupations/${profession.id}/skill-weights`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: editableSkillWeights }),
        },
      );
      const body = (await response.json()) as {
        data?: SkillWeightSnapshot;
        error?: { message?: string };
      };
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? "职业技能要求权重表保存失败。");
      setSkillWeightSnapshot(body.data);
      setIsWeightEditorOpen(false);
    } catch (error) {
      setSkillWeightError(
        error instanceof Error ? error.message : "职业技能要求权重表保存失败。",
      );
    } finally {
      setIsSavingSkillWeights(false);
    }
  }

  function openStructureEditor() {
    if (skillStructureSnapshot) {
      setStructureName(skillStructureSnapshot.name);
      setStructureRuleBasis(skillStructureSnapshot.ruleBasis);
      setStructurePathway(skillStructureSnapshot.pathway);
      setStructureMinutes(skillStructureSnapshot.totalMinutes);
      setStructureRows(skillStructureSnapshot.rows);
      setStructureError("");
      setIsStructureOverviewOpen(false);
      setIsStructureEditorOpen(true);
      return;
    }
    const items = displayedSkillWeights.filter(
      (item) => item.weights[level] > 0,
    );
    setStructureName(`${profession.name}${currentLevel.label}操作技能试卷结构`);
    setStructureRows(
      items.map((item, index) => ({
        code: `4-S-${String(index + 1).padStart(3, "0")}-S${String(index + 1).padStart(2, "0")}-001`,
        name: item.name,
        selection: "required",
        score: item.weights[level],
        minutes: items.length ? structureMinutes / items.length : 0,
        method: "实操",
      })),
    );
    setStructureError("");
    setIsStructureOverviewOpen(false);
    setIsStructureEditorOpen(true);
  }

  function updateStructureRow(
    index: number,
    field: keyof SkillStructureRow,
    value: string,
  ) {
    setStructureRows((rows) =>
      rows.map((row, rowIndex) =>
        rowIndex === index
          ? {
              ...row,
              [field]: ["score", "minutes"].includes(field)
                ? Number(value)
                : value,
            }
          : row,
      ),
    );
  }

  async function saveStructure() {
    setStructureError("");
    setIsSavingStructure(true);
    try {
      const response = await fetch(
        `/api/v1/authoring/occupations/${profession.id}/skill-structures`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: structureName,
            levelCode: level,
            ruleBasis: structureRuleBasis,
            pathway: structurePathway,
            totalMinutes: structureMinutes,
            rows: structureRows,
          }),
        },
      );
      const body = (await response.json()) as {
        data?: SkillStructureSnapshot;
        error?: { message?: string };
      };
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? "内容结构保存失败。");
      setSkillStructureSnapshot(body.data);
      setIsStructureEditorOpen(false);
      setIsAssemblyPlanOpen(true);
    } catch (error) {
      setStructureError(
        error instanceof Error ? error.message : "内容结构保存失败。",
      );
    } finally {
      setIsSavingStructure(false);
    }
  }

  function downloadGapList() {
    const content = [
      "试卷,认定点,缺口原因",
      ...structureRows.flatMap((row) => [
        `试卷1,${row.name},缺少必考项`,
        `试卷2,${row.name},缺少必考项`,
      ]),
    ].join("\n");
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${profession.name}-组卷缺口清单.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function updatePoint(field: keyof NewSkillPoint, value: string) {
    setNewPoint(
      (point) =>
        ({
          ...point,
          [field]: ["ordinal", "weight", "targetCount", "minutes"].includes(
            field,
          )
            ? Number(value)
            : value,
        }) as NewSkillPoint,
    );
  }
  async function savePoint() {
    setPointError("");
    setIsSavingPoint(true);
    try {
      const response = await fetch(
        `/api/v1/authoring/occupations/${profession.id}/skill-assessment-points`,
        {
          method: editingPointCode ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...newPoint,
            levelCode: level,
            ...(editingPointCode ? { originalCode: editingPointCode } : {}),
          }),
        },
      );
      const body = (await response.json()) as {
        data?: { point: SkillAssessmentPoint };
        error?: { message?: string };
      };
      if (!response.ok || !body.data)
        throw new Error(body.error?.message ?? "考评点保存失败。");
      setSkillAssessmentPoints((points) =>
        editingPointCode
          ? points.map((point) =>
              point.code === editingPointCode ? body.data!.point : point,
            )
          : [...points, body.data!.point],
      );
      setBlueprintApproval(null);
      setEditingPointCode(null);
      setIsPointEditorOpen(false);
      refreshSkillPoints();
    } catch (error) {
      setPointError(
        error instanceof Error ? error.message : "考评点保存失败。",
      );
    } finally {
      setIsSavingPoint(false);
    }
  }
  async function approveBlueprint() {
    setReviewError("");
    setIsSavingReview(true);
    try {
      const response = await fetch(
        `/api/v1/authoring/occupations/${profession.id}/skill-blueprint-review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ levelCode: level, opinion: reviewOpinion }),
        },
      );
      const text = await response.text();
      const body = text
        ? (JSON.parse(text) as { error?: { message?: string } })
        : null;
      if (!response.ok)
        throw new Error(
          body?.error?.message ??
            `蓝图审核意见保存失败（HTTP ${response.status}）。`,
        );
      setBlueprintApproval({
        opinion: reviewOpinion,
        approvedAt: new Date().toISOString(),
        reviewer: "当前管理员",
      });
      setIsBlueprintReviewOpen(false);
    } catch (error) {
      setReviewError(
        error instanceof Error ? error.message : "蓝图审核意见保存失败。",
      );
    } finally {
      setIsSavingReview(false);
    }
  }

  return (
    <div className="mt-7">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-1 text-[15px] text-[#466188]">
        <span>
          <strong className="font-semibold text-[#294775]">当前职业：</strong>
          {profession.name}（{profession.code || "未维护职业代码"}）
        </span>
        <span aria-hidden>·</span>
        <span>
          <strong className="font-semibold text-[#294775]">考核方式：</strong>
          操作技能
        </span>
        <button
          className="ml-2 rounded-xl bg-[#3f60e8] px-5 py-3 text-sm font-medium text-white shadow-[0_8px_16px_rgba(63,96,232,0.18)] hover:bg-[#3354d8]"
          onClick={onReturn}
          type="button"
        >
          ← 返回职业列表
        </button>
      </div>

      <section className="mt-5 overflow-hidden rounded-[18px] border border-[#e1e6ef] bg-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-5 border-b border-[#e8ecf3] px-8 py-6">
          <div>
            <h2 className="m-0 text-lg font-semibold text-[#293242]">
              第一步 · 技能要求权重表
            </h2>
            <p className="m-0 mt-2 text-sm text-[#6f7f96]">
              上传本职业国家职业标准，提取五个等级及职业方向的权重；“—”表示不适用。
            </p>
          </div>
          <div className="flex items-center gap-3">
          <SkillStandardUpload occupationId={profession.id} onChange={setImportedStandard} onLoadingChange={setIsLoadingStandard} onLoadError={setStandardLoadError} />
          </div>
        </div>
        <p className="m-0 bg-[#f2f6ff] px-8 py-3 text-sm text-[#55729a]">
          {importedStandard
            ? `当前为第 ${importedStandard.versionNo} 版，来源：${importedStandard.sourceName}。`
            : isLoadingStandard || isLoadingSkillWeights
            ? "正在读取本职业共用的国家职业标准..."
            : skillWeightSnapshot
              ? `当前为第 ${skillWeightSnapshot.versionNo} 版，来源：${skillWeightSnapshot.sourceName}。`
              : "尚未上传国家职业标准，可上传识别权重表和内容结构。"}
        </p>
        {skillWeightError && !isWeightEditorOpen ? (
          <p className="m-0 border-b border-[#f2dfe2] bg-[#fff8f8] px-8 py-3 text-sm text-[#c6474e]">
            {skillWeightError}
          </p>
        ) : null}
        {importedStandard ? <SkillWeightMatrix data={importedStandard} /> : <div className="overflow-x-auto">
          <table className="min-w-[1000px] w-full border-collapse text-center text-sm">
            <thead className="bg-[#fafbfe] text-[#8a98ae]">
              <tr>
                <th className="px-6 py-4 text-left font-medium">分类</th>
                <th className="px-6 py-4 text-left font-medium">项目</th>
                {theoryLevels.map((item) => (
                  <th className="px-5 py-4 font-medium" key={item.value}>
                    {item.label}（%）
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="text-[#344157]">
              {displayedSkillWeights.map((row, index) => (
                <tr className="border-t border-[#e8ecf3]" key={row.name}>
                  {index === 0 ? (
                    <td
                      className="border-r border-[#e0e6f0] bg-[#f4f7fd] px-6 py-5 font-semibold text-[#42608e]"
                      rowSpan={displayedSkillWeights.length}
                    >
                      技能要求
                    </td>
                  ) : null}
                  <td className="px-6 py-5 text-left">{row.name}</td>
                  {theoryLevels.map((weightLevel) => (
                    <td
                      className="px-5 py-5"
                      key={`${row.name}-${weightLevel.value}`}
                    >
                      {row.weights[weightLevel.value] ?? 0}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t border-[#e0e6f0] bg-[#fafbfe] text-[#8a98ae]">
                <td className="px-6 py-4 text-left font-medium" colSpan={2}>
                  各等级权重合计
                </td>
                {skillWeightTotals.map((total, index) => (
                  <td className="px-5 py-4" key={theoryLevels[index].value}>
                    {total}%
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>}
      </section>

      <section className="mt-7 overflow-hidden rounded-[18px] border border-[#e1e6ef] bg-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-5 border-b border-[#e8ecf3] px-8 py-6">
          <div>
            <h2 className="m-0 text-lg font-semibold text-[#293242]">
              第二步 · 操作技能考评内容结构表
            </h2>
            <p className="m-0 mt-2 text-sm text-[#6f7f96]">
              按职业标准权重形成内容结构，补读原文考核方式与总时长下限；选考方式和分项时间可在右侧维护。
            </p>
          </div>
          {importedStandard ? <SkillStructureEditor key={profession.id} data={importedStandard} occupationId={profession.id}
            onSaved={(data) => { setImportedStandard(data); setSkillStructureSnapshot(null); }} /> : <button
            className="rounded-lg bg-[#3f60e8] px-5 py-3 text-sm font-medium text-white shadow-[0_8px_16px_rgba(63,96,232,0.18)] hover:bg-[#3354d8]"
            onClick={() => setIsStructureOverviewOpen(true)}
            disabled={isLoadingStandard || !skillStructureSnapshot}
            type="button"
          >
            ♢ 维护内容结构
          </button>}
        </div>
        {importedStandard ? <SkillStructureMatrix data={importedStandard} /> : <div className="overflow-x-auto">
          <table className="min-w-[1000px] w-full border-collapse text-left text-sm">
            <thead className="bg-[#fafbfe] text-xs font-medium text-[#8a98ae]">
              <tr>
                {[
                  "范围代码",
                  "考评内容",
                  "考核方式",
                  "选考要求",
                  "考核时间",
                  "对应考评点",
                ].map((header) => (
                  <th className="px-6 py-4 font-medium" key={header}>
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {skillStructureSnapshot?.rows.length ? (
                skillStructureSnapshot.rows.map((row) => (
                  <tr
                    className="border-t border-[#e8ecf3] text-[#45536a]"
                    key={row.code}
                  >
                    <td className="px-6 py-4 font-medium">{row.code}</td>
                    <td className="px-6 py-4">{row.name}</td>
                    <td className="px-6 py-4">{row.method}</td>
                    <td className="px-6 py-4">
                      {row.selection === "required" ? "必考" : "选考"}
                    </td>
                    <td className="px-6 py-4">{row.minutes} 分钟</td>
                    <td className="px-6 py-4">比重 {row.score}%</td>
                  </tr>
                ))
              ) : (
                <tr className="border-t border-[#e8ecf3]">
                  <td className="px-6 py-7 text-[#4a5668]" colSpan={6}>
                    尚无内容结构记录。点击“维护内容结构”开始编制。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>}
      </section>

      <section className="mt-7 overflow-hidden rounded-[18px] border border-[#e1e6ef] bg-white shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-5 border-b border-[#e8ecf3] px-8 py-6">
          <div>
            <h2 className="m-0 text-lg font-semibold text-[#293242]">
              第三步 · 操作技能考评要素细目表
            </h2>
            <p className="m-0 mt-2 text-sm text-[#6f7f96]">
              沿用国家职业标准和内容结构，选择有教材或无教材生成五级、四级、三级各适用方向细目表。
            </p>
            {blueprintApproval ? (
              <p className="m-0 mt-2 text-sm text-[#27805b]">
                已登记蓝图通过 ·{" "}
                {new Date(blueprintApproval.approvedAt).toLocaleString(
                  "zh-CN",
                  { hour12: false },
                )}{" "}
                · {blueprintApproval.reviewer} ·{" "}
                {blueprintApproval.opinion || "未填写审核意见"}
              </p>
            ) : (
              <p className="m-0 mt-2 text-sm text-[#a5783d]">
                当前细目表尚未审定通过，职业标准确认与细目表审定分别进行。
              </p>
            )}
          </div>
        </div>
        <SkillOutlinePanel
          occupationId={profession.id}
          occupationName={profession.name}
          level={level}
          onLevelChange={setLevel}
          standardReady={isLoadingStandard ? null : !!importedStandard}
          standardError={standardLoadError}
          onGenerated={refreshSkillPoints}
          refreshVersion={skillRefreshVersion}
          onEdit={(point) => {
            setPointError("");
            setEditingPointCode(point.code);
            setNewPoint({ ...point });
            setIsPointEditorOpen(true);
          }}
        />
      </section>

      {isPointEditorOpen ? (
        <div
          aria-labelledby="skill-point-title"
          aria-modal="true"
          className="fixed inset-0 z-[100] grid place-items-center bg-[#263548]/50 p-3 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-[1080px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="skill-point-title"
              >
                {editingPointCode ? "编辑考评点" : "新增考评点"}
              </h2>
              <button
                aria-label="关闭"
                className="border-0 bg-transparent text-[28px] font-light text-[#718098]"
                onClick={() => setIsPointEditorOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 overflow-auto px-8 py-6">
              <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                <label className="text-sm text-[#718098]">
                  考评点名称
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    onChange={(e) => updatePoint("name", e.target.value)}
                    value={newPoint.name}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  类别
                  <select className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]">
                    <option>操作技能</option>
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  技能等级
                  <select
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    onChange={(e) => setLevel(e.target.value)}
                    value={level}
                  >
                    {theoryLevels.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  一级范围
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    onChange={(e) => updatePoint("level1Name", e.target.value)}
                    value={newPoint.level1Name}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  二级职业功能名称
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    onChange={(e) => updatePoint("level2Name", e.target.value)}
                    value={newPoint.level2Name}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  二级代码
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    onChange={(e) => updatePoint("level2Code", e.target.value)}
                    value={newPoint.level2Code}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  三级工作内容名称
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    onChange={(e) => updatePoint("level3Name", e.target.value)}
                    value={newPoint.level3Name}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  三级代码
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    onChange={(e) => updatePoint("level3Code", e.target.value)}
                    value={newPoint.level3Code}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  考评点顺序号
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    min={1}
                    onChange={(e) => updatePoint("ordinal", e.target.value)}
                    type="number"
                    value={newPoint.ordinal}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  考评点占整体蓝图权重（%）
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    min={0}
                    onChange={(e) => updatePoint("weight", e.target.value)}
                    type="number"
                    value={newPoint.weight}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  重要程度
                  <select
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    onChange={(e) => updatePoint("importance", e.target.value)}
                    value={newPoint.importance}
                  >
                    <option value="critical">X 核心</option>
                    <option value="high">高</option>
                    <option value="medium">中</option>
                    <option value="low">低</option>
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  能力层次
                  <select
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    onChange={(e) =>
                      updatePoint("abilityLevel", e.target.value)
                    }
                    value={newPoint.abilityLevel}
                  >
                    <option>理解</option>
                    <option>应用</option>
                    <option>综合</option>
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  目标题量
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    min={0}
                    onChange={(e) => updatePoint("targetCount", e.target.value)}
                    type="number"
                    value={newPoint.targetCount}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  技能选考方式
                  <select
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    onChange={(e) => updatePoint("selection", e.target.value)}
                    value={newPoint.selection}
                  >
                    <option>必考</option>
                    <option>选考</option>
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  技能考核方式
                  <select
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    onChange={(e) => updatePoint("method", e.target.value)}
                    value={newPoint.method}
                  >
                    <option>实操</option>
                    <option>模拟</option>
                    <option>口试</option>
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  技能考核时间（分钟）
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-[#385578]"
                    min={0}
                    onChange={(e) => updatePoint("minutes", e.target.value)}
                    type="number"
                    value={newPoint.minutes}
                  />
                </label>
              </div>
              <label className="mt-4 block text-sm text-[#718098]">
                职业标准条款原文
                <textarea
                  className="mt-2 h-24 w-full rounded-lg border border-[#d8e1ee] p-3 text-[#385578]"
                  onChange={(e) => updatePoint("standardText", e.target.value)}
                  value={newPoint.standardText}
                />
              </label>
              <label className="mt-4 block text-sm text-[#718098]">
                命题知识要点（须原文可核实）
                <textarea
                  className="mt-2 h-24 w-full rounded-lg border border-[#d8e1ee] p-3 text-[#385578]"
                  onChange={(e) =>
                    updatePoint("knowledgePoints", e.target.value)
                  }
                  value={newPoint.knowledgePoints}
                />
              </label>
              {pointError ? (
                <p className="m-0 mt-3 text-sm text-[#c6474e]">{pointError}</p>
              ) : null}
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-8 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-6 py-3 text-base text-[#536178]"
                onClick={() => setIsPointEditorOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-6 py-3 text-base font-medium text-white disabled:bg-[#aab8eb]"
                disabled={isSavingPoint}
                onClick={() => void savePoint()}
                type="button"
              >
                {isSavingPoint
                  ? "保存中..."
                  : editingPointCode
                    ? "保存修改"
                    : "保存考评点"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isBlueprintReviewOpen ? (
        <div
          aria-labelledby="blueprint-review-title"
          aria-modal="true"
          className="fixed inset-0 z-[100] grid place-items-center bg-[#263548]/50 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="w-full max-w-[1080px] overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="blueprint-review-title"
              >
                考评蓝图审核 · {currentLevel.label} · 技能
              </h2>
              <button
                aria-label="关闭"
                className="border-0 bg-transparent text-[28px] font-light text-[#718098]"
                onClick={() => setIsBlueprintReviewOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="px-8 py-7">
              <p className="m-0 rounded-lg border border-[#f0ddb7] bg-[#fff9ed] px-5 py-4 text-sm text-[#a57b45]">
                ⓘ 先建立操作技能考评内容结构，再编制技能细目表；当前已有{" "}
                {skillAssessmentPoints.length}{" "}
                个考评点，请核对职业标准依据后登记审核结果。
              </p>
              <label className="mt-6 block text-sm text-[#718098]">
                审核意见及核对范围
                <textarea
                  className="mt-2 h-28 w-full rounded-lg border border-[#d8e1ee] p-3 text-base text-[#385578]"
                  onChange={(event) => setReviewOpinion(event.target.value)}
                  value={reviewOpinion}
                />
              </label>
              {reviewError ? (
                <p className="m-0 mt-3 text-sm text-[#c6474e]">{reviewError}</p>
              ) : null}
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-8 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-6 py-3 text-base text-[#536178]"
                onClick={() => setIsBlueprintReviewOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-6 py-3 text-base font-medium text-white disabled:bg-[#aab8eb]"
                disabled={isSavingReview}
                onClick={() => void approveBlueprint()}
                type="button"
              >
                {isSavingReview ? "登记中..." : "登记蓝图通过"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isWeightEditorOpen ? (
        <div
          aria-labelledby="skill-weight-editor-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[#263548]/50 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-[1256px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-7">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="skill-weight-editor-title"
              >
                编辑职业技能要求权重表
              </h2>
              <button
                aria-label="关闭"
                className="grid h-9 w-9 place-items-center rounded-lg border-0 bg-transparent text-[30px] font-light leading-none text-[#718098] hover:bg-[#f5f7fb]"
                onClick={() => setIsWeightEditorOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 overflow-auto px-9 py-8">
              <p className="m-0 mb-4 text-[17px] text-[#718098]">
                {profession.name} · 技能要求权重表（职业级）。
              </p>
              <table className="min-w-[1100px] w-full border-collapse text-left text-sm">
                <thead className="bg-[#f7f9fd] text-[#718098]">
                  <tr>
                    <th className="px-5 py-4 font-medium">
                      考评范围 / 职业功能
                    </th>
                    {theoryLevels.map((item) => (
                      <th
                        className="px-4 py-4 text-center font-medium"
                        key={item.value}
                      >
                        {item.label}（%）
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {editableSkillWeights.map((item, index) => (
                    <tr className="border-b border-[#e8ecf3]" key={index}>
                      <td className="px-5 py-3">
                        <input
                          className="h-9 w-full min-w-[230px] rounded border border-[#aeb6c3] px-2 text-[#293242] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                          onChange={(event) =>
                            updateWeightItem(index, "name", event.target.value)
                          }
                          placeholder="填写考评范围"
                          value={item.name}
                        />
                      </td>
                      {theoryLevels.map((weightLevel) => (
                        <td className="px-4 py-3" key={weightLevel.value}>
                          <input
                            className="h-9 w-full min-w-[115px] rounded border border-[#aeb6c3] px-2 text-center text-[#293242] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                            max={100}
                            min={0}
                            onChange={(event) =>
                              updateWeightItem(
                                index,
                                weightLevel.value,
                                event.target.value,
                              )
                            }
                            type="number"
                            value={item.weights[weightLevel.value] ?? 0}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="m-0 mt-4 text-sm text-[#8491a4]">
                每个启用技能等级的权重合计必须为 100%；未启用等级可全部填写为
                0%。
              </p>
              {skillWeightError ? (
                <p className="m-0 mt-3 text-sm text-[#c6474e]">
                  {skillWeightError}
                </p>
              ) : null}
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-6 py-3 text-base text-[#536178] hover:border-[#aabcf5] hover:text-[#3f60e8]"
                onClick={() => setIsWeightEditorOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-6 py-3 text-base font-medium text-white transition hover:bg-[#3354d8] disabled:cursor-not-allowed disabled:bg-[#aab8eb]"
                disabled={isSavingSkillWeights}
                onClick={() => void saveWeightTable()}
                type="button"
              >
                {isSavingSkillWeights ? "保存中..." : "保存权重表"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isStructureOverviewOpen ? (
        <div
          aria-labelledby="skill-structure-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[#263548]/50 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="flex w-full max-w-[1256px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-7">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="skill-structure-title"
              >
                操作技能考评内容结构表
              </h2>
              <button
                aria-label="关闭"
                className="grid h-9 w-9 place-items-center rounded-lg border-0 bg-transparent text-[30px] font-light leading-none text-[#718098] hover:bg-[#f5f7fb]"
                onClick={() => setIsStructureOverviewOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="min-h-[220px] px-9 py-10 text-[17px] leading-8 text-[#718098]">
              <p className="m-0">
                {profession.name} · {currentLevel.label} ·
                操作技能内容结构与现有结构管理关联，请在结构表中维护考评范围、考核方式、选考要求和时间；完成后返回此页在线编制细目表。
              </p>
              {skillStructureSnapshot ? (
                <div className="mt-8 rounded-xl border border-[#dce5f0] bg-[#f8faff] p-5 text-sm text-[#43516a]">
                  <p className="m-0 font-medium">
                    {skillStructureSnapshot.name} · V
                    {skillStructureSnapshot.versionNo}
                  </p>
                  <p className="m-0 mt-2">
                    共 {skillStructureSnapshot.rows.length} 个考评范围，考试时长{" "}
                    {skillStructureSnapshot.totalMinutes} 分钟。
                  </p>
                </div>
              ) : (
                <p className="m-0 mt-10 text-[#344157]">尚无内容结构。</p>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-6 py-3 text-base text-[#536178] hover:border-[#aabcf5] hover:text-[#3f60e8]"
                onClick={() => setIsStructureOverviewOpen(false)}
                type="button"
              >
                关闭
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-6 py-3 text-base font-medium text-white transition hover:bg-[#3354d8]"
                onClick={openStructureEditor}
                type="button"
              >
                进入内容结构编制
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isStructureEditorOpen ? (
        <div
          aria-labelledby="structure-editor-title"
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[#263548]/50 p-3 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-[1256px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="structure-editor-title"
              >
                建立试卷结构
              </h2>
              <button
                aria-label="关闭"
                className="grid h-10 w-10 place-items-center rounded-xl border border-[#8caefd] bg-white text-[28px] font-light leading-none text-[#718098]"
                onClick={() => setIsStructureEditorOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 overflow-auto px-9 py-7">
              <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
                <label className="text-sm text-[#718098]">
                  结构名称
                  <input
                    className="mt-2 h-14 w-full rounded-lg border border-[#d8e1ee] px-4 text-base text-[#385578] outline-none"
                    onChange={(event) => setStructureName(event.target.value)}
                    value={structureName}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  等级
                  <select
                    className="mt-2 h-14 w-full rounded-lg border border-[#d8e1ee] px-4 text-base text-[#385578] outline-none"
                    onChange={(event) => setLevel(event.target.value)}
                    value={level}
                  >
                    {theoryLevels.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  试卷类别
                  <select className="mt-2 h-14 w-full rounded-lg border border-[#d8e1ee] px-4 text-base text-[#385578] outline-none">
                    <option>操作技能</option>
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  规则依据
                  <input
                    className="mt-2 h-14 w-full rounded-lg border border-[#d8e1ee] px-4 text-base text-[#385578] outline-none"
                    onChange={(event) =>
                      setStructureRuleBasis(event.target.value)
                    }
                    value={structureRuleBasis}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  技能考核路径
                  <input
                    className="mt-2 h-14 w-full rounded-lg border border-[#d8e1ee] px-4 text-base text-[#385578] outline-none"
                    onChange={(event) =>
                      setStructurePathway(event.target.value)
                    }
                    value={structurePathway}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  考试时间（分钟）
                  <input
                    className="mt-2 h-14 w-full rounded-lg border border-[#d8e1ee] px-4 text-base text-[#385578] outline-none"
                    min={1}
                    onChange={(event) =>
                      setStructureMinutes(Number(event.target.value))
                    }
                    type="number"
                    value={structureMinutes}
                  />
                </label>
              </div>
              <h3 className="m-0 mt-3 text-lg font-semibold text-[#293242]">
                操作技能考评内容结构表
              </h3>
              <div className="mt-1 overflow-x-auto">
                <table className="min-w-[1000px] w-full border-collapse text-center text-sm">
                  <thead className="bg-[#f7f9fd] text-[#718098]">
                    <tr>
                      <th className="px-4 py-3 font-medium">认定范围</th>
                      {structureRows.map((row) => (
                        <th
                          className="min-w-[175px] px-3 py-3 font-medium"
                          key={row.code}
                        >
                          {row.name}
                          <br />
                          <span className="font-normal">{row.code}</span>
                        </th>
                      ))}
                      <th className="px-4 py-3 font-medium">合计</th>
                    </tr>
                  </thead>
                  <tbody className="text-[#385578]">
                    <tr className="border-t border-[#e1e7f1]">
                      <td className="px-4 py-3 text-[#718098]">选考方式</td>
                      {structureRows.map((row, index) => (
                        <td className="px-3 py-3" key={row.code}>
                          <select
                            className="h-11 w-[130px] rounded-lg border border-[#d8e1ee] px-2"
                            onChange={(event) =>
                              updateStructureRow(
                                index,
                                "selection",
                                event.target.value,
                              )
                            }
                            value={row.selection}
                          >
                            <option value="required">必考</option>
                            <option value="optional">选考</option>
                          </select>
                        </td>
                      ))}
                      <td>—</td>
                    </tr>
                    <tr className="border-t border-[#e1e7f1]">
                      <td className="px-4 py-3 text-[#718098]">
                        鉴定比重（%）
                      </td>
                      {structureRows.map((row, index) => (
                        <td className="px-3 py-3" key={row.code}>
                          <input
                            className="h-11 w-[130px] rounded-lg border border-[#d8e1ee] px-3 text-center"
                            min={0}
                            onChange={(event) =>
                              updateStructureRow(
                                index,
                                "score",
                                event.target.value,
                              )
                            }
                            type="number"
                            value={row.score}
                          />
                        </td>
                      ))}
                      <td>
                        {structureRows.reduce(
                          (total, row) => total + row.score,
                          0,
                        )}
                      </td>
                    </tr>
                    <tr className="border-t border-[#e1e7f1]">
                      <td className="px-4 py-3 text-[#718098]">
                        考试时间（min）
                      </td>
                      {structureRows.map((row, index) => (
                        <td className="px-3 py-3" key={row.code}>
                          <input
                            className="h-11 w-[130px] rounded-lg border border-[#d8e1ee] px-3 text-center"
                            min={0}
                            onChange={(event) =>
                              updateStructureRow(
                                index,
                                "minutes",
                                event.target.value,
                              )
                            }
                            type="number"
                            value={row.minutes}
                          />
                        </td>
                      ))}
                      <td>
                        {structureRows.reduce(
                          (total, row) => total + row.minutes,
                          0,
                        )}
                        分钟
                      </td>
                    </tr>
                    <tr className="border-t border-[#e1e7f1]">
                      <td className="px-4 py-3 text-[#718098]">考核形式</td>
                      {structureRows.map((row, index) => (
                        <td className="px-3 py-3" key={row.code}>
                          <input
                            className="h-11 w-[145px] rounded-lg border border-[#d8e1ee] px-3"
                            onChange={(event) =>
                              updateStructureRow(
                                index,
                                "method",
                                event.target.value,
                              )
                            }
                            value={row.method}
                          />
                        </td>
                      ))}
                      <td>—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="m-0 mt-3 text-sm leading-7 text-[#718098]">
                同组任选或指定一项，必考项全部纳入。各项考核形式应符合职业标准。
              </p>
              <p className="m-0 text-sm leading-7 text-[#718098]">
                按必考项与各选考组计算比重，合计应为100%。
              </p>
              {structureError ? (
                <p className="m-0 mt-2 text-sm text-[#c6474e]">
                  {structureError}
                </p>
              ) : null}
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-6 py-3 text-base text-[#536178]"
                onClick={() => setIsStructureEditorOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-6 py-3 text-base font-medium text-white disabled:bg-[#aab8eb]"
                disabled={isSavingStructure}
                onClick={() => void saveStructure()}
                type="button"
              >
                {isSavingStructure ? "保存中..." : "→ 保存结构，下一步"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isAssemblyPlanOpen ? (
        <div
          aria-labelledby="assembly-plan-title"
          aria-modal="true"
          className="fixed inset-0 z-[60] grid place-items-center bg-[#263548]/50 p-3 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-[1080px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="assembly-plan-title"
              >
                建立组卷计划
              </h2>
              <button
                aria-label="关闭"
                className="border-0 bg-transparent text-[28px] font-light text-[#718098]"
                onClick={() => setIsAssemblyPlanOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 overflow-auto px-8 py-6">
              <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                <label className="text-sm text-[#718098]">
                  计划名称
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]"
                    defaultValue={`${profession.name}${currentLevel.label}操作技能组卷计划`}
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  关联试卷结构
                  <select className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]">
                    <option>{structureName}</option>
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  组卷套数（1至10套）
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]"
                    defaultValue={2}
                    max={10}
                    min={1}
                    type="number"
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  使用范围
                  <select className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]">
                    <option>正式组卷 · 仅已审定题</option>
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  预估难度
                  <select className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]">
                    <option>不限制</option>
                  </select>
                </label>
              </div>
              <p className="m-0 mt-7 text-sm text-[#718098]">
                每格填写技能任务题号，未选的认定点留空。
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="min-w-[950px] w-full border-collapse text-center text-sm">
                  <thead className="bg-[#f2f5fb] text-[#718098]">
                    <tr>
                      <th className="px-3 py-3">认定范围</th>
                      {structureRows.map((row) => (
                        <th className="px-3 py-3" key={row.code}>
                          {row.name}
                          <br />
                          <span className="font-normal">{row.code}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-[#e1e7f1]">
                      <td className="px-3 py-4 text-[#718098]">试卷1</td>
                      {structureRows.map((row) => (
                        <td className="px-3 py-3" key={row.code}>
                          <input
                            className="h-11 w-[120px] rounded-lg border border-[#d8e1ee] px-3 text-center"
                            placeholder="题号"
                          />
                        </td>
                      ))}
                    </tr>
                    <tr className="border-t border-[#e1e7f1]">
                      <td className="px-3 py-4 text-[#718098]">试卷2</td>
                      {structureRows.map((row) => (
                        <td className="px-3 py-3" key={row.code}>
                          <input
                            className="h-11 w-[120px] rounded-lg border border-[#d8e1ee] px-3 text-center"
                            placeholder="题号"
                          />
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="m-0 mt-5 text-sm text-[#718098]">
                试卷1：0题 / 0分；试卷2：0题 /
                0分；还有10项需完善，可先保存草稿。
              </p>
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-8 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-6 py-3 text-base text-[#536178]"
                onClick={() => setIsAssemblyPlanOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-6 py-3 text-base font-medium text-white"
                onClick={() => {
                  setIsAssemblyPlanOpen(false);
                  setIsPlanSavedOpen(true);
                }}
                type="button"
              >
                保存计划草稿
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isPlanSavedOpen ? (
        <div
          aria-labelledby="plan-saved-title"
          aria-modal="true"
          className="fixed inset-0 z-[70] grid place-items-center bg-[#263548]/50 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="w-full max-w-[1080px] overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="plan-saved-title"
              >
                组卷计划已保存
              </h2>
              <button
                aria-label="关闭"
                className="border-0 bg-transparent text-[28px] font-light text-[#718098]"
                onClick={() => setIsPlanSavedOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="px-8 py-9 text-[17px] text-[#43516a]">
              <p className="m-0">
                已保存：
                <strong>
                  {profession.name}
                  {currentLevel.label}操作技能组卷计划
                </strong>
              </p>
              <p className="m-0 mt-3 text-sm leading-7 text-[#718098]">
                下一步可编排考评点与题号，随后执行组卷；如抽题条件不足，系统会列出缺口，且不会生成空白试卷。
              </p>
              <p className="m-0 mt-3 rounded-lg border border-[#d8e6ff] bg-[#f1f6ff] px-5 py-4 text-sm text-[#6686b2]">
                ⓘ 正式组卷需要结构配分、考评点对应关系及符合条件的题库试题。
              </p>
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-8 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-5 py-3 text-base text-[#536178]"
                onClick={() => setIsPlanSavedOpen(false)}
                type="button"
              >
                关闭
              </button>
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-5 py-3 text-base text-[#536178]"
                onClick={() => {
                  setIsPlanSavedOpen(false);
                  setIsAssemblyPlanOpen(true);
                }}
                type="button"
              >
                编辑并编排题号
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-5 py-3 text-base font-medium text-white"
                onClick={() => {
                  setIsPlanSavedOpen(false);
                  setIsPlanCheckOpen(true);
                }}
                type="button"
              >
                执行组卷
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isPlanCheckOpen ? (
        <div
          aria-labelledby="plan-check-title"
          aria-modal="true"
          className="fixed inset-0 z-[80] grid place-items-center bg-[#263548]/50 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="w-full max-w-[1080px] overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="plan-check-title"
              >
                组卷检查未通过
              </h2>
              <button
                aria-label="关闭"
                className="border-0 bg-transparent text-[28px] font-light text-[#718098]"
                onClick={() => setIsPlanCheckOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="space-y-6 px-8 py-7">
              <p className="m-0 rounded-lg border border-[#f0ddb7] bg-[#fff9ed] px-5 py-4 text-sm text-[#a57b45]">
                ⓘ
                未生成试卷。以下条件必须修复才能继续，不能以空题或占位题代替真实试题。
              </p>
              <div className="rounded-lg border border-[#f0ddb7] bg-[#fffaf2] px-6 py-5 text-sm leading-7 text-[#a57b45]">
                <p className="m-0 font-medium">
                  ▾ 还有 {structureRows.length * 3} 项需要处理
                </p>
                <ul className="m-0 mt-3 list-disc pl-5">
                  {structureRows
                    .flatMap((row) => [
                      `试卷1：缺少必考项${row.name}`,
                      `试卷2：缺少必考项${row.name}`,
                    ])
                    .map((message) => (
                      <li key={message}>{message}</li>
                    ))}
                </ul>
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-8 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-5 py-3 text-base text-[#536178]"
                onClick={() => {
                  setIsPlanCheckOpen(false);
                  setIsPlanSavedOpen(true);
                }}
                type="button"
              >
                返回计划
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-5 py-3 text-base font-medium text-white"
                onClick={() => {
                  setIsPlanCheckOpen(false);
                  setIsAssemblyPlanOpen(true);
                }}
                type="button"
              >
                完善题号编排
              </button>
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-5 py-3 text-base text-[#536178]"
                onClick={downloadGapList}
                type="button"
              >
                ⇩ 下载缺口清单
              </button>
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-5 py-3 text-base text-[#536178]"
                onClick={() => {
                  setIsPlanCheckOpen(false);
                  setIsMakeupTaskOpen(true);
                }}
                type="button"
              >
                ✧ 按计划补题
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isMakeupTaskOpen ? (
        <div
          aria-labelledby="makeup-task-title"
          aria-modal="true"
          className="fixed inset-0 z-[90] grid place-items-center bg-[#263548]/50 p-3 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-[1080px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="makeup-task-title"
              >
                新建智能体命题任务
              </h2>
              <button
                aria-label="关闭"
                className="border-0 bg-transparent text-[28px] font-light text-[#718098]"
                onClick={() => setIsMakeupTaskOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 overflow-auto px-8 py-7">
              <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                <label className="text-sm text-[#718098]">
                  任务名称
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]"
                    defaultValue="智能体命题任务"
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  考核方式
                  <select className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]">
                    <option>操作技能</option>
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  职业名称
                  <select className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]">
                    <option>{profession.name}</option>
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  技能等级
                  <select className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]">
                    <option>{currentLevel.label}</option>
                  </select>
                </label>
                <label className="text-sm text-[#718098]">
                  考评点名称
                  <select className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]">
                    <option>本职业、本技能等级全部考评点</option>
                  </select>
                </label>
                <div className="pt-7 text-sm text-[#344157]">
                  <strong>本级允许题型</strong>
                  <br />
                  单项选择题/判断题
                </div>
              </div>
              <h3 className="m-0 mt-2 text-lg font-semibold text-[#293242]">
                命题配额规则
              </h3>
              <p className="m-0 mt-3 text-base leading-8 text-[#344157]">
                每个考评点至少：单项选择题4道、判断题2道（共6道）。当前可选考评点：
                {structureRows.length * 4}个。
              </p>
              <p className="m-0 text-base leading-8 text-[#344157]">
                每考评点最低6题
              </p>
              <label className="mt-2 block text-sm text-[#718098]">
                关联组卷计划（二级、一级必选）
                <select className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]">
                  <option>按考评点命题</option>
                </select>
              </label>
              <label className="mt-4 block text-sm text-[#718098]">
                预估难度（1至5）
                <input
                  className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]"
                  defaultValue={3}
                  max={5}
                  min={1}
                  type="number"
                />
              </label>
              <label className="mt-4 block text-sm text-[#718098]">
                命题要求、重点及情境
                <textarea
                  className="mt-2 h-28 w-full rounded-lg border border-[#d8e1ee] p-3 text-base text-[#385578]"
                  defaultValue="依据已确认职业标准、考评要素细目表和题型规则命题，避免相似题重复。"
                />
              </label>
              <div className="mt-4 grid gap-5 sm:grid-cols-2">
                <label className="text-sm text-[#718098]">
                  本次题量上限
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]"
                    defaultValue={2000}
                    type="number"
                  />
                </label>
                <label className="text-sm text-[#718098]">
                  模型调用上限
                  <input
                    className="mt-2 h-12 w-full rounded-lg border border-[#d8e1ee] px-3 text-base text-[#385578]"
                    defaultValue={5000}
                    type="number"
                  />
                </label>
              </div>
              <p className="m-0 mt-4 text-sm text-[#718098]">
                命题结果先保存为草稿，专家审定通过后方可入库。
              </p>
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-8 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-6 py-3 text-base text-[#536178]"
                onClick={() => setIsMakeupTaskOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-6 py-3 text-base font-medium text-white"
                type="button"
              >
                检查并确认任务
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BlueprintPanel() {
  const [selectedFlow, setSelectedFlow] = useState<
    "理论知识" | "操作技能" | null
  >(null);
  const [keyword, setKeyword] = useState("");
  const [professions, setProfessions] = useState<Profession[]>([]);
  const [isLoadingProfessions, setIsLoadingProfessions] = useState(false);
  const [listError, setListError] = useState("");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingProfession, setEditingProfession] = useState<Profession | null>(
    null,
  );
  const [compilingProfession, setCompilingProfession] =
    useState<Profession | null>(null);
  const [compilingSkillProfession, setCompilingSkillProfession] =
    useState<Profession | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [directions, setDirections] = useState<DirectionDraft[]>([]);
  const directionKey = useRef(0);
  const [formError, setFormError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const filteredProfessions = professions.filter((profession) =>
    `${profession.name}${profession.code}`
      .toLowerCase()
      .includes(keyword.trim().toLowerCase()),
  );

  useEffect(() => {
    let active = true;

    async function loadProfessions() {
      setIsLoadingProfessions(true);
      setListError("");
      try {
        const response = await fetch("/api/v1/authoring/occupations");
        const body = (await response.json()) as {
          data?: Profession[];
          error?: { message?: string };
        };
        if (!response.ok) {
          throw new Error(body.error?.message ?? "职业列表加载失败。");
        }
        if (active) {
          setProfessions(body.data ?? []);
        }
      } catch (error) {
        if (active) {
          setListError(
            error instanceof Error ? error.message : "职业列表加载失败。",
          );
        }
      } finally {
        if (active) {
          setIsLoadingProfessions(false);
        }
      }
    }

    void loadProfessions();
    return () => {
      active = false;
    };
  }, []);

  function openCreateModal() {
    setName("");
    setCode("");
    setDirections([{ key: `new-${++directionKey.current}`, name: "" }]);
    setFormError("");
    setEditingProfession(null);
    setIsCreateModalOpen(true);
  }

  function openEditModal(profession: Profession) {
    setName(profession.name);
    setCode(profession.code);
    setDirections(profession.directions?.length
      ? profession.directions.map((direction) => ({ ...direction, key: direction.id }))
      : [{ key: `new-${++directionKey.current}`, name: "" }]);
    setFormError("");
    setEditingProfession(profession);
    setIsCreateModalOpen(true);
  }

  async function saveProfession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSaving) return;
    setFormError("");

    if (!name.trim() || !code.trim()) {
      setFormError("请填写职业名称和职业代码。");
      return;
    }
    const submittedDirections = directions.every((direction) => !direction.id && !direction.name.trim())
      ? []
      : directions.map((direction) => ({ id: direction.id, name: direction.name.trim() }));
    if (submittedDirections.some((direction) => !direction.name)) {
      setFormError("请填写职业方向名称，或移除空白方向。");
      return;
    }
    if (new Set(submittedDirections.map((direction) => direction.name.toLowerCase())).size !== submittedDirections.length) {
      setFormError("职业方向名称不能重复。");
      return;
    }

    setIsSaving(true);
    try {
      const response = await fetch(
        editingProfession
          ? `/api/v1/authoring/occupations/${editingProfession.id}`
          : "/api/v1/authoring/occupations",
        {
          method: editingProfession ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, code, directions: submittedDirections }),
        },
      );
      const body = (await response.json()) as {
        data?: Profession;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) {
        throw new Error(body.error?.message ?? "职业保存失败。");
      }
      setProfessions((current) =>
        editingProfession
          ? current.map((profession) =>
              profession.id === editingProfession.id
                ? (body.data as Profession)
                : profession,
            )
          : [body.data as Profession, ...current],
      );
      setIsCreateModalOpen(false);
      setEditingProfession(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "职业保存失败。");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <div>
        <h1 className="m-0 text-[28px] font-semibold tracking-[-0.02em] text-[#293242]">
          考评蓝图
        </h1>
        <p className="m-0 mt-3 text-[15px] text-[#7b879a]">
          先选择编制流程，再选择职业，进入对应权重表、结构表和细目表的在线编制。
        </p>
      </div>

      <section className="mt-9 overflow-hidden rounded-[20px] border border-[#e0e6f0] bg-white shadow-card">
        <div className="border-b border-[#e7eaf0] px-8 py-5">
          <h2 className="m-0 text-lg font-semibold text-[#293242]">
            考评蓝图编制业务流程
          </h2>
        </div>
        <div className="grid gap-3 p-3 md:grid-cols-2">
          <BlueprintFlow
            nodes={[
              { eyebrow: "国家职业标准", title: "理论知识权重表" },
              { title: "理论知识考评要素细目表" },
            ]}
            onSelect={() => setSelectedFlow("理论知识")}
            selected={selectedFlow === "理论知识"}
            title="理论知识"
          />
          <BlueprintFlow
            nodes={[
              { eyebrow: "国家职业标准", title: "技能要求权重表" },
              { title: "操作技能考评内容结构表" },
              { title: "操作技能考评要素细目表" },
            ]}
            onSelect={() => setSelectedFlow("操作技能")}
            selected={selectedFlow === "操作技能"}
            title="操作技能"
          />
        </div>
      </section>

      {selectedFlow === "理论知识" && compilingProfession ? (
        <TheoryCompilationWorkspace
          onReturn={() => setCompilingProfession(null)}
          profession={compilingProfession}
        />
      ) : selectedFlow === "操作技能" && compilingSkillProfession ? (
        <SkillCompilationWorkspace
          onReturn={() => setCompilingSkillProfession(null)}
          profession={compilingSkillProfession}
        />
      ) : selectedFlow ? (
        <section className="mt-7 overflow-hidden rounded-[20px] border border-[#e0e6f0] bg-white shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-5 border-b border-[#e7eaf0] px-8 py-6">
            <div>
              <h2 className="m-0 text-lg font-semibold text-[#293242]">
                {selectedFlow} · 职业列表
              </h2>
              <p className="m-0 mt-2 text-sm text-[#768091]">
                {selectedFlow === "理论知识"
                  ? "选择职业后，先编制该职业的理论知识权重表，再按技能等级编制理论知识考评要素细目表。"
                  : "选择职业后，先编制该职业的技能要求权重表，再按技能等级编制操作技能考评内容结构表与操作技能考评要素细目表。"}
              </p>
            </div>
            <button
              className="rounded-lg bg-[#3f60e8] px-5 py-2.5 text-sm font-medium text-white shadow-[0_8px_16px_rgba(63,96,232,0.18)] transition hover:bg-[#3354d8]"
              onClick={openCreateModal}
              type="button"
            >
              ＋ 新建职业
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-b border-[#eef0f4] px-8 py-5">
            <label
              className="shrink-0 text-sm font-medium text-[#536178]"
              htmlFor="blueprint-profession-search"
            >
              搜索职业
            </label>
            <input
              className="h-11 min-w-[240px] flex-1 rounded-xl border border-[#dce5f0] bg-white px-4 text-sm text-[#293242] outline-none transition placeholder:text-[#a7b1c1] focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
              id="blueprint-profession-search"
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="请输入职业名称或职业代码"
              value={keyword}
            />
            <button
              className="h-10 rounded-lg border border-[#dce5f0] bg-white px-4 text-sm text-[#60708a] hover:border-[#aabcf5] hover:text-[#3f60e8]"
              type="button"
            >
              搜索
            </button>
            <button
              className="h-10 rounded-lg border border-[#dce5f0] bg-white px-4 text-sm text-[#60708a] hover:border-[#aabcf5] hover:text-[#3f60e8]"
              onClick={() => setKeyword("")}
              type="button"
            >
              清空
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[760px] w-full border-collapse text-left">
              <thead className="bg-[#fafbfe] text-xs font-medium text-[#93a0b3]">
                <tr>
                  <th className="px-6 py-4 font-medium">序号</th>
                  <th className="px-6 py-4 font-medium">职业名称</th>
                  <th className="px-6 py-4 font-medium">职业代码</th>
                  <th className="px-6 py-4 font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="text-sm text-[#4a5668]">
                {filteredProfessions.map((profession) => (
                  <tr
                    className="border-t border-[#eef0f4] transition hover:bg-[#fbfcff]"
                    key={profession.id}
                  >
                    <td className="px-6 py-5">
                      {professions.indexOf(profession) + 1}
                    </td>
                    <td className="px-6 py-5 font-medium text-[#39475c]">
                      {profession.name}
                    </td>
                    <td className="px-6 py-5">{profession.code}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <button
                          className="rounded-lg bg-[#3f60e8] px-3.5 py-2 text-xs font-medium text-white hover:bg-[#3354d8]"
                          onClick={() => {
                            if (selectedFlow === "理论知识")
                              setCompilingProfession(profession);
                            if (selectedFlow === "操作技能")
                              setCompilingSkillProfession(profession);
                          }}
                          type="button"
                        >
                          进入编制
                        </button>
                        <button
                          className="rounded-lg border border-[#dfe5ef] bg-white px-3.5 py-2 text-xs font-medium text-[#60708a] hover:border-[#aabcf5] hover:text-[#3f60e8]"
                          onClick={() => openEditModal(profession)}
                          type="button"
                        >
                          编辑
                        </button>
                        <button
                          className="rounded-lg border border-[#f2dfe2] bg-[#fff8f8] px-3.5 py-2 text-xs font-medium text-[#d96a74] hover:bg-[#fff0f1]"
                          type="button"
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!isLoadingProfessions && filteredProfessions.length === 0 ? (
                  <tr className="border-t border-[#eef0f4]">
                    <td
                      className="px-6 py-12 text-center text-sm text-[#8b96a8]"
                      colSpan={4}
                    >
                      {listError ||
                        (keyword ? "未找到匹配的职业" : "暂未创建职业")}
                    </td>
                  </tr>
                ) : null}
                {isLoadingProfessions ? (
                  <tr className="border-t border-[#eef0f4]">
                    <td
                      className="px-6 py-12 text-center text-sm text-[#8b96a8]"
                      colSpan={4}
                    >
                      正在加载职业列表...
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {isCreateModalOpen ? (
        <div
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-[#263548]/50 p-4 backdrop-blur-[2px]"
          role="dialog"
          aria-labelledby="profession-editor-title"
        >
          <form
            className="flex max-h-[90vh] w-full max-w-[812px] flex-col overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]"
            onSubmit={saveProfession}
          >
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-7">
              <h2
                className="m-0 text-[24px] font-semibold text-[#293242]"
                id="profession-editor-title"
              >
                {editingProfession ? "编辑职业" : "新建职业"}
              </h2>
              <button
                aria-label="关闭"
                className="grid h-9 w-9 place-items-center rounded-lg border-0 bg-transparent text-[30px] font-light leading-none text-[#718098] hover:bg-[#f5f7fb]"
                onClick={() => setIsCreateModalOpen(false)}
                disabled={isSaving}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="grid gap-5 overflow-y-auto px-9 py-8 sm:grid-cols-2">
              <label className="block text-base text-[#71809a]">
                职业名称
                <input
                  autoFocus
                  className="mt-2 block h-14 w-full rounded-lg border border-[#d8e1ee] px-4 text-base text-[#293242] outline-none transition focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                  maxLength={200}
                  disabled={isSaving}
                  onChange={(event) => setName(event.target.value)}
                  value={name}
                />
              </label>
              <label className="block text-base text-[#71809a]">
                职业代码
                <input
                  className="mt-2 block h-14 w-full rounded-lg border border-[#d8e1ee] px-4 text-base text-[#293242] outline-none transition focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                  maxLength={64}
                  disabled={isSaving}
                  onChange={(event) => setCode(event.target.value)}
                  value={code}
                />
              </label>
              <div className="min-w-0 sm:col-span-2">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-base text-[#71809a]">职业方向</span>
                  <button
                    className="rounded-lg border border-[#dce3ee] px-3 py-2 text-sm text-[#3f60e8] disabled:opacity-50"
                    disabled={isSaving}
                    onClick={() => {
                      const direction = { key: `new-${++directionKey.current}`, name: "" };
                      setDirections((current) => [...current, direction]);
                    }}
                    type="button"
                  >
                    添加方向
                  </button>
                </div>
                <div className="grid gap-3">
                  {directions.map((direction, index) => {
                    const directionCode = direction.directionCode ?? formatDirectionCode(
                      (editingProfession?.nextDirectionNumber ?? 1) +
                      directions.slice(0, index).filter((item) => !item.id).length,
                    );
                    return (
                      <div className="flex flex-wrap items-center gap-3" key={direction.key}>
                        <input
                          aria-label={`职业方向 ${index + 1}`}
                          className="h-12 min-w-0 flex-1 rounded-lg border border-[#d8e1ee] px-4 text-base text-[#293242] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                          disabled={isSaving}
                          maxLength={200}
                          onChange={(event) => setDirections((current) => current.map((item) =>
                            item.key === direction.key ? { ...item, name: event.target.value } : item))}
                          value={direction.name}
                        />
                        <span className="max-w-full break-all text-sm text-[#71809a]" aria-label={`职业方向 ${index + 1} 编码`}>
                          {code.trim() ? `${code.trim()}-${directionCode}` : directionCode}
                        </span>
                        <button
                          aria-label={`移除职业方向 ${index + 1}`}
                          className="rounded-lg px-2 py-2 text-sm text-[#71809a] hover:text-[#c6474e] disabled:opacity-50"
                          disabled={isSaving}
                          onClick={() => setDirections((current) => current.filter((item) => item.key !== direction.key))}
                          type="button"
                        >
                          移除
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
              <p className="m-0 sm:col-span-2 text-base text-[#748197]">
                职业为权重表的管理单位，细目表按职业及技能等级分别编制。职业代码请按国家职业标准填写。
              </p>
              {formError ? (
                <p className="m-0 sm:col-span-2 text-sm text-[#c6474e]">
                  {formError}
                </p>
              ) : null}
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
              <button
                className="rounded-lg border border-[#dce3ee] bg-white px-6 py-3 text-base text-[#536178] hover:border-[#aabcf5] hover:text-[#3f60e8]"
                onClick={() => setIsCreateModalOpen(false)}
                disabled={isSaving}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-lg bg-[#3f60e8] px-6 py-3 text-base font-medium text-white transition hover:bg-[#3354d8] disabled:cursor-not-allowed disabled:bg-[#aab8eb]"
                disabled={isSaving}
                type="submit"
              >
                {isSaving ? "保存中..." : "保存"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function PlaceholderPanel({
  tab,
}: Readonly<{ tab: Exclude<AuthoringTab, "考评蓝图"> }>) {
  const content = tabDescriptions[tab];

  return (
    <div>
      <h1 className="m-0 text-[28px] font-semibold tracking-[-0.02em] text-[#293242]">
        {content.title}
      </h1>
      <p className="m-0 mt-3 text-[15px] text-[#7b879a]">
        {content.description}
      </p>
      <section className="mt-9 grid min-h-[360px] place-items-center rounded-[20px] border border-[#e0e6f0] bg-white px-6 text-center shadow-card">
        <div>
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-[#f0f4ff] text-xl text-[#3f60e8]">
            +
          </div>
          <h2 className="m-0 mt-4 text-lg font-semibold text-[#293242]">
            {content.title}功能即将接入
          </h2>
          <p className="m-0 mt-2 max-w-md text-sm text-[#768091]">
            当前已完成模块导航和页面框架，下一步将接入该页的业务数据与操作流程。
          </p>
        </div>
      </section>
    </div>
  );
}

function QualityInspectionPanel() {
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({
    type: "B 单项选择题",
    level: "四级 / 中级工",
    point: "4级 · 作业复核复核（样例23）",
    coverage: "",
    score: "1",
    difficulty: "2",
    stem: "【流程样例23】在作业复核环节，以下哪项处理符合给定练习素材的要求？",
    optionA:
      "复核人员逐项检查任务要求与记录是否一致；发现记录缺项时要求补充实际信息",
    optionB: "省略核对，直接继续作业",
    optionC: "依据个人猜测补写记录",
    optionD: "口头说明，不保留处理记录",
    answer: "A",
    analysis:
      "复核人员逐项检查任务要求与记录是否一致；发现记录缺项时要求补充实际信息，禁止猜填。",
    revision: "",
  });
  const update = (key: keyof typeof form, value: string) =>
    setForm({ ...form, [key]: value });
  const saveRevision = () => {
    setIsEditorOpen(false);
    setNotice("已保存修订并形成新版本，等待重新质量检查。");
  };
  return (
    <div>
      <div>
        <h1 className="m-0 text-[30px] font-semibold text-[#293242]">
          质量检查
        </h1>
        <p className="m-0 mt-3 text-[16px] text-[#7b879a]">
          查看命题草稿的结构校验、专家退回意见和修订版本，未通过专家审定的内容不得入库。
        </p>
      </div>
      {notice ? (
        <p className="mt-5 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-5 py-4 text-[#4265d4]">
          {notice}
        </p>
      ) : null}
      <section className="mt-8 overflow-hidden rounded-[20px] border border-[#e0e6f0] bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
          <div>
            <h2 className="m-0 text-xl font-semibold text-[#293242]">
              待修订试题
            </h2>
            <p className="m-0 mt-2 text-sm text-[#7185a5]">
              专家退回 1 题，需补充复核对象与处理步骤的记录要求。
            </p>
          </div>
          <span className="rounded-lg bg-[#fff2ef] px-3 py-2 text-sm text-[#c66b56]">
            待修订
          </span>
        </div>
        <article className="flex items-center gap-6 px-8 py-7">
          <span className="grid h-12 w-12 place-items-center rounded-lg bg-[#edf4ff] font-semibold text-[#4265e8]">
            B
          </span>
          <div className="flex-1">
            <h3 className="m-0 text-lg font-semibold text-[#30415e]">
              【流程样例23】作业复核环节选择题
            </h3>
            <p className="m-0 mt-2 text-sm text-[#7185a5]">
              四级 / 中级工 · 关联考评点：作业复核复核 · 当前版本：V1
            </p>
            <p className="m-0 mt-2 text-sm text-[#a36d2a]">
              专家意见：请将核对对象和处理步骤写清楚，并补充对应的记录要求。
            </p>
          </div>
          <button
            className="rounded-xl bg-[#405fe7] px-5 py-3 text-base font-medium text-white"
            onClick={() => setIsEditorOpen(true)}
            type="button"
          >
            ✎ 编辑修订
          </button>
        </article>
      </section>
      {isEditorOpen ? (
        <div
          aria-labelledby="quality-editor-title"
          aria-modal="true"
          className="fixed inset-0 z-[160] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="flex max-h-[94vh] w-full max-w-[1255px] flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
              <h2
                className="m-0 text-[26px] font-semibold text-[#293242]"
                id="quality-editor-title"
              >
                编辑并形成新版本
              </h2>
              <button
                className="text-3xl text-[#6f8099]"
                onClick={() => setIsEditorOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-9">
              <section className="rounded-xl border border-[#bfd3fb] bg-[#f4f7ff] p-6">
                <h3 className="m-0 text-lg font-semibold text-[#30415e]">
                  专家退回意见
                </h3>
                <div className="mt-6 border-t border-[#dfe8f8] pt-6">
                  <strong className="text-[#284b82]">流程样例</strong>
                  <p className="mb-0 mt-4 text-[#354761]">
                    【预置样例意见】请将核对对象和处理步骤写清楚，并补充对应的记录要求。
                  </p>
                  <p className="mb-0 mt-5 text-sm text-[#61799e]">
                    2026-10-18T23:23:00.000Z
                  </p>
                </div>
              </section>
              <div className="mt-7 grid gap-5 md:grid-cols-2">
                <label className="text-base text-[#527098]">
                  题型
                  <select
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] bg-white px-4 text-[#385578]"
                    onChange={(event) => update("type", event.target.value)}
                    value={form.type}
                  >
                    <option>B 单项选择题</option>
                    <option>C 判断题</option>
                    <option>D 多项选择题</option>
                  </select>
                </label>
                <label className="text-base text-[#527098]">
                  技能等级
                  <select
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] bg-white px-4 text-[#385578]"
                    onChange={(event) => update("level", event.target.value)}
                    value={form.level}
                  >
                    <option>四级 / 中级工</option>
                    <option>五级 / 初级工</option>
                    <option>三级 / 高级工</option>
                  </select>
                </label>
              </div>
              <label className="mt-5 block text-base text-[#527098]">
                关联考评点
                <select
                  className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] bg-white px-4 text-[#385578]"
                  onChange={(event) => update("point", event.target.value)}
                  value={form.point}
                >
                  <option>4级 · 作业复核复核（样例23）</option>
                  <option>4级 · 工作记录管理</option>
                </select>
              </label>
              <label className="mt-5 block text-base text-[#527098]">
                综合题覆盖考评点与配分（每行：考评点ID=分值）
                <textarea
                  className="mt-2 h-24 w-full rounded-xl border border-[#cbdaf0] p-4 text-[#385578]"
                  onChange={(event) => update("coverage", event.target.value)}
                  value={form.coverage}
                />
              </label>
              <div className="mt-5 grid gap-5 md:grid-cols-2">
                <label className="text-base text-[#527098]">
                  本题分值
                  <input
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] px-4 text-[#385578]"
                    min="1"
                    onChange={(event) => update("score", event.target.value)}
                    type="number"
                    value={form.score}
                  />
                </label>
                <label className="text-base text-[#527098]">
                  预计难度（在5）
                  <input
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] px-4 text-[#385578]"
                    max="5"
                    min="1"
                    onChange={(event) =>
                      update("difficulty", event.target.value)
                    }
                    type="number"
                    value={form.difficulty}
                  />
                </label>
              </div>
              <label className="mt-5 block text-base text-[#527098]">
                题干 / 考核任务
                <textarea
                  className="mt-2 h-28 w-full rounded-xl border border-[#cbdaf0] p-4 text-[#385578]"
                  onChange={(event) => update("stem", event.target.value)}
                  value={form.stem}
                />
              </label>
              <p className="mb-0 mt-6 text-base text-[#527098]">选择题选项</p>
              <div className="mt-3 grid gap-5 md:grid-cols-2">
                {(["optionA", "optionB", "optionC", "optionD"] as const).map(
                  (key, index) => (
                    <label className="text-base text-[#527098]" key={key}>
                      选项 {String.fromCharCode(65 + index)}
                      <input
                        className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] px-4 text-[#385578]"
                        onChange={(event) => update(key, event.target.value)}
                        value={form[key]}
                      />
                    </label>
                  ),
                )}
              </div>
              <label className="mt-5 block text-base text-[#527098]">
                标准答案 / 参考答案
                <textarea
                  className="mt-2 h-24 w-full rounded-xl border border-[#cbdaf0] p-4 text-[#385578]"
                  onChange={(event) => update("answer", event.target.value)}
                  value={form.answer}
                />
              </label>
              <label className="mt-5 block text-base text-[#527098]">
                答案解析
                <textarea
                  className="mt-2 h-28 w-full rounded-xl border border-[#cbdaf0] p-4 text-[#385578]"
                  onChange={(event) => update("analysis", event.target.value)}
                  value={form.analysis}
                />
              </label>
              <label className="mt-5 block text-base text-[#527098]">
                本次修订说明
                <textarea
                  className="mt-2 h-28 w-full rounded-xl border border-[#cbdaf0] p-4 text-[#385578]"
                  onChange={(event) => update("revision", event.target.value)}
                  value={form.revision}
                />
              </label>
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
              <button
                className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
                onClick={() => setIsEditorOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-xl bg-[#405fe7] px-5 py-3 text-base font-medium text-white"
                onClick={saveRevision}
                type="button"
              >
                保存并重新检查
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type SourceMaterial = {
  id: string;
  name: string;
  source_type: string;
  remark: string | null;
  original_name: string;
  size_bytes: number;
  created_at: string;
};
type SourcePreview = {
  name: string;
  sourceType: string;
  remark: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  parseStatus: string;
  extractedText: string | null;
};

function SourceMaterialsPanel() {
  const [materials, setMaterials] = useState<SourceMaterial[]>([]);
  const [query, setQuery] = useState("");
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState("occupation_standard");
  const [remark, setRemark] = useState("");
  const [notice, setNotice] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [previewMaterial, setPreviewMaterial] = useState<SourceMaterial | null>(
    null,
  );
  const [previewData, setPreviewData] = useState<SourcePreview | null>(null);
  const [previewTab, setPreviewTab] = useState<"original" | "text">("original");
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isExtractingText, setIsExtractingText] = useState(false);
  const [verificationMaterial, setVerificationMaterial] =
    useState<SourceMaterial | null>(null);
  const [verification, setVerification] = useState({
    occupationName: "",
    applicableLevel: "",
    versionLabel: "",
    locator: "",
    remark: "",
    verified: true,
  });
  const [isSavingVerification, setIsSavingVerification] = useState(false);
  const [isCodeReferenceOpen, setIsCodeReferenceOpen] = useState(false);
  const sourceTypeLabels: Record<string, string> = {
    occupation_standard: "具体职业标准",
    textbook: "教材",
    general_document: "通用文件",
    sample_paper: "样卷",
    outline_sheet: "细目表",
    structure_sheet: "结构表",
    other: "其他",
  };
  const loadMaterials = async () => {
    try {
      const response = await fetch("/api/v1/authoring/sources");
      const payload = (await response.json()) as {
        data?: SourceMaterial[];
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(payload.error?.message ?? "资料列表加载失败。");
      setMaterials(payload.data ?? []);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "资料列表加载失败。");
    }
  };
  useEffect(() => {
    void loadMaterials();
  }, []);
  const selectFile = (selected: File | null) => {
    if (!selected) return;
    if (
      ![
        "application/pdf",
        "text/plain",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ].includes(selected.type) &&
      !/\.(pdf|docx|txt)$/i.test(selected.name)
    ) {
      setNotice("仅支持 PDF、DOCX、TXT 文件。");
      return;
    }
    if (selected.size > 15 * 1024 * 1024) {
      setNotice("单个文件不得超过 15MB。");
      return;
    }
    setFile(selected);
    setName((current) => current || selected.name.replace(/\.[^.]+$/, ""));
    setNotice("");
  };
  const saveMaterial = async () => {
    if (!file || !name.trim()) {
      setNotice("请选择文件并填写资料名称。");
      return;
    }
    setIsSaving(true);
    try {
      const formData = new FormData();
      formData.set("file", file);
      formData.set("name", name.trim());
      formData.set("sourceType", sourceType);
      formData.set("remark", remark.trim());
      const response = await fetch("/api/v1/authoring/sources", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(payload.error?.message ?? "资料保存失败。");
      setIsUploadOpen(false);
      setFile(null);
      setName("");
      setRemark("");
      setNotice("资料已保存，等待解析后可作为命题依据使用。");
      await loadMaterials();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "资料保存失败。");
    } finally {
      setIsSaving(false);
    }
  };
  const openPreview = async (material: SourceMaterial) => {
    setPreviewMaterial(material);
    setPreviewData(null);
    setPreviewTab("original");
    setIsLoadingPreview(true);
    try {
      const response = await fetch(
        `/api/v1/authoring/sources/${material.id}/content`,
      );
      const payload = (await response.json()) as {
        data?: SourcePreview;
        error?: { message?: string };
      };
      if (!response.ok || !payload.data)
        throw new Error(payload.error?.message ?? "资料内容加载失败。");
      setPreviewData(payload.data);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "资料内容加载失败。");
    } finally {
      setIsLoadingPreview(false);
    }
  };
  const downloadExtractedText = async () => {
    if (!previewMaterial || isExtractingText) return;
    setIsExtractingText(true);
    setNotice("");
    try {
      const response = await fetch(
        `/api/v1/authoring/sources/${previewMaterial.id}/content?mode=text-download`,
      );
      if (!response.ok) {
        const payload = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(payload.error?.message ?? "提取文本失败。");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
      const filename = encodedName
        ? decodeURIComponent(encodedName)
        : `${previewMaterial.name}-提取文本.txt`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "提取文本失败。");
    } finally {
      setIsExtractingText(false);
    }
  };
  const openVerification = (material: SourceMaterial) => {
    setVerificationMaterial(material);
    setVerification({
      occupationName: "",
      applicableLevel: "",
      versionLabel: "",
      locator: "",
      remark: material.remark ?? "",
      verified: true,
    });
  };
  const saveVerification = async () => {
    if (!verificationMaterial) return;
    setIsSavingVerification(true);
    try {
      const response = await fetch(
        `/api/v1/authoring/sources/${verificationMaterial.id}/content`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(verification),
        },
      );
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(payload.error?.message ?? "核验信息保存失败。");
      setVerificationMaterial(null);
      setNotice("核验信息已保存，并已写入审计记录。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "核验信息保存失败。");
    } finally {
      setIsSavingVerification(false);
    }
  };
  const filteredMaterials = materials.filter((material) =>
    `${material.name}${material.remark ?? ""}${sourceTypeLabels[material.source_type] ?? ""}`.includes(
      query.trim(),
    ),
  );
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <h1 className="m-0 text-[30px] font-semibold text-[#293242]">
            标准与资料
          </h1>
          <p className="m-0 mt-3 text-[16px] text-[#7b879a]">
            区分通用命题规则、具体职业标准与教材素材，保留原件版本、提取文本、版本与原文出处。
          </p>
        </div>
        <button
          className="rounded-xl bg-[#405fe7] px-6 py-3.5 text-base font-medium text-white shadow-[0_8px_16px_rgba(63,96,232,0.18)]"
          onClick={() => setIsUploadOpen(true)}
          type="button"
        >
          ＋ 上传资料
        </button>
      </div>
      <p className="mt-10 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-6 py-5 text-[#6687b6]">
        ⓘ
        开发指南、命题规程和样卷分别约束开发方法、质量与格式。具体职业标准用于确定本职业的考评内容；通用指南不能代替职业标准。
      </p>
      {notice ? (
        <p className="m-0 mt-4 text-sm text-[#3f60c8]">{notice}</p>
      ) : null}
      <section className="mt-8 overflow-hidden rounded-[20px] border border-[#e0e6f0] bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
          <h2 className="m-0 text-xl font-semibold text-[#293242]">资料清单</h2>
          <span className="rounded-lg bg-[#edf4ff] px-3 py-2 text-sm text-[#557aa9]">
            {materials.length}份
          </span>
        </div>
        <div className="border-b border-[#e5e9f0] p-7">
          <input
            className="h-14 w-full max-w-[630px] rounded-xl border border-[#cbdaf0] px-5 text-base text-[#385578] outline-none"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索资料名称、资料类别、资料备注"
            value={query}
          />
        </div>
        <div>
          {filteredMaterials.map((material) => (
            <article
              className="flex items-center gap-5 border-b border-[#e5e9f0] px-8 py-6 last:border-b-0"
              key={material.id}
            >
              <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-[#ecf3ff] text-sm font-semibold text-[#4b7ed2]">
                {material.original_name.split(".").pop()?.toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="m-0 truncate text-lg font-semibold text-[#30415e]">
                  {material.name}
                </h3>
                <p className="m-0 mt-2 text-sm text-[#61799e]">
                  资料类别：
                  {sourceTypeLabels[material.source_type] ??
                    material.source_type}{" "}
                  · {Math.max(1, Math.round(material.size_bytes / 1024))}KB ·{" "}
                  {material.remark || "未填写备注"}
                </p>
                <p className="m-0 mt-1 text-sm text-[#61799e]">
                  上传时间：
                  {new Date(material.created_at).toLocaleString("zh-CN", {
                    hour12: false,
                  })}
                </p>
              </div>
              <div className="flex gap-3">
                <button
                  className="rounded-xl border border-[#dbe4f0] bg-white px-4 py-2 text-sm text-[#4c6181]"
                  onClick={() => void openPreview(material)}
                  type="button"
                >
                  原文
                </button>
                <button
                  className="rounded-xl border border-[#dbe4f0] bg-white px-4 py-2 text-sm text-[#4c6181]"
                  onClick={() => openVerification(material)}
                  type="button"
                >
                  核验信息
                </button>
              </div>
            </article>
          ))}
          {!filteredMaterials.length ? (
            <p className="m-0 px-8 py-14 text-center text-[#768aa8]">
              暂无资料，点击“上传资料”保存命题依据。
            </p>
          ) : null}
        </div>
      </section>
      <section className="mt-8 overflow-hidden rounded-[20px] border border-[#e0e6f0] bg-white shadow-card">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
          <h2 className="m-0 text-xl font-semibold text-[#293242]">
            已加载的命题规则
          </h2>
          <button
            className="text-sm text-[#7185a5]"
            onClick={() => setIsCodeReferenceOpen(true)}
            type="button"
          >
            编码规则对照
          </button>
        </div>
        <div className="grid grid-cols-[200px_1fr_360px] bg-[#f7f9fc] px-5 py-4 text-sm text-[#8190a6]">
          <span>规则</span>
          <span>执行要求</span>
          <span>依据 / 定位</span>
        </div>
        <div className="grid grid-cols-[200px_1fr_360px] border-t border-[#e6ebf3] px-5 py-5 text-[#3b4c64]">
          <span>理论题库配额</span>
          <span>五四级每点至少4单选＋2判断；三级至少3单选＋2多选＋2判断</span>
          <span className="text-[#7185a5]">开发指南2024.04 / PDF第6-7页</span>
        </div>
      </section>
      {isUploadOpen ? (
        <div
          aria-labelledby="source-upload-title"
          aria-modal="true"
          className="fixed inset-0 z-[130] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="w-full max-w-[1255px] overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-7">
              <h2
                className="m-0 text-[28px] font-semibold text-[#293242]"
                id="source-upload-title"
              >
                上传资料
              </h2>
              <button
                className="text-3xl text-[#6f8099]"
                onClick={() => setIsUploadOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="p-9">
              <p className="m-0 text-base text-[#6680a5]">上传文件</p>
              <label className="mt-3 flex h-[218px] cursor-pointer flex-col items-center justify-center rounded-[18px] border-2 border-dashed border-[#b7cdf7] bg-[#f7faff] text-center">
                <input
                  accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={(event) =>
                    selectFile(event.target.files?.[0] ?? null)
                  }
                  type="file"
                />
                <span className="text-[42px] text-[#456bf4]">⇧</span>
                <strong className="mt-3 text-xl text-[#314b73]">
                  {file ? file.name : "拖拽文件到这里，或点击选择文件"}
                </strong>
                <span className="mt-3 text-base text-[#7c94bb]">
                  支持 PDF、DOCX、TXT，单个文件不超过 15MB
                </span>
              </label>
              <div className="mt-6 grid gap-5 md:grid-cols-2">
                <label className="text-base text-[#527098]">
                  资料名称
                  <input
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] px-4 text-[#385578]"
                    onChange={(event) => setName(event.target.value)}
                    value={name}
                  />
                </label>
                <label className="text-base text-[#527098]">
                  资料类别
                  <select
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] bg-white px-4 text-[#385578]"
                    onChange={(event) => setSourceType(event.target.value)}
                    value={sourceType}
                  >
                    {Object.entries(sourceTypeLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="mt-5 block text-base text-[#527098]">
                资料备注
                <textarea
                  className="mt-2 h-28 w-full rounded-xl border border-[#cbdaf0] p-4 text-[#385578]"
                  onChange={(event) => setRemark(event.target.value)}
                  placeholder="请输入资料说明、用途或补充信息（选填）"
                  value={remark}
                />
              </label>
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
              <button
                className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
                onClick={() => setIsUploadOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-xl bg-[#405fe7] px-5 py-3 text-base font-medium text-white disabled:bg-[#9aaaf0]"
                disabled={isSaving}
                onClick={saveMaterial}
                type="button"
              >
                {isSaving ? "保存中..." : "保存资料"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {previewMaterial ? (
        <div
          aria-labelledby="source-preview-title"
          aria-modal="true"
          className="fixed inset-0 z-[140] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="flex max-h-[94vh] w-full max-w-[1645px] flex-col overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
              <h2
                className="m-0 text-[26px] font-semibold text-[#293242]"
                id="source-preview-title"
              >
                {previewMaterial.name}
              </h2>
              <button
                className="text-3xl text-[#6f8099]"
                onClick={() => setPreviewMaterial(null)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
              <div className="flex gap-3">
                <span className="rounded-md bg-[#edf4ff] px-3 py-2 text-sm text-[#5279a9]">
                  {sourceTypeLabels[previewMaterial.source_type] ?? "资料"}
                </span>
                <span className="rounded-md bg-[#edf4ff] px-3 py-2 text-sm text-[#5279a9]">
                  {previewMaterial.original_name
                    .split(".")
                    .pop()
                    ?.toUpperCase()}
                </span>
              </div>
              <div className="mt-6 flex gap-8 border-b border-[#e0e6f0]">
                <button
                  className={`border-b-2 px-1 pb-4 text-lg ${previewTab === "original" ? "border-[#4265ef] font-medium text-[#4265ef]" : "border-transparent text-[#7185a5]"}`}
                  onClick={() => setPreviewTab("original")}
                  type="button"
                >
                  原件版式
                </button>
                <button
                  className={`border-b-2 px-1 pb-4 text-lg ${previewTab === "text" ? "border-[#4265ef] font-medium text-[#4265ef]" : "border-transparent text-[#7185a5]"}`}
                  onClick={() => setPreviewTab("text")}
                  type="button"
                >
                  提取文本
                </button>
              </div>
              {isLoadingPreview ? (
                <p className="py-20 text-center text-[#7185a5]">
                  正在加载资料内容...
                </p>
              ) : previewTab === "original" ? (
                <div className="pt-5">
                  <p className="m-0 text-[#7185a5]">
                    按原始文件格式展示；扫描页、图示及表格请以原件为准。
                  </p>
                  {previewMaterial.original_name
                    .toLowerCase()
                    .endsWith(".pdf") ? (
                    <iframe
                      className="mt-5 h-[62vh] w-full rounded-xl border border-[#dbe4f0] bg-[#f2f5fa]"
                      src={`/api/v1/authoring/sources/${previewMaterial.id}/content?mode=file`}
                      title={`${previewMaterial.name}原文预览`}
                    />
                  ) : previewData?.extractedText ? (
                    <pre className="mt-5 max-h-[62vh] overflow-auto whitespace-pre-wrap rounded-xl border border-[#dbe4f0] bg-[#f8fafc] p-6 font-sans text-base leading-8 text-[#33445e]">
                      {previewData.extractedText}
                    </pre>
                  ) : (
                    <div className="mt-5 grid h-72 place-items-center rounded-xl border border-[#dbe4f0] bg-[#f8fafc] text-center text-[#7185a5]">
                      <p>
                        该 DOCX 文件暂不支持浏览器内直接预览。
                        <br />
                        请下载原件后查看完整格式与版式。
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="pt-5">
                  <p className="m-0 text-[#7185a5]">
                    提取文本用于检索和智能命题；表格布局、图形和分页请在“原件版式”中查看。
                  </p>
                  {previewData?.extractedText ? (
                    <pre className="mt-5 whitespace-pre-wrap rounded-xl bg-[#f7f9fc] p-6 font-sans text-base leading-8 text-[#33445e]">
                      {previewData.extractedText}
                    </pre>
                  ) : (
                    <div className="mt-5 rounded-xl bg-[#f7f9fc] p-6 text-base leading-8 text-[#41536f]">
                      <p className="m-0">
                        当前文件尚未提取正文。资料类型：
                        {sourceTypeLabels[previewMaterial.source_type] ??
                          "资料"}
                        ；解析状态：
                        {previewData?.parseStatus === "pending"
                          ? "待解析"
                          : "未提取"}
                        。
                      </p>
                      <p className="m-0 mt-3">
                        {previewData?.remark
                          ? `资料备注：${previewData.remark}`
                          : "请在原件版式中查看完整内容。"}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
              <a
                className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
                href={`/api/v1/authoring/sources/${previewMaterial.id}/content?mode=download`}
              >
                ⇩ 下载原文件
              </a>
              <button
                className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isExtractingText}
                onClick={() => void downloadExtractedText()}
                type="button"
              >
                {isExtractingText ? "提取中..." : "下载提取文本"}
              </button>
              <button
                className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
                onClick={() => setPreviewMaterial(null)}
                type="button"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {verificationMaterial ? (
        <div
          aria-labelledby="source-verification-title"
          aria-modal="true"
          className="fixed inset-0 z-[145] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="w-full max-w-[1255px] overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
              <h2
                className="m-0 text-[26px] font-semibold text-[#293242]"
                id="source-verification-title"
              >
                核验资料信息
              </h2>
              <button
                className="text-3xl text-[#6f8099]"
                onClick={() => setVerificationMaterial(null)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="max-h-[68vh] overflow-y-auto p-9">
              <div className="grid gap-5 md:grid-cols-2">
                <label className="text-base text-[#527098]">
                  资料名称
                  <input
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] px-4 text-[#385578]"
                    readOnly
                    value={verificationMaterial.name}
                  />
                </label>
                <label className="text-base text-[#527098]">
                  资料类别
                  <select
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] bg-white px-4 text-[#385578]"
                    disabled
                    value={verificationMaterial.source_type}
                  >
                    {Object.entries(sourceTypeLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-base text-[#527098]">
                  职业名称
                  <input
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] px-4 text-[#385578]"
                    onChange={(event) =>
                      setVerification({
                        ...verification,
                        occupationName: event.target.value,
                      })
                    }
                    value={verification.occupationName}
                  />
                </label>
                <label className="text-base text-[#527098]">
                  适用等级
                  <input
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] px-4 text-[#385578]"
                    onChange={(event) =>
                      setVerification({
                        ...verification,
                        applicableLevel: event.target.value,
                      })
                    }
                    value={verification.applicableLevel}
                  />
                </label>
                <label className="text-base text-[#527098]">
                  版本
                  <input
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] px-4 text-[#385578]"
                    onChange={(event) =>
                      setVerification({
                        ...verification,
                        versionLabel: event.target.value,
                      })
                    }
                    value={verification.versionLabel}
                  />
                </label>
                <label className="text-base text-[#527098]">
                  原文定位
                  <input
                    className="mt-2 h-14 w-full rounded-xl border border-[#cbdaf0] px-4 text-[#385578]"
                    onChange={(event) =>
                      setVerification({
                        ...verification,
                        locator: event.target.value,
                      })
                    }
                    value={verification.locator}
                  />
                </label>
              </div>
              <label className="mt-5 block text-base text-[#527098]">
                资料备注
                <textarea
                  className="mt-2 h-28 w-full rounded-xl border border-[#cbdaf0] p-4 text-[#385578]"
                  onChange={(event) =>
                    setVerification({
                      ...verification,
                      remark: event.target.value,
                    })
                  }
                  value={verification.remark}
                />
              </label>
              <label className="mt-5 block text-base text-[#527098]">
                原文文本
                <textarea
                  className="mt-2 h-32 w-full resize-none rounded-xl border border-[#cbdaf0] bg-[#f8fafc] p-4 text-[#385578]"
                  readOnly
                  value={
                    previewData?.extractedText ??
                    "原文文本需以资料原件或已完成的文本提取结果为准。"
                  }
                />
              </label>
              <label className="mt-5 flex items-center justify-end gap-3 text-base text-[#6e85a7]">
                <input
                  checked={verification.verified}
                  className="h-5 w-5 accent-[#4265ef]"
                  onChange={(event) =>
                    setVerification({
                      ...verification,
                      verified: event.target.checked,
                    })
                  }
                  type="checkbox"
                />
                已核对原文、职业、等级与版本身份
              </label>
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
              <button
                className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
                onClick={() => setVerificationMaterial(null)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-xl bg-[#405fe7] px-5 py-3 text-base font-medium text-white disabled:bg-[#9aaaf0]"
                disabled={isSavingVerification}
                onClick={() => void saveVerification()}
                type="button"
              >
                {isSavingVerification ? "保存中..." : "保存核验"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {isCodeReferenceOpen ? (
        <div
          aria-labelledby="code-reference-title"
          aria-modal="true"
          className="fixed inset-0 z-[150] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="w-full max-w-[1255px] overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
              <h2
                className="m-0 text-[26px] font-semibold text-[#293242]"
                id="code-reference-title"
              >
                统一题型代码
              </h2>
              <button
                className="text-3xl text-[#6f8099]"
                onClick={() => setIsCodeReferenceOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="p-9">
              <p className="m-0 rounded-xl border border-[#d7e5fb] bg-[#f2f7ff] px-6 py-5 text-[#6687b6]">
                ⓘ 题型名称前统一显示代码；简答与计算使用同一个 E 类。
              </p>
              <div className="mt-6 overflow-hidden">
                <div className="grid grid-cols-2 bg-[#f6f8fc] px-5 py-4 text-sm text-[#8190a6]">
                  <span>代码</span>
                  <span>题型</span>
                </div>
                {[
                  ["A", "A 填空题"],
                  ["B", "B 单项选择题"],
                  ["D", "D 多项选择题"],
                  ["C", "C 判断题"],
                  ["E", "E 简答(计算题)"],
                  ["F", "F 论述题"],
                  ["I", "I 案例分析题"],
                  ["G", "G 操作技能"],
                ].map(([code, label]) => (
                  <div
                    className="grid grid-cols-2 border-b border-[#e5e9f0] px-5 py-5 text-[#303e54]"
                    key={code}
                  >
                    <span>{code}</span>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex justify-end border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
              <button
                className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]"
                onClick={() => setIsCodeReferenceOpen(false)}
                type="button"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type PromptTemplate = {
  category: string;
  name: string;
  description: string;
  content: string;
  enabled?: boolean;
};

const promptTemplates: PromptTemplate[] = [
  {
    category: "常用命题",
    name: "标准批量命题",
    description: "依据细目表，按技能等级执行逐考评点最低题量规则。",
    content: `【标准批量命题】| 2024年4月《技能人才评价国家题库开发指南》

1.先核对考核方式、职业、技能等级及已保存的国家职业标准、权重表和该等级考评要素细目表。不得臆造或补全未录入的考评点。
2.理论知识：五、四级仅单项选择题和判断题，每个有效考评点最低4道单选、2道判断；三级仅单选、多选、判断，每考评点最低3、2、2道；二、一级采用试卷库方式，一般不少于10套，并使用规定的试卷结构。操作技能须先有内容结构表、要素细目表及考核方式、评分标准，按实际技能要求命题，不套用理论题型配额。
3.逐考评点输出代码、名称、相关知识要求、重要程度、题型、每题型最低量及目标题量、依据；计算总体题量并检查覆盖、权重与配额。先展示计划，等待确认后命题。
4.客观题标注题型代码(B单选/C判断/D多选)、难度1–5、一致性1–5；优先难度3、一致性目标5。单选4选1、多选5个选项且至少2个正确、判断答案√或×。逐题检查答案、超纲、重复和歧义。未接入模型仅输出可核验计划和明确标识的离线样例。`,
  },
  {
    category: "题量补充",
    name: "题量补充命题",
    description: "优先补齐各考评点不足的题量，避免重复出题。",
    content: `【题量补充命题】

请先读取当前职业、等级、考核方式和已生成题目，按考评点统计每种题型的已有数量与最低配额差额。仅对题量不足的考评点补题，不重复生成已覆盖的知识点或情境。
输出补题清单：考评点代码、名称、缺口题型、缺口数量、命题依据和优先级。确认清单后逐题生成，并逐题检查答案、难度、超纲、重复与歧义。`,
  },
  {
    category: "专项命题",
    name: "专项考评点命题",
    description: "限定指定考评点进行有针对性的命题。",
    content: `【专项考评点命题】

仅围绕用户指定的考评点命题。先核验考评点代码、名称、知识要求、重要程度和适用等级；若考评点不存在或上下文不完整，先说明缺失信息，不得自行编造。
按指定题型和数量输出命题计划，确认后生成试题。每道题均须标注对应考评点、题型、难度、答案与解析，并检查职业标准符合性、答案准确性、重复和歧义。`,
  },
  {
    category: "质量提升",
    name: "高质量提升命题",
    description: "加强答案、解析、干扰项与重复检查。",
    content: `【高质量提升命题】

在既有命题范围内优先提升试题质量：题干表述准确、情境真实、答案唯一且可依据职业标准核验；单选题干扰项具有合理迷惑性，多选题正确项与干扰项边界清晰。
每题输出答案、解析、考评点依据、难度和一致性评价。重点检查超纲、重复、歧义、表述错误及与等级不匹配的问题；发现问题先列出修订建议，再生成修订后的可核验草稿。`,
  },
  {
    category: "案例示范",
    name: "茶艺师五级 / 初级工命题案例",
    description: "逐考评点生成单选、判断的最低量与目标题量配额，确认后命题。",
    content: `【茶艺师五级 / 初级工命题案例】

请为茶艺师五级 / 初级工生成理论知识试题。先读取并核验已保存的职业标准、理论知识权重表和考评要素细目表，逐考评点制定命题计划。
每个有效考评点至少生成4道单项选择题、2道判断题，优先覆盖重要程度为X的考评点。先输出考评点代码、名称、知识要求、最低题量、目标题量和覆盖说明，待确认后再逐题命题。
每道试题须提供4个单选选项或明确的判断题干、正确答案、解析、难度及考评点依据，并逐题检查答案准确性、超纲、重复和歧义。`,
  },
  {
    category: "试卷命题",
    name: "技师综合试卷命题",
    description: "二级、一级按试卷套数规划综合命题。",
    content: `【技师综合试卷命题】

请为二级或一级技师按已确认的试卷结构进行综合命题。先核验职业、等级、考核方式、试卷结构、考评点、权重、题量和时长；一般规划不少于10套试卷，并确保每套试卷的题型、配分与时长符合结构要求。
先输出试卷套数、每套覆盖范围、考评点分布、题型与配分矩阵、时长核对结果和缺口清单，待确认后命题。综合题须明确评分点、参考答案和依据；所有试题均需检查超纲、答案、重复和歧义。`,
  },
];

type GeneratedPlan = {
  requirement: string;
  occupationId?: string;
  occupation: string;
  levelCode: string;
  levelLabel: string;
  assessmentMode: string;
  source: string;
  status: "ready" | "blocked";
  message: string;
  blueprintVersions: {
    outline: { id: string; versionNo: number } | null;
    weights: { id: string; versionNo: number } | null;
    structure?: { id: string; versionNo: number };
  };
  validations: Array<{
    name: string;
    status: "passed" | "blocked";
    detail: string;
  }>;
  temporaryMinimums: { single: number; multiple: number; judgement: number; practical?: number };
  qualityRequirements: string[];
  points: Array<{
    code: string;
    name: string;
    single: number;
    multiple: number;
    judgement: number;
    practical?: number;
    total: number;
  }>;
  minimumTotal: number;
  ruleHint: string;
};

type HistoryPlan = {
  id: string;
  name: string;
  raw_requirement: string;
  scope_json: {
    occupation: string;
    levelCode: GeneratedPlan["levelCode"];
    assessmentMode: GeneratedPlan["assessmentMode"];
    blueprintVersions: GeneratedPlan["blueprintVersions"];
  };
  quota_json: Pick<
    GeneratedPlan,
    | "minimumTotal"
    | "temporaryMinimums"
    | "qualityRequirements"
    | "validations"
    | "points"
  >;
  status: "draft" | "blocked" | "confirmed" | "cancelled";
  created_at: string;
  updated_at: string;
  question_count: number;
  generation_status?: "queued" | "running" | "partial" | "succeeded" | "cancelled" | "stopped" | null;
};

type QuestionGenerationJob = {
  id: string;
  status: "queued" | "running" | "partial" | "succeeded" | "cancelled" | "stopped";
  terminationSummary?: { deletedQuestions: number; preservedQuestions: number } | null;
  stopSummary?: { target: number; preservedQuestions: number; missingQuestions: number; stoppedAt: string } | null;
  target: number;
  generated: number;
  totalBatches: number;
  completedBatches: number;
  currentBatch: number | null;
  activity?: {
    state: "running" | "queued" | "retry_wait" | "rate_limited" | "recovering" | "disabled" | "idle";
    queued: number;
    running: number;
    globalRunning: number;
    recentErrors: Array<{ code: string; attempts: number; error: string }>;
  };
  failedUnits: Array<{
    id: string; code: string; type: string; remaining: number; error: string;
    attempts?: number; failures?: Array<{ code: string; message: string }>; stopReason?: string; retryable?: boolean;
  }>;
};

type GeneratedQuestion = {
  id: string;
  questionNo: string;
  point: string;
  questionType: string;
  stem: string;
  options: Array<{ key: string; content: string }>;
  answers: string[];
  analysis: string;
  scoreRubric?: unknown;
  autoCheck: "通过基础检查" | "需人工复核";
  status?: "draft" | "pending_review" | "returned" | "approved" | "archived";
};

function AuthoringTaskPanel() {
  const [requirement, setRequirement] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("全部状态");
  const [notice, setNotice] = useState("");
  const [isRulesOpen, setIsRulesOpen] = useState(false);
  const [isPromptLibraryOpen, setIsPromptLibraryOpen] = useState(false);
  const [isPromptManagerOpen, setIsPromptManagerOpen] = useState(false);
  const [isPromptTemplateFormOpen, setIsPromptTemplateFormOpen] =
    useState(false);
  const [promptQuery, setPromptQuery] = useState("");
  const [promptCategory, setPromptCategory] = useState("全部");
  const [customPromptTemplates, setCustomPromptTemplates] = useState<
    PromptTemplate[]
  >([]);
  const [hasLoadedCustomPromptTemplates, setHasLoadedCustomPromptTemplates] =
    useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateCategory, setTemplateCategory] = useState("常用命题");
  const [templateDescription, setTemplateDescription] = useState("");
  const [templateContent, setTemplateContent] = useState("");
  const [templateEnabled, setTemplateEnabled] = useState("启用");
  const [templateError, setTemplateError] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [generatedPlan, setGeneratedPlan] = useState<GeneratedPlan | null>(
    null,
  );
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);
  const [confirmedPlanId, setConfirmedPlanId] = useState<string | null>(null);
  const [autoPlanId, setAutoPlanId] = useState<string | null>(null);
  const [executionQuestions, setExecutionQuestions] = useState<
    GeneratedQuestion[]
  >([]);
  const [isViewingHistoryResult, setIsViewingHistoryResult] = useState(false);
  const [isLoadingHistoryResult, setIsLoadingHistoryResult] = useState(false);
  const [questionPage, setQuestionPage] = useState(1);
  const [isConfirmingPlan, setIsConfirmingPlan] = useState(false);
  const [manualChecks, setManualChecks] = useState<string[]>([]);
  const [isSavingHandoff, setIsSavingHandoff] = useState(false);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const [ruleTab, setRuleTab] = useState(0);
  const [taskHistory, setTaskHistory] = useState<HistoryPlan[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [historyPlanId, setHistoryPlanId] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState("");
  const [generationJob, setGenerationJob] = useState<QuestionGenerationJob | null>(null);
  const [progressError, setProgressError] = useState("");
  const [terminatingPlanId, setTerminatingPlanId] = useState<string | null>(null);
  const [stoppingPlanId, setStoppingPlanId] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const manualCheckById = useRef(new Map<string, string>());
  const terminatedPlans = useRef(new Set<string>());
  const generationActive = generationJob?.status === "queued" || generationJob?.status === "running";
  const [isQualityStandardOpen, setIsQualityStandardOpen] = useState(false);
  const [qualityStandardKind, setQualityStandardKind] = useState<"theory" | "skill">("theory");
  const qualityStandardTitle = qualityStandardKind === "skill" ? "操作技能试题质量标准" : "试题质量标准";
  const qualityStandardLoadId = useRef(0);
  const [qualityStandard, setQualityStandard] = useState("");
  const [qualityStandardError, setQualityStandardError] = useState("");
  const [isLoadingQualityStandard, setIsLoadingQualityStandard] =
    useState(false);
  const [isSavingQualityStandard, setIsSavingQualityStandard] = useState(false);
  const getHistoryStage = (plan: HistoryPlan) => {
    if (plan.generation_status === "cancelled" || plan.status === "cancelled") return "已终止";
    if (plan.generation_status === "stopped") return "已停止，保留成果";
    if (plan.generation_status === "queued" || plan.generation_status === "running") return "生成中";
    if (plan.generation_status === "partial") return "部分失败";
    if (plan.generation_status === "succeeded") return "已完成";
    if (plan.question_count > 0) return "已完成";
    return "待执行";
  };
  const rows = taskHistory.filter(
    (row) =>
      (status === "全部状态" || getHistoryStage(row) === status) &&
      `${row.name}${row.scope_json.occupation}${row.scope_json.levelCode}`.includes(
        query.trim(),
      ),
  );
  const selectedHistoryPlan = historyPlanId
    ? taskHistory.find((plan) => plan.id === historyPlanId)
    : null;
  const historyRequirementChanged = Boolean(
    selectedHistoryPlan && selectedHistoryPlan.raw_requirement !== requirement,
  );
  const questionPageSize = 20;
  const questionPageCount = Math.max(
    1,
    Math.ceil(executionQuestions.length / questionPageSize),
  );
  const visibleQuestions = executionQuestions.slice(
    (questionPage - 1) * questionPageSize,
    questionPage * questionPageSize,
  );
  useEffect(() => {
    setQuestionPage((current) => Math.min(current, questionPageCount));
  }, [questionPageCount]);
  useEffect(() => {
    setQuestionPage(1);
    setSessionExpired(false);
  }, [confirmedPlanId]);
  const questionPagination = executionQuestions.length > questionPageSize ? (
    <nav aria-label="试题分页" className="my-5 flex flex-wrap items-center justify-between gap-3 text-sm text-[#607493]">
      <span>共 {executionQuestions.length} 道，每页 {questionPageSize} 道</span>
      <div className="flex items-center gap-3">
        <button
          className="rounded-lg border border-[#cbdaf0] bg-white px-3 py-2 disabled:opacity-50"
          disabled={questionPage <= 1}
          onClick={() => setQuestionPage((current) => Math.max(1, current - 1))}
          type="button"
        >上一页</button>
        <label>
          第{" "}
          <select
            aria-label="试题页码"
            className="rounded-lg border border-[#cbdaf0] bg-white px-2 py-2"
            value={questionPage}
            onChange={(event) => setQuestionPage(Number(event.target.value))}
          >
            {Array.from({ length: questionPageCount }, (_, index) => (
              <option key={index + 1} value={index + 1}>{index + 1}</option>
            ))}
          </select>
          {" "}/ {questionPageCount} 页
        </label>
        <button
          className="rounded-lg border border-[#cbdaf0] bg-white px-3 py-2 disabled:opacity-50"
          disabled={questionPage >= questionPageCount}
          onClick={() => setQuestionPage((current) => Math.min(questionPageCount, current + 1))}
          type="button"
        >下一页</button>
      </div>
    </nav>
  ) : null;
  const allPromptTemplates = [...promptTemplates, ...customPromptTemplates];
  const promptCategories = [
    "全部",
    ...Array.from(
      new Set(allPromptTemplates.map((template) => template.category)),
    ),
  ];
  const matchesPromptFilter = (template: PromptTemplate) => {
    const matchesCategory =
      promptCategory === "全部" || template.category === promptCategory;
    const keyword = promptQuery.trim();
    return (
      matchesCategory &&
      (!keyword ||
        `${template.name}${template.description}${template.content}`.includes(
          keyword,
        ))
    );
  };
  const filteredPromptTemplates = allPromptTemplates.filter(
    (template) => template.enabled !== false && matchesPromptFilter(template),
  );
  const filteredManagedPromptTemplates =
    allPromptTemplates.filter(matchesPromptFilter);
  useEffect(() => {
    const storedTemplates = window.localStorage.getItem(
      "itembank-custom-prompt-templates",
    );
    if (storedTemplates) {
      try {
        const parsedTemplates = JSON.parse(storedTemplates);
        if (Array.isArray(parsedTemplates))
          setCustomPromptTemplates(parsedTemplates);
      } catch {
        window.localStorage.removeItem("itembank-custom-prompt-templates");
      }
    }
    setHasLoadedCustomPromptTemplates(true);
  }, []);
  useEffect(() => {
    if (!hasLoadedCustomPromptTemplates) return;
    window.localStorage.setItem(
      "itembank-custom-prompt-templates",
      JSON.stringify(customPromptTemplates),
    );
  }, [customPromptTemplates, hasLoadedCustomPromptTemplates]);
  const loadTaskHistory = async () => {
    setIsLoadingHistory(true);
    try {
      const response = await fetch("/api/v1/authoring/plans", {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        data?: HistoryPlan[];
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(payload.error?.message ?? "历史命题计划加载失败。");
      setTaskHistory(payload.data ?? []);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "历史命题计划加载失败。",
      );
    } finally {
      setIsLoadingHistory(false);
    }
  };
  useEffect(() => {
    void loadTaskHistory();
  }, []);
  useEffect(() => {
    const planId = new URL(window.location.href).searchParams.get("executionPlan");
    if (planId) setConfirmedPlanId(planId);
  }, []);
  useEffect(() => {
    executionQuestions.forEach((question, index) => {
      manualCheckById.current.set(question.id, manualChecks[index] ?? "待人工核查");
    });
  }, [executionQuestions, manualChecks]);
  useEffect(() => {
    if (!confirmedPlanId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/v1/authoring/plans/${confirmedPlanId}`, { cache: "no-store" });
        const payload = await response.json() as {
          data?: { questions: GeneratedQuestion[]; job: QuestionGenerationJob | null };
          error?: { message?: string };
        };
        if (cancelled) return;
        if (response.status === 401) {
          setSessionExpired(true);
          setProgressError("登录已失效，后台生成不受影响。请重新登录后继续查看。");
          return;
        }
        if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "生成进度读取失败。");
        if (terminatedPlans.current.has(confirmedPlanId) && !["cancelled", "stopped"].includes(payload.data.job?.status ?? "")) return;
        setSessionExpired(false);
        const data = payload.data;
        setProgressError("");
        setGenerationJob(data.job);
        setExecutionQuestions(data.questions);
        setManualChecks(data.questions.map((question) => manualCheckById.current.get(question.id) ?? "待人工核查"));
        if (data.job?.status === "queued" || data.job?.status === "running") {
          timer = setTimeout(() => void poll(), 2000);
        } else {
          void loadTaskHistory();
        }
      } catch (error) {
        if (!cancelled) {
          setProgressError(error instanceof Error ? error.message : "进度读取失败，正在重试。");
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [confirmedPlanId, generationJob?.status]);
  const stopKeepTask = async (planId: string) => {
    if (stoppingPlanId || terminatingPlanId || !window.confirm("确认停止生成并保留成果？\n将停止排队和在途请求，失败请求不再处理，保留全部已保存试题和缺口记录。\n本任务无法恢复生成或重试；保留试题可继续人工核查和专家审定。")) return;
    setStoppingPlanId(planId);
    setExecutionError("");
    setProgressError("");
    try {
      const response = await fetch(`/api/v1/authoring/plans/${planId}/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop_keep" }),
      });
      const payload = await response.json() as {
        data?: { job: QuestionGenerationJob; summary: NonNullable<QuestionGenerationJob["stopSummary"]> };
        error?: { message?: string };
      };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "停止生成失败。");
      terminatedPlans.current.add(planId);
      if (confirmedPlanId === planId) {
        setGenerationJob(payload.data.job);
        const results = await fetch(`/api/v1/authoring/plans/${planId}`, { cache: "no-store" });
        if (!results.ok) throw new Error("任务已停止，但成果读取失败，请刷新页面查看。");
        const data = await results.json() as { data?: { questions: GeneratedQuestion[] } };
        const questions = data.data?.questions ?? [];
        setExecutionQuestions(questions);
        setManualChecks(questions.map((question) => manualCheckById.current.get(question.id) ?? "待人工核查"));
      }
      setNotice(`已停止生成：计划${payload.data.summary.target}道，保留${payload.data.summary.preservedQuestions}道，未生成${payload.data.summary.missingQuestions}道。保留试题可继续核查和审定。`);
      await loadTaskHistory();
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : "停止生成失败。");
    } finally { setStoppingPlanId(null); }
  };
  const terminateTask = async (planId: string) => {
    if (terminatingPlanId || stoppingPlanId || !window.confirm("确认终止命题任务？\n将停止后续生成，清理本任务未审定的原始草稿及批次数据，无法恢复或重试。\n已审核、修订、确认、入库或用于试卷的试题保留，终止操作会留痕。")) return;
    setTerminatingPlanId(planId);
    setExecutionError("");
    try {
      const response = await fetch(`/api/v1/authoring/plans/${planId}/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "terminate" }),
      });
      const payload = await response.json() as {
        data?: { job: QuestionGenerationJob; summary: { deletedQuestions: number; preservedQuestions: number } };
        error?: { message?: string };
      };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "任务终止失败。");
      terminatedPlans.current.add(planId);
      if (confirmedPlanId === planId) {
        setGenerationJob(payload.data.job);
        const results = await fetch(`/api/v1/authoring/plans/${planId}`, { cache: "no-store" });
        if (results.ok) {
          const data = await results.json() as { data?: { questions: GeneratedQuestion[] } };
          setExecutionQuestions(data.data?.questions ?? []);
        }
        manualCheckById.current.clear();
        setManualChecks([]);
      }
      setNotice(`任务已终止：清理 ${payload.data.summary.deletedQuestions} 道草稿，保留 ${payload.data.summary.preservedQuestions} 道已进入业务流程的试题。`);
      await loadTaskHistory();
    } catch (error) {
      setExecutionError(error instanceof Error ? error.message : "任务终止失败。");
    } finally { setTerminatingPlanId(null); }
  };
  const trackExecution = (planId: string | null) => {
    const url = new URL(window.location.href);
    if (planId) url.searchParams.set("executionPlan", planId);
    else url.searchParams.delete("executionPlan");
    window.history.replaceState(null, "", url);
  };
  const applyQuickInput = (text: string) => setRequirement(text);
  const createNewTask = () => {
    setRequirement("");
    setSelectedTemplate("");
    setGeneratedPlan(null);
    setConfirmedPlanId(null);
    setGenerationJob(null);
    manualCheckById.current.clear();
    trackExecution(null);
    setAutoPlanId(null);
    setExecutionQuestions([]);
    setQuestionPage(1);
    setIsViewingHistoryResult(false);
    setHistoryPlanId(null);
    setExecutionError("");
    setNotice("已创建空白命题任务草稿。");
  };
  const updatePlanPointQuota = (
    pointCode: string,
    field: "single" | "multiple" | "judgement" | "practical",
    value: string,
  ) => {
    const quantity = Math.max(
      0,
      Math.min(100, Number.parseInt(value, 10) || 0),
    );
    setGeneratedPlan((current) => {
      if (!current) return current;
      const points = current.points.map((point) => {
        if (point.code !== pointCode) return point;
        const next = { ...point, [field]: quantity };
        return { ...next, total: next.single + next.multiple + next.judgement + (next.practical ?? 0) };
      });
      return {
        ...current,
        points,
        minimumTotal: points.reduce((sum, point) => sum + point.total, 0),
      };
    });
    setExecutionError("");
  };
  const openQualityStandard = async (kind: "theory" | "skill" = "theory") => {
    const loadId = ++qualityStandardLoadId.current;
    setQualityStandardKind(kind);
    setIsQualityStandardOpen(true);
    setQualityStandard("");
    setQualityStandardError("");
    setIsLoadingQualityStandard(true);
    try {
      const response = await fetch(`/api/v1/authoring/quality-standard?kind=${kind}`, {
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await response.json();
      if (loadId !== qualityStandardLoadId.current) return;
      if (!response.ok)
        throw new Error(payload.error?.message ?? "加载试题质量标准失败。");
      setQualityStandard(payload.data?.content ?? "");
    } catch (error) {
      if (loadId !== qualityStandardLoadId.current) return;
      setQualityStandardError(
        error instanceof Error ? error.message : "加载试题质量标准失败。",
      );
    } finally {
      if (loadId === qualityStandardLoadId.current) setIsLoadingQualityStandard(false);
    }
  };
  const saveQualityStandard = async () => {
    setIsSavingQualityStandard(true);
    setQualityStandardError("");
    try {
      const response = await fetch(`/api/v1/authoring/quality-standard?kind=${qualityStandardKind}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: qualityStandard }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error?.message ?? "保存试题质量标准失败。");
      setQualityStandard(payload.data?.content ?? qualityStandard);
      setIsQualityStandardOpen(false);
      setNotice(`${qualityStandardTitle}已保存，后续${qualityStandardKind === "skill" ? "操作技能" : ""}命题时将作为生成约束。`);
    } catch (error) {
      setQualityStandardError(
        error instanceof Error ? error.message : "保存试题质量标准失败。",
      );
    } finally {
      setIsSavingQualityStandard(false);
    }
  };
  const executePlan = async (plan: GeneratedPlan) => {
    if (plan.status !== "ready" || isConfirmingPlan || isGeneratingPlan) return;
    if (plan.requirement !== requirement) {
      setExecutionError("命题需求已修改，请重新生成计划后确认。");
      return;
    }
    setIsConfirmingPlan(true);
    setExecutionError("");
    try {
      let planId = autoPlanId;
      const savedPlanId = historyPlanId && !historyRequirementChanged ? historyPlanId : autoPlanId;
      if (savedPlanId) {
        const response = await fetch(
          `/api/v1/authoring/plans/${savedPlanId}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ points: plan.points }),
          },
        );
        const payload = (await response.json()) as {
          data?: { minimumTotal: number; points: GeneratedPlan["points"] };
          error?: { message?: string };
        };
        if (!response.ok || !payload.data)
          throw new Error(
            payload.error?.message ?? "调整后的命题题量保存失败。",
          );
        planId = savedPlanId;
        plan = {
          ...plan,
          minimumTotal: payload.data.minimumTotal,
          points: payload.data.points,
        };
      }
      if (!planId) {
        const response = await fetch("/api/v1/authoring/plans/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requirement: plan.requirement,
            occupation: plan.occupation,
            occupationId: plan.occupationId,
            levelCode: plan.levelCode,
            assessmentMode: plan.assessmentMode,
            minimumTotal: plan.minimumTotal,
            blueprintVersions: plan.blueprintVersions,
            temporaryMinimums: plan.temporaryMinimums,
            qualityRequirements: plan.qualityRequirements,
            validations: plan.validations,
            points: plan.points,
          }),
        });
        const payload = (await response.json()) as {
          data?: { planId: string };
          error?: { message?: string };
        };
        if (!response.ok || !payload.data)
          throw new Error(payload.error?.message ?? "命题计划快照保存失败。");
        planId = payload.data.planId;
        setAutoPlanId(planId);
      }
      const executionResponse = await fetch(
        `/api/v1/authoring/plans/${planId}/generate`,
        { method: "POST" },
      );
      const executionPayload = (await executionResponse.json()) as {
        data?: { job: QuestionGenerationJob | null };
        error?: { message?: string };
      };
      if (!executionResponse.ok || !executionPayload.data)
        throw new Error(
          executionPayload.error?.message ?? "AI 命题任务执行失败。",
        );
      setConfirmedPlanId(planId);
      setGenerationJob(executionPayload.data.job);
      manualCheckById.current.clear();
      trackExecution(planId);
      setAutoPlanId(null);
      setHistoryPlanId(null);
      setIsViewingHistoryResult(false);
      setGeneratedPlan(null);
      setExecutionQuestions([]);
      setQuestionPage(1);
      setManualChecks([]);
      setNotice(
        `已启动 ${plan.minimumTotal} 道试题的后台分批生成，可刷新或关闭页面；失败部分可单独重试。`,
      );
      await loadTaskHistory();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "命题计划确认失败。";
      setExecutionError(message);
      setNotice(message);
    } finally {
      setIsConfirmingPlan(false);
    }
  };
  const retryFailedGeneration = async () => {
    if (!confirmedPlanId) return;
    setIsConfirmingPlan(true);
    setProgressError("");
    try {
      const response = await fetch(`/api/v1/authoring/plans/${confirmedPlanId}/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "retry_failed" }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? "重试启动失败。");
      setGenerationJob(payload.data.job);
      setNotice("已重新排队失败请求，仅补齐缺失试题，保留已有草稿。");
    } catch (error) {
      setProgressError(error instanceof Error ? error.message : "重试启动失败。");
    } finally {
      setIsConfirmingPlan(false);
    }
  };
  const saveExpertHandoff = async () => {
    if (!confirmedPlanId) {
      setNotice(
        "当前成果未关联有效命题计划，请从历史任务中重新打开本次命题成果后再交接。",
      );
      return;
    }
    setIsSavingHandoff(true);
    try {
      const manualCheckPayload = manualChecks
        .map((status, index) => ({
          question: executionQuestions[index],
          status,
        }))
        .filter(
          ({ question }) =>
            question?.id && (!question.status || question.status === "draft" || question.status === "pending_review" && question.questionType === "实操题"),
        )
        .map(({ question, status }) => ({ questionId: question.id, status }));
      if (!manualCheckPayload.some((item) => item.status === "人工通过")) {
        throw new Error("请至少将一题草稿标记为“人工通过”后再交接专家审定。");
      }
      const response = await fetch(
        `/api/v1/authoring/plans/${confirmedPlanId}/handoff`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ manualChecks: manualCheckPayload }),
        },
      );
      const payload = (await response.json()) as {
        data?: { transitioned: number; questionIds: string[] };
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(payload.error?.message ?? "交接记录保存失败。");
      const transitionedIds = new Set(payload.data?.questionIds ?? []);
      setExecutionQuestions((current) =>
        current.map((question) =>
          transitionedIds.has(question.id)
            ? { ...question, status: "pending_review" }
            : question,
        ),
      );
      setHandoffNotice(
        `已将 ${payload.data?.transitioned ?? transitionedIds.size} 道人工通过的试题交接至专家审定，状态已更新为“待审定”。请前往“专家审定 - 分配任务”选择专家并分配任务。`,
      );
      await loadTaskHistory();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "交接记录保存失败。");
    } finally {
      setIsSavingHandoff(false);
    }
  };
  const viewHistoryPlan = (plan: HistoryPlan) => {
    setAutoPlanId(null);
    const quota = plan.quota_json;
    const scope = plan.scope_json;
    setRequirement(plan.raw_requirement);
    setGeneratedPlan({
      requirement: plan.raw_requirement,
      occupation: scope.occupation,
      levelCode: scope.levelCode,
      levelLabel:
        {
          level_5: "5级",
          level_4: "4级",
          level_3: "3级",
          level_2: "2级",
          level_1: "1级",
        }[scope.levelCode] ?? scope.levelCode,
      assessmentMode: scope.assessmentMode,
      source: "历史命题计划",
      status: "ready",
      message:
        "当前显示已保存的计划快照。确认后将按当前命题需求重新生成计划并以新结果替换本次工作区展示，原计划与已生成版本保留留痕。",
      blueprintVersions: scope.blueprintVersions,
      validations: quota.validations,
      temporaryMinimums: quota.temporaryMinimums,
      qualityRequirements: quota.qualityRequirements,
      points: quota.points,
      minimumTotal: quota.minimumTotal,
      ruleHint: "历史计划快照",
    });
    setHistoryPlanId(plan.id);
    setConfirmedPlanId(null);
    setGenerationJob(null);
    trackExecution(null);
    setExecutionQuestions([]);
    setIsViewingHistoryResult(false);
    setExecutionError("");
    setNotice(`已打开“${plan.name}”的命题计划。`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const viewHistoryResult = async (plan: HistoryPlan) => {
    setIsLoadingHistoryResult(true);
    setNotice("");
    try {
      const response = await fetch(`/api/v1/authoring/plans/${plan.id}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        data?: { questions: GeneratedQuestion[]; job: QuestionGenerationJob | null };
        error?: { message?: string };
      };
      if (!response.ok || !payload.data)
        throw new Error(payload.error?.message ?? "命题成果加载失败。");
      setGeneratedPlan(null);
      setHistoryPlanId(null);
      setConfirmedPlanId(plan.id);
      setGenerationJob(payload.data.job);
      manualCheckById.current.clear();
      trackExecution(plan.id);
      setExecutionQuestions(payload.data.questions);
      setManualChecks(
        payload.data.questions.map(() => "待人工核查"),
      );
      setQuestionPage(1);
      setIsViewingHistoryResult(true);
      setNotice(`已加载 ${payload.data.questions.length} 道历史命题成果。`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "命题成果加载失败。");
    } finally {
      setIsLoadingHistoryResult(false);
    }
  };
  const generatePlan = async () => {
    if (!requirement.trim()) {
      setNotice("请先描述命题需求。");
      return;
    }
    setIsGeneratingPlan(true);
    setGeneratedPlan(null);
    setNotice("");
    setAutoPlanId(null);
    setHistoryPlanId(null);
    setExecutionError("");
    try {
      const response = await fetch("/api/v1/authoring/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requirement }),
      });
      const payload = (await response.json()) as {
        data?: GeneratedPlan;
        error?: { message?: string };
      };
      if (!response.ok || !payload.data)
        throw new Error(payload.error?.message ?? "命题计划生成失败。");
      setGeneratedPlan(payload.data);
      if (payload.data.status === "ready") {
        setNotice(`计划校验通过，共 ${payload.data.minimumTotal} 道题；请确认后自动分批生成。`);
      } else {
        setNotice(payload.data.message);
      }
    } catch (error) {
      setGeneratedPlan(null);
      setNotice(
        error instanceof Error
          ? error.message
          : "命题计划生成失败，请稍后重试。",
      );
    } finally {
      setIsGeneratingPlan(false);
    }
  };
  const applyPromptTemplate = (template: PromptTemplate) => {
    setRequirement(template.content);
    setSelectedTemplate(template.name);
    setIsPromptLibraryOpen(false);
    setIsPromptManagerOpen(false);
    setNotice(`已应用“${template.name}”模板，可继续修改命题需求。`);
  };
  const startNewPromptTemplate = () => {
    setTemplateName("");
    setTemplateCategory("常用命题");
    setTemplateDescription("");
    setTemplateContent("");
    setTemplateEnabled("启用");
    setTemplateError("");
    setIsPromptTemplateFormOpen(true);
  };
  const savePromptTemplate = () => {
    if (
      !templateName.trim() ||
      !templateDescription.trim() ||
      !templateContent.trim()
    ) {
      setTemplateError("请完整填写模板名称、用途简介和提示词内容。");
      return;
    }
    setCustomPromptTemplates((currentTemplates) => [
      ...currentTemplates,
      {
        name: templateName.trim(),
        category: templateCategory,
        description: templateDescription.trim(),
        content: templateContent.trim(),
        enabled: templateEnabled === "启用",
      },
    ]);
    setIsPromptTemplateFormOpen(false);
    setNotice(`已保存“${templateName.trim()}”模板。`);
  };
  const ruleTabs = [
    {
      label: "总则与依据",
      pages: "3–6、26、39页",
      body: (
        <>
          命题前先明确职业、等级、考核方式，核实对应国家职业标准、权重及考评要素细目表。理论知识按照职业、每等级分别编制细目表；操作技能先有内容结构表，再有要素细目表，最后编写试题。
        </>
      ),
      bullets: [
        "理论知识考评点是独立可考的最小知识点；代码逐级衔接，未级考评点用001、002……；重要程度X为核心、Y为一般、Z为辅助。",
        "理论知识每等级考评点总量一般不少于200个；考评范围中考评点数量一般达到该范围权重的2倍及以上；X一般占85%以上，Y不超过10%，Z不超过5%。",
        "试题要严格对应考评点，不得超出对应知识要求；应考查职业活动的核心内容，避免偏题、怪题和机械记忆。",
      ],
    },
    {
      label: "理论知识 · 五四三级",
      pages: "7–18页",
      body: (
        <>
          理论知识五级、四级、三级按细目表确定题型、题量与配分，单选题和判断题均需绑定可核验考评点。
        </>
      ),
      bullets: [
        "每道题必须有唯一正确答案或明确判定依据。",
        "同一考评点题目应覆盖不同情境，避免换词重复。",
      ],
    },
    {
      label: "理论知识 · 二一级",
      pages: "19–25页",
      body: (
        <>
          理论知识二级、一级重点考查综合应用、技术管理与创新能力，题目难度应与技能等级一致。
        </>
      ),
      bullets: [
        "综合题须明确评分点与参考答案。",
        "不得以超纲知识代替职业能力要求。",
      ],
    },
    {
      label: "操作技能与笔答题",
      pages: "27–38页",
      body: (
        <>
          操作技能试题应按内容结构、选考规则与考核时间编制，笔答题应与技能任务的知识要求对应。
        </>
      ),
      bullets: [
        "必考、选考和时长必须与已确认的试卷结构一致。",
        "实操任务应提供可执行的材料、工具和评分依据。",
      ],
    },
    {
      label: "试题质量与审定",
      pages: "40–45页",
      body: (
        <>
          所有 AI 生成内容均为可核验草稿，须经过规则校验与专家审定后方可入库。
        </>
      ),
      bullets: [
        "审定意见、修订记录和版本必须完整留痕。",
        "重复、错误或无法追溯依据的试题不得进入题库。",
      ],
    },
  ];
  const activeRule = ruleTabs[ruleTab];
  return (
    <div>
      <h1 className="m-0 text-[30px] font-semibold tracking-[-0.02em] text-[#293242]">
        命题任务
      </h1>
      <p className="m-0 mt-3 text-[16px] text-[#7b879a]">
        自然语言提出需求，自动生成并执行命题计划，随后人工核查试题成果。
      </p>
      <section className="mt-12 rounded-[22px] border border-[#d6e3ff] bg-[#f5f8ff] p-12 shadow-card">
        <p className="m-0 text-sm font-semibold tracking-[0.18em] text-[#3567c9]">
          AI AGENT · 智能命题
        </p>
        <h2 className="m-0 mt-6 text-[32px] font-semibold tracking-[-0.02em] text-[#29436d]">
          描述命题需求，智能体帮你规划
        </h2>
        <p className="m-0 mt-4 text-[17px] text-[#7185a5]">
          先理解命题意图、关联职业标准及细目表，再核对强制规则，自动执行命题并进入人工核查。
        </p>
        <div className="mt-12 flex flex-wrap items-center justify-between gap-4">
          <h3 className="m-0 text-lg font-semibold text-[#385578]">命题需求</h3>
        </div>
        {selectedTemplate ? (
          <p className="m-0 mt-4 rounded-xl bg-[#eaf4ff] px-4 py-3 text-[16px] text-[#3866a5]">
            已选模板：{selectedTemplate}（可继续修改需求）
          </p>
        ) : null}
        <textarea
          className="mt-4 h-[360px] w-full rounded-[16px] border border-[#c6d8f7] bg-white p-7 text-lg leading-8 text-[#385578] outline-none placeholder:text-[#98a7bd] focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
          onChange={(event) => setRequirement(event.target.value)}
          placeholder="例如：请为车工四级/中级工生成理论知识试题，每个考评点至少4道单选题、2道判断题，确保答案准确、避免重复。"
          value={requirement}
        />
        <div className="mt-6 flex flex-wrap items-center justify-between gap-5 border-b border-[#dce7f8] pb-6">
          <p className="m-0 text-[16px] text-[#7185a5]">
            自动解析职业、等级、考核方式；权重、细目表和题量规则由系统校验
          </p>
          <div className="flex gap-3">
            <button
              className="rounded-xl border border-[#91aeef] bg-white px-5 py-3 text-base font-medium text-[#3971d0]"
              onClick={createNewTask}
              type="button"
            >
              ＋ 新建命题任务
            </button>
            <button
              className="rounded-xl bg-[#405fe7] px-6 py-3 text-base font-medium text-white shadow-[0_8px_16px_rgba(63,96,232,0.18)] disabled:cursor-not-allowed disabled:bg-[#9aaaf0]"
              disabled={isGeneratingPlan}
              onClick={generatePlan}
              type="button"
            >
              {isGeneratingPlan ? "生成中..." : "✦ 生成命题计划"}
            </button>
          </div>
        </div>
        {notice ? (
          <p className="m-0 mt-4 text-sm text-[#3f60c8]">{notice}</p>
        ) : null}
        <div className="mt-5 flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium text-[#7185a5]">快速输入</span>
          <button
            className="rounded-lg border border-[#dfe6f1] bg-white px-3 py-2 text-[#50627e]"
            onClick={() =>
              applyQuickInput(
                "请为车工四级/中级工生成理论知识试题，每个考评点至少4道单选题、2道判断题。",
              )
            }
            type="button"
          >
            四级·车工
          </button>
          <button
            className="rounded-lg border border-[#dfe6f1] bg-white px-3 py-2 text-[#50627e]"
            onClick={() =>
              applyQuickInput(
                "请为茶艺师五级/初级工生成理论知识试题，每个考评点至少4道单选题、2道判断题。",
              )
            }
            type="button"
          >
            五级·茶艺师
          </button>
          <button
            className="rounded-lg border border-[#dfe6f1] bg-white px-3 py-2 text-[#50627e]"
            onClick={() =>
              applyQuickInput(
                "请为车工三级/高级工生成理论知识试题，优先覆盖重点考评点。",
              )
            }
            type="button"
          >
            三级·车工
          </button>
        </div>
      </section>
      {generatedPlan ? (
        <section className="mt-7 rounded-[22px] border border-[#d6e3ff] bg-white p-8 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="m-0 text-[28px] font-semibold text-[#293242]">
                命题计划确认
              </h2>
              <p className="m-0 mt-3 text-[16px] text-[#6980a4]">
                AI 意图解析 · 蓝图关联 · 强制规则校验 · 考评点配额
              </p>
            </div>
            <span
              className={`rounded-xl px-4 py-2 text-sm ${generatedPlan.status === "ready" ? "bg-[#e9f6ee] text-[#31825d]" : "bg-[#fff4df] text-[#a96f13]"}`}
            >
              {generatedPlan.source}
            </span>
          </div>
          <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["职业", generatedPlan.occupation],
              ["技能等级", generatedPlan.levelLabel],
              ["考核方式", generatedPlan.assessmentMode],
              ["最低题量", `${generatedPlan.minimumTotal}道`],
            ].map(([label, value]) => (
              <div
                className="rounded-xl border border-[#e0e8f5] bg-[#f5f8ff] p-5"
                key={label}
              >
                <p className="m-0 text-sm text-[#7185a5]">{label}</p>
                <p className="m-0 mt-4 text-[26px] font-semibold text-[#2d5cb4]">
                  {value}
                </p>
              </div>
            ))}
          </div>
          <p
            className={`m-0 mt-5 rounded-xl border px-5 py-4 text-[15px] leading-7 ${generatedPlan.status === "ready" ? "border-[#cde8d8] bg-[#f1fbf5] text-[#39745a]" : "border-[#f2d59a] bg-[#fff7e7] text-[#a6711f]"}`}
          >
            {generatedPlan.message}
          </p>
          <div className="mt-5 grid gap-3 lg:grid-cols-2">
            {generatedPlan.validations.map((validation) => (
              <div
                className={`rounded-xl border px-4 py-3 ${validation.status === "passed" ? "border-[#d8eadf] bg-[#f7fcf8]" : "border-[#f1d398] bg-[#fff9ed]"}`}
                key={validation.name}
              >
                <p
                  className={`m-0 text-sm font-medium ${validation.status === "passed" ? "text-[#39745a]" : "text-[#a6711f]"}`}
                >
                  {validation.status === "passed" ? "✓ " : "!"}
                  {validation.name}
                </p>
                <p className="m-0 mt-1 text-sm leading-6 text-[#7185a5]">
                  {validation.detail}
                </p>
              </div>
            ))}
          </div>
          {generatedPlan.qualityRequirements.length ? (
            <p className="m-0 mt-4 text-sm text-[#5d718f]">
              本次质量要求：{generatedPlan.qualityRequirements.join("、")}。
            </p>
          ) : null}
          {generatedPlan.points.length ? (
            <div className="mt-5 overflow-x-auto rounded-xl border border-[#dde5f1]">
              <table className="min-w-[760px] w-full border-collapse text-left">
                <thead className="bg-[#f4f7fc] text-sm font-medium text-[#7185a5]">
                  <tr>
                    <th className="px-5 py-4">考评点名称</th>
                    {generatedPlan.assessmentMode === "操作技能" ? <th className="px-5 py-4 text-center">实操题</th> : <>
                      <th className="px-5 py-4 text-center">单选题</th>
                      <th className="px-5 py-4 text-center">多选题</th>
                      <th className="px-5 py-4 text-center">判断题</th>
                    </>}
                    <th className="px-5 py-4 text-center">合计</th>
                  </tr>
                </thead>
                <tbody>
                  {generatedPlan.points.map((point) => (
                    <tr className="border-t border-[#e4eaf3]" key={point.code}>
                      <td className="px-5 py-4 text-[#34445d]">{point.name}</td>
                      {(generatedPlan.assessmentMode === "操作技能" ? ["practical"] as const : ["single", "multiple", "judgement"] as const).map(
                        (field) => (
                          <td className="px-5 py-3 text-center" key={field}>
                            <input
                              aria-label={`${point.name}${field}`}
                              className="h-9 w-16 rounded-md border border-[#cbdaf0] bg-white px-2 text-center text-[#34445d] outline-none focus:border-[#7691ee]"
                              min={0}
                              max={100}
                              onChange={(event) =>
                                updatePlanPointQuota(
                                  point.code,
                                  field,
                                  event.target.value,
                                )
                              }
                              type="number"
                              value={point[field] ?? 0}
                            />
                          </td>
                        ),
                      )}
                      <td className="px-5 py-4 text-center font-medium text-[#34445d]">
                        {point.total}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <p className="m-0 mt-4 text-sm text-[#7185a5]">
            {generatedPlan.ruleHint}
            {generatedPlan.blueprintVersions.outline
              ? ` 当前细目表版本：V${generatedPlan.blueprintVersions.outline.versionNo}。`
              : ""}
            {generatedPlan.blueprintVersions.weights
              ? ` 当前权重表版本：V${generatedPlan.blueprintVersions.weights.versionNo}。`
              : ""}
            {generatedPlan.blueprintVersions.structure
              ? ` 当前内容结构版本：V${generatedPlan.blueprintVersions.structure.versionNo}。`
              : ""}
          </p>
          {executionError ? (
            <p className="m-0 mt-4 rounded-xl border border-[#f2d59a] bg-[#fff7e7] px-5 py-4 text-[15px] leading-7 text-[#a6711f]">
              {executionError}
            </p>
          ) : null}
          <div className="mt-7 flex flex-wrap justify-end gap-3">
            <button
              className="rounded-xl border border-[#cbdaf0] bg-white px-5 py-3 text-base text-[#385578]"
              onClick={() => setGeneratedPlan(null)}
              disabled={isConfirmingPlan}
              type="button"
            >
              返回修改需求
            </button>
            <button
              className="rounded-xl border border-[#cbdaf0] bg-white px-5 py-3 text-base text-[#385578]"
              onClick={() => void openQualityStandard()}
              type="button"
            >
              试题质量标准
            </button>
            <button
              className="rounded-xl border border-[#cbdaf0] bg-white px-5 py-3 text-base text-[#385578]"
              onClick={() => void openQualityStandard("skill")}
              type="button"
            >
              操作技能试题质量标准
            </button>
            <button
              className="rounded-xl bg-[#2e66dd] px-5 py-3 text-base font-medium text-white disabled:cursor-not-allowed disabled:bg-[#9aaae0]"
              disabled={
                generatedPlan.status !== "ready" ||
                isConfirmingPlan || isGeneratingPlan
              }
              onClick={() =>
                historyPlanId && historyRequirementChanged
                  ? void generatePlan()
                  : void executePlan(generatedPlan)
              }
              type="button"
            >
              {isConfirmingPlan
                ? "正在启动..."
                : `确认并分批生成（${generatedPlan.minimumTotal}题）`}
            </button>
          </div>
        </section>
      ) : null}
      {confirmedPlanId || isViewingHistoryResult ? (
        <section className="mt-7 rounded-[22px] border border-[#d6e3ff] bg-white p-8 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="m-0 text-[28px] font-semibold text-[#293242]">
                命题成果与质量检查
              </h2>
              <p className="m-0 mt-3 text-[16px] text-[#6980a4]">
                查看题干、选项、答案、解析及审核状态
              </p>
            </div>
            <span className="rounded-xl bg-[#fff4df] px-4 py-2 text-sm text-[#a96f13]">
              {generationJob?.status === "stopped" ? "已停止，保留成果" : generationJob?.status === "cancelled" ? "已终止" : generationActive ? "后台生成中" : generationJob?.status === "partial" ? "尚未完成" : "待人工核查"}
            </span>
          </div>
          {generationJob ? (
            <div className="mt-6 rounded-xl border border-[#d6e3ff] bg-[#f5f8ff] p-5">
              <div className="flex flex-wrap justify-between gap-3 text-[#385578]">
                <span>
                  {generationJob.status === "stopped" ? "生成已停止，保留试题可继续人工核查和专家审定" : generationJob.status === "cancelled" ? "任务已终止，不再生成试题" : generationJob.status === "succeeded" ? "全部试题已生成" : generationJob.status === "partial" ? "部分请求失败，已保留成功草稿"
                    : generationJob.activity ? {
                      running: "正在执行请求（准备资料、调用模型或保存试题）",
                      queued: "等待后台领取（全局最多2路请求，较早任务优先）",
                      retry_wait: "等待下次执行时间，尚未发起请求",
                      rate_limited: "模型限流，等待冷却后继续",
                      recovering: "请求租约已过期，等待后台恢复",
                      disabled: "后台工作器已禁用，请检查服务器配置",
                      idle: "正在汇总生成状态",
                    }[generationJob.activity.state] : "正在自动分批生成试题"}
                </span>
                <strong>已生成 {generationJob.generated} / {generationJob.target} 道 · {Math.floor(generationJob.generated * 100 / Math.max(1, generationJob.target))}%</strong>
              </div>
              <div
                className="mt-3 h-2 overflow-hidden rounded-full bg-[#dfe8f8]"
                role="progressbar" aria-label="试题生成进度" aria-valuemin={0} aria-valuemax={generationJob.target} aria-valuenow={generationJob.generated}
              >
                <div className="h-full rounded-full bg-[#4160ec] transition-all" style={{ width: `${generationJob.generated * 100 / Math.max(1, generationJob.target)}%` }} />
              </div>
              <p className="mb-0 mt-3 text-sm text-[#6980a4]">
                {generationJob.currentBatch ? `当前第 ${generationJob.currentBatch} / ${generationJob.totalBatches} 批；` : ""}
                {generationJob.status === "stopped" ? "所有未完成请求已关闭，不再生成或重试。" : generationJob.status === "cancelled" ? "任务批次和请求已清理。" : `已完成 ${generationJob.completedBatches} / ${generationJob.totalBatches} 批。每批最多100题，每点合并题型生成，最多2路并发；刷新或关闭页面不会中断。`}
              </p>
              {generationJob.status === "cancelled" && generationJob.terminationSummary ? (
                <p className="mb-0 mt-3 text-sm text-[#6980a4]">已清理 {generationJob.terminationSummary.deletedQuestions} 道草稿；保留 {generationJob.terminationSummary.preservedQuestions} 道受保护试题。终止记录已留存。</p>
              ) : null}
              {generationJob.status === "stopped" && generationJob.stopSummary ? (
                <p className="mb-0 mt-3 text-sm text-[#6980a4]">原计划 {generationJob.stopSummary.target} 道，保留 {generationJob.stopSummary.preservedQuestions} 道，未生成 {generationJob.stopSummary.missingQuestions} 道。缺口及失败记录已留存。</p>
              ) : null}
              {(generationActive || generationJob.status === "partial") && confirmedPlanId ? (
                <div className="mt-3 flex flex-wrap gap-3">
                <button type="button" className="rounded-lg border border-[#b9cae5] bg-white px-4 py-2 text-[#385578] disabled:opacity-50"
                  disabled={Boolean(stoppingPlanId || terminatingPlanId)} onClick={() => void stopKeepTask(confirmedPlanId)}>
                  {stoppingPlanId === confirmedPlanId ? "停止生成中..." : "停止生成，保留成果"}
                </button>
                <button type="button" className="rounded-lg border border-[#f0c8ce] px-4 py-2 text-[#cf4d58] disabled:opacity-50"
                  disabled={Boolean(terminatingPlanId || stoppingPlanId)} onClick={() => void terminateTask(confirmedPlanId)}>
                  {terminatingPlanId === confirmedPlanId ? "终止清理中..." : "终止任务"}
                </button>
                </div>
              ) : null}
              {generationActive && generationJob.activity ? (
                <div className="mt-3 text-sm text-[#6980a4]">
                  <p className="m-0">本任务：执行中 {generationJob.activity.running} 个请求，排队 {generationJob.activity.queued} 个请求；全局执行中 {generationJob.activity.globalRunning} / 2 个请求。</p>
                  {generationJob.activity.recentErrors.map((error, index) => (
                    <p className="mb-0 mt-2 text-[#a6711f]" key={`${error.code}-${index}`}>最近错误 · {error.code} · 第{error.attempts}次尝试：{error.error}</p>
                  ))}
                </div>
              ) : null}
              {generationJob.failedUnits.length ? (
                <div className="mt-4 text-sm text-[#a6711f]">
                  <details>
                    <summary className="cursor-pointer">查看 {generationJob.failedUnits.length} 个{generationJob.status === "stopped" ? "已关闭缺额" : "失败请求"}</summary>
                    {generationJob.failedUnits.map((unit) => (
                      <p className="mb-0 mt-2" key={unit.id}>{unit.code} · {unit.type === "mixed" ? "混合题型" : unit.type === "single" ? "单选" : unit.type === "multiple" ? "多选" : unit.type === "practical" ? "实操" : "判断"} · 缺 {unit.remaining} 题{unit.attempts !== undefined ? ` · 累计${unit.attempts}次` : ""}：{unit.error}{generationJob.status !== "stopped" && unit.retryable === false ? " · 不可自动补题，需人工处理" : ""}</p>
                    ))}
                  </details>
                  {generationJob.status !== "stopped" ? <>
                  <button
                    className="mt-3 rounded-lg bg-[#2e66dd] px-4 py-2 text-white disabled:bg-[#9aaae0]"
                    disabled={isConfirmingPlan || Boolean(stoppingPlanId || terminatingPlanId) || generationActive || generationJob.failedUnits.every((unit) => unit.retryable === false)}
                    onClick={() => void retryFailedGeneration()} type="button"
                  >{isConfirmingPlan ? "正在重试..." : "仅重试失败部分"}</button>
                  <p className="mb-0 mt-2">重试先分析未覆盖知识角度，每次仅补1题；连续两次新增0题停止。累计最多6次精准补题、12次执行，达到上限或依据不足时需人工处理。</p>
                  </> : null}
                </div>
              ) : null}
              {progressError ? <p className="mb-0 mt-3 text-sm text-red-600" role="alert">{progressError}</p> : null}
            </div>
          ) : progressError ? <p className="mt-4 text-sm text-red-600" role="alert">{progressError}</p> : null}
          {sessionExpired ? (
            <a
              className="mt-3 inline-block rounded-lg bg-[#2e66dd] px-4 py-2 text-sm text-white"
              href={`/?callbackUrl=${encodeURIComponent(`/workspace/authoring?executionPlan=${confirmedPlanId ?? ""}`)}`}
            >重新登录并返回当前任务</a>
          ) : null}
          <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["已生成试题", `${executionQuestions.length}`],
              [
                "通过基础结构检查",
                `${executionQuestions.filter((item) => item.autoCheck === "通过基础检查").length}`,
              ],
              [
                "待人工核查",
                `${manualChecks.filter((item) => item === "待人工核查").length}`,
              ],
              [
                "执行进度",
                `${generationJob?.generated ?? executionQuestions.length}/${generationJob?.target ?? executionQuestions.length}`,
              ],
            ].map(([label, value]) => (
              <div
                className="rounded-xl border border-[#e0e8f5] bg-[#f5f8ff] p-5"
                key={label}
              >
                <p className="m-0 text-sm text-[#7185a5]">{label}</p>
                <p className="m-0 mt-4 text-[26px] font-semibold text-[#2d5cb4]">
                  {value}
                </p>
              </div>
            ))}
          </div>
          <p className="m-0 mt-5 rounded-xl border border-[#f2d59a] bg-[#fff7e7] px-5 py-4 text-[15px] leading-7 text-[#a6711f]">
            当前仅提供可核验草稿和基础结构检查结果，尚未生效或进入题库；须由专家审定通过后方可入库。
          </p>
          {questionPagination}
          <div className="mt-5 space-y-4">
            {visibleQuestions.map((item, pageIndex) => {
              const index = (questionPage - 1) * questionPageSize + pageIndex;
              return (
                <article
                  className="rounded-xl border border-[#dde5f1] p-5"
                  key={item.id}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <strong className="text-lg text-[#293242]">
                      {item.questionNo}
                    </strong>
                    <span className="rounded-lg bg-[#eaf2ff] px-3 py-1.5 text-sm text-[#3567c9]">
                      {item.questionType}
                    </span>
                    <p className="m-0 text-lg font-medium text-[#34445d]">
                      {item.stem}
                    </p>
                  </div>
                  <p className="m-0 mt-4 text-sm text-[#7185a5]">
                    考评点：{item.point}　·　质量：{item.autoCheck}
                  </p>
                  {item.options.length ? (
                    <div className="mt-4 space-y-2 text-[#34445d]">
                      {item.options.map((option) => (
                        <p className="m-0" key={option.key}>
                          {option.key}. {option.content}
                        </p>
                      ))}
                    </div>
                  ) : null}
                  <details className="mt-4 text-[#2e66dd]">
                    <summary className="cursor-pointer">查看答案、解析及评分标准</summary>
                    <p className="m-0 mt-2 text-sm text-[#50627e]">
                      答案：{item.answers.join("、")}；解析：{item.analysis}
                    </p>
                    <ScoreRubric value={item.scoreRubric} />
                  </details>
                  <label className="ml-5 text-sm text-[#7185a5]">
                    人工核查{" "}
                    <select
                      className="ml-2 rounded-lg border border-[#cbdaf0] bg-white px-3 py-2 text-[#385578]"
                      onChange={(event) =>
                        setManualChecks((current) =>
                          current.map((value, itemIndex) =>
                            itemIndex === index ? event.target.value : value,
                          ),
                        )
                      }
                      value={manualChecks[index]}
                    >
                      <option>待人工核查</option>
                      <option>人工通过</option>
                      <option>需修订</option>
                    </select>
                  </label>
                </article>
              );
            })}
          </div>
          {questionPagination}
          <div className="mt-7 flex flex-wrap justify-end gap-3">
            <button
              className="rounded-xl border border-[#cbdaf0] bg-white px-5 py-3 text-base text-[#385578]"
              onClick={() => {
                setConfirmedPlanId(null);
                setIsViewingHistoryResult(false);
                setExecutionQuestions([]);
              }}
              type="button"
            >
              返回执行过程
            </button>
            <button
              className="rounded-xl border border-[#cbdaf0] bg-white px-5 py-3 text-base text-[#385578]"
              onClick={() =>
                setManualChecks(executionQuestions.map(() => "人工通过"))
              }
              type="button"
            >
              批量标记基础检查通过
            </button>
            <button
              className="rounded-xl bg-[#2e66dd] px-5 py-3 text-base font-medium text-white disabled:cursor-not-allowed disabled:bg-[#9aaae0]"
              disabled={
                isSavingHandoff ||
                Boolean(generationJob && !["succeeded", "stopped"].includes(generationJob.status)) ||
                Boolean(stoppingPlanId || terminatingPlanId) ||
                !executionQuestions.length ||
                manualChecks.some((item) => item === "待人工核查")
              }
              onClick={saveExpertHandoff}
              type="button"
            >
              {isSavingHandoff ? "保存中..." : "保存待专家审定交接记录"}
            </button>
          </div>
        </section>
      ) : null}
      <section className="mt-7 rounded-[22px] border border-[#e0e6f0] bg-white p-8 shadow-card">
        <h2 className="m-0 text-[28px] font-semibold text-[#293242]">
          历史命题任务与计划
        </h2>
        <p className="m-0 mt-3 text-[15px] text-[#7185a5]">
          共{taskHistory.length}条任务记录，符合筛选条件{rows.length}
          条；可查看计划或管理历史记录
        </p>
        <div className="mt-8 flex flex-wrap items-end gap-4">
          <label className="text-sm font-medium text-[#607493]">
            搜索
            <input
              className="mt-2 block h-14 w-[360px] max-w-full rounded-xl border border-[#cbdaf0] px-4 text-base font-normal text-[#385578] outline-none"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="任务名称、职业、等级"
              value={query}
            />
          </label>
          <label className="text-sm font-medium text-[#607493]">
            任务阶段
            <select
              className="mt-2 block h-14 w-40 rounded-xl border border-[#cbdaf0] px-4 text-base font-normal text-[#385578]"
              onChange={(event) => setStatus(event.target.value)}
              value={status}
            >
              <option>全部状态</option>
              <option>待执行</option>
              <option>生成中</option>
              <option>部分失败</option>
              <option>已暂停</option>
              <option>已停止，保留成果</option>
              <option>已终止</option>
              <option>已完成</option>
            </select>
          </label>
          <button
            className="h-14 rounded-xl border border-[#cbdaf0] bg-white px-5 text-base text-[#3f567b]"
            onClick={() => {
              setQuery("");
              setStatus("全部状态");
            }}
            type="button"
          >
            清空筛选
          </button>
        </div>
        <div className="mt-6 overflow-x-auto rounded-xl border border-[#dde5f1]">
          <table className="min-w-[900px] w-full border-collapse text-left">
            <thead className="bg-[#f4f7fc] text-sm font-medium text-[#8493aa]">
              <tr>
                <th className="px-5 py-4">任务名称 / 职业</th>
                <th className="px-5 py-4">技能等级</th>
                <th className="px-5 py-4">保存时间</th>
                <th className="px-5 py-4">阶段 / 状态</th>
                <th className="px-5 py-4">操作</th>
              </tr>
            </thead>
            <tbody>
              {isLoadingHistory ? (
                <tr>
                  <td
                    className="px-5 py-10 text-center text-[#7185a5]"
                    colSpan={5}
                  >
                    正在加载历史命题计划...
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr className="border-t border-[#e4eaf3]" key={row.id}>
                    <td className="px-5 py-5">
                      <p className="m-0 font-semibold text-[#34445d]">
                        {row.name}
                      </p>
                      <p className="m-0 mt-2 text-sm text-[#7185a5]">
                        {row.scope_json.occupation} ·{" "}
                        {row.scope_json.assessmentMode}
                      </p>
                    </td>
                    <td className="px-5 py-5 text-[#34445d]">
                      {
                        {
                          level_5: "5级",
                          level_4: "4级",
                          level_3: "3级",
                          level_2: "2级",
                          level_1: "1级",
                        }[row.scope_json.levelCode]
                      }
                    </td>
                    <td className="px-5 py-5 text-[#34445d]">
                      {new Date(row.updated_at).toLocaleString("zh-CN", {
                        hour12: false,
                      })}
                    </td>
                    <td className="px-5 py-5 text-[#34445d]">
                      {getHistoryStage(row)}
                    </td>
                    <td className="px-5 py-5">
                      <button
                        className="rounded-xl border border-[#b9cae5] bg-white px-4 py-2.5 text-sm font-medium text-[#385578]"
                        disabled={isLoadingHistoryResult}
                        onClick={() =>
                          row.question_count > 0 || row.generation_status
                            ? void viewHistoryResult(row)
                            : viewHistoryPlan(row)
                        }
                        type="button"
                      >
                        {row.question_count > 0
                          ? isLoadingHistoryResult
                            ? "加载中..."
                            : "查看结果"
                          : "查看计划"}
                      </button>
                      <button
                        className="ml-3 rounded-xl border border-[#b9cae5] bg-white px-4 py-2.5 text-sm font-medium text-[#385578] disabled:opacity-50"
                        disabled={Boolean(stoppingPlanId || terminatingPlanId) || !["queued", "running", "partial"].includes(row.generation_status ?? "")}
                        onClick={() => void stopKeepTask(row.id)} type="button"
                      >
                        {stoppingPlanId === row.id ? "停止生成中..." : row.generation_status === "stopped" ? "已停止，保留成果" : "停止生成，保留成果"}
                      </button>
                      <button
                        className="ml-3 rounded-xl border border-[#f0c8ce] bg-white px-4 py-2.5 text-sm font-medium text-[#cf4d58]"
                        disabled={Boolean(terminatingPlanId || stoppingPlanId) || !["queued", "running", "partial"].includes(row.generation_status ?? "")}
                        onClick={() => void terminateTask(row.id)}
                        type="button"
                      >
                        {terminatingPlanId === row.id ? "终止清理中..." : row.generation_status === "cancelled" ? "已终止" : "终止任务"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
              {!isLoadingHistory && !rows.length ? (
                <tr>
                  <td
                    className="px-5 py-10 text-center text-[#7185a5]"
                    colSpan={5}
                  >
                    暂无历史命题计划。
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="m-0 mt-6 text-[#7185a5]">
          第 1 / 1 页，当前显示 {rows.length} 条
        </p>
      </section>
      {handoffNotice ? (
        <div
          aria-labelledby="handoff-notice-title"
          aria-modal="true"
          className="fixed inset-0 z-[140] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="w-full max-w-[754px] rounded-[24px] bg-white p-8 shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <h2
              className="m-0 text-[24px] font-semibold text-[#293242]"
              id="handoff-notice-title"
            >
              专家审定交接成功
            </h2>
            <p className="m-0 mt-7 text-[18px] leading-8 text-[#40516b]">
              {handoffNotice}
            </p>
            <div className="mt-8 flex justify-end">
              <button
                className="rounded-xl bg-[#2e66dd] px-7 py-3 text-base font-medium text-white"
                onClick={() => setHandoffNotice(null)}
                type="button"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {isPromptLibraryOpen ? (
        <div
          aria-labelledby="prompt-library-title"
          aria-modal="true"
          className="fixed inset-0 z-[110] overflow-y-auto bg-[#263548]/55 p-4 backdrop-blur-[2px] sm:grid sm:place-items-center"
          role="dialog"
        >
          <div className="my-5 w-full max-w-[1284px] overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-7">
              <h2
                className="m-0 text-[28px] font-semibold text-[#29436d]"
                id="prompt-library-title"
              >
                专业命题提示词库
              </h2>
              <button
                className="rounded-xl border border-[#cbdaf0] bg-white px-5 py-3 text-base text-[#293242]"
                onClick={() => setIsPromptLibraryOpen(false)}
                type="button"
              >
                关闭 ×
              </button>
            </div>
            <div className="p-9">
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  className="h-14 min-w-0 flex-1 rounded-xl border border-[#cbdaf0] px-4 text-base text-[#385578] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                  onChange={(event) => setPromptQuery(event.target.value)}
                  placeholder="搜索模板名称或内容"
                  value={promptQuery}
                />
                <select
                  className="h-14 rounded-xl border border-[#cbdaf0] bg-white px-4 text-base text-[#385578] outline-none"
                  onChange={(event) => setPromptCategory(event.target.value)}
                  value={promptCategory}
                >
                  {promptCategories.map((category) => (
                    <option key={category}>{category}</option>
                  ))}
                </select>
              </div>
              <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {filteredPromptTemplates.map((template) => (
                  <article
                    className="flex min-h-[264px] flex-col rounded-[16px] border border-[#d8e2f2] p-6"
                    key={template.name}
                  >
                    <span className="w-fit rounded-md bg-[#ebf1ff] px-3 py-1.5 text-sm text-[#4773c8]">
                      {template.category} ·{" "}
                      {promptTemplates.includes(template)
                        ? "系统内置"
                        : "自定义"}
                    </span>
                    <h3 className="m-0 mt-4 text-[21px] font-semibold text-[#29436d]">
                      {template.name}
                    </h3>
                    <p className="m-0 mt-4 text-[16px] leading-7 text-[#6980a4]">
                      {template.description}
                    </p>
                    <button
                      className="mt-auto w-fit rounded-xl bg-[#405fe7] px-5 py-3 text-base font-medium text-white hover:bg-[#3354d8]"
                      onClick={() => applyPromptTemplate(template)}
                      type="button"
                    >
                      使用模板
                    </button>
                  </article>
                ))}
              </div>
              {filteredPromptTemplates.length === 0 ? (
                <p className="m-0 py-12 text-center text-[#7185a5]">
                  未找到匹配的提示词模板。
                </p>
              ) : null}
              <p className="m-0 mt-6 text-[15px] text-[#7185a5]">
                系统内置模板不可修改或删除；自定义模板可在“管理提示词”中维护。用户可调整填入的需求文本，明确指定题量时按本次需求执行，未指定时使用默认配额；职业、等级与试题质量仍需通过系统校验。
              </p>
            </div>
          </div>
        </div>
      ) : null}
      {isPromptManagerOpen ? (
        <div
          aria-labelledby="prompt-manager-title"
          aria-modal="true"
          className="fixed inset-0 z-[120] overflow-y-auto bg-[#263548]/55 p-4 backdrop-blur-[2px] sm:grid sm:place-items-center"
          role="dialog"
        >
          <div className="my-5 w-full max-w-[1284px] overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-7">
              <h2
                className="m-0 text-[28px] font-semibold text-[#29436d]"
                id="prompt-manager-title"
              >
                管理命题提示词模板
              </h2>
              <button
                className="rounded-xl border border-[#cbdaf0] bg-white px-5 py-3 text-base text-[#293242]"
                onClick={() => {
                  setIsPromptManagerOpen(false);
                  setIsPromptTemplateFormOpen(false);
                }}
                type="button"
              >
                关闭 ×
              </button>
            </div>
            {isPromptTemplateFormOpen ? (
              <div className="p-9">
                <div className="space-y-5">
                  <label className="block text-base font-medium text-[#4e6688]">
                    模板名称
                    <input
                      className="mt-2 block h-14 w-full rounded-xl border border-[#cbdaf0] px-4 text-base font-normal text-[#385578] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                      onChange={(event) => setTemplateName(event.target.value)}
                      value={templateName}
                    />
                  </label>
                  <label className="block text-base font-medium text-[#4e6688]">
                    模板分类
                    <select
                      className="mt-2 block h-14 w-full rounded-xl border border-[#cbdaf0] bg-white px-4 text-base font-normal text-[#385578] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                      onChange={(event) =>
                        setTemplateCategory(event.target.value)
                      }
                      value={templateCategory}
                    >
                      {promptCategories
                        .filter((category) => category !== "全部")
                        .map((category) => (
                          <option key={category}>{category}</option>
                        ))}
                    </select>
                  </label>
                  <label className="block text-base font-medium text-[#4e6688]">
                    用途简介
                    <input
                      className="mt-2 block h-14 w-full rounded-xl border border-[#cbdaf0] px-4 text-base font-normal text-[#385578] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                      onChange={(event) =>
                        setTemplateDescription(event.target.value)
                      }
                      value={templateDescription}
                    />
                  </label>
                  <label className="block text-base font-medium text-[#4e6688]">
                    提示词内容
                    <textarea
                      className="mt-2 block h-[216px] w-full rounded-xl border border-[#cbdaf0] p-4 text-base font-normal leading-7 text-[#385578] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                      onChange={(event) =>
                        setTemplateContent(event.target.value)
                      }
                      value={templateContent}
                    />
                  </label>
                  <label className="block text-base font-medium text-[#4e6688]">
                    启用状态
                    <select
                      className="mt-2 block h-14 w-full rounded-xl border border-[#cbdaf0] bg-white px-4 text-base font-normal text-[#385578] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                      onChange={(event) =>
                        setTemplateEnabled(event.target.value)
                      }
                      value={templateEnabled}
                    >
                      <option>启用</option>
                      <option>停用</option>
                    </select>
                  </label>
                </div>
                {templateError ? (
                  <p className="m-0 mt-4 text-sm text-[#c6474e]">
                    {templateError}
                  </p>
                ) : null}
                <div className="mt-4 flex justify-end gap-3 border-t border-[#e5e9f0] pt-5">
                  <button
                    className="rounded-xl border border-[#cbdaf0] bg-white px-5 py-3 text-base text-[#385578]"
                    onClick={() => setIsPromptTemplateFormOpen(false)}
                    type="button"
                  >
                    返回
                  </button>
                  <button
                    className="rounded-xl bg-[#405fe7] px-5 py-3 text-base font-medium text-white hover:bg-[#3354d8]"
                    onClick={savePromptTemplate}
                    type="button"
                  >
                    保存模板
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-9">
                <div className="flex flex-col gap-3 sm:flex-row">
                  <input
                    className="h-14 min-w-0 flex-1 rounded-xl border border-[#cbdaf0] px-4 text-base text-[#385578] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff]"
                    onChange={(event) => setPromptQuery(event.target.value)}
                    placeholder="搜索模板名称或内容"
                    value={promptQuery}
                  />
                  <select
                    className="h-14 rounded-xl border border-[#cbdaf0] bg-white px-4 text-base text-[#385578] outline-none"
                    onChange={(event) => setPromptCategory(event.target.value)}
                    value={promptCategory}
                  >
                    {promptCategories.map((category) => (
                      <option key={category}>{category}</option>
                    ))}
                  </select>
                  <button
                    className="h-14 shrink-0 rounded-xl bg-[#405fe7] px-5 text-base font-medium text-white hover:bg-[#3354d8]"
                    onClick={startNewPromptTemplate}
                    type="button"
                  >
                    ＋ 新建模板
                  </button>
                </div>
                <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {filteredManagedPromptTemplates.map((template) => (
                    <article
                      className="flex min-h-[264px] flex-col rounded-[16px] border border-[#d8e2f2] p-6"
                      key={template.name}
                    >
                      <span className="w-fit rounded-md bg-[#ebf1ff] px-3 py-1.5 text-sm text-[#4773c8]">
                        {template.category} ·{" "}
                        {promptTemplates.includes(template)
                          ? "系统内置"
                          : "自定义"}
                      </span>
                      <h3 className="m-0 mt-4 text-[21px] font-semibold text-[#29436d]">
                        {template.name}
                      </h3>
                      <p className="m-0 mt-4 text-[16px] leading-7 text-[#6980a4]">
                        {template.description}
                      </p>
                      <button
                        className="mt-auto w-fit rounded-xl bg-[#405fe7] px-5 py-3 text-base font-medium text-white hover:bg-[#3354d8]"
                        onClick={() => applyPromptTemplate(template)}
                        type="button"
                      >
                        使用模板
                      </button>
                    </article>
                  ))}
                </div>
                {filteredManagedPromptTemplates.length === 0 ? (
                  <p className="m-0 py-12 text-center text-[#7185a5]">
                    未找到匹配的提示词模板。
                  </p>
                ) : null}
                <p className="m-0 mt-6 text-[15px] text-[#7185a5]">
                  系统内置模板不可修改或删除。自定义模板保存在当前浏览器中，可用于填充命题需求。
                </p>
              </div>
            )}
          </div>
        </div>
      ) : null}
      {isRulesOpen ? (
        <div
          aria-labelledby="rules-title"
          aria-modal="true"
          className="fixed inset-0 z-[110] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="w-full max-w-[1440px] overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-7">
              <div>
                <h2
                  className="m-0 text-[28px] font-semibold text-[#29436d]"
                  id="rules-title"
                >
                  命题规则要求 · 国家题库开发指南
                </h2>
                <p className="m-0 mt-4 text-[16px] text-[#6f85a8]">
                  依据《中华人民共和国职业技能培训技术指导中心命题处〈技能人才评价国家题库开发指南〉》（2024年4月）整理
                </p>
              </div>
              <button
                className="rounded-xl border border-[#cbdaf0] bg-white px-5 py-3 text-base text-[#293242]"
                onClick={() => setIsRulesOpen(false)}
                type="button"
              >
                关闭 ×
              </button>
            </div>
            <div className="p-8">
              <div className="flex flex-wrap gap-3">
                {ruleTabs.map((tab, index) => (
                  <button
                    className={`rounded-xl border px-5 py-4 text-base font-medium ${index === ruleTab ? "border-[#405fe7] bg-[#405fe7] text-white" : "border-[#c8d7ee] bg-[#f7f9fd] text-[#536d94]"}`}
                    key={tab.label}
                    onClick={() => setRuleTab(index)}
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              <p className="m-0 mt-7 rounded-xl bg-[#f2f6fd] px-5 py-4 text-[16px] text-[#6d85aa]">
                指南对应页：{activeRule.pages}
              </p>
              <div className="mt-6 text-[18px] leading-9 text-[#385578]">
                <p className="m-0">{activeRule.body}</p>
                <ul className="m-0 mt-4 list-disc space-y-3 pl-7">
                  {activeRule.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </div>
              <p className="m-0 mt-7 border-t border-[#e4eaf3] pt-5 text-sm text-[#7185a5]">
                此处为供命题人快速查阅的重点提要，完整规定以已上传的原始《开发指南》及相应职业现行国家职业标准为准。系统提示词不得替代细目表或专业审核。
              </p>
            </div>
          </div>
        </div>
      ) : null}
      {isQualityStandardOpen ? (
        <div
          aria-labelledby="quality-standard-title"
          aria-modal="true"
          className="fixed inset-0 z-[120] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]"
          role="dialog"
        >
          <div className="w-full max-w-[820px] overflow-hidden rounded-[20px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
            <div className="flex items-center justify-between border-b border-[#e5e9f0] px-8 py-6">
              <div>
                <h2
                  className="m-0 text-[26px] font-semibold text-[#29436d]"
                  id="quality-standard-title"
                >
                  {qualityStandardTitle}
                </h2>
                <p className="m-0 mt-2 text-[15px] text-[#7185a5]">
                  保存后覆盖当前标准，并在后续{qualityStandardKind === "skill" ? "操作技能" : ""} AI 命题时作为质量约束使用。
                </p>
              </div>
              <button
                aria-label={`关闭${qualityStandardTitle}`}
                className="text-3xl text-[#7185a5]"
                disabled={isSavingQualityStandard}
                onClick={() => setIsQualityStandardOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <div className="p-8">
              <label className="block text-[16px] text-[#526f97]">
                质量标准文本
                <textarea
                  className="mt-3 min-h-[340px] w-full resize-y rounded-xl border border-[#cbdaf0] px-5 py-4 text-[16px] leading-7 text-[#34445d] outline-none focus:border-[#7691ee] focus:ring-2 focus:ring-[#e8eeff] disabled:bg-[#f5f7fb]"
                  disabled={isLoadingQualityStandard || isSavingQualityStandard}
                  onChange={(event) => setQualityStandard(event.target.value)}
                  placeholder={`请输入${qualityStandardTitle}`}
                  value={qualityStandard}
                />
              </label>
              {isLoadingQualityStandard ? (
                <p className="mb-0 mt-3 text-sm text-[#7185a5]">加载中...</p>
              ) : null}
              {qualityStandardError ? (
                <p className="mb-0 mt-4 rounded-xl border border-[#f0c4c4] bg-[#fff5f5] px-4 py-3 text-sm text-[#b34d4d]">
                  {qualityStandardError}
                </p>
              ) : null}
            </div>
            <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-8 py-5">
              <button
                className="rounded-xl border border-[#cbdaf0] bg-white px-5 py-3 text-base text-[#385578]"
                disabled={isSavingQualityStandard}
                onClick={() => setIsQualityStandardOpen(false)}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-xl bg-[#2e66dd] px-5 py-3 text-base font-medium text-white disabled:cursor-not-allowed disabled:bg-[#9aaae0]"
                disabled={
                  isLoadingQualityStandard ||
                  isSavingQualityStandard ||
                  !qualityStandard.trim()
                }
                onClick={() => void saveQualityStandard()}
                type="button"
              >
                {isSavingQualityStandard ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function AuthoringWorkspace() {
  const [activeTab, setActiveTab] = useState<AuthoringTab>("考评蓝图");

  return (
    <section>
      <div className="flex gap-8 overflow-x-auto border-b border-[#e2e6ee]">
        {tabs.map((tab) => {
          const active = tab === activeTab;
          return (
            <button
              aria-selected={active}
              className={`relative shrink-0 border-0 bg-transparent px-1 pb-4 text-[17px] font-medium transition ${
                active
                  ? "text-[#3f60e8]"
                  : "text-[#9aa4b5] hover:text-[#60708c]"
              }`}
              key={tab}
              onClick={() => setActiveTab(tab)}
              role="tab"
              type="button"
            >
              {tab}
              {active ? (
                <span className="absolute inset-x-0 -bottom-px h-[3px] rounded-full bg-[#3f60e8]" />
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="pt-12">
        {activeTab === "考评蓝图" ? (
          <BlueprintPanel />
        ) : activeTab === "命题任务" ? (
          <AuthoringTaskPanel />
        ) : activeTab === "资料依据" ? (
          <SourceMaterialsPanel />
        ) : activeTab === "质量检查" ? (
          <QualityInspectionPanel />
        ) : (
          <PlaceholderPanel tab={activeTab} />
        )}
      </div>
    </section>
  );
}
