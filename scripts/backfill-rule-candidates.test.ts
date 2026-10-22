// @vitest-environment node
import { describe, expect, it } from "vitest";

import { migratedDatabase } from "../test/d1-sqlite-shim";
import { backfillInsertStatements, planBackfill } from "./backfill-rule-candidates";

describe("历史意见回填候选规则", () => {
  it("只按指定题目生成待审批候选，过滤无效意见、合并相近意见，不写长期规则", async () => {
    const db = migratedDatabase();
    const insert = db.prepare("INSERT INTO grading_opinions (id, owner_id, body, change_request, scope, source_title, source_student_name, created_at, updated_at) VALUES (?, 'u1', ?, ?, ?, ?, ?, 1, 1)");
    insert.run("o1", "x", "第三段要写细节", "essay", "这件事打动了我", "小明");
    insert.run("o2", "x", "第三段要写细节。", "essay", "这件事打动了我", "小红");
    insert.run("o3", "x", "无", "essay", "这件事打动了我", "小刚");
    insert.run("o4", "x", "测试", "essay", "为自己鼓掌", "小刚");
    insert.run("o5", "x", "结尾回扣鼓掌", "essay", "为自己鼓掌", "小丽");
    insert.run("o6", "x", "别的题目", "essay", "珍贵的礼物", "小丽");
    insert.run("o7", "x", "开头点题", "standing", "为自己鼓掌", "");
    insert.run("o8", "x", "开头点题", "essay", "为自己鼓掌", "小丽");
    const execute = (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>>, changes: 0 });
    const plans = await planBackfill(execute);
    expect(plans.map((plan) => [plan.title, plan.create.map((item) => item.ruleText)])).toEqual([
      ["为自己鼓掌", ["结尾回扣鼓掌"]],
      ["这件事打动了我", ["第三段要写细节。"]],
    ]);
    const statements = backfillInsertStatements(plans, 5, () => "c");
    expect(statements).toHaveLength(2);
    expect(statements.every((sql) => sql.startsWith("INSERT INTO grading_rule_candidates") && sql.includes("'pending'"))).toBe(true);
    statements.forEach((sql) => db.exec(sql.replace("'c'", `'c${Math.random()}'`)));
    expect((db.prepare("SELECT count(*) AS n FROM grading_opinions WHERE scope = 'standing'").get() as { n: number }).n).toBe(1);
  });
});
