import type { RowDataPacket } from "mysql2/promise";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";
import { qualityStandardConfigs, qualityStandardContent } from "@/modules/authoring/quality-standard";

function configFor(request: Request) {
  return qualityStandardConfigs[new URL(request.url).searchParams.get("kind") === "skill" ? "skill" : "theory"];
}

function unauthorized() {
  return NextResponse.json(
    { error: { code: "FORBIDDEN", message: "仅管理员可维护试题质量标准。" } },
    { status: 403 },
  );
}

export async function GET(request: Request) {
  const session = await getVerifiedSession();
  if (!session?.user?.id || session.user.role !== "admin")
    return unauthorized();
  const { settingKey, defaultContent } = configFor(request);

  try {
    const rows = await query<
      (RowDataPacket & { setting_value_json: unknown; updated_at: string })[]
    >(
      "SELECT setting_value_json, updated_at FROM system_settings WHERE setting_key = ? LIMIT 1",
      [settingKey],
    );
    return NextResponse.json({
      data: {
        content: qualityStandardContent(rows[0]?.setting_value_json, defaultContent),
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
  const { settingKey, title } = configFor(request);
  const schema = z.object({
    content: z.string().trim().min(1, `请填写${title}。`).max(20_000),
  });
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
      const [previous] = await connection.execute<
        (RowDataPacket & { setting_value_json: unknown; row_version: number })[]
      >(
        "SELECT setting_value_json, row_version FROM system_settings WHERE setting_key = ? FOR UPDATE",
        [settingKey],
      );
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
          (id, project_id, actor_id, action, object_type, object_id, before_json, after_json, result)
         VALUES (?, ?, ?, 'authoring.quality_standard.save', 'system_setting', ?, ?, ?, 'success')`,
        [
          createUlid(),
          projects[0]?.id ?? null,
          session.user.id,
          createUlid(),
          JSON.stringify({
            settingKey,
            content: qualityStandardContent(previous[0]?.setting_value_json, ""),
            version: previous[0]?.row_version ?? 0,
          }),
          JSON.stringify({
            settingKey,
            content: parsed.data.content,
            version: Number(previous[0]?.row_version ?? 0) + 1,
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
