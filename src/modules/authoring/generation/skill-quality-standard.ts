import type { RowDataPacket } from "mysql2/promise";
import { query } from "@/shared/database/mysql";
import { qualityStandardConfigs, qualityStandardContent } from "../quality-standard";

export type AppliedSkillQualityStandard = {
  content: string; version: number | null; updatedAt: string | null; appliedAt: string;
  source: "saved" | "default";
};
type Setting = RowDataPacket & { setting_value_json: unknown; row_version: number; updated_at: Date | string };

export async function readSkillQualityStandard(
  read: () => Promise<Setting[]> = () => query<Setting[]>(
    "SELECT setting_value_json,row_version,updated_at FROM system_settings WHERE setting_key=? LIMIT 1",
    [qualityStandardConfigs.skill.settingKey],
  ),
): Promise<AppliedSkillQualityStandard> {
  // Do not cache or fall back to the initial job snapshot on read errors.
  const [setting] = await read();
  const content = qualityStandardContent(setting?.setting_value_json, "");
  return {
    content: content || qualityStandardConfigs.skill.defaultContent,
    version: content ? Number(setting.row_version) : null,
    updatedAt: setting?.updated_at instanceof Date ? setting.updated_at.toISOString() : setting?.updated_at ?? null,
    appliedAt: new Date().toISOString(), source: content ? "saved" : "default",
  };
}
