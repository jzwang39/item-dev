import { access, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import type { RowDataPacket } from "mysql2/promise";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getVerifiedSession } from "@/auth";
import { query } from "@/shared/database/mysql";
import { createUlid } from "@/shared/database/ulid";

type SourceFileRow = RowDataPacket & {
  version_id: string; name: string; source_type: string; remark: string | null; original_name: string;
  mime_type: string; object_key: string; size_bytes: number; parse_status: string; created_at: string; project_id: string;
};

const execFileAsync = promisify(execFile);
const pdfExtractorPath = "/tmp/itembank-pdf-text-extractor";
const pdfExtractionTimeoutMs = 10 * 60 * 1000;

async function findSource(sourceId: string) {
  const rows = await query<SourceFileRow[]>(
    `SELECT s.project_id, sv.id AS version_id, s.name, s.source_type, s.remark, fo.original_name, fo.mime_type, fo.object_key, fo.size_bytes, sv.parse_status, sv.created_at
       FROM sources s
       INNER JOIN source_versions sv ON sv.id = s.current_version_id
       INNER JOIN file_objects fo ON fo.id = sv.file_object_id
       INNER JOIN projects p ON p.id = s.project_id
      WHERE s.id = ? AND s.status = 'active' AND p.status = 'active'
      LIMIT 1`,
    [sourceId]
  );
  return rows[0] ?? null;
}

async function extractText(source: SourceFileRow, bytes: Buffer) {
  const extension = extname(source.original_name).toLowerCase();
  if (extension === ".txt") return bytes.toString("utf8");
  if (extension === ".docx") {
    const { stdout } = await execFileAsync("/usr/bin/textutil", ["-convert", "txt", "-stdout", source.object_key], { maxBuffer: 20 * 1024 * 1024 });
    return stdout.trim();
  }
  if (extension === ".pdf") {
    await ensurePdfExtractor();
    const { stdout } = await execFileAsync(pdfExtractorPath, [source.object_key], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: pdfExtractionTimeoutMs
    });
    const result = JSON.parse(stdout) as { text: string };
    return result.text.trim();
  }
  throw new Error("不支持该文件类型的文本提取。");
}

async function ensurePdfExtractor() {
  try {
    await access(pdfExtractorPath);
  } catch {
    await execFileAsync(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-framework", "PDFKit",
        "-framework", "Vision",
        "-framework", "AppKit",
        join(process.cwd(), "scripts", "extract-pdf-text.swift"),
        "-o", pdfExtractorPath
      ],
      { timeout: 120000 }
    );
  }
}

function textFilename(originalName: string) {
  const filename = originalName.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_");
  return `${filename || "提取文本"}.txt`;
}

const verificationSchema = z.object({
  occupationName: z.string().trim().max(200).optional(),
  applicableLevel: z.string().trim().max(50).optional(),
  versionLabel: z.string().trim().max(100).optional(),
  locator: z.string().trim().max(500).optional(),
  remark: z.string().trim().max(2000).optional(),
  verified: z.boolean()
});

export async function GET(request: Request, { params }: Readonly<{ params: { sourceId: string } }>) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  const source = await findSource(params.sourceId);
  if (!source) return NextResponse.json({ error: { code: "NOT_FOUND", message: "资料不存在或已归档。" } }, { status: 404 });

  const mode = new URL(request.url).searchParams.get("mode");
  try {
    const bytes = await readFile(source.object_key);
    if (mode === "file" || mode === "download") {
      return new Response(bytes, {
        headers: {
          "Content-Type": source.mime_type || "application/octet-stream",
          "Content-Disposition": `${mode === "download" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(source.original_name)}`,
          "Cache-Control": "private, no-store"
        }
      });
    }
    let extractedText: string | null = null;
    try {
      extractedText = await extractText(source, bytes);
      await query("UPDATE source_versions SET parse_status = 'succeeded', error_code = NULL, error_message = NULL WHERE id = ?", [source.version_id]);
    } catch (error) {
      await query("UPDATE source_versions SET parse_status = 'failed' WHERE id = ?", [source.version_id]);
      if (mode === "text-download") {
        const reason = error instanceof Error ? error.message : "无法提取文件正文。";
        return NextResponse.json({ error: { code: "TEXT_EXTRACTION_FAILED", message: `提取文本失败：${reason} 扫描版 PDF 请先完成 OCR。` } }, { status: 422 });
      }
    }
    if (mode === "text-download") {
      if (!extractedText) return NextResponse.json({ error: { code: "TEXT_EXTRACTION_FAILED", message: "该文件未提取到可下载的正文文本。" } }, { status: 422 });
      return new Response(extractedText, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(textFilename(source.original_name))}`,
          "Cache-Control": "private, no-store"
        }
      });
    }
    return NextResponse.json({
      data: {
        name: source.name,
        sourceType: source.source_type,
        remark: source.remark,
        originalName: source.original_name,
        mimeType: source.mime_type,
        sizeBytes: source.size_bytes,
        createdAt: source.created_at,
        parseStatus: source.parse_status,
        extractedText
      }
    });
  } catch {
    return NextResponse.json({ error: { code: "FILE_READ_FAILED", message: "原始文件不存在或无法读取。" } }, { status: 404 });
  }
}

export async function POST(request: Request, { params }: Readonly<{ params: { sourceId: string } }>) {
  const session = await getVerifiedSession();
  if (!session?.user?.id) return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "登录已失效。" } }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: { code: "FORBIDDEN", message: "仅管理员可保存核验信息。" } }, { status: 403 });
  const payload = verificationSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: { code: "VALIDATION_FAILED", message: "核验信息格式无效。" } }, { status: 400 });
  const source = await findSource(params.sourceId);
  if (!source) return NextResponse.json({ error: { code: "NOT_FOUND", message: "资料不存在或已归档。" } }, { status: 404 });
  await query(
    `INSERT INTO audit_logs (id, project_id, actor_id, action, object_type, object_id, after_json, result)
     VALUES (?, ?, ?, 'source.verify', 'source', ?, ?, ?)`,
    [createUlid(), source.project_id, session.user.id, params.sourceId, JSON.stringify(payload.data), payload.data.verified ? "success" : "warning"]
  );
  return NextResponse.json({ data: { saved: true } });
}
