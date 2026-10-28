import type { RowDataPacket } from "mysql2/promise";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getVerifiedSession } from "@/auth";
import { query, getPool } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";
import { createPaperWord, type PaperWord, type PaperWordItem } from "@/modules/documents/paper-word";
import { paperItemContent, parseRecord, type PaperPresentation } from "@/modules/documents/paper-presentation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { message: "仅管理员可下载组卷成果。" } }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const parsed = z.object({ paperId: z.string().length(26), kind: z.enum(["paper", "answers"]) }).safeParse({ paperId: params.get("paperId"), kind: params.get("kind") });
  if (!parsed.success) return NextResponse.json({ error: { message: "下载参数无效。" } }, { status: 400 });
  try {
    const papers = await query<(RowDataPacket & Omit<PaperWord, "items"> & { project_id: string; selection_summary_json: unknown })[]>(
      `SELECT p.title,p.paper_no,p.project_id,po.name AS occupation_name,ap.level_code,ap.assessment_mode,psv.duration_minutes,ar.selection_summary_json
       FROM papers p JOIN projects pr ON pr.id=p.project_id AND pr.status='active'
       JOIN assembly_runs ar ON ar.id=p.assembly_run_id
       JOIN assembly_plan_versions apv ON apv.id=p.assembly_plan_version_id
       JOIN assembly_plans ap ON ap.id=apv.assembly_plan_id
       JOIN project_occupations po ON po.id=ap.occupation_id
       JOIN paper_structure_versions psv ON psv.id=p.paper_structure_version_id WHERE p.id=?`, [parsed.data.paperId],
    );
    if (!papers.length) return NextResponse.json({ error: { message: "试卷不存在或项目已停用。" } }, { status: 404 });
    const items = await query<(RowDataPacket & PaperWordItem & { assessment_point_names?: unknown })[]>(
      `SELECT item_no,section_no,question_type,stem_snapshot,content_snapshot_json,answer_snapshot_json,
         score_rubric_snapshot_json,score,
         (SELECT JSON_ARRAYAGG(n.name) FROM question_assessment_points qp JOIN blueprint_nodes n ON n.id=qp.blueprint_node_id
          WHERE qp.question_version_id=paper_items.question_version_id) AS assessment_point_names
         FROM paper_items WHERE paper_id=? ORDER BY item_no`, [parsed.data.paperId],
    );
    const presentation = parseRecord(papers[0].selection_summary_json).presentation as PaperPresentation | undefined;
    const bytes = await createPaperWord({ ...papers[0], presentation,
      items: items.map((item) => ({ ...item, content_snapshot_json: paperItemContent(item) })) }, parsed.data.kind);
    await getPool().execute("INSERT INTO audit_logs(id,project_id,actor_id,action,object_type,object_id,after_json,result) VALUES(?,?,?,'paper.download','paper',?,?,'success')",
      [createUlid(), papers[0].project_id, session.user.id, parsed.data.paperId, JSON.stringify({ kind: parsed.data.kind, format: "docx", templateId: presentation?.format.id ?? (papers[0].assessment_mode === "skill" ? "skill_sample_v1" : "theory_sample_v1") })]);
    const filename = `${papers[0].title.replace(/[\\/:*?"<>|\r\n]/g, "_").slice(0, 100)}-${parsed.data.kind === "paper" ? "试卷" : "答案及评分标准"}.docx`;
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="paper-${papers[0].paper_no.replace(/[^A-Za-z0-9_-]/g, "_")}.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
    } });
  } catch (error) {
    return NextResponse.json({ error: { message: error instanceof Error ? error.message : "Word 文件生成失败。" } }, { status: 422 });
  }
}
