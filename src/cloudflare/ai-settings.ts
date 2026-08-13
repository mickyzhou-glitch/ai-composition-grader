import type { AiModelRole } from "../settings/settings-repository";
import type { RuntimeSettings } from "../settings/settings-service";
import { openSetting } from "./settings-secret";

interface ConfigEnv {
  DB: D1Database;
  AUTH_PROOF_ENCRYPTION_KEY: string;
  VISION_AI_API_KEY?: string;
  CONTENT_AI_API_KEY?: string;
  AI_API_KEY?: string;
}

interface ConfigRow {
  base_url: string;
  model: string;
  encrypted_api_key: string | null;
}

export async function configuredApiKey(input: {
  encryptedApiKey: string | null;
  roleApiKey?: string;
  legacyApiKey?: string;
  encryptionKey: string;
  open?: typeof openSetting;
}): Promise<string | null> {
  if (input.encryptedApiKey) {
    return (input.open ?? openSetting)(input.encryptedApiKey, input.encryptionKey);
  }
  return input.roleApiKey || input.legacyApiKey || null;
}

export interface WorkerAiSettingsSource {
  getRuntimeConfig(role?: AiModelRole): Promise<RuntimeSettings | null>;
}

export function createWorkerAiSettingsSource(env: ConfigEnv): WorkerAiSettingsSource {
  return {
    async getRuntimeConfig(role: AiModelRole = "content") {
      const settings = await env.DB.prepare(
        "SELECT base_url, model, encrypted_api_key FROM settings WHERE role = ?",
      ).bind(role).first<ConfigRow>();
      if (!settings) return null;
      const apiKey = await configuredApiKey({
        encryptedApiKey: settings.encrypted_api_key,
        roleApiKey: role === "vision" ? env.VISION_AI_API_KEY : env.CONTENT_AI_API_KEY,
        legacyApiKey: env.AI_API_KEY,
        encryptionKey: env.AUTH_PROOF_ENCRYPTION_KEY,
      });
      return apiKey ? {
        baseUrl: settings.base_url,
        model: settings.model,
        apiKey,
      } : null;
    },
  };
}
