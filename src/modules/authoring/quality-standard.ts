export const qualityStandardConfigs = {
  theory: {
    settingKey: "authoring.question_quality_standard",
    title: "试题质量标准",
    defaultContent: `1. 试题应准确对应考评点，不得超出职业标准和细目表范围。
2. 题干表述清晰、条件完整，避免歧义、暗示性和无关信息。
3. 选择题选项应具有合理干扰性，答案唯一或组合明确。
4. 答案和解析必须准确，解析应说明判断依据。
5. 同一计划内试题应避免重复或高度相似。`,
  },
  skill: {
    settingKey: "authoring.skill_question_quality_standard",
    title: "操作技能试题质量标准",
    defaultContent: `1. 试题须对应冻结鉴定点及职业标准原文，不得跨等级、方向或超出考核范围。
2. 任务情境、工作要求和提交成果须清晰完整，具备可执行性与可观察性。
3. 参考答案应列出完整操作步骤，评分项目应对应可核验的操作表现或成果。
4. 各评分项目分值之和须等于总分，评分标准应明确、客观，便于考评员一致评分。
5. 综合鉴定点应覆盖其下属技能的完整工作过程，不得缩减为单个子技能。
6. 不得编造法律条文、国家标准、强制工具、时间或数值阈值；缺少的关键数据标注“待核对”，模拟材料须标注“模拟题设”。
7. 同一计划内任务内容不得重复或高度相似，生成结果须经人工审定后方可入库。`,
  },
} as const;

export type QualityStandardKind = keyof typeof qualityStandardConfigs;

export function qualityStandardContent(value: unknown, fallback: string): string {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const content = (parsed as { content?: unknown } | null)?.content;
  return typeof content === "string" && content.trim() ? content : fallback;
}
