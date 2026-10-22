import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { RowDataPacket } from "mysql2/promise";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { createUlid } from "@/shared/database/ulid";
import { query, withTransaction } from "@/shared/database/mysql";

const allowedExtensions = new Set([".pdf", ".docx", ".txt"]);
const sourceTypes = ["occupation_standard", "textbook", "general_document", "sample_paper", "outline_sheet", "structure_sheet", "other"] as const;
const metadataSchema = z.object({
  name: z.string().trim().min(1, "请填写资料名称。").max(300),
  sourceType: z.enum(sourceTypes),
  remark: z.string().trim().max(2000).optional()
});
const uploadDirectory = join(process.cwd(), ".data", "uploads", "sources");

type SourceRow = RowDataPacket & {
  id: string; name: string; source_type: typeof sourceTypes[number]; remark: string | null;
  original_name: string; mime_type: string; size_bytes: number; created_at: string;
};

function guard(session: Awaited<ReturnType<typeof getVerifiedSession>>) {
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可维护资料依据。" } }, { status: 403 });
  return null;
}

export async function GET() {
  const session = await getVerifiedSession();
  const rejection = guard(session);
  if (rejection) return rejection;
  try {
    const rows = await query<SourceRow[]>(
      `SELECT s.id, s.name, s.source_type, s.remark, fo.original_name, fo.mime_type, fo.size_bytes, sv.created_at
         FROM sources s
         INNER JOIN source_versions sv ON sv.id = s.current_version_id
         INNER JOIN file_objects fo ON fo.id = sv.file_object_id
         INNER JOIN projects p ON p.id = s.project_id
        WHERE p.status = 'active' AND s.status = 'active'
        ORDER BY sv.created_at DESC`
    );
    return NextResponse.json({ data: rows });
  } catch (error) {
    return NextResponse.json({ error: { code: "SOURCE_LIST_FAILED", message: error instanceof Error ? error.message : "资料列表加载失败。" } }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await getVerifiedSession();
  const rejection = guard(session);
  if (rejection) return rejection;
  const actorId = session!.user.id;
  try {
    const formData = await request.formData();
    const metadata = metadataSchema.safeParse({
      name: formData.get("name"),
      sourceType: formData.get("sourceType"),
      remark: formData.get("remark") || undefined
    });
    const file = formData.get("file");
    if (!metadata.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: metadata.error.issues[0]?.message ?? "资料信息无效。" } }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: { code: "FILE_REQUIRED", message: "请选择要上传的资料文件。" } }, { status: 400 });
    const extension = extname(file.name).toLowerCase();
    if (!allowedExtensions.has(extension)) return NextResponse.json({ error: { code: "UNSUPPORTED_FILE", message: "仅支持 PDF、DOCX、TXT 文件。" } }, { status: 400 });
    if (file.size > 15 * 1024 * 1024) return NextResponse.json({ error: { code: "FILE_TOO_LARGE", message: "单个文件不得超过 15MB。" } }, { status: 400 });

    const bytes = Buffer.from(await file.arrayBuffer());
    const result = await withTransaction(async (connection) => {
      const [projects] = await connection.execute<(RowDataPacket & { id: string })[]>("SELECT id FROM projects WHERE status = 'active' ORDER BY created_at LIMIT 2 FOR UPDATE");
      if (projects.length !== 1) throw new Error("当前项目上下文无效，无法保存资料。");
      const projectId = projects[0].id;
      const sourceId = createUlid();
      const versionId = createUlid();
      const fileId = createUlid();
      const objectPath = join(uploadDirectory, `${fileId}${extension}`);
      await mkdir(uploadDirectory, { recursive: true });
      await writeFile(objectPath, bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      await connection.execute(
        `INSERT INTO file_objects (id, project_id, storage_provider, bucket, object_key, original_name, mime_type, size_bytes, sha256, purpose, created_by)
         VALUES (?, ?, 'local', 'itembank-local', ?, ?, ?, ?, ?, 'source_upload', ?)`,
        [fileId, projectId, objectPath, basename(file.name), file.type || "application/octet-stream", bytes.length, hash, actorId]
      );
      await connection.execute(
        `INSERT INTO sources (id, project_id, name, source_type, remark, current_version_id, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [sourceId, projectId, metadata.data.name, metadata.data.sourceType, metadata.data.remark || null, versionId, actorId]
      );
      await connection.execute(
        `INSERT INTO source_versions (id, source_id, version_no, file_object_id, parse_status, content_hash, created_by)
         VALUES (?, ?, 1, ?, 'pending', ?, ?)`,
        [versionId, sourceId, fileId, hash, actorId]
      );
      await connection.execute(
        `INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result)
         VALUES (?, ?, ?, 'source.upload', 'source', ?, ?, 'success')`,
        [createUlid(), projectId, actorId, sourceId, JSON.stringify({ name: metadata.data.name, sourceType: metadata.data.sourceType, fileName: file.name, versionId })]
      );
      return { id: sourceId, name: metadata.data.name, sourceType: metadata.data.sourceType, remark: metadata.data.remark || null, originalName: file.name, mimeType: file.type, sizeBytes: file.size, createdAt: new Date().toISOString() };
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: { code: "SOURCE_UPLOAD_FAILED", message: error instanceof Error ? error.message : "资料保存失败。" } }, { status: 500 });
  }
}
