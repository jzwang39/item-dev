import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Pool, PoolConnection } from "mysql2/promise";
import { archiveOccupation, createOccupation, getActiveProjectIdForUpdate, listActiveOccupations, updateOccupation } from "./service";

function mockDatabase(context: TestContext, businessProjectCount: number, options: {
  status?: "active" | "archived"; missing?: boolean; failAudit?: boolean; transactions?: string[];
} = {}) {
  const previous = globalThis.__itembankMysqlPool;
  context.after(() => { globalThis.__itembankMysqlPool = previous; });
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const projects = [
    { id: "legal-project", code: "SYSTEM-GENERIC-LEGAL" },
    ...Array.from({ length: businessProjectCount }, (_, i) => ({ id: `business-${i}`, code: `authoring-${i}` })),
  ];
  const occupation = { id: "occupation", code: "TEST", name: "测试职业", status: options.status ?? "active" };
  const db = {
    beginTransaction: async () => { options.transactions?.push("begin"); },
    commit: async () => { options.transactions?.push("commit"); },
    rollback: async () => { options.transactions?.push("rollback"); },
    release: () => undefined,
    execute: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT id FROM projects")) {
        return [projects.filter((project) => !sql.includes("code <> 'SYSTEM-GENERIC-LEGAL'") || project.code !== "SYSTEM-GENERIC-LEGAL"), []];
      }
      if (sql.includes("FROM project_occupations") && sql.includes("SELECT id, name, code, status")) {
        return [options.missing || (occupation.status === "archived" && sql.includes("status = 'active'")) ? [] : [occupation], []];
      }
      if (options.failAudit && sql.includes("INSERT INTO audit_logs")) throw new Error("audit write failed");
      return [[], []];
    },
  };
  globalThis.__itembankMysqlPool = { execute: db.execute, getConnection: async () => db } as unknown as Pool;
  return calls;
}

test("删除职业仅归档并留痕，保留全部历史关联数据", async (context) => {
  const transactions: string[] = [];
  const calls = mockDatabase(context, 1, { transactions });
  const archived = await archiveOccupation("occupation", "admin");
  assert.equal(archived.status, "archived");
  assert.equal(archived.id, "occupation");
  const update = calls.find((call) => call.sql.includes("UPDATE project_occupations"));
  assert.deepEqual(update?.values, ["occupation", "business-0"]);
  assert.match(update!.sql, /status = 'archived', row_version = row_version \+ 1/);
  assert.ok(calls.some((call) => call.sql.includes("FOR UPDATE") && call.sql.includes("project_id = ?")));
  assert.ok(!calls.some((call) => /\bDELETE\b/.test(call.sql)));
  const audit = calls.find((call) => call.sql.includes("INSERT INTO audit_logs"))!;
  assert.match(audit.sql, /occupation.archive/);
  assert.deepEqual(audit.values.slice(1, 4), ["business-0", "admin", "occupation"]);
  assert.equal(JSON.parse(audit.values[4] as string).status, "active");
  assert.equal(JSON.parse(audit.values[5] as string).status, "archived");
  assert.deepEqual(transactions, ["begin", "commit"]);
});

test("归档职业不再列出，重复删除不重复写入或记录审计", async (context) => {
  const calls = mockDatabase(context, 1, { status: "archived" });
  assert.deepEqual(await listActiveOccupations(), []);
  assert.equal((await archiveOccupation("occupation", "admin")).status, "archived");
  assert.ok(!calls.some((call) => /UPDATE project_occupations|INSERT INTO audit_logs/.test(call.sql)));
});

test("删除不存在或越出当前项目的职业不执行写入", async (context) => {
  const calls = mockDatabase(context, 1, { missing: true });
  await assert.rejects(archiveOccupation("unknown", "admin"), /不存在或不属于当前项目/);
  assert.ok(!calls.some((call) => /\bUPDATE\b|\bINSERT\b/.test(call.sql.replace(/FOR UPDATE/g, ""))));
});

test("没有业务项目或有多个业务项目时拒绝删除", async (context) => {
  mockDatabase(context, 0);
  await assert.rejects(archiveOccupation("occupation", "admin"), /当前项目不存在/);
  mockDatabase(context, 2);
  await assert.rejects(archiveOccupation("occupation", "admin"), /多个启用项目/);
});

test("删除审计写入失败时，归档事务回滚", async (context) => {
  const transactions: string[] = [];
  mockDatabase(context, 1, { failAudit: true, transactions });
  await assert.rejects(archiveOccupation("occupation", "admin"), /audit write failed/);
  assert.deepEqual(transactions, ["begin", "rollback"]);
});

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

for (const businessProjectCount of [0, 1, 2]) {
  test(`命题确认事务解析业务项目：${businessProjectCount}个业务项目与法规内部项目共存`, async (context) => {
    const calls = mockDatabase(context, businessProjectCount);
    const connection = await globalThis.__itembankMysqlPool!.getConnection() as PoolConnection;
    if (businessProjectCount === 2) {
      await assert.rejects(getActiveProjectIdForUpdate(connection), /多个启用项目/);
    } else {
      assert.equal(await getActiveProjectIdForUpdate(connection), businessProjectCount === 1 ? "business-0" : null);
    }
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /code <> 'SYSTEM-GENERIC-LEGAL'/);
    assert.match(calls[0].sql, /FOR UPDATE$/);
    assert.ok(!calls.some((call) => /INSERT|UPDATE projects/.test(call.sql)));
  });
}
