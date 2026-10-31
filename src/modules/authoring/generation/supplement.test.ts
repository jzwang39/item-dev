import assert from "node:assert/strict";
import test from "node:test";
import type { PoolConnection } from "mysql2/promise";
import { queueSupplementRound, supplementManifest, type SupplementSlot, type SupplementUnit } from "./supplement";
import type { Snapshot } from "./contracts";

const snapshot: Snapshot = {
  projectId: "project", requirement: "每点4单选2判断",
  scope: { occupationId: "occupation", occupation: "测试职业", levelCode: "level_4", assessmentMode: "理论知识",
    blueprintVersions: { outline: { id: "outline", versionNo: 1 }, weights: { id: "weights", versionNo: 1 } } },
  points: [{ code: "A", name: "归档规则", single: 4, multiple: 0, judgement: 2, total: 6 }],
  qualityRequirements: [], qualityStandard: "理论标准", sourceVersionIds: [],
  nodes: [{ id: "node", code: "A", name: "归档规则", chapterIds: [] }],
  model: { provider: "test", baseUrl: "https://test.example/v1", model: "test-model" },
};

function fixture() {
  const units: SupplementUnit[] = [{
    id: "original", batch_id: "batch", ordinal: 1, point_code: "A", status: "stopped", attempts: 12,
    retry_state_json: { targetedAttempts: 6, failures: [{ code: "duplicate", message: "题干重复" }] },
  }];
  const slots: SupplementSlot[] = ["single", "single", "single", "single", "judgement", "judgement"].map((type, index) => ({
    id: `slot-${index + 1}`, unit_id: "original", ordinal: index + 1,
    question_type: type as SupplementSlot["question_type"], question_id: index < 3 ? `saved-${index}` : null,
  }));
  return { units, slots };
}

test("按冻结逐点逐题型最低题量只补空槽，保留成功题的题号和归属", () => {
  const { units, slots } = fixture();
  const manifest = supplementManifest(snapshot, units, slots);
  assert.equal(manifest.target, 6);
  assert.equal(manifest.preservedQuestions, 3);
  assert.equal(manifest.missingQuestions, 3);
  assert.deepEqual(manifest.groups[0].slots.map((slot) => slot.question_type), ["single", "judgement", "judgement"]);
  assert.deepEqual(manifest.groups[0].slots.map((slot) => slot.ordinal), [4, 5, 6]);
});

test("总数相同但题型或考评点配额错位也拒绝，不用其他题抵缺额", () => {
  const { units, slots } = fixture();
  assert.throws(() => supplementManifest(snapshot, units, slots.map((slot) => ({ ...slot, question_type: "single" }))), /逐题型/);
  assert.throws(() => supplementManifest(snapshot, [{ ...units[0], point_code: "B" }], slots), /超出/);
  assert.throws(() => supplementManifest(snapshot, units, slots.slice(1)), /最低题量/);
  assert.throws(() => supplementManifest(snapshot, units, [...slots, slots[0]]), /重复/);
});

test("无缺额、未停止和活动请求不创建新一轮，技能按实操题配额补题", () => {
  const { units, slots } = fixture();
  assert.throws(() => supplementManifest(snapshot, units, slots.map((slot) => ({ ...slot, question_id: "saved" }))), /无需/);
  assert.throws(() => supplementManifest(snapshot, [{ ...units[0], status: "running" }], slots), /尚未关闭/);
  const skill: Snapshot = { ...snapshot, scope: { ...snapshot.scope, assessmentMode: "操作技能" }, points: [{ ...snapshot.points[0], single: 0, judgement: 0, practical: 2, total: 2 }] };
  const manifest = supplementManifest(skill, units, slots.slice(0, 2).map((slot, index) => ({
    ...slot, question_type: "practical", question_id: index ? null : slot.question_id,
  })));
  assert.equal(manifest.missingQuestions, 1);
  assert.equal(manifest.groups[0].slots[0].question_type, "practical");
});

test("大缺额分拆为每请求最多6题，精准补题上限不会天然小于本请求缺额", () => {
  const { units } = fixture();
  const large = { ...snapshot, points: [{ ...snapshot.points[0], single: 12, judgement: 0, total: 12 }] };
  const slots = Array.from({ length: 12 }, (_, index) => ({
    id: `slot-${index}`, ordinal: index + 1, unit_id: "original", question_type: "single" as const, question_id: null,
  }));
  const manifest = supplementManifest(large, units, slots);
  assert.equal(manifest.missingQuestions, 12);
  assert.deepEqual(manifest.groups.map((group) => group.slots.length), [6, 6]);
  assert.equal(new Set(manifest.groups.flatMap((group) => group.slots.map((slot) => slot.id))).size, 12);
});

function fakeDatabase(status: string | null = "stopped", outlineConfirmed = true) {
  const data = fixture();
  const job = { id: "job", status, target_count: 6, snapshot_json: snapshot, stop_summary_json: { target: 6, preservedQuestions: 3, missingQuestions: 3 } };
  const writes: Array<{ sql: string; params: unknown[] }> = [];
  const statements: string[] = [];
  const db = { execute: async (sql: string, params: unknown[] = []) => {
    statements.push(sql);
    if (sql.startsWith("SELECT id FROM authoring_generation_capacity")) return [[{ id: 1 }]];
    if (sql.startsWith("SELECT project_id,status")) return [[{ project_id: "project", status: "confirmed" }]];
    if (sql.includes("SELECT id,status,target_count,snapshot_json")) return [job.status ? [{ ...job }] : []];
    if (sql.includes("SELECT po.id")) return [[{ id: "occupation" }]];
    if (sql.includes("SELECT v.version_no")) return [[{ version_no: 1 }]];
    if (sql.includes("LEFT JOIN outline_point_reviews")) return [[{ total: 1, confirmed: outlineConfirmed ? 1 : 0 }]];
    if (sql.startsWith("SELECT id,batch_id")) return [[...data.units]];
    if (sql.startsWith("SELECT id,unit_id")) return [data.slots.map((slot) => ({ ...slot }))];
    writes.push({ sql, params });
    if (sql.startsWith("INSERT INTO authoring_generation_units")) {
      data.units.push({ id: params[0] as string, batch_id: params[2] as string, ordinal: params[3] as number,
        point_code: params[4] as string, status: "queued", attempts: 0, retry_state_json: JSON.parse(params[6] as string) });
    } else if (sql.startsWith("UPDATE authoring_generation_slots")) {
      for (const slot of data.slots) if (!slot.question_id && slot.unit_id === params[2] && params.slice(3).includes(slot.id)) slot.unit_id = params[0] as string;
    } else if (sql.startsWith("UPDATE authoring_generation_jobs")) job.status = "queued";
    return [{ affectedRows: 1 }];
  } } as unknown as PoolConnection;
  return { db, ...data, job, writes, statements };
}

test("新请求接管空槽，旧请求累计12次及错误历史不清零；重复启动被锁定状态拒绝", async () => {
  const fake = fakeDatabase();
  const old = structuredClone(fake.units[0]);
  const saved = structuredClone(fake.slots.slice(0, 3));
  const result = await queueSupplementRound(fake.db, "plan", "admin", snapshot.model);
  assert.equal(result.summary.missingQuestions, 3);
  assert.equal(fake.job.status, "queued");
  assert.deepEqual(fake.units[0], old);
  assert.deepEqual(fake.slots.slice(0, 3), saved);
  const fresh = fake.units[1];
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.attempts, 0);
  assert.deepEqual(fake.slots.slice(3).map((slot) => slot.unit_id), [fresh.id, fresh.id, fresh.id]);
  assert.equal(fake.statements[0], "SELECT id FROM authoring_generation_capacity WHERE id=1 FOR UPDATE");
  const metadata = fresh.retry_state_json as { supplement: { previousAttempts: number; previousUnitId: string; actorId: string }; targeted: boolean };
  assert.equal(metadata.supplement.previousAttempts, 12);
  assert.equal(metadata.supplement.previousUnitId, old.id);
  assert.equal(metadata.supplement.actorId, "admin");
  assert.equal(metadata.targeted, true);
  assert.ok(fake.writes.some((write) => write.sql.includes("authoring.plan.supplement_started")));
  const writes = fake.writes.length;
  await assert.rejects(queueSupplementRound(fake.db, "plan", "admin", snapshot.model), /仅停止/);
  assert.equal(fake.writes.length, writes);
});

test("取消、运行中、部分失败、已完成及无任务均不能走停止后补题入口", async () => {
  for (const status of ["cancelled", "queued", "running", "partial", "succeeded", null]) {
    const fake = fakeDatabase(status);
    await assert.rejects(queueSupplementRound(fake.db, "plan", "admin", snapshot.model), /仅停止/);
    assert.equal(fake.writes.length, 0);
  }
  const fake = fakeDatabase();
  await assert.rejects(queueSupplementRound(fake.db, "plan", "admin", { ...snapshot.model, baseUrl: "https://changed.example" }), /连接已变更/);
  assert.equal(fake.writes.length, 0);
});

test("补题再次停止后可重新计算剩余缺额，不重复生成上一轮已补题", async () => {
  const fake = fakeDatabase();
  await queueSupplementRound(fake.db, "plan", "admin", snapshot.model);
  fake.units[1].status = "stopped";
  fake.units[1].attempts = 6;
  fake.slots[3].question_id = "supplement-saved";
  fake.job.status = "stopped";
  const result = await queueSupplementRound(fake.db, "plan", "admin", snapshot.model);
  assert.equal(result.summary.preservedQuestions, 4);
  assert.equal(result.summary.missingQuestions, 2);
  assert.equal(fake.slots[3].unit_id, fake.units[1].id);
  assert.equal(fake.slots[4].unit_id, fake.units[2].id);
  assert.equal(fake.units[1].attempts, 6);
});

test("补题仍要求冻结细目表审核确认，不能绕过基础命题前置条件", async () => {
  const fake = fakeDatabase("stopped", false);
  await assert.rejects(queueSupplementRound(fake.db, "plan", "admin", snapshot.model), /尚未全部审核/);
  assert.equal(fake.writes.length, 0);
  assert.equal(fake.job.status, "stopped");
});
