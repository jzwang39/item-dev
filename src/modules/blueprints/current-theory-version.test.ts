import assert from "node:assert/strict";
import test from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { assertPlanVersions, readCurrentTheoryVersion } from "./current-theory-version";

type Row = {
  project: string; occupation: string; kind: string; mode: string; level: string;
  updated: number; blueprintId: string; id: string | null;
};
function database(rows: Row[]) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { execute: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values });
    assert.match(sql, /INNER JOIN blueprint_versions bv ON bv.id = b.current_version_id/);
    assert.match(sql, /ORDER BY b.updated_at DESC, b.id DESC/);
    assert.match(sql, /LIMIT 1 FOR UPDATE/);
    const matches = rows.filter((row) => row.project === values[0] && row.occupation === values[1] &&
      row.kind === values[2] && row.mode === "theory" && row.id &&
      (sql.includes("AND b.level_code = ?") ? row.level === values[3] : true));
    matches.sort((a, b) => b.updated - a.updated || b.blueprintId.localeCompare(a.blueprintId));
    return [matches.slice(0, 1).map((row) => ({ id: row.id, version_no: 1, snapshot_json: {}, created_at: new Date() })), []];
  } } as unknown as PoolConnection;
  return { db, calls };
}
const common = { project: "business", occupation: "occupation", mode: "theory", level: "level_5", blueprintId: "B" };
const selection = { projectId: "business", occupationId: "occupation" };

test("旧权重排在前面时，生成与确认均取最新权重，不误报更新", async () => {
  const { db } = database([
    { ...common, kind: "theory_weight", updated: 1, id: "old-weight" },
    { ...common, kind: "theory_weight", updated: 3, id: "new-weight" },
    { ...common, kind: "theory_outline", updated: 2, id: "outline" },
  ]);
  const weights = await readCurrentTheoryVersion(db, { ...selection, kind: "theory_weight" });
  assert.equal(weights?.id, "new-weight");
  const current = {
    weights: await readCurrentTheoryVersion(db, { ...selection, kind: "theory_weight" }),
    outline: await readCurrentTheoryVersion(db, { ...selection, kind: "theory_outline", levelCode: "level_5" }),
  };
  assert.doesNotThrow(() => assertPlanVersions(current, { weights: { id: weights!.id }, outline: { id: "outline" } }));
});

test("相同更新时间的重复记录使用蓝图ID排序保证确定性", async () => {
  const { db } = database([
    { ...common, blueprintId: "A", kind: "theory_weight", updated: 1, id: "A-version" },
    { ...common, blueprintId: "Z", kind: "theory_weight", updated: 1, id: "Z-version" },
  ]);
  assert.equal((await readCurrentTheoryVersion(db, { ...selection, kind: "theory_weight" }))?.id, "Z-version");
});

test("细目表严格区分等级、职业、项目及理论技能模式", async () => {
  const { db } = database([
    { ...common, kind: "theory_outline", updated: 1, id: "correct" },
    { ...common, kind: "theory_outline", level: "level_4", updated: 9, id: "other-level" },
    { ...common, kind: "theory_outline", occupation: "other", updated: 9, id: "other-occupation" },
    { ...common, kind: "theory_outline", project: "legal", updated: 9, id: "other-project" },
    { ...common, kind: "theory_outline", mode: "skill", updated: 9, id: "skill" },
  ]);
  assert.equal((await readCurrentTheoryVersion(db, { ...selection, kind: "theory_outline", levelCode: "level_5" }))?.id, "correct");
});

test("权重表为职业级共享，不按当前命题等级误过滤", async () => {
  const { db, calls } = database([{ ...common, kind: "theory_weight", updated: 1, id: "shared-weight" }]);
  assert.equal((await readCurrentTheoryVersion(db, { ...selection, kind: "theory_weight" }))?.id, "shared-weight");
  assert.doesNotMatch(calls[0].sql, /AND b.level_code/);
  assert.equal(calls[0].values.length, 3);
});

test("空current_version或缺少有效版本仍拦截，不回退历史版本", async () => {
  const { db } = database([{ ...common, kind: "theory_weight", updated: 5, id: null }]);
  assert.equal(await readCurrentTheoryVersion(db, { ...selection, kind: "theory_weight" }), null);
  assert.throws(() => assertPlanVersions({ outline: { id: "outline" }, weights: null },
    { outline: { id: "outline" }, weights: { id: "old" } }), /权重表已更新或不再可用/);
});

test("真正发生版本变化时精确提示变更对象，技能也保留版本保护", () => {
  const current = { outline: { id: "outline" }, weights: { id: "weights" } };
  assert.doesNotThrow(() => assertPlanVersions(current, current));
  assert.throws(() => assertPlanVersions(current, { ...current, outline: { id: "old-outline" } }), /细目表已更新/);
  assert.throws(() => assertPlanVersions(current, { ...current, weights: { id: "old-weights" } }), /权重表已更新/);
  assert.throws(() => assertPlanVersions(current, { outline: { id: "old" }, weights: { id: "old" } }), /细目表、权重表/);
});
