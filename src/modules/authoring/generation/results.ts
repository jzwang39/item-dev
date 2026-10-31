import type { RowDataPacket } from "mysql2/promise";

import { query } from "@/shared/database/mysql";
import type { QualityRelaxation } from "./quality-policy";

type QuestionRow = RowDataPacket & {
  id: string;
  question_no: string;
  question_type: string;
  stem: string;
  content_json: string | { options?: Array<{ key: string; content: string }> };
  answer_json: string | { answers?: string[] };
  analysis_text: string | null;
  score_rubric_json: unknown;
  point_name: string | null;
  current_status: string;
  quality_relaxations_json: string | QualityRelaxation[] | null;
};

export function resultQualityRelaxations(value: QuestionRow["quality_relaxations_json"]): QualityRelaxation[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

export async function getPlanQuestionRows(planId: string) {
  // Aggregate only the point names so multiple associations cannot duplicate
  // questions, and the outer query stays compatible with ONLY_FULL_GROUP_BY.
  return query<QuestionRow[]>(
    `SELECT q.id, q.question_no, q.question_type, q.current_status,
            qv.stem, qv.content_json, qv.answer_json, qv.analysis_text, qv.score_rubric_json,
            JSON_EXTRACT(qv.source_snapshot_json, '$.qualityRelaxations') AS quality_relaxations_json,
            (SELECT MIN(bn.name)
               FROM question_assessment_points qap
               INNER JOIN blueprint_nodes bn ON bn.id = qap.blueprint_node_id
              WHERE qap.question_version_id = qv.id) AS point_name
       FROM questions q
       INNER JOIN question_versions qv ON qv.id = q.current_version_id
      WHERE q.project_id = (SELECT project_id FROM authoring_plans WHERE id = ?)
        AND JSON_UNQUOTE(JSON_EXTRACT(qv.source_snapshot_json, '$.planId')) = ?
      ORDER BY q.question_no`,
    [planId, planId]
  );
}
