export type GenerationChapter = {
  id: string;
  ordinal: number;
  chapterTitle: string;
  sectionTitle: string | null;
  content: string;
};

export type ChapterExcerpt = {
  chapterId: string;
  title: string;
  content: string;
  start: number;
};

function cleanTitle(title: string) {
  return title.replace(/[\t .·…]+\d+\s*$/, "").trim();
}

export function selectRelevantChapters(chapters: GenerationChapter[], topic: string) {
  // DOCX contents pages can be parsed as duplicate sections. Prefer the full body.
  const unique = new Map<string, GenerationChapter>();
  for (const chapter of chapters) {
    const title = [cleanTitle(chapter.chapterTitle), cleanTitle(chapter.sectionTitle ?? "")].join("/");
    const previous = unique.get(title);
    if (!previous || previous.content.length < chapter.content.length) unique.set(title, chapter);
  }
  // These are umbrella scopes, not literal section titles. A passing mention in
  // one paragraph must not restrict the whole scope to that section.
  if (/^(?:基础知识|基本知识|理论知识|基础理论|相关知识)$/u.test(topic.trim())) {
    const sections = Array.from(unique.values()).sort((left, right) => left.ordinal - right.ordinal);
    // Professional ethics is a separate weight-table scope.
    const foundational = sections.filter((chapter) => !/职业道德|职业守则/u.test(`${chapter.chapterTitle} ${chapter.sectionTitle ?? ""}`));
    return foundational.length ? foundational : sections;
  }
  const stem = topic.replace(/(?:相关知识|基础知识|基本知识|知识|管理|要求|常识|宣讲|活动|募集)$/u, "");
  const terms = Array.from(new Set([topic, ...(stem.length >= 2 ? [stem] : [])]));
  const ranked = Array.from(unique.values()).map((chapter) => {
    const title = `${chapter.chapterTitle} ${chapter.sectionTitle ?? ""}`;
    let score = 0;
    for (const [index, term] of terms.entries()) {
      if (title.includes(term)) score += index === 0 ? 100 : 60;
      // Inspect the entire section, not just the first 1,500 characters.
      score += Math.min(chapter.content.split(term).length - 1, 10) * (index === 0 ? 2 : 1);
    }
    return { chapter, score };
  }).sort((left, right) => right.score - left.score || left.chapter.ordinal - right.chapter.ordinal);
  const threshold = ranked.some(({ score }) => score >= 60) ? 60 : 1;
  const matched = ranked.filter(({ score }) => score >= threshold);
  return (matched.length ? matched : ranked).map(({ chapter }) => chapter);
}

function splitChapter(chapter: GenerationChapter): ChapterExcerpt[] {
  const excerpts: ChapterExcerpt[] = [];
  let start = 0;
  while (start < chapter.content.length) {
    const limit = Math.min(start + 3000, chapter.content.length);
    const newline = chapter.content.lastIndexOf("\n", limit);
    const end = limit < chapter.content.length && newline > start + 1500 ? newline + 1 : limit;
    excerpts.push({
      chapterId: chapter.id,
      title: [cleanTitle(chapter.chapterTitle), cleanTitle(chapter.sectionTitle ?? "")].filter(Boolean).join(" / "),
      content: chapter.content.slice(start, end),
      start,
    });
    start = end;
  }
  return excerpts;
}

export function buildChapterExcerptPool(chapters: GenerationChapter[], topic: string) {
  const sections = selectRelevantChapters(chapters, topic).map(splitChapter);
  const pool: ChapterExcerpt[] = [];
  // Interleave sections so earlier batches do not consume one section exclusively.
  for (let index = 0; index < Math.max(0, ...sections.map((section) => section.length)); index += 1) {
    for (const section of sections) {
      if (section[index]) pool.push(section[index]);
    }
  }
  return pool;
}

export function selectBatchExcerpts(pool: ChapterExcerpt[], batchIndex: number, batchCount: number, attempt: number) {
  if (!pool.length) return [];
  const start = Math.floor(batchIndex * pool.length / batchCount) + (attempt - 1) * 3;
  return Array.from({ length: Math.min(3, pool.length) }, (_, index) => pool[(start + index) % pool.length]);
}
