import type { Snapshot } from "./contracts";

// Fetched excerpts/table cells, not model-generated factual content.
// Scope and candidate approval still belong to independent runtime review.
const basis = {
  id: "ustb-new-media-roles-20261101-v1",
  url: "https://bkds.ustb.edu.cn/cn/article/doi/10.19979/j.cnki.issn10082689.2023070087?viewType=HTML",
  title: "邢华超：短视频场域高校提升主流意识形态引领力的现实境遇与实践指向",
  publication: "北京科技大学学报（社会科学版），2024，40(3)：31-39",
  locator: "一、短视频场域高校提升主流意识形态引领力面临的新机遇；（一）利用“去中心化”的制作方式盘活主体引导力",
  retrievedAt: "2026-11-01T12:13:20Z",
  acquisition: "WebFetch获取出版机构HTML正文后人工核对摘录；随代码保存的版本化资料，不代表运行时重新下载",
  text: "而短视频开放式的参与模式、低门槛的创作模式、碎片化的表达方式，既为信息传播提供了更加自由的表达空间，也使得人人都拥有了“话语权”。这种“去中心化”的平权创作、分享模式，既使得短视频用户由原来单一的信息接收者变为在信息生成、传播、分享和接收间自由切换的多重主体，也使得短视频中的人际关系“呈现出‘缺席的在场’和‘在场的缺席’两种并存状态”。",
  designHint: "只考查短视频用户在信息接收、内容生成与传播分享之间的角色切换，不考高校意识形态政策；区别于已有的传播速度范围和传播效果指标题。设计一个知识识别或必要应用题，四选项表达层级相同，逐项有排除依据，不使用绝对词制造明显错误。不得把建议任务当作通过的题目，仍须按完整标准核验。",
};

const evaluationBasis = {
  id: "scnu-video-evaluation-20261101-v1",
  url: "https://journal-n.scnu.edu.cn/cn/supplement/1e1d6c6c-d0a7-409e-a6fc-b131e15276d1",
  title: "夏宝君、郑龙：基于MOA模型的知识类视频对青年亚文化群体的传播效果研究",
  publication: "华南师范大学学报（自然科学版），2023，55(4)：87-99；DOI：10.6054/j.jscnun.2023053",
  locator: "表1：影响知识类视频传播效果因素的指标体系，效果E的四项观测变量及指标说明",
  retrievedAt: "2026-11-01T13:22:33Z",
  acquisition: "WebFetch获取出版机构正文及表1后核对摘录；以下保留表格的效果E四行，空白合并列补齐，不代表运行时重新下载",
  text: "| 潜在变量 | 观测变量 | 指标说明 |\n| 效果E | 认知效果 | 知识学习、信息获取的实现程度 |\n| 效果E | 情感效果 | 情感、情绪、社交的变化及实现程度 |\n| 效果E | 态度效果 | 主观体验后对事物立场、态度的转变 |\n| 效果E | 行为效果 | 基于认知情感态度转变所表现的行动或行为倾向 |",
  designHint: "考查知识类视频传播效果评估中，知识学习、信息获取对应的认知效果维度；限定为该指标框架的知识类视频，不泛化为统一国家标准。不再设计“哪项不是评估指标”、传播速度范围或用户角色题。四个选项分别使用认知效果、情感效果、态度效果、行为效果，依据表中定义区分；题干不能直接写出正确维度名称。不得据此宣称评论数、观看时长等不是传播效果指标。仍须逐项完整核验，建议不是合格结论。",
};

export function curatedTheoryBasis(snapshot: Pick<Snapshot, "scope" | "nodes">, code: string) {
  const node = snapshot.nodes.find((item) => item.code === code);
  if (snapshot.scope.assessmentMode !== "理论知识" || snapshot.scope.occupation !== "劝募员"
    || !["level_5", "level_4", "level_3"].includes(snapshot.scope.levelCode)
    || code !== "B-C-AD-002" || !node || node.chapterIds.length
    || !/新媒体传播/.test(node.name)) return undefined;
  return /评估.*指标|指标体系/.test(node.name) ? evaluationBasis : basis;
}

export function curatedTheoryBasisReplacement(snapshot: Pick<Snapshot, "scope" | "nodes">, code: string) {
  return curatedTheoryBasis(snapshot, code)?.id === evaluationBasis.id ? { previous: basis, next: evaluationBasis } : undefined;
}

export function curatedEvaluationTask(basisId: string, sources: Array<{ id: string; content: string }>) {
  if (basisId !== evaluationBasis.id) return undefined;
  const source = sources.find((item) => ["认知效果", "知识学习、信息获取的实现程度", "情感效果", "态度效果", "行为效果"]
    .every((text) => item.content.includes(text)));
  if (!source) return undefined;
  return { angle: "知识类视频传播效果评估的认知维度",
    task: "根据知识学习、信息获取的测评目标识别对应效果维度，区别于既有指标排除和传播速度题",
    sourceId: source.id, quote: source.content, questionType: "single" as const, reusesKnowledge: false,
    reason: "版本化资料表1直接给出四类维度及定义；具体候选仍须独立核验依据、考点范围和任务差异。" };
}
