import type { Connection, RowDataPacket } from "mysql2/promise";
import { createUlid } from "../src/shared/database/ulid";

export type CleanupTarget = { table: string; where: string };
const all = (table: string): CleanupTarget => ({ table, where: "1=1" });
const outlines = "blueprint_kind IN ('theory_outline','skill_outline')";
const versions = `blueprint_id IN (SELECT id FROM blueprints WHERE ${outlines})`;
const nodes = `blueprint_version_id IN (SELECT id FROM blueprint_versions WHERE ${versions})`;
const businessIds = [
  "questions", "question_versions", "authoring_plans", "authoring_tasks",
  "authoring_batches", "authoring_generation_jobs", "legal_agent_jobs",
  "theory_outline_generation_jobs", "skill_outline_generation_jobs",
  "papers", "paper_structures", "paper_structure_versions", "assembly_plans",
  "assembly_plan_versions", "assembly_runs",
].map((table) => `SELECT id FROM \`${table}\``).concat([
  `SELECT id FROM blueprints WHERE ${outlines}`,
  `SELECT id FROM blueprint_versions WHERE ${versions}`,
  `SELECT id FROM blueprint_nodes WHERE ${nodes}`,
]).join(" UNION ALL ");
const exportWhere = `source_id IN (${businessIds}) OR source_type IN (
  'paper','papers','question','questions','question_version','blueprint','blueprint_version',
  'theory_outline','skill_outline','assembly_plan','assembly_run')`;
const jobWhere = `business_id IN (${businessIds}) OR id IN (
  SELECT job_id FROM exports WHERE ${exportWhere}
  UNION ALL SELECT job_id FROM blueprint_imports WHERE ${outlines}
  UNION ALL SELECT job_id FROM assembly_runs)`;

// Weight tables and skill structures also hold the parsed occupation standard.
// Keep them, their source bindings, and all uploaded files.
export const cleanupTargets: CleanupTarget[] = [
  ...[
    "paper_item_points", "paper_items", "papers", "assembly_runs", "assembly_plan_slots",
    "assembly_plan_versions", "assembly_plans", "paper_structure_sections",
    "paper_structure_versions", "paper_structures", "question_revision_links",
    "review_records", "review_assignments", "question_review_confirmations",
    "question_status_events", "question_options", "question_assessment_points",
    "question_source_refs", "question_quality_checks", "question_version_tags",
    "question_versions", "questions", "authoring_generation_slots",
    "authoring_generation_units", "authoring_generation_batches", "authoring_generation_jobs",
    "authoring_batches", "authoring_tasks", "authoring_plan_sources",
    "authoring_plan_blueprints", "authoring_plans", "legal_agent_jobs",
    "theory_outline_generation_jobs", "skill_outline_generation_jobs",
  ].map(all),
  { table: "model_runs", where: "task_id IS NOT NULL OR batch_id IS NOT NULL OR capability IN ('plan','author','review')" },
  { table: "outline_point_reviews", where: `node_id IN (SELECT id FROM blueprint_nodes WHERE ${nodes})` },
  { table: "theory_outline_point_quotas", where: `blueprint_node_id IN (SELECT id FROM blueprint_nodes WHERE ${nodes})` },
  { table: "blueprint_node_source_refs", where: `blueprint_node_id IN (SELECT id FROM blueprint_nodes WHERE ${nodes})` },
  { table: "blueprint_nodes", where: nodes },
  { table: "blueprint_version_sources", where: `blueprint_version_id IN (SELECT id FROM blueprint_versions WHERE ${versions})` },
  { table: "blueprint_publish_checks", where: `blueprint_version_id IN (SELECT id FROM blueprint_versions WHERE ${versions})` },
  { table: "blueprint_versions", where: versions },
  { table: "blueprints", where: outlines },
  { table: "blueprint_imports", where: outlines },
  { table: "download_events", where: `export_id IN (SELECT id FROM exports WHERE ${exportWhere})` },
  { table: "export_files", where: `export_id IN (SELECT id FROM exports WHERE ${exportWhere})` },
  { table: "exports", where: exportWhere },
  { table: "job_attempts", where: `job_id IN (SELECT id FROM jobs WHERE ${jobWhere})` },
  { table: "jobs", where: jobWhere },
  { table: "idempotency_records", where: `resource_id IN (${businessIds})
    OR resource_id IN (SELECT id FROM jobs WHERE ${jobWhere})
    OR resource_id IN (SELECT id FROM exports WHERE ${exportWhere}) OR resource_type IN (
    'paper','papers','question','questions','question_version','blueprint','blueprint_version',
    'theory_outline','skill_outline','authoring_plan','authoring_task','assembly_plan','assembly_run')` },
];

export type ForeignKey = {
  child: string; parent: string; name: string; columns: string[]; parentColumns: string[];
  nullable: boolean;
};
type TableInfo = { table: string; keys: string[]; engine: string };
export type CleanupSchema = { tables: TableInfo[]; foreignKeys: ForeignKey[] };
export type CleanupCount = { table: string; count: number };
const quote = (name: string) => `\`${name.replace(/`/g, "``")}\``;
const temporary = (table: string) => quote(`cleanup_${table}`);

export function deletionOrder(targets: CleanupTarget[], foreignKeys: ForeignKey[]): string[] {
  const pending = new Set(targets.map((target) => target.table));
  const result: string[] = [];
  while (pending.size) {
    const next = [...pending].find((table) => !foreignKeys.some(
      (key) => key.parent === table && key.child !== table && pending.has(key.child),
    ));
    if (!next) throw new Error("清理表之间存在循环外键，请先调整清理规则。");
    pending.delete(next);
    result.push(next);
  }
  return result;
}

export async function readCleanupSchema(db: Connection): Promise<CleanupSchema> {
  const [tableRows] = await db.query<RowDataPacket[]>(
    "SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'",
  );
  const [primaryRows] = await db.query<RowDataPacket[]>(
    `SELECT TABLE_NAME AS name, COLUMN_NAME AS column_name FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA=DATABASE() AND CONSTRAINT_NAME='PRIMARY' ORDER BY TABLE_NAME,ORDINAL_POSITION`,
  );
  const tables = tableRows.map((row) => ({
    table: String(row.name), engine: String(row.engine),
    keys: primaryRows.filter((key) => key.name === row.name).map((key) => String(key.column_name)),
  }));
  for (const target of cleanupTargets.concat(all("audit_logs"), all("authoring_generation_capacity"))) {
    const info = tables.find((table) => table.table === target.table);
    if (!info?.keys.length || info.engine !== "InnoDB") {
      throw new Error(`表 ${target.table} 缺失主键、不是 InnoDB 或迁移未完成，已拒绝清理。`);
    }
  }
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT k.TABLE_NAME AS child, k.REFERENCED_TABLE_NAME AS parent, k.CONSTRAINT_NAME AS name,
       k.COLUMN_NAME AS child_column, k.REFERENCED_COLUMN_NAME AS parent_column,
       c.IS_NULLABLE AS nullable
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA=k.TABLE_SCHEMA
       AND c.TABLE_NAME=k.TABLE_NAME AND c.COLUMN_NAME=k.COLUMN_NAME
     WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_SCHEMA=DATABASE()
       AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION`,
  );
  const foreignKeys: ForeignKey[] = [];
  for (const row of rows) {
    let key = foreignKeys.find((item) => item.child === row.child && item.name === row.name);
    if (!key) {
      key = { child: row.child, parent: row.parent, name: row.name, columns: [], parentColumns: [], nullable: true };
      foreignKeys.push(key);
    }
    key.columns.push(row.child_column);
    key.parentColumns.push(row.parent_column);
    key.nullable = key.nullable && row.nullable === "YES";
  }
  deletionOrder(cleanupTargets, foreignKeys);
  return { tables, foreignKeys };
}

export async function previewCleanup(db: Connection): Promise<CleanupCount[]> {
  const result: CleanupCount[] = [];
  for (const target of cleanupTargets) {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM ${quote(target.table)} WHERE ${target.where}`,
    );
    result.push({ table: target.table, count: Number(rows[0].count) });
  }
  return result;
}

function keyMatch(keys: string[], left: string, right: string): string {
  return keys.map((key) => `${left}.${quote(key)}=${right}.${quote(key)}`).join(" AND ");
}

// Refuse unexpected references from preserved rows, including new tables added
// after this tool was released. Never disable FOREIGN_KEY_CHECKS.
async function assertNoPreservedReferences(db: Connection, schema: CleanupSchema) {
  for (const key of schema.foreignKeys) {
    if (!cleanupTargets.some((target) => target.table === key.parent)) continue;
    const parent = schema.tables.find((table) => table.table === key.parent)!;
    const child = schema.tables.find((table) => table.table === key.child)!;
    const selectedChild = cleanupTargets.some((target) => target.table === key.child);
    const join = key.columns.map((column, index) =>
      `c.${quote(column)}=p.${quote(key.parentColumns[index])}`).join(" AND ");
    // Self-references use a LEFT JOIN to avoid opening one temporary table twice.
    const exclusion = selectedChild
      ? `LEFT JOIN ${temporary(key.child)} chosen ON ${keyMatch(child.keys, "c", "chosen")}`
      : "";
    const selectedParent = key.child === key.parent
      ? `(SELECT ${parent.keys.map(quote).join(",")} FROM ${quote(key.parent)}
          WHERE ${cleanupTargets.find((target) => target.table === key.parent)!.where})`
      : temporary(key.parent);
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS count FROM ${quote(key.child)} c
       JOIN ${quote(key.parent)} p ON ${join}
       JOIN ${selectedParent} selected ON ${keyMatch(parent.keys, "p", "selected")}
       ${exclusion} ${selectedChild ? `WHERE chosen.${quote(child.keys[0])} IS NULL` : ""}`,
    );
    if (Number(rows[0].count)) {
      throw new Error(`保留数据 ${key.child} 仍通过 ${key.name} 引用待清理数据，已拒绝清理。`);
    }
  }
}

export async function executeCleanup(
  db: Connection, schema: CleanupSchema, options: { database: string; operator: string },
): Promise<{ auditId: string; counts: CleanupCount[] }> {
  const lockName = `business-cleanup:${options.database}`.slice(0, 64);
  const [locks] = await db.query<RowDataPacket[]>("SELECT GET_LOCK(?,0) AS acquired", [lockName]);
  if (Number(locks[0].acquired) !== 1) throw new Error("已有清理工具正在执行，请勿重复运行。");
  const created: string[] = [];
  try {
    await db.beginTransaction();
    const counts: CleanupCount[] = [];
    for (const target of cleanupTargets) {
      const info = schema.tables.find((table) => table.table === target.table)!;
      await db.query(
        `CREATE TEMPORARY TABLE ${temporary(target.table)}
         (PRIMARY KEY (${info.keys.map(quote).join(",")})) ENGINE=InnoDB AS
         SELECT ${info.keys.map(quote).join(",")} FROM ${quote(target.table)} WHERE ${target.where}`,
      );
      created.push(target.table);
      const [rows] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${temporary(target.table)}`);
      counts.push({ table: target.table, count: Number(rows[0].count) });
    }
    await assertNoPreservedReferences(db, schema);
    for (const key of schema.foreignKeys.filter((key) => key.child === key.parent &&
      cleanupTargets.some((target) => target.table === key.child))) {
      if (!key.nullable) throw new Error(`自关联外键 ${key.name} 不允许置空，已拒绝清理。`);
      const info = schema.tables.find((table) => table.table === key.child)!;
      await db.query(`UPDATE ${quote(key.child)} t JOIN ${temporary(key.child)} chosen
        ON ${keyMatch(info.keys, "t", "chosen")}
        SET ${key.columns.map((column) => `t.${quote(column)}=NULL`).join(",")}`);
    }
    for (const table of deletionOrder(cleanupTargets, schema.foreignKeys)) {
      const info = schema.tables.find((item) => item.table === table)!;
      await db.query(`DELETE t FROM ${quote(table)} t JOIN ${temporary(table)} chosen
        ON ${keyMatch(info.keys, "t", "chosen")}`);
    }
    const remaining = await previewCleanup(db);
    if (remaining.some((item) => item.count !== 0)) throw new Error("清理后仍有业务数据，可能存在并发写入，已回滚。");
    await db.query("UPDATE authoring_generation_capacity SET cooldown_until=NULL WHERE id=1");
    const auditId = createUlid();
    await db.execute(
      `INSERT INTO audit_logs(id,action,object_type,object_id,after_json,result)
       VALUES(?,'maintenance.business_cleanup','database',?,?,'success')`,
      [auditId, auditId, JSON.stringify({
        database: options.database, operator: options.operator, counts,
        maintenanceConfirmed: true, backupConfirmed: true,
        preserved: "accounts,projects,occupations,sources,files,standards,weights,skill_structures,settings,audit_logs",
      })],
    );
    await db.commit();
    return { auditId, counts };
  } catch (error) {
    await db.rollback();
    throw error;
  } finally {
    for (const table of created) await db.query(`DROP TEMPORARY TABLE IF EXISTS ${temporary(table)}`);
    await db.query("SELECT RELEASE_LOCK(?)", [lockName]);
  }
}
