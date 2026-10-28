import type { LegalConfig } from "@/modules/authoring/legal-contracts";

export function hasLegalSourceConfig(topic: LegalConfig): boolean {
  return [topic.documentTitle, topic.documentVersion, topic.effectiveDate, topic.sourceUrl, topic.fullText]
    .every((value) => Boolean(value.trim()));
}

export function legalSourceStatus(topic: LegalConfig): string {
  if (topic.confirmed) return "原文已核验";
  return hasLegalSourceConfig(topic) ? "已配置，待确认核验" : "待配置原文";
}
