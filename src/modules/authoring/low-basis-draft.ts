export type LowBasisDraft = {
  mode: "title_only";
  pointName: string;
  titleContext: string;
  placeholderExcerpt: string;
  manualEvidenceExcerpt?: string;
  manualEvidenceCitation?: string;
  requiresManualEvidence: true;
  updatedAt?: string;
};

type SourceSnapshot = Record<string, unknown> & { lowBasisDraft?: LowBasisDraft };

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function parseSourceSnapshot(value: unknown): SourceSnapshot {
  if (typeof value === "string") {
    try { return asObject(JSON.parse(value)) as SourceSnapshot; }
    catch { return {}; }
  }
  return asObject(value) as SourceSnapshot;
}

export function buildLowBasisDraft(pointName: string, titleContext: string): LowBasisDraft {
  return {
    mode: "title_only",
    pointName,
    titleContext,
    placeholderExcerpt: titleContext,
    manualEvidenceExcerpt: "",
    manualEvidenceCitation: "",
    requiresManualEvidence: true,
  };
}

export function lowBasisDraftMeta(value: unknown) {
  const snapshot = parseSourceSnapshot(value);
  const draft = snapshot.lowBasisDraft;
  if (!draft || draft.mode !== "title_only") return undefined;
  return draft;
}

export function withLowBasisEvidence(
  value: unknown,
  input: { excerpt?: string; citation?: string },
) {
  const snapshot = parseSourceSnapshot(value);
  const draft = snapshot.lowBasisDraft;
  if (!draft || draft.mode !== "title_only") return snapshot;
  return {
    ...snapshot,
    lowBasisDraft: {
      ...draft,
      manualEvidenceExcerpt: input.excerpt?.trim() ?? draft.manualEvidenceExcerpt ?? "",
      manualEvidenceCitation: input.citation?.trim() ?? draft.manualEvidenceCitation ?? "",
      updatedAt: new Date().toISOString(),
    },
  } satisfies SourceSnapshot;
}

export function hasLowBasisEvidence(value: unknown) {
  const draft = lowBasisDraftMeta(value);
  if (!draft) return true;
  return Boolean(draft.manualEvidenceExcerpt?.trim());
}

export function assertLowBasisEvidence(value: unknown) {
  const draft = lowBasisDraftMeta(value);
  if (!draft) return;
  if (!draft.manualEvidenceExcerpt?.trim()) {
    throw new Error("标题相关草稿须先在人工审核时补充来源摘录后，方可确认或入库。");
  }
}
