import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidenceCatalog, factualTheorySources } from "./evidence-catalog";
import type { Snapshot } from "./contracts";
import { theoryEvidenceSourceVersionIds, theoryEvidenceTopic } from "./service";

const node: Snapshot["nodes"][number] = {
  id: "node-1",
  code: "B-C-Z-001",
  name: "募捐工作的信息渠道单向筛选的原则",
  chapterIds: [],
  theoryContext: {
    point: {
      primaryName: "相关知识要求 · 款物募集",
      secondaryName: "信息策划",
      tertiaryName: "3.2.1 募捐信息整理",
      standardSource: {
        sourceVersionId: "standard-version",
        functionName: "款物募集",
        contentName: "信息策划",
        name: "募捐信息整理",
        evidence: "3.2.1 募捐信息整理",
      },
    },
    source: {
      standard: {
        sourceVersionId: "standard-version",
      },
    },
  },
};

test("理论无教材点从标准上下文提取唯一 sourceVersionId", () => {
  assert.deepEqual(theoryEvidenceSourceVersionIds(node), ["standard-version"]);
});

test("理论无教材点可用标准原文片段补足可核验依据", () => {
  const sources = buildEvidenceCatalog(node.theoryContext, [{
    id: "seg-1",
    chapter_title: "职业标准 3.2.1 募捐信息整理",
    section_title: null,
    content_text: "募捐信息整理应当围绕信息收集、甄别、分类和单向筛选展开，明确不同渠道信息的真实性核验要求，并记录筛选依据和流转结果。",
  }], theoryEvidenceTopic(node));
  const factual = factualTheorySources(sources);
  assert.ok(factual.length > 0);
  assert.match(factual[0].content, /单向筛选/);
});
