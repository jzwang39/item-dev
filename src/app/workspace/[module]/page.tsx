import { notFound } from "next/navigation";

import { getVerifiedSession } from "@/auth";
import { AuthoringWorkspace } from "@/components/authoring/authoring-workspace";
import { AssemblyWorkspace } from "@/components/assembly/assembly-workspace";
import { QuestionBankWorkspace } from "@/components/questions/question-bank-workspace";
import { ExpertReviewWorkspace } from "@/components/review/expert-review-workspace";

const moduleNames: Record<string, { title: string; description: string }> = {
  authoring: {
    title: "智能命题",
    description: "管理考评蓝图、命题计划、资料依据与批次生成。",
  },
  review: {
    title: "专家审定",
    description: "查看分配任务，提交通过或退回意见并保留审定记录。",
  },
  questions: {
    title: "题库管理",
    description: "检索题目版本、审定状态、来源依据和历史编码。",
  },
  assembly: {
    title: "智能组卷",
    description: "配置试卷结构，生成并冻结题目、答案和评分快照。",
  },
};

export default async function ModulePlaceholderPage({
  params,
}: Readonly<{ params: { module: string } }>) {
  const currentModule = moduleNames[params.module];
  if (!currentModule) {
    notFound();
  }

  if (params.module === "authoring") {
    return <AuthoringWorkspace />;
  }
  if (params.module === "review") {
    const session = await getVerifiedSession();
    return <ExpertReviewWorkspace role={session?.user.role ?? "expert"} />;
  }
  if (params.module === "questions") {
    const session = await getVerifiedSession();
    return <QuestionBankWorkspace readOnly={session?.user.role === "expert"} />;
  }
  if (params.module === "assembly") {
    return <AssemblyWorkspace />;
  }

  return (
    <section>
      <p className="m-0 text-sm text-[#768091]">功能模块</p>
      <h1 className="mt-1 text-[23px] font-semibold">{currentModule.title}</h1>
      <div className="mt-6 rounded-xl border border-[#e7eaf0] bg-white p-8 shadow-card">
        <h2 className="m-0 text-base font-semibold">模块框架已就绪</h2>
        <p className="mb-0 mt-2 text-sm text-[#768091]">
          {currentModule.description}
        </p>
      </div>
    </section>
  );
}
