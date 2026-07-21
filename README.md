# AI 作业批改助手

面向教师的 AI 作业批改工作台。图片和批改数据默认保存在本机；仅当点击 AI 批改时，图片才会发送至教师在设置页配置的 AI 服务。

## 环境要求

- Node.js >= 24
- npm（随 Node.js 安装）
- macOS（API Key 使用系统 Keychain 保存）

## 安装与启动

```bash
npm install
npx playwright install chromium
npm run db:init
npm run dev
```

开发服务器只监听 `http://127.0.0.1:3001`，不会暴露到局域网。PDF 导出依赖 Chromium，因此首次安装时必须执行上述 Playwright Chromium 安装命令。

首次启动后，打开 `http://127.0.0.1:3001/settings`，填写 AI 服务的 API 根地址、模型和 API key，再点击「测试并保存」完成测试保存。API key 仅保存在 macOS Keychain，页面不会读取或回显。

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

## 本地数据与删除边界

- `.data/app.db` 保存批改记录与模型连接的非密钥设置；`.data/reviews/` 保存原图、批注图及相关本机文件。
- 删除 `.data/` 会永久删除上述本机数据，无法通过本应用恢复；它不会删除 macOS Keychain 中保存的 API key，也不会删除已发往 AI 服务的数据或已导出的文件。
- 如需删除 API key，请在 macOS「钥匙串访问」中删除服务 `ai-composition-grader`、账户 `default` 的条目。

测试产物与环境文件均不会提交到 Git。

本地文件存储会将 reviews 根目录限制为 `0700`，逐级拒绝符号链接，并使用同目录临时文件原子替换。威胁模型以本地单用户应用为前提：防御非预期路径和符号链接逃逸，但不声称可抵御拥有同一 OS 用户权限的恶意进程并发篡改文件系统。
