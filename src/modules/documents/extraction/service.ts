import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import mammoth from "mammoth";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ocr } from "tencentcloud-sdk-nodejs-ocr";

const nativeTextThreshold = 80;
const ocrBase64Limit = 10 * 1024 * 1024;

export type PdfExtractionResult = {
  text: string;
  usedOcr: boolean;
  pageCount: number;
};

export class DocumentExtractionError extends Error {
  constructor(
    public readonly code: "INVALID_PDF" | "OCR_NOT_CONFIGURED" | "OCR_FILE_TOO_LARGE" | "OCR_FAILED" | "OCR_NO_TEXT",
    message: string
  ) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

export async function extractPdfText(bytes: Buffer): Promise<PdfExtractionResult> {
  const native = await extractNativePdfText(bytes);
  if (native.text.length >= nativeTextThreshold) {
    return { ...native, usedOcr: false };
  }

  const text = await extractPdfTextWithOcr(bytes, native.pageCount);
  return { text, usedOcr: true, pageCount: native.pageCount };
}

export async function extractDocxText(bytes: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return normalizeText(result.value);
  } catch (error) {
    throw new Error(`DOCX 文本提取失败：${getErrorMessage(error)}`);
  }
}

async function extractNativePdfText(bytes: Buffer): Promise<Omit<PdfExtractionResult, "usedOcr">> {
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  let document;
  try {
    // Next.js does not copy PDF.js's worker into its server vendor chunks.
    // Point PDF.js at the installed module before it creates its Node fake worker.
    GlobalWorkerOptions.workerSrc = pathToFileURL(
      resolve(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")
    ).href;
    // Use a copy because PDF.js may transfer the source ArrayBuffer to its worker.
    const data = new Uint8Array(bytes);
    loadingTask = getDocument({ data, useWorkerFetch: false });
    document = await loadingTask.promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return { text: normalizeText(pages.join("\n")), pageCount: document.numPages };
  } catch (error) {
    throw new DocumentExtractionError("INVALID_PDF", `PDF 文件无法读取：${getErrorMessage(error)}`);
  } finally {
    await loadingTask?.destroy();
  }
}

async function extractPdfTextWithOcr(bytes: Buffer, pageCount: number): Promise<string> {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID?.trim();
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY?.trim();
  const enabled = process.env.TENCENTCLOUD_OCR_ENABLED?.trim().toLowerCase();
  if (enabled === "false" || !secretId || !secretKey) {
    throw new DocumentExtractionError(
      "OCR_NOT_CONFIGURED",
      "扫描版 PDF 需要配置腾讯云 OCR：请设置 TENCENTCLOUD_SECRET_ID、TENCENTCLOUD_SECRET_KEY，并启用 TENCENTCLOUD_OCR_ENABLED。"
    );
  }

  const imageBase64 = bytes.toString("base64");
  if (Buffer.byteLength(imageBase64, "utf8") > ocrBase64Limit) {
    throw new DocumentExtractionError(
      "OCR_FILE_TOO_LARGE",
      "扫描版 PDF 经 Base64 编码后超过腾讯云通用文字识别 10MB 限制，请压缩或拆分文件后重试。"
    );
  }

  const client = new ocr.v20181119.Client({
    credential: { secretId, secretKey },
    region: process.env.TENCENTCLOUD_REGION?.trim() || "ap-guangzhou",
    profile: { httpProfile: { reqMethod: "POST", reqTimeout: 60 } }
  });

  try {
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const response = await client.GeneralBasicOCR({
        ImageBase64: imageBase64,
        IsPdf: true,
        PdfPageNumber: pageNumber,
        LanguageType: "zh"
      });
      const pageText = response.TextDetections
        ?.map((item) => item.DetectedText?.trim() ?? "")
        .filter(Boolean)
        .join("\n");
      if (pageText) pageTexts.push(pageText);
    }
    const text = normalizeText(pageTexts.join("\n"));
    if (!text) {
      throw new DocumentExtractionError("OCR_NO_TEXT", "腾讯云 OCR 未能从该扫描版 PDF 识别出可用文字。");
    }
    return text;
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError("OCR_FAILED", `腾讯云 OCR 调用失败：${getErrorMessage(error)}`);
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
