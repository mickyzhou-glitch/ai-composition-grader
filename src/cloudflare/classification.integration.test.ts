// @vitest-environment node
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initializeSchema } from "../db/init";
import { D1ReviewWriter } from "./d1-review-writer";
import { D1ReviewReader } from "./d1-review-reader";

describe("class persistence and tenant boundaries", () => {
  it("creates, updates, clears and lists classes without exposing another teacher", async () => {
    const sqlite = new Database(":memory:");
    initializeSchema(sqlite);
    for (const owner of ["teacher-1", "teacher-2"]) sqlite.prepare("INSERT INTO users VALUES (?, ?, 'hash', 'teacher', 0, NULL, 1, 1)").run(owner, owner);
    function prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      return { bind(...args: unknown[]) {
        return { async first() { return statement.get(...args) ?? null; }, async all() { return { results: statement.all(...args) }; }, async run() { return { meta: { changes: statement.run(...args).changes } }; } };
      } };
    }
    const database = { prepare, async batch(statements: Array<{ run: () => Promise<unknown> }>) { return Promise.all(statements.map((statement) => statement.run())); } } as unknown as D1Database;
    const writer = new D1ReviewWriter(database);
    const reader = new D1ReviewReader(database);
    const config = { title: "为自己鼓掌", grade: "六年级", writingRequirements: "叙事", targetCharacters: 600, structureRequirements: "完整", scoringFocus: "细节", templateType: "preset_self_applause" };
    try {
      const first = await writer.create("teacher-1", { config, className: " 六（1）班 " });
      await writer.create("teacher-2", { config, className: "其他老师的班级" });
      const legacy = await writer.create("teacher-1", { config });
      expect(await reader.classes("teacher-1")).toEqual(["六（1）班"]);
      expect(await reader.get("teacher-1", first.id)).toMatchObject({ className: "六（1）班" });
      expect(await reader.get("teacher-1", legacy.id)).toMatchObject({ className: "" });
      expect(await writer.update("teacher-2", first.id, { expectedRevision: 0, className: "越权" })).toBeNull();
      await writer.update("teacher-1", first.id, { expectedRevision: 0, className: "六（2）班" });
      await writer.update("teacher-1", first.id, { expectedRevision: 1, studentName: "小明" });
      expect(await reader.classes("teacher-1")).toEqual(["六（2）班"]);
      await expect(writer.update("teacher-1", first.id, { expectedRevision: 0, className: "旧版本" })).rejects.toThrow();
      await writer.update("teacher-1", first.id, { expectedRevision: 2, className: "" });
      expect(await reader.classes("teacher-1")).toEqual([]);
    } finally { sqlite.close(); }
  });
});
