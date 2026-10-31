import type { RowDataPacket } from "mysql2/promise";
import { query } from "@/shared/database/mysql";
import { qualityStandardConfigs, qualityStandardContent, type QualityStandardKind } from "../quality-standard";

export type AppliedQualityStandard = {
  content: string; version: number | null; updatedAt: string | null; appliedAt: string;
  source: "saved" | "default"; kind: QualityStandardKind; settingKey: string;
};
export type AppliedSkillQualityStandard = AppliedQualityStandard;
type Setting = RowDataPacket & { setting_value_json: unknown; row_version: number; updated_at: Date | string };

export async function readGenerationQualityStandard(
  kind: QualityStandardKind,
  read: () => Promise<Setting[]> = () => query<Setting[]>(
    "SELECT setting_value_json,row_version,updated_at FROM system_settings WHERE setting_key=? LIMIT 1",
    [qualityStandardConfigs[kind].settingKey],
  ),
): Promise<AppliedQualityStandard> {
  // Do not cache or fall back to the initial job snapshot on read errors.
  const [setting] = await read();
  const content = qualityStandardContent(setting?.setting_value_json, "");
  return {
    kind, settingKey: qualityStandardConfigs[kind].settingKey,
    content: content || qualityStandardConfigs[kind].defaultContent,
    version: content ? Number(setting.row_version) : null,
    updatedAt: setting?.updated_at instanceof Date ? setting.updated_at.toISOString() : setting?.updated_at ?? null,
    appliedAt: new Date().toISOString(), source: content ? "saved" : "default",
  };
}

export function readSkillQualityStandard(read?: () => Promise<Setting[]>) {
  return readGenerationQualityStandard("skill", read);
}
