export type RequestedQuota = { single: number; multiple: number; judgement: number };
export type Quota = RequestedQuota & { total: number; hint: string };

export function practicalQuota(requirement: string, requested: RequestedQuota & { practical?: number }) {
  if (requested.single + requested.multiple + requested.judgement > 0) {
    throw new Error("操作技能应按实操任务命题，不套用单选、多选、判断配额，请调整命题需求。");
  }
  const match = requirement.match(/每(?:个|一|项)?(?:考评点|鉴定点)[^，。；\n]{0,12}?(?:至少|不少于|生成|出)?\s*(\d+|[一二三四五六七八九十])\s*道(?:实操题|操作题|技能题|操作技能试题|题|试题)/);
  const count = match ? Number(match[1]) || "一二三四五六七八九十".indexOf(match[1]) + 1 : requested.practical || 1;
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("每鉴定点实操题数量须为1至100道。");
  return { practical: count, hint: `每鉴定点生成${count}道实操题，包含参考操作步骤和评分标准草稿，不套用理论题型配额。` };
}

export function mergeQuota(defaultQuota: Quota, requested: RequestedQuota): Quota {
  const hasRequestedQuota = requested.single + requested.multiple + requested.judgement > 0;
  const applied = hasRequestedQuota ? requested : defaultQuota;
  const total = applied.single + applied.multiple + applied.judgement;
  return {
    single: applied.single,
    multiple: applied.multiple,
    judgement: applied.judgement,
    total,
    hint: hasRequestedQuota
      ? `按本次需求，每考评点生成 ${applied.single} 道单选、${applied.multiple} 道多选、${applied.judgement} 道判断，共 ${total} 道；不额外补齐默认题量。`
      : defaultQuota.hint,
  };
}
