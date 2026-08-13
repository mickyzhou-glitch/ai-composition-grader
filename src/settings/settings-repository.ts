import { eq } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { settings } from "../db/schema";

export type AiModelRole = "vision" | "content";

export interface StoredSettings {
  role: AiModelRole;
  baseUrl: string;
  model: string;
  updatedAt: Date;
}

export interface SaveSettingsInput {
  baseUrl: string;
  model: string;
}

export class SettingsRepository {
  constructor(
    private readonly database: AppDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(role: AiModelRole = "content"): StoredSettings | null {
    const row = this.database
      .select()
      .from(settings)
      .where(eq(settings.role, role))
      .get();
    if (!row) return null;
    return {
      role: row.role,
      baseUrl: row.baseUrl,
      model: row.model,
      updatedAt: row.updatedAt,
    };
  }

  save(input: SaveSettingsInput, role: AiModelRole = "content"): StoredSettings {
    const updatedAt = this.now();
    this.database
      .insert(settings)
      .values({ role, ...input, updatedAt })
      .onConflictDoUpdate({
        target: settings.role,
        set: { ...input, updatedAt },
      })
      .run();
    return this.get(role) as StoredSettings;
  }
}
