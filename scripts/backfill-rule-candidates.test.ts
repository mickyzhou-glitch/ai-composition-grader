// @vitest-environment node
import { describe, expect, it } from "vitest";

import { migratedDatabase } from "../test/d1-sqlite-shim";
import { backfillInsertStatements, isGeneralOpinion, planBackfill, planBackfillSince, revisionSections } from "./backfill-rule-candidates";

describe("历史意见回填候选规则", () => {
  it("只按指定题目生成原话候选，过滤无效意见、保留标点差异，不写长期规则", async () => {
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
      ["这件事打动了我", ["第三段要写细节", "第三段要写细节。"]],
    ]);
    const statements = backfillInsertStatements(plans, 5, () => "c");
    expect(statements).toHaveLength(3);
    expect(statements.every((sql) => sql.startsWith("INSERT INTO grading_rule_candidates") && sql.includes("'pending'"))).toBe(true);
    statements.forEach((sql) => db.exec(sql.replace("'c'", `'c${Math.random()}'`)));
    expect((db.prepare("SELECT count(*) AS n FROM grading_opinions WHERE scope = 'standing'").get() as { n: number }).n).toBe(1);
  });

  it("--since 按完整字段保留原话，已生效的精确原文不重复，相近意见分别保留", async () => {
    const db = migratedDatabase();
    db.prepare("INSERT INTO reviews (id, owner_id, status, student_name, config, revision, created_at, updated_at) VALUES ('r1', 'u1', 'ready_for_review', '小明', ?, 1, 1, 1)").run(JSON.stringify({ title: "这件事打动了我", grade: "六年级", writingRequirements: "写一件事。", targetCharacters: 600, structureRequirements: "五段", scoringFocus: "内容具体。", templateType: "custom", sampleParagraphCount: 5 }));
    const job = db.prepare("INSERT INTO analysis_jobs (id, review_id, owner_id, mode, status, attempt, available_at, progress_stage, teacher_guidance, created_at) VALUES (?, 'r1', 'u1', 'full', 'succeeded', 0, 1, 'saving_result', ?, ?)");
    const tail = "\n\n以下是这位老师存档的长期批改要求，已按题目归纳成规则清单。\n【结构】\n1. 旧规则不应被收";
    job.run("j0", "[结构问题 / 共性问题]\n界点之前的意见", 100);
    job.run("j1", `[结构问题 / 共性问题]\n开头用名人名言\n[内容建议]\n把主角改成张阿姨；第一段简单铺垫即可${tail}`, 2000);
    job.run("j2", "[结构问题 / 共性问题]\n名人名言不合适，换一个\n[内容建议]\n无", 3000);
    job.run("j3", "[结构问题 / 共性问题]\n名人名言不合适，重新换一个", 4000);
    job.run("j4", "[结构问题 / 共性问题]\n第一段简单铺垫即可。\n第二段  写过程；保留语气！\n[内容建议]\n语言自然，避免长句。", 5000);
    db.prepare("INSERT INTO grading_opinions (id, owner_id, body, change_request, scope, source_title, created_at, updated_at) VALUES ('s1', 'u1', 'x', '开头用名人名言', 'standing', '这件事打动了我', 2000, 2000)").run();
    const execute = (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>>, changes: 0 });
    const [plan] = await planBackfillSince(execute, 1000);
    expect(plan!.create.map((item) => [item.ruleText, item.sources.length])).toEqual([
      ["名人名言不合适，换一个", 1],
      ["名人名言不合适，重新换一个", 1],
      ["第一段简单铺垫即可。\n第二段  写过程；保留语气！", 1],
      ["语言自然，避免长句。", 1],
    ]);
  });

  it("存档中的多行原话完整保留，历史候选只跳过相同来源文本", async () => {
    const db = migratedDatabase();
    const text = "第一段铺垫。\n第二段  写具体；保留语气！";
    const insert = db.prepare("INSERT INTO grading_opinions (id, owner_id, body, change_request, scope, source_title, created_at, updated_at) VALUES (?, 'u1', ?, ?, 'essay', '这件事打动了我', 1, 1)");
    insert.run("a", text, text);
    insert.run("b", "第一段铺垫。", "第一段铺垫。");
    insert.run("c", "第一段铺垫！", "第一段铺垫！");
    db.prepare("INSERT INTO grading_rule_candidates (id, owner_id, source_title, rule_text, sources, created_at, updated_at) VALUES ('c1', 'u1', '这件事打动了我', '旧 AI 归纳', ?, 1, 1)").run(JSON.stringify([{ text: "第一段铺垫。" }]));
    const execute = (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>>, changes: 0 });
    const [plan] = await planBackfill(execute);
    expect(plan!.create.map((item) => item.ruleText)).toEqual([text, "第一段铺垫！"]);
    expect(plan!.skipped).toBe(1);
  });

  it.each(["not-json", "{}", JSON.stringify([null, { text: 7 }])])("历史来源不可用时按原 ruleText 去重，离线规划不会报错：%s", async (sources) => {
    const db = migratedDatabase();
    db.prepare("INSERT INTO grading_opinions (id, owner_id, body, change_request, scope, source_title, created_at, updated_at) VALUES ('o1', 'u1', '第一段铺垫。', '第一段铺垫。', 'essay', '这件事打动了我', 1, 1)").run();
    db.prepare("INSERT INTO grading_rule_candidates (id, owner_id, source_title, rule_text, sources, created_at, updated_at) VALUES ('c1', 'u1', '这件事打动了我', '第一段铺垫。', ?, 1, 1)").run(sources);
    const execute = (sql: string) => ({ rows: db.prepare(sql).all() as Array<Record<string, unknown>>, changes: 0 });
    const [plan] = await planBackfill(execute);
    expect(plan).toMatchObject({ inspected: 1, create: [], skipped: 1 });
    expect(db.prepare("SELECT sources FROM grading_rule_candidates WHERE id = 'c1'").get()).toEqual({ sources });
  });

  it("revisionSections 只取本次两栏，不含附带的规则清单", () => {
    expect(revisionSections("[结构问题 / 共性问题]\nA\n[内容建议]\nB\n\n以下是这位老师存档的长期批改要求\nC")).toEqual({ common: "A", content: "B" });
    expect(isGeneralOpinion("第一段用名人名言")).toBe(true);
    expect(isGeneralOpinion("他写的是金老师")).toBe(false);
  });
});
