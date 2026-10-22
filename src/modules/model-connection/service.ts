import type { RowDataPacket } from "mysql2";

import { query } from "@/shared/database/mysql";

type StoredConnection = RowDataPacket & {
  provider: string;
  base_url: string;
  model_name: string | null;
  api_key: string | null;
};

export type ModelConnectionInput = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
};

async function findStoredConnection() {
  const rows = await query<StoredConnection[]>(
    "SELECT provider, base_url, model_name, api_key FROM model_connection_settings WHERE id = 1 LIMIT 1"
  );
  return rows[0] ?? null;
}

export async function getModelConnectionSettings() {
  const row = await findStoredConnection();
  return row ? { provider: row.provider, baseUrl: row.base_url, model: row.model_name ?? "", hasApiKey: Boolean(row.api_key) } : null;
}

export async function getSavedModelConnection() {
  const row = await findStoredConnection();
  if (!row?.api_key || !row.model_name) return null;
  return { provider: row.provider, baseUrl: row.base_url, model: row.model_name, apiKey: row.api_key };
}

export async function saveModelConnectionSettings(input: ModelConnectionInput, actorId: string) {
  const current = await findStoredConnection();
  const apiKey = input.apiKey?.trim() || current?.api_key || "";
  if (!apiKey) throw new Error("首次保存请填写 API Key。");
  await query(
    `INSERT INTO model_connection_settings
       (id, provider, base_url, model_name, api_key, created_by, updated_by)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE provider = VALUES(provider), base_url = VALUES(base_url), model_name = VALUES(model_name),
       api_key = VALUES(api_key),
       updated_by = VALUES(updated_by)`,
    [input.provider, input.baseUrl, input.model || null, apiKey, actorId, actorId]
  );
  return { provider: input.provider, baseUrl: input.baseUrl, model: input.model, hasApiKey: true };
}

export async function resolveModelApiKey(providedKey?: string) {
  if (providedKey?.trim()) return providedKey.trim();
  const current = await findStoredConnection();
  return current?.api_key ?? "";
}
