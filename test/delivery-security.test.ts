// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliveryDocument } from "../src/delivery/contracts";
import { CompositionReviewAdapter } from "../src/ai/composition-review-adapter";
import { D1Reanalysis } from "../src/cloudflare/d1-reanalysis";
import { D1ReviewReader } from "../src/cloudflare/d1-review-reader";
import { publicOcrView } from "../src/ocr/contracts";
import worker from "../worker/index";
import { createReviewDocx } from "../app/lib/docx-download";
import { paginateDeliveryDocument } from "../app/lib/delivery-pagination";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readWorkspaceFile(filename: string) {
  return readFileSync(path.join(workspace, filename), "utf8");
}

function recursiveStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => recursiveStrings(item, seen));
  return Object.entries(value).flatMap(([key, item]) => [key, ...recursiveStrings(item, seen)]);
}

function expectNoRecursiveLeak(value: unknown, secrets: readonly string[]) {
  const flattened = recursiveStrings(value).join("\n");
  for (const secret of secrets) expect(flattened).not.toContain(secret);
}

function authenticatedDatabase() {
  return {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind() { return statement; },
        first: vi.fn(async () => sql.includes("FROM sessions INNER JOIN users") ? {
          id: "teacher-1",
          username: "teacher",
          role: "teacher",
          must_change_password: 0,
          expires_at: Date.now() + 60_000,
        } : null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      };
      return statement;
    }),
    batch: vi.fn(async () => []),
  };
}

describe("最终交付的本机安全默认值", () => {
  afterEach(() => vi.restoreAllMocks());

  it("开发、生产和 Playwright 服务都只使用 loopback 地址", () => {
    const packageJson = JSON.parse(readWorkspaceFile("package.json")) as { scripts: Record<string, string> };
    const playwrightConfig = readWorkspaceFile("playwright.config.ts");

    expect(packageJson.scripts.dev).toBe("next dev --hostname 127.0.0.1 --port 3001");
    expect(packageJson.scripts.start).toBe("next start --hostname 127.0.0.1 --port 3001");
    expect(playwrightConfig).toContain('command: "npm run dev"');
    expect(`${packageJson.scripts.dev}\n${packageJson.scripts.start}\n${playwrightConfig}`).not.toContain("0.0.0.0");
  });

  it("db:init 使用与应用相同的数据库安全入口", () => {
    const script = readWorkspaceFile("scripts/init-db.mts");

    expect(script).toContain('import { openAppDatabase } from "../src/db/client.ts"');
    expect(script).toContain("openAppDatabase(databasePath)");
    expect(script).not.toContain("new Database(");
    expect(script).not.toContain("initializeSchema(");
  });

  it("db:init 可由 Node 24 直接执行并初始化指定数据库", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ai-composition-grader-init-"));
    const databasePath = path.join(directory, "app.db");

    try {
      const output = execFileSync(
        process.execPath,
        [path.join(workspace, "scripts/init-db.mts")],
        {
          cwd: workspace,
          encoding: "utf8",
          env: { ...process.env, APP_DATABASE_PATH: databasePath },
        },
      );

      expect(output).toContain(`Initialized SQLite database at ${databasePath}`);
      expect(statSync(databasePath).isFile()).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(databasePath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("README 面向教师说明产品价值、人工复核与云端数据边界", () => {
    const readme = readWorkspaceFile("README.md");
    const install = readme.indexOf("npm install");
    const devVars = readme.indexOf("cp .dev.vars.example .dev.vars");
    const database = readme.indexOf("npx wrangler d1 migrations apply ai-composition-grader --local");
    const build = readme.indexOf("npm run build");
    const development = readme.indexOf("npm run cf:dev");

    expect([install, devVars, database, build, development]).toEqual([...new Set([install, devVars, database, build, development])]);
    expect(install).toBeGreaterThan(-1);
    expect(devVars).toBeGreaterThan(install);
    expect(database).toBeGreaterThan(devVars);
    expect(build).toBeGreaterThan(database);
    expect(development).toBeGreaterThan(build);
    expect(readme).toContain("Node.js >= 24");
    expect(readme).toContain("面向一线语文教师");
    expect(readme).toContain("教师负责最终判断");
    expect(readme).toContain("不提供公开注册");
    expect(readme).toContain("OpenAI 兼容视觉模型");
    expect(readme).toContain("OpenAI 兼容内容模型");
    expect(readme).toContain("Cloudflare D1");
    expect(readme).toContain("Cloudflare R2");
    expect(readme).not.toContain("30 天到期时间");
    expect(readme).not.toMatch(/作文.{0,20}30 天.{0,20}(到期|删除)/u);
    expect(readme).toContain("长期保留");
    expect(readme).toContain("手动永久删除");
    expect(readme).toContain("存储容量");
    expect(readme).toContain("第三方如何保存和处理数据，以其服务条款为准");
    expect(readme).toContain("不要把真实密钥、学生作文或数据库导出提交到 Git");
  });

  it("双模型环境示例和 README 明确职责、密钥与 OCR 复核流程", () => {
    const variables = readWorkspaceFile(".dev.vars.example");
    const readme = readWorkspaceFile("README.md");
    const workerEnv = readWorkspaceFile("src/cloudflare/env.ts");
    const generatedBindings = readWorkspaceFile("worker-configuration.d.ts");

    expect(variables).toContain("VISION_AI_API_KEY=");
    expect(variables).toContain("CONTENT_AI_API_KEY=");
    expect(variables).toContain("AI_API_KEY=");
    expect(readme).toContain("视觉模型只负责 OCR");
    expect(readme).toContain("内容模型只接收识别文字");
    expect(readme).toContain("新分析会写入 OCR v2");
    expect(readme).toContain("旧报告需要完整重新分析才能生成新格式");
    expect(readme).toContain("同一 revision 已存在的旧版 PDF 可原样下载");
    expect(readme).toContain("内容模型只接收自然段文字");
    expect(readme).toContain("单篇和批量均支持 PDF 与 Word");
    expect(readme).toContain("下载后不会自动重算红黑差异");
    expect(readme).toContain("导出失败不会标记为已导出");
    expect(readme).toContain("重新生成批改");
    expect(readme).toContain("VISION_AI_API_KEY");
    expect(readme).toContain("CONTENT_AI_API_KEY");
    expect(readme).toContain("AI_API_KEY");
    expect(workerEnv).toContain("VISION_AI_API_KEY?: string");
    expect(workerEnv).toContain("CONTENT_AI_API_KEY?: string");
    expect(generatedBindings).toContain("ANALYSIS_QUEUE: Queue");
    expect(generatedBindings).toContain("ANALYSIS_DLQ: Queue");
    expect(generatedBindings).not.toContain("VISION_AI_API_KEY");
    expect(generatedBindings).not.toContain("CONTENT_AI_API_KEY");
  });

  it("内容模型适配器不包含图片载荷、坐标或作文日志", () => {
    const adapter = readWorkspaceFile("src/ai/composition-review-adapter.ts");
    const pipeline = readWorkspaceFile("src/cloudflare/cloud-analysis-pipeline.ts");

    expect(adapter).not.toContain("image_url");
    expect(adapter).not.toContain("data:image");
    expect(adapter).not.toContain("signed");
    expect(adapter).not.toContain("segments");
    expect(adapter).not.toContain("blocks");
    expect(adapter).not.toMatch(/["'](?:x|y)["']/u);
    expect(adapter).not.toMatch(/\b(x|y|width|height):/u);
    expect(adapter).not.toContain("console.");
    expect(pipeline).not.toContain("console.");
  });

  it("公开 OCR JSON 不包含 blocks 或 segment 原始文字", () => {
    const view = publicOcrView({
      version: 2,
      sourceRevision: 1,
      ocrRevision: 0,
      editedAt: null,
      pages: [{
        pageIndex: 0,
        text: "公开页文字",
        readable: true,
        warnings: [],
        blocks: [{ text: "BLOCK_SECRET", x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
      }],
      paragraphs: [{
        id: "paragraph-1",
        paragraphIndex: 0,
        text: "教师可复核文字",
        segments: [{
          pageIndex: 0,
          text: "SEGMENT_SECRET",
          x: 0.1,
          y: 0.2,
          width: 0.5,
          height: 0.08,
        }],
      }],
    });

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("blocks");
    expect(serialized).not.toContain("BLOCK_SECRET");
    expect(serialized).not.toContain("SEGMENT_SECRET");
    if (view.version !== 2) throw new Error("expected OCR v2 public view");
    expect(view.paragraphs[0].segments[0]).toEqual({
      pageIndex: 0,
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.08,
    });
  });

  it("内容模型运行时请求递归扫描不到图片、链接、定位和 OCR 内部结构", async () => {
    const create = vi.fn(async () => ({
      choices: [{ message: { content: "{}" } }],
    }));
    const adapter = new CompositionReviewAdapter({
      getRuntimeConfig: vi.fn(async () => ({
        baseUrl: "https://content.example/v1",
        model: "content-model",
        apiKey: "content-secret",
      })),
    }, {
      clientFactory: () => ({ chat: { completions: { create } } }),
    });

    await expect(adapter.analyzeText({
      config: {
        title: "雨中的坚持",
        grade: "六年级",
        writingRequirements: "写一件真实的事。",
        targetCharacters: 600,
        structureRequirements: "开头点题，结尾升华。",
        scoringFocus: "内容具体。",
        templateType: "custom",
      },
      paragraphs: [{
        id: "paragraph-1",
        text: "我冒雨走进了赛场。",
        segments: [{ x: 0.1, y: 0.2 }],
        blocks: [],
      }],
      pages: [{ image_url: "data:image/jpeg;base64,QQ==" }],
      studentName: "小艾",
    } as never)).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });

    const requests = create.mock.calls.map(([request]) => request);
    const serialized = JSON.stringify(requests);
    expect(serialized).not.toMatch(/image_url|data:image|signed|segments|blocks|https?:\/\//u);
    expect(serialized).not.toMatch(/\\"(?:x|y)\\"/u);
    expect(serialized).toContain("paragraph-1");
    expect(serialized).toContain("我冒雨走进了赛场。");
  });

  it("公开详情递归扫描不到存储路径、内部 OCR 文字或教师账号", async () => {
    const config = JSON.stringify({
      title: "我的老师", grade: "六年级", writingRequirements: "叙事", targetCharacters: 600,
      structureRequirements: "完整", scoringFocus: "细节", templateType: "custom",
    });
    const report = JSON.stringify({
      version: 2,
      themeFit: "fits",
      themeReason: "紧扣主题。",
      personalizedComment: "文章真诚。",
      painPoints: [], commonIssues: [], revisionSuggestions: [],
      grade: "A",
      diagnostics: {
        authenticityAndRelevance: { finding: "真实。", action: "保留。" },
        materialAndDetails: { finding: "具体。", action: "保留。" },
        structure: { finding: "完整。", action: "保留。" },
        language: { finding: "通顺。", action: "保留。" },
      },
      paragraphReviews: [{
        paragraphId: "paragraph-1",
        suggestions: [{ problem: "保留", advice: "保留原文", example: "自然。" }],
        revisedText: "公开自然段文字。",
      }],
      parentFeedbacks: [],
    });
    const checkpoint = JSON.stringify({
      version: 2,
      sourceRevision: 3,
      ocrRevision: 1,
      editedAt: "2026-08-28T07:30:00.000Z",
      pages: [{
        pageIndex: 0,
        text: "公开自然段文字。",
        readable: true,
        warnings: [],
        blocks: [{ text: "BLOCK_SECRET", x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
      }],
      paragraphs: [{
        id: "paragraph-1",
        paragraphIndex: 0,
        text: "公开自然段文字。",
        segments: [{
          pageIndex: 0,
          text: "SEGMENT_SECRET",
          x: 0.1,
          y: 0.2,
          width: 0.5,
          height: 0.08,
        }],
      }],
    });
    const database = {
      prepare(query: string) {
        return {
          bind() {
            return {
              async first() {
                if (!query.includes("FROM reviews WHERE id")) return null;
                return {
                  id: "review-1", status: "ready_for_review", student_name: "小明", config, report,
                  revision: 4, image_revision: 3, ocr_checkpoint: checkpoint, report_ocr_revision: 1,
                  pdf_filename: null, pdf_path: null, pdf_revision: null, exported_at: null,
                  teacher_reviewed_at: Date.parse("2026-08-28T08:00:00.000Z"), expires_at: null,
                  created_at: 1_700_000_000_000, updated_at: 1_700_000_100_000,
                  owner_id: "TEACHER_ACCOUNT_SECRET", api_key: "API_KEY_SECRET",
                  model: "MODEL_SECRET", internal_path: "/Users/teacher/private/review.db",
                };
              },
              async all() {
                if (query.includes("FROM review_images")) return { results: [{
                  id: 7, review_id: "review-1", position: 0, original_name: "essay.png", mime_type: "image/png",
                  original_path: "images/ORIGINAL_PATH_SECRET.png",
                  annotation_path: "images/ANNOTATION_PATH_SECRET.png",
                  ai_path: "images/AI_PATH_SECRET.png",
                  width: 1200, height: 1600, rotation: 0, crop: null,
                }] };
                return { results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const detail = await new D1ReviewReader(database).get("TEACHER_ACCOUNT_SECRET", "review-1");

    expect(detail).toMatchObject({ id: "review-1", ocr: { version: 2 } });
    expectNoRecursiveLeak(detail, [
      "TEACHER_ACCOUNT_SECRET", "API_KEY_SECRET", "MODEL_SECRET", "/Users/teacher/private",
      "ORIGINAL_PATH_SECRET", "ANNOTATION_PATH_SECRET", "AI_PATH_SECRET", "BLOCK_SECRET", "SEGMENT_SECRET",
    ]);
  });

  it("DOCX 属性与 Worker 错误响应递归扫描不到内部配置", async () => {
    const png = new Uint8Array(Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    const delivery: DeliveryDocument = {
      title: "公开作文标题",
      studentName: "公开学生姓名",
      paragraphs: [{
        paragraphNumber: 1,
        crops: [{ pageIndex: 0, bytes: png, width: 600, height: 300 }],
        suggestions: [{ problem: "保留", advice: "保留原文", example: "自然。" }],
        revisionRuns: [{ kind: "unchanged", text: "公开修改稿。" }],
      }],
    };
    const docx = await createReviewDocx(delivery, paginateDeliveryDocument(delivery));
    const zip = await JSZip.loadAsync(await docx.arrayBuffer());
    const propertyFiles = Object.values(zip.files).filter(({ dir, name }) => (
      !dir && name.startsWith("docProps/")
    ));
    const properties = await Promise.all(propertyFiles.map((file) => file.async("string")));

    const database = authenticatedDatabase();
    const queue = { send: vi.fn().mockRejectedValue(new Error(
      "API_KEY_SECRET MODEL_SECRET TEACHER_ACCOUNT_SECRET /Users/teacher/private/review.db",
    )), sendBatch: vi.fn() };
    vi.spyOn(D1Reanalysis.prototype, "requestRevision").mockResolvedValue({
      newlyQueued: true,
      job: {
        id: "job-1", reviewId: "review-1", mode: "content_only", status: "queued",
        progressStage: "queued", message: null, createdAt: new Date().toISOString(), finishedAt: null,
      },
    });
    vi.spyOn(D1Reanalysis.prototype, "markDispatchFailed").mockResolvedValue();
    const response = await worker.fetch(new Request(
      "https://grader.workers.dev/api/reviews/review-1/revision-request",
      {
        method: "POST",
        headers: { cookie: "__Host-zuowen_session=session-token", "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: 3, reason: "原因", changeRequest: "要求" }),
      },
    ), {
      DB: database,
      ASSETS: { fetch: async () => new Response("asset") },
      ANALYSIS_QUEUE: queue,
    } as never);
    const errorBody = await response.json();

    expect(response.status).toBe(503);
    expectNoRecursiveLeak([...properties, errorBody], [
      "API_KEY_SECRET", "MODEL_SECRET", "TEACHER_ACCOUNT_SECRET", "/Users/teacher/private",
    ]);
  });
});
