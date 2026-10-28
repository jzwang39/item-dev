import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Pool } from "mysql2/promise";
import { createOccupation, listActiveOccupations, updateOccupation } from "./service";

function mockDatabase(context: TestContext, businessProjectCount: number) {
  const previous = globalThis.__itembankMysqlPool;
  context.after(() => { globalThis.__itembankMysqlPool = previous; });
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const projects = [
    { id: "legal-project", code: "SYSTEM-GENERIC-LEGAL" },
    ...Array.from({ length: businessProjectCount }, (_, i) => ({ id: `business-${i}`, code: `authoring-${i}` })),
  ];
  const occupation = { id: "occupation", code: "TEST", name: "测试职业", status: "active" };
  const db = {
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
    execute: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT id FROM projects")) {
        return [projects.filter((project) => !sql.includes("code <> 'SYSTEM-GENERIC-LEGAL'") || project.code !== "SYSTEM-GENERIC-LEGAL"), []];
      }
      if (sql.includes("FROM project_occupations") && sql.includes("SELECT id, name, code, status")) return [[occupation], []];
      return [[], []];
    },
  };
  globalThis.__itembankMysqlPool = { execute: db.execute, getConnection: async () => db } as unknown as Pool;
  return calls;
}

test("业务项目与通用法规项目共存时，职业列表、新建和修改都使用业务项目", async (context) => {
  const calls = mockDatabase(context, 1);
  assert.equal((await listActiveOccupations()).length, 1);
  assert.equal((await createOccupation({ name: "新职业", code: "NEW" }, "admin")).name, "新职业");
  assert.equal((await updateOccupation("occupation", { name: "修改职业", code: "EDIT" }, "admin")).name, "修改职业");
  const projectQueries = calls.filter((call) => call.sql.startsWith("SELECT id FROM projects"));
  assert.equal(projectQueries.length, 3);
  assert.ok(projectQueries.every((call) => call.sql.includes("code <> 'SYSTEM-GENERIC-LEGAL'")));
  assert.equal(calls.find((call) => call.sql.includes("INSERT INTO project_occupations"))?.values[1], "business-0");
  assert.ok(calls.filter((call) => call.sql.includes("INSERT INTO audit_logs")).every((call) => call.values[1] === "business-0"));
});

test("只有通用法规项目时职业列表为空，新增创建独立默认业务项目", async (context) => {
  const calls = mockDatabase(context, 0);
  assert.deepEqual(await listActiveOccupations(), []);
  await createOccupation({ name: "新职业", code: "NEW" }, "admin");
  const project = calls.find((call) => call.sql.includes("INSERT INTO projects"));
  const occupation = calls.find((call) => call.sql.includes("INSERT INTO project_occupations"));
  assert.ok(project);
  assert.equal(occupation?.values[1], project.values[0]);
  assert.notEqual(occupation?.values[1], "legal-project");
});

test("多个真实业务项目仍拒绝任意选取，避免写错项目", async (context) => {
  const calls = mockDatabase(context, 2);
  await assert.rejects(listActiveOccupations(), /多个启用项目/);
  await assert.rejects(createOccupation({ name: "新职业", code: "NEW" }, "admin"), /多个启用项目/);
  await assert.rejects(updateOccupation("occupation", { name: "修改职业", code: "EDIT" }, "admin"), /多个启用项目/);
  assert.ok(!calls.some((call) => call.sql.includes("INSERT INTO project_occupations")));
});
