import {
  cleanSingleStudentName,
  codePointLength,
  deduplicateStudentNames,
  deleteClassRosterNameSchema,
  MAX_ROSTER_CLASSES_PER_OWNER,
  MAX_ROSTER_STUDENT_NAME_CHARS,
  MAX_ROSTER_STUDENTS_PER_CLASS,
  upsertClassRostersInputSchema,
  type ClassRosterView,
} from "../domain/class-roster";

export class ClassRosterValidationError extends Error {
  readonly code = "ROSTER_VALIDATION_ERROR";
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "ClassRosterValidationError";
  }
}

interface ClassRosterRow {
  class_name: string;
  students: string;
  updated_at: number;
}

function isMissingClassRostersTableError(error: unknown): boolean {
  return error instanceof Error && /no such table:\s*class_rosters/iu.test(error.message);
}

function parseStoredStudents(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const safeItems = parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => cleanSingleStudentName(item))
      .filter((item) => item.length > 0 && codePointLength(item) <= MAX_ROSTER_STUDENT_NAME_CHARS);
    return deduplicateStudentNames(safeItems).students.slice(0, MAX_ROSTER_STUDENTS_PER_CLASS);
  } catch {
    return [];
  }
}

export class D1ClassRosters {
  constructor(private readonly database: D1Database) {}

  async list(ownerId: string): Promise<ClassRosterView[]> {
    try {
      const { results = [] } = await this.database.prepare(`
        SELECT class_name, students, updated_at
        FROM class_rosters
        WHERE owner_id = ?
      `).bind(ownerId).all<ClassRosterRow>();

      return results
        .map((row) => ({
          className: row.class_name,
          students: parseStoredStudents(row.students),
          updatedAt: new Date(row.updated_at).toISOString(),
        }))
        .filter((item) => item.className.trim().length > 0)
        .sort((left, right) => left.className.localeCompare(right.className, "zh-CN", { numeric: true }));
    } catch (error) {
      if (isMissingClassRostersTableError(error)) {
        return [];
      }
      throw error;
    }
  }

  async classNames(ownerId: string): Promise<string[]> {
    try {
      const { results = [] } = await this.database.prepare(`
        SELECT class_name
        FROM class_rosters
        WHERE owner_id = ? AND class_name <> ''
      `).bind(ownerId).all<{ class_name: string }>();
      return results.map((row) => row.class_name);
    } catch (error) {
      if (isMissingClassRostersTableError(error)) {
        return [];
      }
      throw error;
    }
  }

  async upsert(ownerId: string, rawInput: unknown): Promise<ClassRosterView[]> {
    const parsed = upsertClassRostersInputSchema.parse(rawInput);

    // 合并同一次请求中出现的相同班级
    const incomingByClass = new Map<string, string[]>();
    for (const entry of parsed.rosters) {
      const prev = incomingByClass.get(entry.className) ?? [];
      incomingByClass.set(entry.className, [...prev, ...entry.students]);
    }

    const existingList = await this.list(ownerId);
    const existingByClass = new Map(existingList.map((item) => [item.className, item.students]));

    const finalEntries: Array<{ className: string; students: string[] }> = [];
    for (const [className, incomingStudents] of incomingByClass.entries()) {
      const baseStudents = parsed.mode === "append" ? (existingByClass.get(className) ?? []) : [];
      const merged = deduplicateStudentNames([...baseStudents, ...incomingStudents]).students;
      if (merged.length === 0) {
        throw new ClassRosterValidationError(`「${className}」至少需要保留 1 名有效学生姓名`);
      }
      if (merged.length > MAX_ROSTER_STUDENTS_PER_CLASS) {
        throw new ClassRosterValidationError(
          `「${className}」合并后共有 ${merged.length} 人，超过单班上限 ${MAX_ROSTER_STUDENTS_PER_CLASS} 人`,
        );
      }
      finalEntries.push({ className, students: merged });
    }

    const projectedClasses = new Set(existingByClass.keys());
    for (const entry of finalEntries) {
      projectedClasses.add(entry.className);
    }
    if (projectedClasses.size > MAX_ROSTER_CLASSES_PER_OWNER) {
      throw new ClassRosterValidationError(`最多支持保存 ${MAX_ROSTER_CLASSES_PER_OWNER} 个班级名单`);
    }

    const now = Date.now();
    const statements = finalEntries.map((entry) =>
      this.database.prepare(`
        INSERT INTO class_rosters (id, owner_id, class_name, students, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, class_name) DO UPDATE SET
          students = excluded.students,
          updated_at = excluded.updated_at
      `).bind(
        crypto.randomUUID(),
        ownerId,
        entry.className,
        JSON.stringify(entry.students),
        now,
        now,
      ),
    );

    if (statements.length > 0) {
      await this.database.batch(statements);
    }

    return this.list(ownerId);
  }

  async delete(ownerId: string, rawClassName: unknown): Promise<boolean> {
    const className = deleteClassRosterNameSchema.parse(rawClassName);
    const result = await this.database.prepare(`
      DELETE FROM class_rosters
      WHERE owner_id = ? AND class_name = ?
    `).bind(ownerId, className).run();
    return (result.meta?.changes ?? 0) > 0;
  }
}
