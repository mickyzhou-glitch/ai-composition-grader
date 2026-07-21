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

  it("README 给出完整的本机安装、设置与数据删除边界", () => {
    const readme = readWorkspaceFile("README.md");
    const install = readme.indexOf("npm install");
    const chromium = readme.indexOf("npx playwright install chromium");
    const database = readme.indexOf("npm run db:init");
    const development = readme.indexOf("npm run dev");

    expect([install, chromium, database, development]).toEqual([...new Set([install, chromium, database, development])]);
    expect(install).toBeGreaterThan(-1);
    expect(chromium).toBeGreaterThan(install);
    expect(database).toBeGreaterThan(chromium);
    expect(development).toBeGreaterThan(database);
    expect(readme).toContain("Node.js >= 24");
    expect(readme).toContain("macOS");
    expect(readme).toContain("Keychain");
    expect(readme).toContain("127.0.0.1");
    expect(readme).toContain("API 根地址");
    expect(readme).toContain("模型");
    expect(readme).toContain("API key");
    expect(readme).toContain("测试保存");
    expect(readme).toContain("Chromium");
    expect(readme).toContain(".data/");
    expect(readme).toContain("不会删除");
  });
});
