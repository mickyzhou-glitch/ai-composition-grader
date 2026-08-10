// @vitest-environment node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
    expect(readme).toContain("OpenAI 兼容模型");
    expect(readme).toContain("Cloudflare D1");
    expect(readme).toContain("Cloudflare R2");
    expect(readme).toContain("30 天到期时间");
    expect(readme).toContain("第三方 AI 服务");
    expect(readme).toContain("不要把真实密钥、学生作文或数据库导出提交到 Git");
  });
});
