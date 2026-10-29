import type { PoolConnection, RowDataPacket } from "mysql2/promise";

export type CurrentTheoryVersion = RowDataPacket & {
  id: string;
  version_no: number;
  snapshot_json: unknown;
  created_at: Date;
};

type Selection = { projectId: string; occupationId: string } & (
  { kind: "theory_outline"; levelCode: string } | { kind: "theory_weight" }
);

// Planning and confirmation must use the same ordering, including legacy duplicate rows.
export async function readCurrentTheoryVersion(db: PoolConnection, selection: Selection) {
  const [rows] = await db.execute<CurrentTheoryVersion[]>(
    `SELECT bv.id, bv.version_no, bv.snapshot_json, bv.created_at
       FROM blueprints b
       INNER JOIN blueprint_versions bv ON bv.id = b.current_version_id
      WHERE b.project_id = ? AND b.occupation_id = ?
        AND b.blueprint_kind = ? AND b.assessment_mode = 'theory'
        ${selection.kind === "theory_outline" ? "AND b.level_code = ?" : ""}
      ORDER BY b.updated_at DESC, b.id DESC
      LIMIT 1 FOR UPDATE`,
    [selection.projectId, selection.occupationId, selection.kind,
      ...(selection.kind === "theory_outline" ? [selection.levelCode] : [])],
  );
  return rows[0] ?? null;
}

export function assertPlanVersions(
  current: { outline: { id: string } | null; weights: { id: string } | null },
  planned: { outline: { id: string }; weights: { id: string } },
) {
  const changed = [
    ...(current.outline?.id === planned.outline.id ? [] : ["细目表"]),
    ...(current.weights?.id === planned.weights.id ? [] : ["权重表"]),
  ];
  if (changed.length) throw new Error(`${changed.join("、")}已更新或不再可用，请返回修改需求，重新生成命题计划后确认。`);
}
