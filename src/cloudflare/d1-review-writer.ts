import { assignmentConfigSchema, studentNameSchema } from "../domain/contracts";

export class D1ReviewWriter {
  constructor(private readonly database: D1Database) {}

  async create(ownerId: string, input: { config: unknown; studentName?: unknown }): Promise<{ id: string; revision: number }> {
    const config = assignmentConfigSchema.parse(input.config);
    const studentName = studentNameSchema.parse(input.studentName ?? "");
    const id = crypto.randomUUID();
    const now = Date.now();
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, config, report, revision, analysis_run_id, pdf_filename, pdf_path, pdf_revision, exported_at, expires_at, deleting_at, privacy_consent_version, privacy_consented_at, created_at, updated_at)
        VALUES (?, ?, 'draft', ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).bind(id, ownerId, studentName, JSON.stringify(config), now, now),
    ];
    if (config.templateType === "custom") {
      statements.push(this.database.prepare(`
        INSERT INTO saved_assignments (id, owner_id, title, config, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, title) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at
      `).bind(crypto.randomUUID(), ownerId, config.title, JSON.stringify(config), now, now));
    }
    await this.database.batch(statements);
    return { id, revision: 0 };
  }

  async deleteSavedAssignment(ownerId: string, id: string): Promise<boolean> {
    const result = await this.database.prepare("DELETE FROM saved_assignments WHERE id = ? AND owner_id = ?").bind(id, ownerId).run();
    return result.meta.changes > 0;
  }
}
