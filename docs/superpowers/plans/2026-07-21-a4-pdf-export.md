# A4 PDF 导出实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为已有报告与作文图片的批改记录生成可缓存、可安全下载的 A4 中文 PDF。

**架构：** 打印路由 Server Component 直接读取仓储快照，在页面内通过现有 imageId/variant 接口加载图片。`PdfService` 使用可注入的 `BrowserFactory` 访问当前请求 origin 下的打印页，将内容 revision 与 PDF 元数据一起原子持久化。所有内容变更使缓存失效并将旧文件加入 best-effort 清理队列。

**技术栈：** Next.js 16 App Router、React 19 Server/Client Components、Drizzle + SQLite、Playwright Chromium、Vitest + Testing Library。

---

### 任务 1：PDF 元数据与缓存失效

**文件：**
- 修改：`src/db/schema.ts`、`src/db/init.ts`、`src/db/review-repository.ts`
- 修改：`src/storage/review-file-store.ts`
- 测试：`src/db/review-repository.test.ts`、`src/storage/review-file-store.test.ts`

- [ ] 先写失败测试：导出元数据仅在 `pdfRevision === revision` 时有效，配置、报告、批注、图片变更均清空元数据、恢复合理状态并递增 revision。
- [ ] 运行 `npm test -- src/db/review-repository.test.ts src/storage/review-file-store.test.ts`，确认因字段和清理能力缺失而失败。
- [ ] 最小实现 schema 迁移、仓储写入/CAS 及通用 PDF 清理队列。
- [ ] 重跑定向测试至通过。

### 任务 2：A4 打印 Server Component

**文件：**
- 创建：`app/print/reviews/[id]/page.tsx`、`app/print/reviews/[id]/print.css`
- 创建：`app/print/reviews/[id]/PrintReview.tsx`
- 测试：`app/print/reviews/[id]/page.test.tsx`

- [ ] 先写失败组件测试，覆盖章节顺序、每张图一个红批页、按 pageIndex/y 排序、红色锚点与引线、示范段落与紧随修改建议。
- [ ] 运行 `npm test -- 'app/print/reviews/[id]/page.test.tsx'`，确认打印组件缺失。
- [ ] 实现纯服务端数据读取、无学生信息的打印 DOM 与 A4 CSS，图片只使用安全 API URL。
- [ ] 重跑定向测试至通过。

### 任务 3：PdfService 与下载 API

**文件：**
- 创建：`src/pdf/pdf-service.ts`、`src/pdf/pdf-service.test.ts`
- 创建：`app/api/reviews/[id]/pdf/route.ts`
- 修改：`src/api/handlers.ts`、`src/runtime/application-services.ts`
- 测试：`src/api/handlers.test.ts`

- [ ] 先写失败服务测试：60s 导航、`data-print-ready=true`、图片 load 等待、print media、A4 PDF 参数、page/browser finally 关闭、安全中文文件名、持久化与缓存命中。
- [ ] 运行 `npm test -- src/pdf/pdf-service.test.ts`，确认服务缺失。
- [ ] 实现最小 `BrowserFactory` / `PdfService`，并保持引擎缺失的结构化错误。
- [ ] 先写失败 Route Handler 测试，覆盖 PDF 响应头、422、503 操作提示与不泄露磁盘路径。
- [ ] 实现 API，重跑服务与 API 测试至通过。

### 任务 4：首页与复核页导出交互

**文件：**
- 修改：`app/lib/types.ts`、`app/page.tsx`、`app/reviews/[id]/page.tsx`
- 测试：`app/page.test.tsx`、`app/reviews/[id]/page.test.tsx`

- [ ] 先写失败 UI 测试：首页重新导出/下载中与错误，复核页 dirty 禁止导出，成功后刷新状态。
- [ ] 运行 `npm test -- app/page.test.tsx 'app/reviews/[id]/page.test.tsx'`，确认交互缺失。
- [ ] 实现下载 blob 与按钮状态，重跑定向测试至通过。

### 任务 5：全量验证与提交

- [ ] 运行 `npm test`、`npm run lint`、`npm run build`、`npx playwright test --list`。
- [ ] 对照任务说明逐项检查，确认 DTO 无 path、缓存不会过期返回、关闭路径在 finally 中。
- [ ] 使用 Conventional Commit 提交实现，记录 SHA 与实际验证输出。
