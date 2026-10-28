import type { OccupationDirection } from "@/modules/authoring/occupations/directions";
import type { PdfTextRun } from "@/modules/documents/extraction/service";
import { normalizeStandardText, type TheoryWeightLevel, type WeightColumnHint } from "./standard";

const gradeLevels: Record<string, TheoryWeightLevel> = {
  五: "level_5", 四: "level_4", 三: "level_3", 二: "level_2", 一: "level_1",
};

export function readPdfWeightColumns(
  pages: readonly PdfTextRun[][],
  directions: readonly OccupationDirection[],
): WeightColumnHint[] {
  for (const page of pages) {
    const text = normalizeStandardText(page.map((run) => run.text).join(" "));
    if (!/理论知识权重表/.test(text) || !/基本要求/.test(text)) continue;
    const gradeRuns = page.flatMap((run) => {
      const match = run.text.replace(/\s+/g, "").match(/^([五四三二一])级/);
      return match ? [{ levelCode: gradeLevels[match[1]], center: run.x + run.width / 2, y: run.y }] : [];
    });
    if (gradeRuns.length !== 5) continue;
    const namedRuns = page.flatMap((run) => {
      const direction = directions.find((item) => run.text.replace(/\s+/g, "") === item.name.replace(/\s+/g, ""));
      return direction ? [{ name: direction.name, center: run.x + run.width / 2, y: run.y }] : [];
    });
    // Multi-line direction labels retain their horizontal anchor.
    if (!namedRuns.length) {
      for (const direction of directions) {
        for (const run of page) {
          const nearby = page.filter((item) => Math.abs(item.x - run.x) < 8 && Math.abs(item.y - run.y) < 40)
            .sort((a, b) => b.y - a.y);
          if (nearby.map((item) => item.text).join("").replace(/\s+/g, "") === direction.name.replace(/\s+/g, "")) {
            namedRuns.push({ name: direction.name, center: run.x + run.width / 2, y: run.y });
            break;
          }
        }
      }
    }
    if (!namedRuns.length) continue;
    const columns: { center: number; levelCode: TheoryWeightLevel; directionName: string | null }[] = [];
    for (const grade of gradeRuns) {
      const names = namedRuns.filter((name) => {
        const closest = [...gradeRuns].sort((a, b) => Math.abs(a.center - name.center) - Math.abs(b.center - name.center))[0];
        return closest === grade && name.y <= grade.y && grade.y - name.y < 80;
      });
      if (names.length) {
        columns.push(...names.map((name) => ({ center: name.center, levelCode: grade.levelCode, directionName: name.name })));
      } else {
        columns.push({ ...grade, directionName: null });
      }
    }
    return columns.sort((a, b) => a.center - b.center).map(({ levelCode, directionName }) => ({ levelCode, directionName }));
  }
  return [];
}
