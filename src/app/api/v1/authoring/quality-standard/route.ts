import type { RowDataPacket } from "mysql2/promise";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";

const settingKey = "authoring.question_quality_standard";
const defaultContent = `1. 试题应准确对应考评点，不得超出职业标准和细目表范围。
2. 题干表述清晰、条件完整，避免歧义、暗示性和无关信息。
3. 选择题选项应具有合理干扰性，答案唯一或组合明确。
4. 答案和解析必须准确，解析应说明判断依据。
5. 同一计划内试题应避免重复或高度相似。`;

const schema = z.object({
  content: z.string().trim().min(1, "请填写试题质量标准。").max(20_000),
});

function unauthorized() {
  return NextResponse.json(
    { error: { code: "FORBIDDEN", message: "仅管理员可维护试题质量标准。" } },
    { status: 403 },
  );
}

export async function GET() {
  const session = await getVerifiedSession();
  if (!session?.user?.id || session.user.role !== "admin")
    return unauthorized();

  try {
    const rows = await query<
      (RowDataPacket & { setting_value_json: unknown; updated_at: string })[]
    >(
      "SELECT setting_value_json, updated_at FROM system_settings WHERE setting_key = ? LIMIT 1",
      [settingKey],
    );
    const value = rows[0]?.setting_value_json;
    const parsed =
      typeof value === "string"
        ? JSON.parse(value)
        : (value ?? { content: defaultContent });
    return NextResponse.json({
      data: {
        content:
          typeof parsed?.content === "string" && parsed.content.trim()
            ? parsed.content
            : defaultContent,
        updatedAt: rows[0]?.updated_at ?? null,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "QUALITY_STANDARD_LOAD_FAILED",
          message:
            error instanceof Error ? error.message : "加载试题质量标准失败。",
        },
      },
      { status: 500 },
    );
  }
}

export async function PUT(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id || session.user.role !== "admin")
    return unauthorized();
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: parsed.error.issues[0]?.message ?? "试题质量标准无效。",
        },
      },
      { status: 400 },
    );
  }

  try {
    await withTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO system_settings (setting_key, setting_value_json, updated_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           setting_value_json = VALUES(setting_value_json),
           updated_by = VALUES(updated_by),
           row_version = row_version + 1`,
        [
          settingKey,
          JSON.stringify({ content: parsed.data.content }),
          session.user.id,
        ],
      );
      const [projects] = await connection.execute<
        (RowDataPacket & { id: string })[]
      >(
        "SELECT id FROM projects WHERE status = 'active' ORDER BY created_at LIMIT 1",
      );
      await connection.execute(
        `INSERT INTO audit_logs
          (id, project_id, actor_id, action, object_type, object_id, after_json, result)
         VALUES (?, ?, ?, 'authoring.quality_standard.save', 'system_setting', ?, ?, 'success')`,
        [
          createUlid(),
          projects[0]?.id ?? null,
          session.user.id,
          createUlid(),
          JSON.stringify({
            settingKey,
            contentLength: parsed.data.content.length,
          }),
        ],
      );
    });
    return NextResponse.json({ data: { content: parsed.data.content } });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "QUALITY_STANDARD_SAVE_FAILED",
          message:
            error instanceof Error ? error.message : "保存试题质量标准失败。",
        },
      },
      { status: 422 },
    );
  }
}
