# AI 作业批改助手

面向教师的 AI 作业批改工作台。当前阶段提供 Next.js 应用基础设施、中文教师工作台壳及测试工具链。

## 环境要求

- Node.js >= 24
- npm（随 Node.js 安装）

## 安装与启动

```bash
npm install
npm run db:init
npm run dev
```

开发服务器默认运行在 `http://localhost:3000`。

## 验证命令

```bash
# Vitest 单元测试
npm test

# ESLint
npm run lint

# 生产构建
npm run build

# Playwright 端到端 smoke 测试（自动启动本地开发服务器）
npm run test:e2e
```

首次执行端到端测试前，需要安装 Chromium：

```bash
npx playwright install chromium
```

## 项目结构

- `app/`：Next.js App Router 页面与全局样式
- `src/domain/`：作业配置、批注与评价报告契约
- `src/db/`：SQLite/Drizzle schema 与强类型 repository
- `src/storage/`：按 review 隔离的本地文件存储
- `src/settings/`：基础设置与 macOS Keychain 密钥适配器
- `e2e/`：Playwright smoke 测试
- `test/`：Vitest 测试初始化
- `playwright.config.ts`：端到端测试与本地服务配置
- `vitest.config.ts`：jsdom 与 Testing Library 配置

本地运行数据存放在 `.data/`，测试产物与环境文件均不会提交到 Git。

本地文件存储会将 reviews 根目录限制为 `0700`，逐级拒绝符号链接，并使用同目录临时文件原子替换。威胁模型以本地单用户应用为前提：防御非预期路径和符号链接逃逸，但不声称可抵御拥有同一 OS 用户权限的恶意进程并发篡改文件系统。
