// @vitest-environment node
import { describe, expect, it } from "vitest";

import { migratedDatabase } from "../test/d1-sqlite-shim";
import { backfillInsertStatements, isGeneralOpinion, planBackfill, planBackfillSince, revisionSections } from "./backfill-rule-candidates";

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

  it("--since 只收界点之后：第一栏全收，第二栏只收通用句子，已生效规则不重复，相近意见合并", async () => {
    const db = migratedDatabase();
    db.prepare("INSERT INTO reviews (id, owner_id, status, student_name, config, revision, created_at, updated_at) VALUES ('r1', 'u1', 'ready_for_review', '小明', ?, 1, 1, 1)").run(JSON.stringify({ title: "这件事打动了我", grade: "六年级", writingRequirements: "写一件事。", targetCharacters: 600, structureRequirements: "五段", scoringFocus: "内容具体。", templateType: "custom", sampleParagraphCount: 5 }));
    const job = db.prepare("INSERT INTO analysis_jobs (id, review_id, owner_id, mode, status, attempt, available_at, progress_stage, teacher_guidance, created_at) VALUES (?, 'r1', 'u1', 'full', 'succeeded', 0, 1, 'saving_result', ?, ?)");
    const tail = "\n\n以下是这位老师存档的长期批改要求，已按题目归纳成规则清单。\n【结构】\n1. 旧规则不应被收";
    job.run("j0", "[结构问题 / 共性问题]\n界点之前的意见", 100);
    job.run("j1", `[结构问题 / 共性问题]\n开头用名人名言\n[内容建议]\n把主角改成张阿姨；第一段简单铺垫即可${tail}`, 2000);
    job.run("j2", "[结构问题 / 共性问题]\n名人名言不合适，换一个\n[内容建议]\n无", 3000);
    job.run("j3", "[结构问题 / 共性问题]\n名人名言不合适，重新换一个", 4000);
    db.prepare("INSERT INTO grading_opinions (id, owner_id, body, change_request, scope, source_title, created_at, updated_at) VALUES ('s1', 'u1', 'x', '开头用名人名言', 'standing', '这件事打动了我', 2000, 2000)").run();
    const execute = (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>>, changes: 0 });
    const [plan] = await planBackfillSince(execute, 1000);
    expect(plan!.create.map((item) => [item.ruleText, item.sources.length])).toEqual([
      ["第一段简单铺垫即可", 1],
      ["名人名言不合适，重新换一个", 2],
    ]);
  });

  it("revisionSections 只取本次两栏，不含附带的规则清单", () => {
    expect(revisionSections("[结构问题 / 共性问题]\nA\n[内容建议]\nB\n\n以下是这位老师存档的长期批改要求\nC")).toEqual({ common: "A", content: "B" });
    expect(isGeneralOpinion("第一段用名人名言")).toBe(true);
    expect(isGeneralOpinion("他写的是金老师")).toBe(false);
  });
});
