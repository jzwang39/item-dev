export const theoryOutlineGenerationLevels = ["level_5", "level_4", "level_3"] as const;

export function isTheoryOutlineGenerationLevel(level: string): boolean {
  return theoryOutlineGenerationLevels.some((candidate) => candidate === level);
}
