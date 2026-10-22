// @vitest-environment node
import { describe, expect, it } from "vitest";

import { d1Shim, migratedDatabase } from "../../test/d1-sqlite-shim";
import { D1RuleCandidates } from "./d1-rule-candidates";
import { listD1StandingOpinions } from "./d1-grading-opinions";

function setup() {
  const db = migratedDatabase();
  let id = 0;
  const repo = new D1RuleCandidates(d1Shim(db), () => 1_000, () => `id-${++id}`);
  return { db, repo, d1: d1Shim(db) };
}

describe("D1RuleCandidates", () => {
  it("意见归纳成待审批候选，通过后写入同名题目的长期规则并立即生效", async () => {
    const { repo, d1 } = setup();
    await expect(repo.ingest("u1", "这件事打动了我", [
      { text: "第三段要写细节", studentName: "小明" },
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

  it("相近意见并入已有待审批候选；驳回后不导入", async () => {
    const { repo, d1 } = setup();
    await repo.ingest("u1", "为自己鼓掌", [{ text: "结尾要点题" }]);
    await expect(repo.ingest("u1", "为自己鼓掌", [{ text: "结尾要点题。" }])).resolves.toEqual({ created: 0, merged: 1 });
    const [candidate] = await repo.listPending("u1");
    expect(candidate!.sources).toHaveLength(2);
    await expect(repo.reject("u1", candidate!.id)).resolves.toBe(true);
    expect(await repo.countPending("u1")).toBe(0);
    expect(await listD1StandingOpinions(d1, "u1", "为自己鼓掌")).toEqual([]);
  });
});
