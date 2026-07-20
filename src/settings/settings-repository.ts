import { eq } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { settings } from "../db/schema";

export interface StoredSettings {
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

  get(): StoredSettings | null {
    const row = this.database
      .select()
      .from(settings)
      .where(eq(settings.id, 1))
      .get();
    if (!row) return null;
    return {
      baseUrl: row.baseUrl,
      model: row.model,
      updatedAt: row.updatedAt,
    };
  }

  save(input: SaveSettingsInput): StoredSettings {
    const updatedAt = this.now();
    this.database
      .insert(settings)
      .values({ id: 1, ...input, updatedAt })
      .onConflictDoUpdate({
        target: settings.id,
        set: { ...input, updatedAt },
      })
      .run();
    return this.get() as StoredSettings;
  }
}

