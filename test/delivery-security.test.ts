// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { CompositionReviewAdapter } from "../src/ai/composition-review-adapter";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readWorkspaceFile(filename: string) {
  return readFileSync(path.join(workspace, filename), "utf8");
}

describe("最终交付的本机安全默认值", () => {
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

  it("内容模型运行时请求递归扫描不到图片、链接、定位和 OCR 内部结构", async () => {
    const create = vi.fn(async (_request: unknown) => ({
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
});
