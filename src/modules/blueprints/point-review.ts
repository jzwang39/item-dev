import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { query, withTransaction } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";

export async function assertOutlineConfirmed(db: PoolConnection, versionId: string) {
  const [rows] = await db.execute<(RowDataPacket & { total: number; confirmed: number })[]>(
    `SELECT COUNT(*) AS total,COALESCE(SUM(r.status='confirmed'),0) AS confirmed
     FROM blueprint_nodes n LEFT JOIN outline_point_reviews r ON r.node_id=n.id
     WHERE n.blueprint_version_id=? AND n.node_kind='assessment_point'`, [versionId],
  );
  if (!Number(rows[0].total) || Number(rows[0].total) !== Number(rows[0].confirmed)) {
    throw new Error("细目表尚未全部审核并经管理员确认，请先完成细目表审核。");
  }
}

export async function listOutlineReviews(actorId: string, role: "admin" | "expert", versionId?: string) {
  const params: string[] = [];
  const conditions = ["p.status='active'", "po.status='active'", "b.blueprint_kind IN ('theory_outline','skill_outline')", "v.status<>'archived'"];
  if (versionId) { conditions.push("v.id=?"); params.push(versionId); }
  if (role === "expert") { conditions.push("r.expert_id=?"); params.push(actorId); }
  return query<RowDataPacket[]>(
    `SELECT v.id AS versionId,v.version_no AS versionNo,v.created_at AS createdAt,
      po.name AS occupationName,b.level_code AS levelCode,b.assessment_mode AS assessmentMode,
      b.current_version_id=v.id AS isCurrent,n.id AS nodeId,n.node_code AS code,n.name,
      n.weight,n.importance,n.requirement_json AS requirement,
      COALESCE(r.status,'pending') AS status,r.opinion,r.expert_id AS expertId,
      a.display_name AS expertName,r.assigned_at AS assignedAt
     FROM blueprint_versions v JOIN blueprints b ON b.id=v.blueprint_id
     JOIN projects p ON p.id=b.project_id JOIN project_occupations po ON po.id=b.occupation_id
     JOIN blueprint_nodes n ON n.blueprint_version_id=v.id AND n.node_kind='assessment_point'
     LEFT JOIN outline_point_reviews r ON r.node_id=n.id LEFT JOIN accounts a ON a.id=r.expert_id
     WHERE ${conditions.join(" AND ")} ORDER BY v.created_at DESC,n.ordinal`, params,
  );
}

export type OutlineAction = {
  versionId: string; nodeId?: string; action: "approve" | "return" | "confirm" | "assign";
  opinion: string; expertId?: string;
};

export async function actOnOutline(input: OutlineAction, actorId: string, role: "admin" | "expert", connection?: PoolConnection) {
  const run = async (db: PoolConnection) => {
    const [versions] = await db.execute<(RowDataPacket & { project_id: string })[]>(
      `SELECT b.project_id FROM blueprint_versions v JOIN blueprints b ON b.id=v.blueprint_id
       JOIN projects p ON p.id=b.project_id AND p.status='active'
       WHERE v.id=? AND v.status<>'archived' AND b.blueprint_kind IN ('theory_outline','skill_outline') FOR UPDATE`, [input.versionId],
    );
    if (!versions.length) throw new Error("细目表版本不存在或已归档。");
    if (role !== "admin" && (!input.nodeId || ["confirm", "assign"].includes(input.action))) throw new Error("仅管理员可批量审核、分配或确认。");
    if (input.action === "assign") {
      const [experts] = await db.execute<RowDataPacket[]>("SELECT id FROM accounts WHERE id=? AND role='expert' AND status='active' AND deleted_at IS NULL", [input.expertId ?? ""]);
      if (!experts.length) throw new Error("请选择有效专家。");
    }
    const [nodes] = await db.execute<(RowDataPacket & { id: string })[]>(
      `SELECT id FROM blueprint_nodes WHERE blueprint_version_id=? AND node_kind='assessment_point'${input.nodeId ? " AND id=?" : ""} FOR UPDATE`,
      input.nodeId ? [input.versionId, input.nodeId] : [input.versionId],
    );
    if (!nodes.length) throw new Error("没有可审核考评点。");
    if (input.action === "assign") {
      const [blocked] = await db.execute<RowDataPacket[]>(
        `SELECT r.node_id FROM outline_point_reviews r JOIN blueprint_nodes n ON n.id=r.node_id
         WHERE n.blueprint_version_id=? AND (r.expert_id IS NOT NULL OR r.status IN ('awaiting_confirmation','confirmed'))`,
        [input.versionId],
      );
      if (blocked.length) throw new Error("本版本已分配或已有审核通过的考评点，不能再分配给专家。");
    }
    if (role === "admin" && ["approve", "return"].includes(input.action)) {
      const [assigned] = await db.execute<RowDataPacket[]>(
        "SELECT r.node_id FROM outline_point_reviews r JOIN blueprint_nodes n ON n.id=r.node_id WHERE n.blueprint_version_id=? AND r.expert_id IS NOT NULL",
        [input.versionId],
      );
      if (assigned.length) throw new Error("本版本已分配给专家，管理员只能查看和确认，不能审核。");
    }
    let changed = 0;
    for (const node of nodes) {
      await db.execute("INSERT IGNORE INTO outline_point_reviews(node_id) VALUES(?)", [node.id]);
      const [reviews] = await db.execute<(RowDataPacket & { status: string; expert_id: string | null })[]>("SELECT status,expert_id FROM outline_point_reviews WHERE node_id=? FOR UPDATE", [node.id]);
      const current = reviews[0];
      if (role === "expert" && current.expert_id !== actorId) throw new Error("不能处理未分配给本人的考评点。");
      if (input.action === "confirm") {
        if (current.status === "confirmed") continue;
        if (current.status !== "awaiting_confirmation") throw new Error("仅审核通过的考评点可以确认；请先全部审核通过。");
        await db.execute("UPDATE outline_point_reviews SET status='confirmed',confirmed_by=?,confirmed_at=UTC_TIMESTAMP(3) WHERE node_id=?", [actorId, node.id]);
      } else if (input.action === "assign") {
        if (["confirmed", "awaiting_confirmation"].includes(current.status) || current.expert_id) throw new Error("考评点已通过或已分配，不能重复分配。");
        await db.execute("UPDATE outline_point_reviews SET expert_id=?,assigned_by=?,assigned_at=UTC_TIMESTAMP(3) WHERE node_id=?", [input.expertId!, actorId, node.id]);
      } else {
        if (["confirmed", "awaiting_confirmation"].includes(current.status)) {
          if (input.nodeId) throw new Error("该考评点已审核，请勿重复操作。");
          continue;
        }
        await db.execute("UPDATE outline_point_reviews SET status=?,opinion=?,reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3) WHERE node_id=?",
          [input.action === "approve" ? "awaiting_confirmation" : "returned", input.opinion, actorId, node.id]);
      }
      changed += 1;
      await db.execute(
        `INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,before_json,after_json,result)
         VALUES(?,?,?,'outline.point_review','blueprint_node',?,?,?,'success')`,
        [createUlid(), versions[0].project_id, actorId, node.id, JSON.stringify(current),
          JSON.stringify({ ...input, actingRole: role, proxyReview: role === "admin" && ["approve", "return"].includes(input.action) })],
      );
    }
    return { changed };
  };
  return connection ? run(connection) : withTransaction(run);
}
