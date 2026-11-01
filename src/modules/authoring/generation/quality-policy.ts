import type { QuestionType } from "./contracts";
import type { QualityStandardKind } from "../quality-standard";

export type QualityRelaxation = {
  rule: "knowledge_independence";
  reason: string;
  knowledge: string;
  task: string;
  questionType: QuestionType;
  recordedAt: string;
};

export const QUALITY_FLOOR = "答案正确且可判定、单选唯一解、依据真实可核验、题干条件完整可答、符合考评点和等级；不得编造事实或依据，不得以题数要求突破这些底线。AI结果仅为待人工审定草稿。";

export function generationQualityPolicy(kind: QualityStandardKind, targeted: boolean) {
  return {
    题量优先: "按当前考评点及每种题型的实际缺额补齐，不用其他考评点或其他题型抵数。",
    不可放宽底线: QUALITY_FLOOR,
    质量标准执行: "完整遵守数据库提供的对应质量标准，不删除、覆盖或放宽标准中的要求；每个候选须重新核验。",
    多样性策略: kind === "skill"
      ? "操作技能只按专项标准设计不同任务；不得套用理论题的同知识变式放宽。任务情境、提交成果、操作步骤、评分项目及分值、综合技能覆盖不得缺失；缺少关键数据保留待核对。"
      : targeted
        ? "补题优先寻找新知识；仅在完整质量标准允许时采用同一知识、不同考查任务，并说明任务差异。若标准要求知识独立，不得覆盖该要求。只换词、语序、答案位置或简单正反改写不算新题。"
        : "首轮优先不同知识要素和考查任务，尽量满足全部质量要求；不足部分进入精准补题，不用重复题凑数。",
  };
}
