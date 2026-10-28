import React from "react";
import type { PaperWord } from "@/modules/documents/paper-word";
import { chineseNumber, paperLevels, parseRecord, sectionInstruction, skillDisplay } from "@/modules/documents/paper-presentation";

export function PaperSamplePreview({ paper, kind }: Readonly<{ paper: PaperWord; kind: "paper" | "answers" }>) {
  const skill = paper.assessment_mode === "skill";
  const sections = [...new Set(paper.items.map((item) => item.section_no))];
  const total = paper.items.reduce((sum, item) => sum + Math.round(Number(item.score) * 100), 0) / 100;
  return <div className="border border-[#dbe2ec] bg-white p-6 text-black" style={{ fontFamily: skill ? "FangSong, 仿宋, serif" : "SimSun, 宋体, serif" }}>
    <p className="text-center">职业技能等级认定</p>
    <h2 className="text-center text-xl font-bold">{paper.occupation_name}{paperLevels[paper.level_code]}{skill ? "操作技能" : "理论知识"}{kind === "paper" ? "试卷" : "答案及评分标准"}</h2>
    <p className="text-center text-sm">{paper.title} · 考试时间：{paper.duration_minutes || "待核对"}分钟 · {paper.items.length}题 / {total}分</p>
    {kind === "paper" ? <p>地区：________　姓名：________　单位名称：____________　准考证号：____________</p> : null}
    {!skill && kind === "paper" ? <>
      <h3 className="text-center font-bold">注 意 事 项</h3>
      <p>1、本试卷由已入库试题组卷，依据资料及版本以组卷留痕记录为准。</p>
      <p>2、请在试卷标封处填写地区、姓名、准考证号和所在单位名称。</p>
      <p>3、请仔细阅读答题要求，在规定位置填写答案。</p>
      <div className="overflow-x-auto"><table className="my-6 w-full border-collapse text-center text-sm"><tbody>
        <tr>{["", ...sections.map((_, index) => chineseNumber(index + 1)), "总分"].map((text, index) => <td key={index} className="border border-black p-2">{text}</td>)}</tr>
        <tr>{["得分", ...sections.map(() => ""), ""].map((text, index) => <td key={index} className="border border-black p-2">{text || "　"}</td>)}</tr>
      </tbody></table></div>
    </> : null}
    {paper.items.map((item, index) => {
      const display = skillDisplay(item);
      const data = parseRecord(item.content_snapshot_json);
      const rubric = parseRecord(item.score_rubric_snapshot_json);
      const criteria = Array.isArray(rubric.criteria) ? rubric.criteria.map(parseRecord) : [];
      const answer = parseRecord(item.answer_snapshot_json);
      const answerValue = answer.answers ?? answer.answer ?? item.answer_snapshot_json;
      const text = Array.isArray(answerValue) ? answerValue.map(String).join("、") : typeof answerValue === "string" ? answerValue : JSON.stringify(answerValue);
      return <article key={item.item_no} className="my-6 border-t border-[#dbe2ec] pt-5">
        {skill ? <>
          <h3 className="font-bold">评价点：{display.evaluationPoint}</h3>
          <h3 className="font-bold">试题{item.item_no}.{display.title}</h3>
          <h4>1.准备要求</h4>
          {[["（1）考场准备：", display.venuePreparation], ["（2）考生准备：", display.candidatePreparation]].map(([label, preparation]) => <div key={label} className="mb-4">
            <p>{label}</p><p>①试题名称：{display.title}</p><p>②本题分值：{Number(item.score)}分</p>
            <p>③考核时间：{display.time}</p><p>④考核形式：{display.method}</p><p>⑤{label.includes("考场") ? "设备设施准备" : "工具及其他准备"}：{preparation}</p>
          </div>)}
          <h4>2.考核试题</h4><p>（1）本题分值：{Number(item.score)}分</p><p>（2）考核时间：{display.time}</p><p>（3）考核形式：{display.method}</p>
          <p className="whitespace-pre-wrap">（4）具体考核要求：{display.requirements}</p><p>（5）否定项说明：{display.veto}</p>
        </> : <>
          {index === 0 || paper.items[index - 1].section_no !== item.section_no ? <>
            {kind === "paper" ? <p>得分：________　评分人：________</p> : null}
            <h3 className="font-bold">{sectionInstruction(paper.items.filter((value) => value.section_no === item.section_no), sections.indexOf(item.section_no) + 1)}</h3>
          </> : null}
          {kind === "paper" ? <p>{item.item_no}．{/判断/.test(item.question_type) ? "（　　）" : ""}{item.stem_snapshot}（{Number(item.score)}分）</p> : <h4>第{item.item_no}题 · {item.question_type} · {Number(item.score)}分</h4>}
        </>}
        {kind === "paper" ? <>
          {!skill && Array.isArray(data.options) ? data.options.map((value, optionIndex) => { const option = parseRecord(value); return <p key={optionIndex}>{String(option.key ?? "")}、{String(option.text ?? option.content ?? "")}</p>; }) : null}
          {!/选|判断/.test(item.question_type) ? <p className="min-h-[100px]">{skill ? "答题与成果提交：" : "答："}</p> : null}
        </> : <>
          {skill ? <>
            <h4>3.配分与评分标准</h4>
            <div className="overflow-x-auto"><table className="w-full min-w-[840px] border-collapse text-sm">
              <thead><tr>{["序号", "考核内容", "考核要点", "配分", "评分标准（细化可操作扣分标准）", "扣分", "得分"].map((label) => <th key={label} className="border border-black p-2 font-normal">{label}</th>)}</tr></thead>
              <tbody>{criteria.length ? criteria.map((criterion, rowIndex) => <tr key={rowIndex}>
                {[rowIndex + 1, criterion.item, criterion.points ?? "待核对（未单独保存考核要点）", criterion.score, criterion.standard, "", ""].map((value, column) => <td key={column} className="border border-black p-2">{String(value ?? "")}</td>)}
              </tr>) : <tr><td colSpan={7} className="border border-black p-2">未保存结构化评分标准，请核对题库评分标准。</td></tr>}
                <tr><td colSpan={3} className="border border-black p-2">合计</td><td className="border border-black p-2">{Number(item.score)}</td><td colSpan={3} className="border border-black p-2"/></tr>
                <tr><td colSpan={2} className="border border-black p-2">否定项</td><td colSpan={5} className="border border-black p-2">{display.veto}</td></tr>
              </tbody>
            </table></div>
            {typeof rubric.scalingNote === "string" ? <p className="text-sm">{rubric.scalingNote}</p> : null}
          </> : <p>评分标准：{rubric.criteria ? JSON.stringify(rubric.criteria) : /选|判断/.test(item.question_type) ? `答案完全正确得${Number(item.score)}分，错答、漏答不得分。` : JSON.stringify(item.score_rubric_snapshot_json ?? "未保存评分标准")}</p>}
          <p className="whitespace-pre-wrap">参考答案：{text || "未保存参考答案"}</p>
        </>}
      </article>;
    })}
    <p className="mt-8 text-center text-sm">试卷编码：{paper.paper_no}（网页预览非分页版，正式页码以Word为准）</p>
  </div>;
}
