// @vitest-environment node
import { describe, expect, it } from "vitest";

import { d1Shim, migratedDatabase } from "../../test/d1-sqlite-shim";
import { D1RuleCandidates } from "./d1-rule-candidates";
import { listD1StandingOpinions } from "./d1-grading-opinions";

function setup() {
  const db = migratedDatabase();
  db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u2', 'other-teacher', 'x', 'teacher', 0, 1, 1)").run();
  let id = 0;
  const repo = new D1RuleCandidates(d1Shim(db), () => 1_000, () => `id-${++id}`);
  return { db, repo, d1: d1Shim(db) };
}

describe("D1RuleCandidates", () => {
  it("原话生成待审批候选，通过后原样写入同名题目的长期规则", async () => {
    const { repo, d1 } = setup();
    await expect(repo.ingest("u1", "这件事打动了我", [
      { text: "第三段要写细节。", studentName: "小明" },
      { text: "第三段要写细节。", studentName: "小红" },
      { text: "无" },
    ])).resolves.toEqual({ created: 1, merged: 0 });
    expect(await repo.countPending("u1")).toBe(1);
    const [candidate] = await repo.listPending("u1");
    expect(candidate).toMatchObject({ title: "这件事打动了我", ruleText: "第三段要写细节。", status: "pending" });
    expect(candidate!.sources.map((item) => item.studentName)).toEqual(["小明", "小红"]);
    expect(await listD1StandingOpinions(d1, "u1", "这件事打动了我")).toEqual([]);

    await expect(repo.approve("u1", candidate!.id)).resolves.toBe(true);
    expect(await repo.countPending("u1")).toBe(0);
    expect((await listD1StandingOpinions(d1, "u1", "这件事打动了我")).map((item) => item.text)).toEqual(["第三段要写细节。"]);
    expect(await listD1StandingOpinions(d1, "u1", "为自己鼓掌")).toEqual([]);
    await expect(repo.approve("u1", candidate!.id)).resolves.toBe(false);

    // 提交的内容和已通过规则一模一样，不再生成候选。
    await expect(repo.ingest("u1", "这件事打动了我", [{ text: "第三段要写细节。" }])).resolves.toEqual({ created: 0, merged: 0 });
  });

  it("相同原话并入已有待审批候选；驳回后不导入", async () => {
    const { repo, d1 } = setup();
    await repo.ingest("u1", "为自己鼓掌", [{ text: "结尾要点题" }]);
    await expect(repo.ingest("u1", "为自己鼓掌", [{ text: "结尾要点题" }])).resolves.toEqual({ created: 0, merged: 1 });
    const [candidate] = await repo.listPending("u1");
    expect(candidate!.sources).toHaveLength(2);
    await expect(repo.reject("u1", candidate!.id)).resolves.toBe(true);
    expect(await repo.countPending("u1")).toBe(0);
    expect(await listD1StandingOpinions(d1, "u1", "为自己鼓掌")).toEqual([]);
  });

  it("历史 AI 候选展示所有不同原话，通过后每条原话分别入库且不截断", async () => {
    const { repo, db, d1 } = setup();
    const originals = ["第一段不合适，简单铺垫一下即可。", "第一段先铺垫，别急着点题！", "细节".repeat(650)];
    await repo.ingest("u1", "这件事打动了我", [{ text: originals[0] }]);
    const [candidate] = await repo.listPending("u1");
    db.prepare("UPDATE grading_rule_candidates SET rule_text = ?, sources = ? WHERE id = ?").run(
      "AI 改写：开头三句话以内。",
      JSON.stringify([...originals.map((text) => ({ text, studentName: "小明" })), { text: originals[0], studentName: "小红" }]),
      candidate!.id,
    );
    expect((await repo.listPending("u1"))[0]!.ruleText).toBe(originals.join("\n"));
    expect(await repo.countPending("u1")).toBe(1);
    expect(await repo.approve("u2", candidate!.id)).toBe(false);
    expect(await repo.approve("u1", candidate!.id)).toBe(true);
    const stored = (await listD1StandingOpinions(d1, "u1", "这件事打动了我")).map((item) => item.text);
    expect(stored.sort()).toEqual([...originals].sort());
    expect(await listD1StandingOpinions(d1, "u1", "为自己鼓掌")).toEqual([]);
    expect(await listD1StandingOpinions(d1, "u2", "这件事打动了我")).toEqual([]);
    expect(await repo.approve("u1", candidate!.id)).toBe(false);
    expect(await repo.countPending("u1")).toBe(0);
  });

  it("不同用户、不同题目各自保留候选，相近的原话不会合并", async () => {
    const { repo } = setup();
    await repo.ingest("u1", "题目一", [{ text: "开头要简单铺垫" }]);
    await repo.ingest("u1", "题目一", [{ text: "开头要简单铺垫。" }]);
    await repo.ingest("u1", "题目二", [{ text: "开头要简单铺垫" }]);
    await repo.ingest("u2", "题目一", [{ text: "开头要简单铺垫" }]);
    expect(await repo.countPending("u1")).toBe(3);
    expect(await repo.countPending("u2")).toBe(1);
  });

  it("审批只跳过同用户同题目的相同原话，各条规则使用自身的分类和段落", async () => {
    const { repo, db, d1 } = setup();
    const originals = ["第一段先铺垫。", "第一段先铺垫！", "语言  要通顺。\n保留语气！"];
    await repo.ingest("u1", "题目一", [{ text: originals[0] }]);
    const [candidate] = await repo.listPending("u1");
    db.prepare("UPDATE grading_rule_candidates SET rule_text = ?, sources = ? WHERE id = ?").run("旧 AI 改写", JSON.stringify(originals.map((text) => ({ text }))), candidate!.id);
    const insert = db.prepare("INSERT INTO grading_opinions (id, owner_id, body, change_request, scope, source_title, created_at, updated_at) VALUES (?, ?, ?, ?, 'standing', ?, 1, 1)");
    insert.run("existing", "u1", originals[0], originals[0], " 题目一 ");
    insert.run("other-owner", "u2", originals[1], originals[1], "题目一");
    insert.run("other-title", "u1", originals[2], originals[2], "题目二");

    expect(await repo.approve("u1", candidate!.id)).toBe(true);
    const stored = await listD1StandingOpinions(d1, "u1", "题目一");
    expect(stored.map((item) => item.text).sort()).toEqual([...originals].sort());
    expect(stored.find((item) => item.text === originals[1])).toMatchObject({ category: "结构", paragraphLabel: "第1段" });
    expect(stored.find((item) => item.text === originals[2])).toMatchObject({ category: "语言", paragraphLabel: null });
  });

  it.each(["[]", "not-json", JSON.stringify([null, { text: 7 }, { text: "  " }])])("无可用 sources 时仍可展示和通过旧规则：%s", async (sources) => {
    const { repo, db, d1 } = setup();
    const original = "第三段  写具体。\n" + "保留细节！".repeat(300);
    await repo.ingest("u1", "题目一", [{ text: "临时来源" }]);
    const [candidate] = await repo.listPending("u1");
    db.prepare("UPDATE grading_rule_candidates SET rule_text = ?, sources = ? WHERE id = ?").run(original, sources, candidate!.id);
    expect((await repo.listPending("u1"))[0]!.ruleText).toBe(original);
    expect(await repo.approve("u1", candidate!.id)).toBe(true);
    expect((await listD1StandingOpinions(d1, "u1", "题目一")).map((item) => item.text)).toEqual([original]);
  });

  it("新候选原文超出旧截断长度时仍完整保存", async () => {
    const { repo, db } = setup();
    const original = "细节".repeat(650) + "。\n保留  语气！";
    await repo.ingest("u1", "题目一", [{ text: original }]);
    const [candidate] = await repo.listPending("u1");
    expect(candidate!.ruleText).toBe(original);
    expect(db.prepare("SELECT rule_text FROM grading_rule_candidates WHERE id = ?").get(candidate!.id)).toEqual({ rule_text: original });
    expect(await repo.approve("u1", candidate!.id)).toBe(true);
    expect(db.prepare("SELECT body, change_request FROM grading_opinions WHERE owner_id = 'u1'").get()).toEqual({ body: original, change_request: original });
  });

  it("多条原话入库失败时整批回滚，候选保持待审批", async () => {
    const { repo, db, d1 } = setup();
    await repo.ingest("u1", "题目一", [{ text: "第一段铺垫" }]);
    const [candidate] = await repo.listPending("u1");
    db.prepare("UPDATE grading_rule_candidates SET sources = ? WHERE id = ?").run(JSON.stringify([{ text: "第一段铺垫" }, { text: "语言要通顺" }]), candidate!.id);
    db.exec("CREATE TRIGGER reject_second_original BEFORE INSERT ON grading_opinions WHEN NEW.change_request = '语言要通顺' BEGIN SELECT RAISE(ABORT, 'second_rule_failed'); END");
    await expect(repo.approve("u1", candidate!.id)).rejects.toThrow("second_rule_failed");
    expect(await repo.countPending("u1")).toBe(1);
    expect(await listD1StandingOpinions(d1, "u1", "题目一")).toEqual([]);
    expect(db.prepare("SELECT approved_opinion_id, decided_at FROM grading_rule_candidates WHERE id = ?").get(candidate!.id)).toEqual({ approved_opinion_id: null, decided_at: null });
  });

  it("并发审批同一候选仅成功一次", async () => {
    const { db, d1 } = setup();
    let queued: Promise<unknown> = Promise.resolve();
    const serializedD1 = {
      prepare: d1.prepare.bind(d1),
      batch: (statements: D1PreparedStatement[]) => {
        const result = queued.then(() => d1.batch(statements));
        queued = result.catch(() => undefined);
        return result;
      },
    } as D1Database;
    const repo = new D1RuleCandidates(serializedD1);
    await repo.ingest("u1", "题目一", [{ text: "第一段铺垫" }]);
    const [candidate] = await repo.listPending("u1");
    db.prepare("UPDATE grading_rule_candidates SET sources = ? WHERE id = ?").run(JSON.stringify([{ text: "第一段铺垫" }, { text: "语言要通顺" }]), candidate!.id);
    const outcomes = await Promise.all([repo.approve("u1", candidate!.id), repo.approve("u1", candidate!.id)]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect((await listD1StandingOpinions(d1, "u1", "题目一")).map((item) => item.text).sort()).toEqual(["第一段铺垫", "语言要通顺"]);
  });
});
