// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { d1Shim, migratedDatabase } from "../test/d1-sqlite-shim";
import { D1Reanalysis } from "../src/cloudflare/d1-reanalysis";
import { D1RuleCandidates } from "../src/cloudflare/d1-rule-candidates";
import type { WorkerEnv } from "../src/cloudflare/env";
import worker from "./index";

function setup() {
  const db = migratedDatabase();
  const d1 = d1Shim(db);
  db.prepare("INSERT INTO sessions (id, user_id, token_hash, last_seen_at, expires_at, created_at) VALUES ('session-1', 'u1', ?, 1, ?, 1)").run(
    createHash("sha256").update("session-token").digest("hex"), Date.now() + 60_000,
  );
  db.prepare("INSERT INTO reviews (id, owner_id, status, student_name, config, revision, created_at, updated_at) VALUES ('review-1', 'u1', 'ready_for_review', '小明', ?, 1, 1, 1)").run(JSON.stringify({
    title: "题目一", grade: "六年级", writingRequirements: "写一件事。", targetCharacters: 600,
    structureRequirements: "五段", scoringFocus: "内容具体。", templateType: "custom", sampleParagraphCount: 5,
  }));
  db.prepare("INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at) VALUES ('review-1', 0, 'test.jpg', 0, 'test.jpg', 'image/jpeg', 'test.jpg', 'test.jpg', 'test.jpg', 100, 100, 0, 1)").run();
  const env = { DB: d1, ANALYSIS_QUEUE: { send: vi.fn().mockResolvedValue(undefined) } } as unknown as WorkerEnv;
  const request = (pathname: string, body?: unknown) => new Request(`https://grader.workers.dev${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { cookie: "__Host-zuowen_session=session-token", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { db, d1, env, request, repo: new D1RuleCandidates(d1) };
}

function stubRevisionJob() {
  vi.spyOn(D1Reanalysis.prototype, "requestRevision").mockResolvedValue({
    newlyQueued: true,
    job: {
      id: "job-1", reviewId: "review-1", mode: "content_only", status: "queued", progressStage: "queued",
      message: null, createdAt: new Date(1_000).toISOString(), finishedAt: null,
    },
  });
}

describe("Worker 原话候选规则", () => {
  afterEach(() => vi.restoreAllMocks());

  it("没有 AI 凭据也会采集完整共性意见，保留换行并排除第二框", async () => {
    const { env, request, repo } = setup();
    stubRevisionJob();
    const text = "  第一段简单铺垫。\n第三段  写出细节！ \n";
    const response = await worker.fetch(request("/api/reviews/review-1/revision-request", {
      expectedRevision: 1, commonIssue: text, contentSuggestion: "把主人公改成爸爸。",
    }), env);
    expect(response.status).toBe(202);
    const pending = await repo.listPending("u1");
    expect(pending.map((item) => item.ruleText)).toEqual([text]);
    expect(pending[0]!.sources).toEqual([{ text, reviewId: "review-1", studentName: "小明", kind: "revision" }]);
  });

  it("仅填写第二框不会创建候选规则", async () => {
    const { env, request, repo } = setup();
    stubRevisionJob();
    const response = await worker.fetch(request("/api/reviews/review-1/revision-request", {
      expectedRevision: 1, commonIssue: "", contentSuggestion: "第三段写出和爸爸的对话。",
    }), env);
    expect(response.status).toBe(202);
    expect(await repo.countPending("u1")).toBe(0);
  });

  it("退回仅收第一框完整原话，第二框仍保留在单篇作文", async () => {
    const { db, env, request, repo } = setup();
    const reason = "  第一段简单铺垫。\n第三段  写出细节！ \n";
    const changeRequest = "把主人公改成爸爸。";
    const response = await worker.fetch(request("/api/reviews/review-1/reject", {
      expectedRevision: 1, reason, changeRequest,
    }), env);
    expect(response.status).toBe(200);
    const pending = await repo.listPending("u1");
    expect(pending.map((item) => item.ruleText)).toEqual([reason]);
    expect(pending[0]!.sources).toEqual([{ text: reason, reviewId: "review-1", studentName: "小明", kind: "rejection" }]);
    expect(db.prepare("SELECT rejection_change_request FROM reviews WHERE id = 'review-1'").get()).toEqual({
      rejection_change_request: changeRequest,
    });
  });

  it("退回仅填写第二框也不会创建候选规则", async () => {
    const { env, request, repo } = setup();
    const response = await worker.fetch(request("/api/reviews/review-1/reject", {
      expectedRevision: 1, reason: " \n", changeRequest: "第三段写出细节。",
    }), env);
    expect(response.status).toBe(200);
    expect(await repo.countPending("u1")).toBe(0);
  });

  it("已配置内容模型时也不调用 AI 改写原话", async () => {
    const { db, env, request, repo } = setup();
    stubRevisionJob();
    env.CONTENT_AI_API_KEY = "test-only-key";
    db.prepare("INSERT OR REPLACE INTO settings (role, base_url, model, updated_at) VALUES ('content', 'https://ai.example.test/v1', 'test-model', 1)").run();
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ rules: ["AI 改写，限定三句话"] }) }, finish_reason: "stop" }],
    }), { headers: { "content-type": "application/json" } }));
    const response = await worker.fetch(request("/api/reviews/review-1/revision-request", {
      expectedRevision: 1, commonIssue: "第一段简单铺垫即可。", contentSuggestion: "",
    }), env);
    expect(response.status).toBe(202);
    expect(upstream).not.toHaveBeenCalled();
    expect((await repo.listPending("u1")).map((item) => item.ruleText)).toEqual(["第一段简单铺垫即可。"]);
  });

  it("审批忽略请求附带的改写内容，按历史来源原话分别入库", async () => {
    const { db, env, request, repo } = setup();
    const texts = ["开头简单铺垫。", "第三段写细节！"];
    await repo.ingest("u1", "题目一", [{ text: texts[0] }]);
    const [candidate] = await repo.listPending("u1");
    db.prepare("UPDATE grading_rule_candidates SET rule_text = ?, sources = ? WHERE id = ?").run("旧 AI 归纳", JSON.stringify(texts.map((text) => ({ text }))), candidate!.id);
    const listing = await worker.fetch(request("/api/rule-candidates"), env);
    await expect(listing.json()).resolves.toMatchObject({ ok: true, data: [{ ruleText: texts.join("\n") }] });
    const response = await worker.fetch(request(`/api/rule-candidates/${candidate!.id}/approve`, { ruleText: "请求中的改写" }), env);
    expect(response.status).toBe(200);
    expect(db.prepare("SELECT change_request FROM grading_opinions WHERE owner_id = 'u1' ORDER BY change_request").all()).toEqual(
      [...texts].sort().map((change_request) => ({ change_request })),
    );
  });
});
