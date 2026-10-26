import { z } from "zod";

const pointSchema = z.object({
  name: z.string().trim().min(2).max(500).regex(/[\u4e00-\u9fff]/, "考评点名称必须使用中文"),
  importance: z.enum(["X", "Y", "Z"]).default("X"),
  tertiaryName: z.string().trim().min(1).max(500).optional(),
});

const arrayKeys = ["points", "考评点", "考核点", "考评点列表", "考核点列表", "assessmentPoints"];
const wrapperKeys = ["data", "result", "output"];
type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function findPoints(value: unknown, depth = 0): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record || depth > 2) return undefined;
  for (const key of arrayKeys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  for (const key of wrapperKeys) {
    const points = findPoints(record[key], depth + 1);
    if (points !== undefined) return points;
  }
  return undefined;
}

function firstValue(record: RecordValue, keys: string[]) {
  return keys.map((key) => record[key]).find((value) => value !== undefined && value !== null && value !== "");
}

function parseJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[{[]/);
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // Report malformed output rather than silently treating it as an empty batch.
      }
    }
    throw new Error("AI 返回的细目表 JSON 格式不正确。");
  }
}

export function parseModelOutput(content: string) {
  const payload = parseJson(content);
  const rawPoints = findPoints(payload);
  if (!rawPoints) {
    const keys = Object.keys(asRecord(payload) ?? {}).slice(0, 8).join("、");
    throw new Error(`AI 响应未包含考评点数组${keys ? `（返回字段：${keys}）` : ""}。`);
  }
  const points: z.infer<typeof pointSchema>[] = [];
  let invalidCount = 0;
  for (const rawPoint of rawPoints) {
    const point = asRecord(rawPoint) ?? {};
    const importance = firstValue(point, ["importance", "重要程度", "importanceCode"]);
    const result = pointSchema.safeParse({
      name: firstValue(point, ["name", "考评点名称", "考核点名称", "名称"]),
      importance: typeof importance === "string" ? importance.trim().toUpperCase() : importance,
      tertiaryName: firstValue(point, ["tertiaryName", "三级考评范围", "三级名称", "三级名称/代码"]),
    });
    if (result.success) points.push(result.data);
    else invalidCount += 1;
  }
  return { points, receivedCount: rawPoints.length, invalidCount };
}
