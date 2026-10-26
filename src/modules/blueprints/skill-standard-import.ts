import { createHash } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { extractDocxText, extractPdfText } from "@/modules/documents/extraction/service";
import { query, withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { parseSkillStandard, skillLevels, type SkillStandardData } from "./skill-standard";

export async function listSkillStandards(occupationId: string) {
  return query<(RowDataPacket & { id: string; name: string; original_name: string })[]>(
    `SELECT DISTINCT sv.id,s.name,fo.original_name,sv.created_at FROM sources s
     JOIN source_versions sv ON sv.id=s.current_version_id
     JOIN file_objects fo ON fo.id=sv.file_object_id
     JOIN source_scopes ss ON ss.source_version_id=sv.id
     JOIN project_occupations po ON po.id=ss.occupation_id AND po.project_id=s.project_id AND po.status='active'
     JOIN projects p ON p.id=s.project_id AND p.status='active'
     WHERE ss.occupation_id=?
     AND s.source_type='occupation_standard' AND s.status='active' AND sv.parse_status='succeeded'
     ORDER BY sv.created_at DESC`, [occupationId],
  );
}

export async function getSkillStandard(occupationId: string) {
  const rows = await query<(RowDataPacket & { id: string; snapshot_json: string | SkillStandardData; version_no: number })[]>(
    `SELECT v.id,v.snapshot_json,v.version_no FROM blueprints b JOIN blueprint_versions v ON v.id=b.current_version_id
     JOIN projects p ON p.id=b.project_id AND p.status='active'
     JOIN project_occupations po ON po.id=b.occupation_id AND po.project_id=b.project_id AND po.status='active'
     WHERE b.occupation_id=? AND b.blueprint_kind='theory_weight' AND b.assessment_mode='skill' LIMIT 1`, [occupationId],
  );
  const snapshot = rows[0] ? typeof rows[0].snapshot_json === "string" ? JSON.parse(rows[0].snapshot_json) : rows[0].snapshot_json : null;
  return snapshot?.columns ? { ...snapshot, versionId: rows[0].id, versionNo: rows[0].version_no } : null;
}

export async function importSkillStandard(occupationId: string, input: { file?: File; sourceVersionId?: string; preview?: boolean }, actorId: string) {
  if (!!input.file === !!input.sourceVersionId) throw new Error("请选择一种来源：本地标准文件或已解析资料。");
  let bytes: Buffer | undefined, text = "", name = "", fileObjectId = "", usedOcr = false;
  if (input.file) {
    const extension = extname(input.file.name).toLowerCase();
    if (![".pdf", ".docx", ".txt"].includes(extension) || !input.file.size || input.file.size > 30 * 1024 * 1024) throw new Error("请选择30MB以内的PDF、DOCX或TXT标准文件。");
    bytes = Buffer.from(await input.file.arrayBuffer()); name = basename(input.file.name);
    if (extension === ".pdf") { const result = await extractPdfText(bytes); text = result.text; usedOcr = result.usedOcr; }
    else text = extension === ".docx" ? await extractDocxText(bytes) : bytes.toString("utf8");
  } else {
    const rows = await query<(RowDataPacket & { original_name: string; file_object_id: string; text: string })[]>(
      `SELECT fo.original_name,fo.id AS file_object_id,seg.content_excerpt AS text FROM source_versions sv
       JOIN sources s ON s.id=sv.source_id AND s.source_type='occupation_standard' AND s.status='active'
       JOIN projects p ON p.id=s.project_id AND p.status='active'
       JOIN project_occupations po ON po.id=? AND po.project_id=s.project_id AND po.status='active'
       JOIN file_objects fo ON fo.id=sv.file_object_id JOIN source_scopes ss ON ss.source_version_id=sv.id
       JOIN source_segments seg ON seg.source_version_id=sv.id
       WHERE sv.id=? AND ss.occupation_id=? AND sv.parse_status='succeeded'
       GROUP BY seg.id,fo.original_name,fo.id,seg.content_excerpt,seg.ordinal ORDER BY seg.ordinal`, [occupationId, input.sourceVersionId!, occupationId],
    );
    if (!rows.length) throw new Error("所选资料没有可用解析文本或不属于当前职业操作技能范围。");
    text = rows.map((row) => row.text).join("\n"); name = rows[0].original_name; fileObjectId = rows[0].file_object_id;
  }
  const data = parseSkillStandard(text);
  if (input.preview) return { ...data, sourceName: name, usedOcr, versionNo: 0 };
  let objectPath: string | undefined;
  try {
    return await withTransaction(async (db) => {
      const [projects] = await db.execute<(RowDataPacket & { id: string })[]>(
        `SELECT p.id FROM projects p JOIN project_occupations po ON po.project_id=p.id
         WHERE po.id=? AND p.status='active' AND po.status='active' FOR UPDATE`, [occupationId],
      );
      if (!projects.length) throw new Error("职业不存在或已停用。");
      const projectId = projects[0].id;
      if (bytes) {
        fileObjectId = createUlid();
        const directory = process.env.UPLOAD_DIR || join(process.cwd(), ".data", "uploads", "blueprint-imports");
        await mkdir(directory, { recursive: true });
        objectPath = join(directory, `${fileObjectId}${extname(name).toLowerCase()}`);
        await writeFile(objectPath, bytes);
        await db.execute(`INSERT INTO file_objects(id,project_id,storage_provider,bucket,object_key,original_name,mime_type,size_bytes,sha256,purpose,created_by)
          VALUES(?,?,'local','itembank-local',?,?,?,?,?,'blueprint_import',?)`,
        [fileObjectId, projectId, objectPath, name, input.file!.type || "application/octet-stream", bytes.length, createHash("sha256").update(bytes).digest("hex"), actorId]);
      }
      const source = { sourceName: name, fileObjectId, sourceVersionId: input.sourceVersionId ?? null, usedOcr };
      const versionNo = await publish(db, projectId, occupationId, "theory_weight", "level_5", { ...data, ...source }, actorId);
      for (const levelCode of skillLevels) {
        const scopes = data.scopes.filter((scope) => scope.column.levelCode === levelCode);
        // Publish empty scopes too, so old levels cannot retain a structure
        // linked to a different standard after the weight version changes.
        await publish(db, projectId, occupationId, "skill_structure", levelCode, {
          ...source, name: "操作技能考评内容结构表", levelCode, ruleBasis: name,
          pathway: scopes[0]?.column.direction ?? "不适用", totalMinutes: scopes[0]?.totalMinutes ?? null,
          rows: scopes[0]?.rows ?? [], standardScopes: scopes,
        }, actorId);
      }
      await db.execute(`INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result)
        VALUES(?,?,?,'blueprint.skill_standard.import','occupation',?,?,'success')`,
      [createUlid(), projectId, actorId, occupationId, JSON.stringify({ ...source, versionNo, scopeCount: data.scopes.length })]);
      return { ...data, ...source, versionNo };
    });
  } catch (error) {
    if (objectPath) await unlink(objectPath).catch(() => undefined);
    throw error;
  }
}

async function publish(db: PoolConnection, projectId: string, occupationId: string, kind: string, level: string, snapshot: Record<string, unknown>, actorId: string) {
  const [rows] = await db.execute<(RowDataPacket & { id: string })[]>(
    "SELECT id FROM blueprints WHERE project_id=? AND occupation_id=? AND blueprint_kind=? AND assessment_mode='skill' AND level_code=? FOR UPDATE", [projectId, occupationId, kind, level],
  );
  const id = rows[0]?.id ?? createUlid();
  if (!rows.length) await db.execute("INSERT INTO blueprints(id,project_id,name,blueprint_kind,occupation_id,level_code,assessment_mode,status) VALUES(?,?,?,?,?,?,'skill','draft')", [id, projectId, kind === "theory_weight" ? "技能要求权重表" : "操作技能考评内容结构表", kind, occupationId, level]);
  const [versions] = await db.execute<(RowDataPacket & { version_no: number })[]>("SELECT COALESCE(MAX(version_no),0) AS version_no FROM blueprint_versions WHERE blueprint_id=?", [id]);
  const versionNo = Number(versions[0].version_no) + 1, versionId = createUlid(), encoded = JSON.stringify(snapshot);
  await db.execute(`INSERT INTO blueprint_versions(id,blueprint_id,version_no,status,content_hash,snapshot_json,published_at,created_by)
    VALUES(?,?,?,'published',?,?,UTC_TIMESTAMP(3),?)`, [versionId, id, versionNo, createHash("sha256").update(encoded).digest("hex"), encoded, actorId]);
  const entries = (kind === "theory_weight" ? snapshot.items : (snapshot.standardScopes as { column: unknown; rows: object[] }[]).flatMap((scope) => scope.rows.map((row) => ({ ...row, column: scope.column })))) as { name: string; score?: number }[];
  for (const [index, entry] of entries.entries()) await db.execute(`INSERT INTO blueprint_nodes(id,blueprint_version_id,node_kind,node_code,name,ordinal,weight,requirement_json,source_ref_json)
    VALUES(?,?,?,?,?,?,?,?,?)`, [createUlid(), versionId, kind === "theory_weight" ? "weight_item" : "structure_item", `S-${String(index + 1).padStart(3, "0")}`, entry.name, index + 1, entry.score ?? null, JSON.stringify(entry), JSON.stringify({ fileObjectId: snapshot.fileObjectId, sourceName: snapshot.sourceName })]);
  if (typeof snapshot.sourceVersionId === "string") await db.execute("INSERT INTO blueprint_version_sources(blueprint_version_id,source_version_id) VALUES(?,?)", [versionId, snapshot.sourceVersionId]);
  await db.execute("UPDATE blueprints SET current_version_id=?,status='published',row_version=row_version+1 WHERE id=?", [versionId, id]);
  return versionNo;
}
