import { createHash } from "node:crypto";
import type { AngleSource } from "./retry-policy";

export type EvidenceChapter = {
  id: string;
  chapter_title: string;
  section_title: string | null;
  content_text: string;
  source_type?: "textbook" | "standard";
};
export const EVIDENCE_PAGE_SIZE = 6;

export function factualTheorySources(sources: AngleSource[]) {
  return sources.filter((source) => {
    const text = source.content.trim();
    // A section heading identifies scope, not a factual proposition.
    return text.length >= 80 || /[。！？；;!?]/u.test(text.replace(/^\d+(?:\.\d+)*\s*/, ""));
  });
}

function referenceId(prefix: string, content: string) {
  return `${prefix}:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

export function buildEvidenceCatalog(context: unknown, chapters: EvidenceChapter[], topic: string): AngleSource[] {
  const sources: AngleSource[] = [];
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /^(evidence|standardText|standardRequirement)$/.test(key) && child.trim()) {
        for (let start = 0; start < child.length; start += 1200) {
          const content = child.slice(start, start + 1500);
          if (!content.trim()) continue;
          sources.push({ id: referenceId(`${path}.${key}:${start}`, content), content, systemQuote: true, sourceKind: "standard" });
        }
      } else if (child && typeof child === "object") visit(child, `${path}.${key}`);
    }
  };
  visit(context, "standard");
  // Inspect every chapter linked by the frozen point. Ranking affects order,
  // never removes chapters or expands to other points/source versions.
  for (const chapter of chapters) {
    const sourceKind = chapter.source_type ?? "textbook";
    const prefix = sourceKind === "standard" ? "standard" : "textbook";
    for (let start = 0; start < chapter.content_text.length; start += 1200) {
      const content = chapter.content_text.slice(start, start + 1500);
      if (!content.trim()) continue;
      sources.push({ id: referenceId(`${prefix}:${chapter.id}:${start}`, content), content,
        title: [chapter.chapter_title, chapter.section_title].filter(Boolean).join(" / "), start, systemQuote: true, sourceKind });
    }
  }
  const terms = topic.split(/[\s、，；：/]+/u).filter((term) => term.length >= 2);
  const score = (source: AngleSource) => terms.reduce((sum, term) =>
    sum + (source.title?.includes(term) ? 10 : 0) + Math.min(5, source.content.split(term).length - 1), 0);
  return [...new Map(sources.map((source) => [source.id, source])).values()].sort((a, b) => score(b) - score(a));
}

export function nextEvidencePage(sources: AngleSource[], searched: string[]) {
  const seen = new Set(searched);
  return sources.filter((source) => !seen.has(source.id)).slice(0, EVIDENCE_PAGE_SIZE);
}
