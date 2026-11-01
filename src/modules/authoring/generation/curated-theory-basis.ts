import type { Snapshot } from "./contracts";

// A fetched, verbatim source excerpt, not model-generated factual content.
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

export function curatedTheoryBasis(snapshot: Pick<Snapshot, "scope" | "nodes">, code: string) {
  const node = snapshot.nodes.find((item) => item.code === code);
  if (snapshot.scope.assessmentMode !== "理论知识" || snapshot.scope.occupation !== "劝募员"
    || !["level_5", "level_4", "level_3"].includes(snapshot.scope.levelCode)
    || code !== "B-C-AD-002" || !node || node.chapterIds.length
    || !/新媒体传播/.test(node.name)) return undefined;
  return basis;
}
