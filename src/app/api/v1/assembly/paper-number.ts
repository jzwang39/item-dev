export function assemblyPaperNumber(runId: string, paperIndex: number) {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(runId)) throw new Error("组卷执行标识无效。");
  if (!Number.isSafeInteger(paperIndex) || paperIndex < 1) throw new Error("试卷套数序号无效。");
  return `P-${runId}-${paperIndex}`;
}
