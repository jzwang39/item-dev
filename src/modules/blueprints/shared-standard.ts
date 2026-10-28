import { readFile } from "node:fs/promises";
import type { RowDataPacket } from "mysql2/promise";
import { withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { extractDocxText, extractPdfText } from "@/modules/documents/extraction/service";
import { publishSharedOccupationStandard } from "./theory-weights/service";

export type StandardBinding = {
  mode: "theory" | "skill";
  fileObjectId: string | null;
  sourceVersionId: string | null;
  createdAt: Date;
  snapshot: { scopes?: unknown[]; columns?: unknown[]; usedOcr?: boolean };
};

export function sharedStandardNeedsSync(bindings: StandardBinding[]) {
  const latest = bindings.filter((binding) => binding.fileObjectId)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  if (!latest) return null;
  const theory = bindings.find((binding) => binding.mode === "theory");
  const skill = bindings.find((binding) => binding.mode === "skill");
  if (theory?.fileObjectId === latest.fileObjectId && theory.snapshot.scopes?.length &&
    skill?.fileObjectId === latest.fileObjectId && skill.snapshot.columns?.length) return null;
  return latest;
}

// Compatibility repair uses the confirmed original, never another occupation's file.
export async function ensureSharedOccupationStandard(occupationId: string, actorId: string) {
  return withTransaction(async (db) => {
    const [occupations] = await db.execute<(RowDataPacket & { project_id: string })[]>(
      `SELECT po.project_id FROM project_occupations po JOIN projects p ON p.id=po.project_id
       WHERE po.id=? AND po.status='active' AND p.status='active' FOR UPDATE`, [occupationId],
    );
    if (!occupations.length) throw new Error("职业不存在或已停用。");
    const projectId = occupations[0].project_id;
    const [rows] = await db.execute<RowDataPacket[]>(
      `SELECT b.assessment_mode AS mode,v.snapshot_json,v.created_at,
        COALESCE(CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(v.snapshot_json,'$.fileObjectId')),'null') AS CHAR(26) CHARACTER SET ascii) COLLATE ascii_bin,
          (SELECT rs.file_object_id FROM occupation_standard_requirement_scopes rs WHERE rs.blueprint_version_id=v.id LIMIT 1),
          (SELECT bi.file_object_id FROM blueprint_imports bi JOIN file_objects fo ON fo.id=bi.file_object_id
           WHERE bi.project_id=b.project_id AND bi.status='succeeded'
             AND JSON_UNQUOTE(JSON_EXTRACT(bi.scope_json,'$.occupationId'))=b.occupation_id
             AND fo.original_name=JSON_UNQUOTE(JSON_EXTRACT(v.snapshot_json,'$.sourceName'))
             AND ABS(TIMESTAMPDIFF(SECOND,bi.created_at,v.created_at))<60
           ORDER BY ABS(TIMESTAMPDIFF(MICROSECOND,bi.created_at,v.created_at)) LIMIT 1)) AS file_object_id,
        COALESCE(CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(v.snapshot_json,'$.sourceVersionId')),'null') AS CHAR(26) CHARACTER SET ascii) COLLATE ascii_bin,
          (SELECT rs.source_version_id FROM occupation_standard_requirement_scopes rs WHERE rs.blueprint_version_id=v.id LIMIT 1)) AS source_version_id
       FROM blueprints b JOIN blueprint_versions v ON v.id=b.current_version_id
       WHERE b.occupation_id=? AND b.project_id=? AND b.blueprint_kind='theory_weight'
         AND v.status='published' ORDER BY v.created_at DESC FOR UPDATE`,
      [occupationId, projectId],
    );
    const pending = sharedStandardNeedsSync(rows.map((row) => ({
      mode: row.mode, fileObjectId: row.file_object_id === "null" ? null : row.file_object_id,
      sourceVersionId: row.source_version_id === "null" ? null : row.source_version_id,
      createdAt: new Date(row.created_at),
      snapshot: typeof row.snapshot_json === "string" ? JSON.parse(row.snapshot_json) : row.snapshot_json,
    })));
    if (!pending) return;
    const [running] = await db.execute<RowDataPacket[]>(
      `SELECT id FROM theory_outline_generation_jobs WHERE occupation_id=? AND status IN ('queued','running')
       UNION ALL SELECT id FROM skill_outline_generation_jobs WHERE occupation_id=? AND status IN ('queued','running')`,
      [occupationId, occupationId],
    );
    if (running.length) throw new Error("当前职业正在生成细目表，请任务完成后再同步职业标准。");
    const [files] = await db.execute<RowDataPacket[]>(
      "SELECT object_key,original_name FROM file_objects WHERE id=? AND project_id=?", [pending.fileObjectId, projectId],
    );
    if (!files.length) throw new Error("已确认职业标准的原件关联缺失，无法同步。");
    const file = files[0], bytes = await readFile(file.object_key);
    const extension = file.original_name.split(".").pop()?.toLowerCase();
    const extracted = extension === "pdf" ? await extractPdfText(bytes, { includeLayout: true })
      : { text: extension === "docx" ? await extractDocxText(bytes) : bytes.toString("utf8"), usedOcr: pending.snapshot.usedOcr ?? false };
    await publishSharedOccupationStandard(db, projectId, occupationId, extracted, {
      name: file.original_name, fileObjectId: pending.fileObjectId!,
      sourceVersionId: pending.sourceVersionId,
    }, actorId);
    await db.execute(
      `INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result)
       VALUES(?,?,?,'occupation.standard.sync','occupation',?,?,'success')`,
      [createUlid(), projectId, actorId, occupationId,
        JSON.stringify({ fileObjectId: pending.fileObjectId, reusedOriginal: true })],
    );
  });
}
