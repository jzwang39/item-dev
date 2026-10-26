import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { Document, Packer, Paragraph } from "docx";
import { createUlid } from "../src/shared/database/ulid";

function textPdf(text: string) {
  const unicode = (value: string) => Array.from(value).map((character) => character.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const content = `BT /F1 12 Tf 30 760 Td ${text.split("\n").map((line) => `<${unicode(line)}> Tj 0 -20 Td`).join("\n")} ET`;
  const characters = Array.from(new Set(Array.from(text.replace(/\n/g, ""))));
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /TestUnicode def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${characters.length} beginbfchar ${characters.map((character) => `<${unicode(character)}> <${unicode(character)}>`).join("\n")} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1000 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /TestFont /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 /FontDescriptor 8 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
    "<< /Type /FontDescriptor /FontName /TestFont /Flags 4 /FontBBox [0 -200 1000 900] /Ascent 900 /Descent -200 /CapHeight 700 /ItalicAngle 0 /StemV 80 >>",
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(result.length);
    result += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = result.length;
  result += `xref\n0 9\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return new Uint8Array(Buffer.from(result, "ascii"));
}

async function main() {
  loadEnvConfig(process.cwd());
  const prefix = `vs_${Date.now()}_`;
  const tables = ["projects", "project_occupations", "file_objects", "sources", "source_versions", "source_scopes",
    "source_segments", "blueprints", "blueprint_versions", "blueprint_nodes", "blueprint_version_sources", "audit_logs",
    "textbook_chapters", "skill_outline_generation_jobs"];
  const db = await createConnection(process.env.DATABASE_URL!);
  const raw = db.query.bind(db);
  const execute = db.execute.bind(db);
  const directory = await mkdtemp(join(tmpdir(), "skill-standard-test-"));
  const previousDirectory = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = directory;
  const rewrite = (sql: string) => sql.replace(new RegExp(`\\b(${tables.join("|")})\\b`, "g"), (name) => `${prefix}${name}`);
  let fail = false;
  const { getPool } = await import("../src/shared/database/mysql");
  const pool = getPool();
  try {
    for (const table of tables) await raw(`CREATE TABLE \`${prefix}${table}\` LIKE \`${table}\``);
    db.execute = ((sql: string, values?: Parameters<typeof db.execute>[1]) => execute(rewrite(sql), values)) as typeof db.execute;
    const poolExecute = pool.execute.bind(pool);
    pool.execute = ((sql: string, values?: Parameters<typeof pool.execute>[1]) => poolExecute(rewrite(sql), values)) as typeof pool.execute;
    const connect = pool.getConnection.bind(pool);
    pool.getConnection = async () => {
      const connection = await connect();
      const wrapped = connection as typeof connection & { skillTestWrapped?: boolean };
      if (!wrapped.skillTestWrapped) {
        const original = connection.execute.bind(connection);
        connection.execute = ((sql: string, values?: Parameters<typeof connection.execute>[1]) => {
          if (fail && sql.startsWith("INSERT INTO audit_logs")) throw new Error("injected failure after all versions");
          return original(rewrite(sql), values);
        }) as typeof connection.execute;
        wrapped.skillTestWrapped = true;
      }
      return connection;
    };
    const { importSkillStandard, getSkillStandard, listSkillStandards } = await import("../src/modules/blueprints/skill-standard-import");
    const project = createUlid(), occupation = createUlid(), actor = createUlid();
    await db.execute("INSERT INTO projects(id,code,name) VALUES(?,'skill-test','技能测试项目')", [project]);
    await db.execute("INSERT INTO project_occupations(id,project_id,code,name) VALUES(?,?,'skill-test','技能测试职业')", [occupation, project]);
    const text = `技能要求权重表
项目 五级/初级工 四级/中级工 三级/高级工 二级/技师 一级/高级技师
技能要求 轴类工件加工 60 60 60 60 —
设备维护与保养 40 40 40 40 —
合计 100 100 100 100 0`;
    const file = new File([text], "技能标准.txt", { type: "text/plain" });
    const count = async (table: string) => Number((await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n);
    const preview = await importSkillStandard(occupation, { file, preview: true }, actor);
    assert.equal(preview.versionNo, 0);
    assert.equal(await count("blueprint_versions"), 0);
    assert.equal((await readdir(directory)).length, 0);
    const result = await importSkillStandard(occupation, { file }, actor);
    assert.equal(result.versionNo, 1);
    assert.equal(await count("blueprints"), 6);
    assert.equal(await count("blueprint_versions"), 6);
    const [files] = await db.execute<RowDataPacket[]>("SELECT id,object_key FROM file_objects");
    assert.equal(await readFile(files[0].object_key, "utf8"), text);
    const stored = await getSkillStandard(occupation);
    assert.equal(stored.scopes.length, 4);
    const [empty] = await db.execute<RowDataPacket[]>(
      "SELECT v.snapshot_json FROM blueprints b JOIN blueprint_versions v ON v.id=b.current_version_id WHERE b.blueprint_kind='skill_structure' AND b.level_code='level_1'",
    );
    const emptySnapshot = typeof empty[0].snapshot_json === "string" ? JSON.parse(empty[0].snapshot_json) : empty[0].snapshot_json;
    assert.deepEqual(emptySnapshot.standardScopes, []);
    fail = true;
    await assert.rejects(importSkillStandard(occupation, { file }, actor), /injected/);
    fail = false;
    assert.equal(await count("blueprint_versions"), 6);
    assert.equal(await count("file_objects"), 1);
    assert.equal((await readdir(directory)).length, 1);
    assert.equal((await getSkillStandard(occupation)).versionNo, 1);
    await assert.rejects(importSkillStandard(occupation, { file: new File(["没有表格"], "错误.txt") }, actor));
    assert.equal(await count("blueprint_versions"), 6);
    const docx = await Packer.toBuffer(new Document({ sections: [{ children: text.split("\n").map((line) => new Paragraph(line)) }] }));
    const importedDocx = await importSkillStandard(occupation, { file: new File([new Uint8Array(docx)], "技能标准.docx") }, actor);
    assert.equal(importedDocx.versionNo, 2);
    assert.equal(importedDocx.items.length, 2);
    const { extractPdfText } = await import("../src/modules/documents/extraction/service");
    const extractedPdf = await extractPdfText(Buffer.from(textPdf(text)));
    assert.ok(extractedPdf.text.includes("技能要求权重表"), JSON.stringify(extractedPdf.text));
    const importedPdf = await importSkillStandard(occupation, { file: new File([textPdf(text)], "技能标准.pdf") }, actor);
    assert.equal(importedPdf.versionNo, 3);
    assert.equal(importedPdf.items[0].name, "轴类工件加工");
    const source = createUlid(), version = createUlid();
    await db.execute("INSERT INTO sources(id,project_id,name,source_type,current_version_id) VALUES(?,?,'技能依据','occupation_standard',?)", [source, project, version]);
    await db.execute("INSERT INTO source_versions(id,source_id,version_no,file_object_id,parse_status) VALUES(?,?,1,?,'succeeded')", [version, source, files[0].id]);
    for (const level of ["level_5", "level_4"]) await db.execute("INSERT INTO source_scopes(id,source_version_id,occupation_id,level_code,assessment_mode) VALUES(?,?,?,?,'skill')", [createUlid(), version, occupation, level]);
    await db.execute("INSERT INTO source_segments(id,source_version_id,ordinal,locator,content_excerpt,content_hash) VALUES(?,?,1,'full',?,?)", [createUlid(), version, text, "a".repeat(64)]);
    assert.equal((await listSkillStandards(occupation)).length, 1);
    const importedSource = await importSkillStandard(occupation, { sourceVersionId: version }, actor);
    assert.equal(importedSource.items.length, 2, "Repeated scopes must not duplicate parsed segments");
    assert.equal(await count("blueprint_version_sources"), 6);
    const otherProject = createUlid();
    await db.execute("INSERT INTO projects(id,code,name) VALUES(?,'other-skill-test','另一项目')", [otherProject]);
    await db.execute("UPDATE sources SET project_id=? WHERE id=?", [otherProject, source]);
    await assert.rejects(importSkillStandard(occupation, { sourceVersionId: version }, actor), /不属于/);
    assert.equal((await listSkillStandards(occupation)).length, 0);
    const authPath = require.resolve("../src/auth");
    const previousAuth = require.cache[authPath];
    let role: string | null = null;
    require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: {
      getVerifiedSession: async () => role ? { user: { id: actor, role } } : null,
    } } as NonNullable<typeof previousAuth>;
    try {
      const { GET, POST } = await import("../src/app/api/v1/authoring/occupations/[occupationId]/skill-standard/route");
      const context = { params: { occupationId: occupation } };
      const url = "http://localhost/api/v1/authoring/occupations/test/skill-standard";
      assert.equal((await GET(new Request(url), context)).status, 401);
      role = "expert";
      assert.equal((await GET(new Request(url), context)).status, 403);
      assert.equal((await POST(new Request(url, { method: "POST" }), context)).status, 403);
      role = "admin";
      assert.equal((await GET(new Request(url), context)).status, 200);
      const form = new FormData();
      form.set("file", file); form.set("preview", "true");
      const versionsBefore = await count("blueprint_versions");
      const response = await POST(new Request(url, { method: "POST", body: form }), context);
      assert.equal(response.status, 201);
      assert.equal((await response.json()).data.items.length, 2);
      assert.equal(await count("blueprint_versions"), versionsBefore);
      form.set("preview", "false");
      assert.equal((await POST(new Request(url, { method: "POST", body: form }), context)).status, 201);
      assert.equal(await count("blueprint_versions"), versionsBefore + 6);
    } finally {
      if (previousAuth) require.cache[authPath] = previousAuth;
      else delete require.cache[authPath];
    }
    if (process.env.VERIFY_SKILL_GENERATION === "1") {
      const { startSkillGeneration, runSkillGeneration, getSkillGenerationState } = await import("../src/modules/blueprints/skill-outline-generation");
      const { uploadTextbook, listTextbooks } = await import("../src/modules/blueprints/theory-outline-generation/service");
      // Test jobs are driven synchronously with a fake model, never real AI.
      globalThis.__skillOutlineWorker = setInterval(() => undefined, 60000);
      globalThis.__skillOutlineWorker.unref();
      try {
        await assert.rejects(startSkillGeneration(occupation, "textbook", 40, actor), /上传/);
        await assert.rejects(startSkillGeneration(occupation, "model", 29, actor), /30/);
        const bookText = "第一章 车削加工\n第一节 轴类工件加工\n" + "操作技能教材正文：根据任务图样选择刀具并调整切削参数，执行加工并检查尺寸公差。".repeat(30);
        const book = await uploadTextbook(occupation, "level_5", new File([bookText], "技能教材.txt"), actor, "skill");
        const [bookFiles] = await db.execute<RowDataPacket[]>("SELECT fo.object_key FROM file_objects fo JOIN source_versions sv ON sv.file_object_id=fo.id WHERE sv.id=?", [book.sourceVersionId]);
        const bookPath = bookFiles[0].object_key;
        try {
          assert.equal((await listTextbooks(occupation, "level_5", "skill")).length, 1);
          assert.equal((await listTextbooks(occupation, "level_5", "theory")).length, 0);
          const [chapters] = await db.execute<RowDataPacket[]>("SELECT id FROM textbook_chapters WHERE source_version_id=?", [book.sourceVersionId]);
          assert.ok(chapters.length > 0);
          const fakeModel = async (instruction: string, prompt: string) => {
            assert.ok(instruction.includes("操作技能"));
            const payload = JSON.parse(prompt);
            assert.equal(payload.本批必须生成考评点数, undefined);
            assert.ok(payload.正文.length);
            const scopes = instruction.includes("提取正文") ? payload.可用考评范围.slice(0, 1) : payload.可用考评范围;
            return JSON.stringify({ completed: true, knowledgePoints: scopes.flatMap((scope: { scopeKey: string; 二级范围: string[] }) =>
              scope.二级范围.map((row: string) => ({
                knowledgeName: `${scope.scopeKey} ${row}操作要点`, evidence: payload.正文.slice(0, 40).trim(),
                name: `执行${row}工序并核验尺寸`, scopeKey: scope.scopeKey, rowName: row, importance: "X",
              })),
            ) });
          };
          const job = await startSkillGeneration(occupation, "textbook", 40, actor);
          await assert.rejects(startSkillGeneration(occupation, "model", 40, actor), /已有/);
          await runSkillGeneration(job.id, fakeModel);
          let generation = await getSkillGenerationState(occupation);
          assert.equal(generation.jobs[0].status, "succeeded", generation.jobs[0].errorMessage ?? "");
          assert.equal(generation.versions.length, 5);
          assert.equal(generation.versions.filter((item) => item.points.length).length, 1);
          for (const item of generation.versions.filter((item) => item.points.length)) {
            assert.equal(item.points.length, 2, "Two extracted knowledge points must yield exactly two assessment points, not weight×2");
            assert.equal(item.points.reduce((sum: number, point: { targetCount: number }) => sum + point.targetCount, 0), 40);
            assert.ok(item.points.every((point: { targetCount: number }) => point.targetCount === 20));
            assert.ok(item.points.every((point: { sourceChapterIds: string[] }) => point.sourceChapterIds.length > 0));
            assert.ok(item.points.every((point: { sourceKnowledgePoint?: { evidence: string } }) => point.sourceKnowledgePoint?.evidence));
          }
          const outlineVersionsBefore = generation.versions.length;
          const failJob = await startSkillGeneration(occupation, "model", 35, actor);
          await runSkillGeneration(failJob.id, async () => { throw new Error("模型测试失败"); });
          generation = await getSkillGenerationState(occupation);
          assert.equal(generation.jobs[0].status, "failed");
          assert.equal(generation.versions.length, outlineVersionsBefore);
          const rollbackJob = await startSkillGeneration(occupation, "model", 30, actor);
          fail = true;
          await runSkillGeneration(rollbackJob.id, fakeModel);
          fail = false;
          generation = await getSkillGenerationState(occupation);
          assert.equal(generation.jobs[0].status, "failed");
          assert.equal(generation.versions.length, outlineVersionsBefore);
          const directions = `技能要求权重表
项目 五级/初级工 四级/中级工 三级/高级工 二级/技师 一级/高级技师
通用 普通车床 数控车床 普通车床 数控车床 普通车床 数控车床 普通车床 数控车床
轴类工件加工 60 60 60 60 60 60 60 60 60
设备维护与保养 40 40 40 40 40 40 40 40 40
合计 100 100 100 100 100 100 100 100 100`;
          await importSkillStandard(occupation, { file: new File([directions], "方向标准.txt") }, actor);
          const multiJob = await startSkillGeneration(occupation, "model", 50, actor);
          await runSkillGeneration(multiJob.id, fakeModel);
          generation = await getSkillGenerationState(occupation);
          assert.equal(generation.jobs[0].status, "succeeded", generation.jobs[0].errorMessage ?? "");
          assert.equal(generation.jobs[0].generatedPointCount, 18);
          const latest = generation.versions.filter((item) => item.versionNo === 2);
          assert.equal(latest.length, 5);
          for (const item of latest) {
            const points = item.points as { direction: string; code: string; targetCount: number }[];
            assert.equal(new Set(points.map((point) => point.code)).size, points.length);
            assert.equal(points.reduce((sum, point) => sum + point.targetCount, 0), 50);
            for (const direction of new Set(points.map((point) => point.direction))) {
              assert.equal(points.filter((point) => point.direction === direction).reduce((sum, point) => sum + point.targetCount, 0), points.length === 2 ? 50 : 25);
            }
          }
          console.log("PASS: skill-only textbook chapters, knowledge-to-point 1:1, standard requirement extraction, all directions/levels, 30–50 question allocation, duplicate-job guard, model failure and atomic publication rollback.");
        } finally { await rm(bookPath, { force: true }); }
      } finally { clearInterval(globalThis.__skillOutlineWorker); globalThis.__skillOutlineWorker = undefined; }
    }
    console.log("PASS: preview, TXT/DOCX/PDF extraction, source scopes, source references, cross-project isolation, all-level publication, rollback, original file cleanup and API authorization.");
  } finally {
    await pool.end();
    for (const table of [...tables].reverse()) await raw(`DROP TABLE IF EXISTS \`${prefix}${table}\``);
    await db.end();
    await rm(directory, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = previousDirectory;
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
