export const skillGenerationLevels = ["level_5", "level_4", "level_3"] as const;
export const skillOutlineWorkerVersion = "standard_hierarchy_three_levels_v1";

export function isSkillGenerationLevel(level: string) {
  return (skillGenerationLevels as readonly string[]).includes(level);
}

export function skillGenerationRule(mode: "textbook" | "model") {
  return mode === "model" ? "standard_hierarchy_1to1" : "knowledge_1to1_three_levels";
}
