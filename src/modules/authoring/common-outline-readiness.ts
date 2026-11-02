import type { PoolConnection, RowDataPacket } from "mysql2/promise";

type Outline = { id: string; levelCode: string; versionNo: number };
type ApprovalCount = RowDataPacket & {
  version_id: string; total: number; confirmed: number; pending: number; returned: number; awaiting_confirmation: number;
};
const levels: Record<string, string> = { level_5: "五级", level_4: "四级", level_3: "三级" };

// Keep the whole-outline approval gate, but report every blocked level so the
// administrator can finish the existing review workflow without guessing.
export async function assertCommonOutlinesConfirmed(db: PoolConnection, outlines: Outline[]) {
  if (!outlines.length) throw new Error("没有可核对的理论知识细目表。");
  const [rows] = await db.execute<ApprovalCount[]>(
    `SELECT n.blueprint_version_id AS version_id,COUNT(*) AS total,
      SUM(COALESCE(r.status,'pending')='confirmed') AS confirmed,
      SUM(COALESCE(r.status,'pending')='pending') AS pending,
      SUM(COALESCE(r.status,'pending')='returned') AS returned,
      SUM(COALESCE(r.status,'pending')='awaiting_confirmation') AS awaiting_confirmation
     FROM blueprint_nodes n LEFT JOIN outline_point_reviews r ON r.node_id=n.id
     WHERE n.blueprint_version_id IN (${outlines.map(() => "?").join(",")}) AND n.node_kind='assessment_point'
     GROUP BY n.blueprint_version_id`, outlines.map((outline) => outline.id),
  );
  const blocked = outlines.flatMap((outline) => {
    const row = rows.find((item) => item.version_id === outline.id);
    const label = `${levels[outline.levelCode] ?? outline.levelCode} V${outline.versionNo}`;
    if (!row || !Number(row.total)) return [`${label}：没有可审核考评点。`];
    if (Number(row.confirmed) === Number(row.total)) return [];
    const remaining = [
      Number(row.pending) ? `待审核${Number(row.pending)}个` : "",
      Number(row.returned) ? `已退回待修订${Number(row.returned)}个` : "",
      Number(row.awaiting_confirmation) ? `已审核通过、待管理员确认${Number(row.awaiting_confirmation)}个` : "",
    ].filter(Boolean);
    return [`${label}：共${Number(row.total)}个考评点，已确认${Number(row.confirmed)}个；${remaining.join("，")}。`];
  });
  if (blocked.length) throw new Error([
    "细目表尚未全部审核并经管理员确认，公共题组暂不能创建或同步：",
    ...blocked,
    "请进入“专家审定 → 细目表审核任务”，完成对应版本审核，再由管理员确认；之后返回重试。",
  ].join("\n"));
}
