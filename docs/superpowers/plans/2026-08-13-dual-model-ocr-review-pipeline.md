# 双模型 OCR 与作文批改流水线实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将现有单模型图片批改改为「视觉模型 OCR 检查点 → 内容模型生成报告」的双模型流水线，并允许教师修正 OCR 后仅重跑内容生成。

**架构：** Cloudflare Queue 的单个任务依次调用 `VisionOcrAdapter` 和只接收文本的 `CompositionReviewAdapter`，在 D1 中保存带图片版本和编辑版本的 OCR 检查点。两个适配器通过按 `vision` / `content` 角色读取的 OpenAI 兼容配置解耦；内容模型返回无坐标批注锚点，再由确定性的 `AnnotationMapper` 映射到 OCR 文本块。

**技术栈：** TypeScript、Next.js 16 静态导出、React 19、Cloudflare Workers、D1、R2、Queues、OpenAI Chat Completions 兼容接口、Zod、Vitest、React Testing Library、Playwright。

---

## 文件结构

- 创建 `src/ocr/contracts.ts`：OCR 检查点、页面、文本块和批注锚点 Schema。
- 创建 `src/ocr/annotation-mapper.ts`：无副作用的锚点唯一匹配与坐标映射。
- 创建 `src/ai/vision-ocr-adapter.ts`：视觉模型请求、响应解析和修复错误。
- 创建 `src/ai/composition-review-adapter.ts`：从 OCR 文本生成现有报告和无坐标批注锚点。
- 修改 `src/ai/openai-review-adapter.ts`：保留内容重写 API，并移除主分析链路对图片的依赖；用兼容导出降低调用方迁移风险。
- 修改 `src/ai/assignment-guidance-adapter.ts`：读取 `content` 角色配置。
- 创建 `src/cloudflare/ai-settings.ts`：D1 双角色配置读取、密钥回退和连接测试。
- 创建 `src/cloudflare/d1-ocr-checkpoint.ts`：OCR 检查点读取、模型保存、教师编辑和版本条件写入。
- 修改 `migrations/`、`src/db/schema.ts`、`src/db/init.ts`：双角色配置与 OCR/图片版本字段。
- 修改 `src/settings/`：本机兼容层支持按角色读取和保存配置。
- 修改 `src/cloudflare/d1-analysis-jobs.ts`、`worker/index.ts`：两阶段任务、检查点复用、进度和并发保护。
- 修改 `src/cloudflare/d1-review-reader.ts`、`src/cloudflare/d1-review-writer.ts`、`src/cloudflare/d1-image-writer.ts`：返回 OCR 视图、报告过期状态并正确推进图片版本。
- 创建 `app/components/OcrTextEditor.tsx`：逐页 OCR 文本编辑器。
- 修改 `app/(protected)/settings/page.tsx`、`app/(protected)/reviews/ReviewPage.tsx`、`app/lib/types.ts`、`app/globals.css`：双模型设置、OCR 标签页、过期报告提示和阶段文案。
- 修改 `.dev.vars.example`、`src/cloudflare/env.ts`、`worker-configuration.d.ts`、`README.md`：部署配置和迁移说明。

### 任务 1：建立 OCR 领域契约与确定性坐标映射

**文件：**
- 创建：`src/ocr/contracts.ts`
- 创建：`src/ocr/contracts.test.ts`
- 创建：`src/ocr/annotation-mapper.ts`
- 创建：`src/ocr/annotation-mapper.test.ts`

- [ ] **步骤 1：编写失败的 OCR Schema 测试**

测试必须覆盖连续页码、`0..1` 坐标边界、`x + width <= 1`、`y + height <= 1`、`sourceRevision`、`ocrRevision` 和严格对象字段。

```ts
expect(() => ocrCheckpointSchema.parse({
  version: 1,
  sourceRevision: 2,
  ocrRevision: 0,
  editedAt: null,
  pages: [{ pageIndex: 1, text: "正文", readable: true, warnings: [], blocks: [] }],
})).toThrow();
```

- [ ] **步骤 2：运行契约测试并确认因模块不存在而失败**

运行：`npm test -- src/ocr/contracts.test.ts`

预期：FAIL，提示无法解析 `./contracts`。

- [ ] **步骤 3：实现最小 OCR 契约**

导出 `ocrBlockSchema`、`ocrPageSchema`、`ocrCheckpointSchema`、`reviewAnnotationAnchorSchema` 及对应类型。使用 `superRefine` 校验页面索引连续，使用对象 refine 校验文本块边界。

- [ ] **步骤 4：编写失败的坐标映射测试**

覆盖单块精确匹配、相邻块连续匹配、Unicode/空白/全半角标点规范化、重复候选放弃、无候选放弃，以及教师新增文字不产生坐标。

```ts
expect(mapAnnotationAnchors(checkpoint, [{
  pageIndex: 0,
  category: "structure",
  anchorText: "我终于明白了",
  comment: "这里需要回扣题目",
  isHighlight: false,
}])).toEqual([{
  pageIndex: 0,
  x: 0.2,
  y: 0.4,
  category: "structure",
  anchorText: "我终于明白了",
  comment: "这里需要回扣题目",
  isHighlight: false,
}]);
```

- [ ] **步骤 5：运行映射测试并确认因函数不存在而失败**

运行：`npm test -- src/ocr/annotation-mapper.test.ts`

预期：FAIL，提示无法解析 `./annotation-mapper`。

- [ ] **步骤 6：实现最小唯一匹配算法并运行测试**

只允许单块或连续最多 `4` 块的规范化包含匹配；收集所有候选，候选数恰好为 `1` 才返回首块 `x/y`。运行：

```bash
npm test -- src/ocr/contracts.test.ts src/ocr/annotation-mapper.test.ts
```

预期：2 个测试文件全部 PASS。

- [ ] **步骤 7：提交任务 1**

```bash
git add src/ocr
git commit -m "feat(OCR): 添加识别契约与批注坐标映射"
```

### 任务 2：建立双角色模型配置与迁移

**文件：**
- 创建：`migrations/0005_dual_model_ocr.sql`
- 创建：`src/cloudflare/ai-settings.ts`
- 创建：`src/cloudflare/ai-settings.test.ts`
- 修改：`src/cloudflare/env.ts`
- 修改：`src/settings/settings-repository.ts`
- 修改：`src/settings/settings-service.ts`
- 修改：`src/settings/settings-service.test.ts`
- 修改：`src/db/schema.ts`
- 修改：`src/db/init.ts`
- 修改：`src/db/client.test.ts`

- [ ] **步骤 1：编写失败的双角色配置测试**

测试 `vision` 和 `content` 独立读取，角色加密密钥优先，分别回退 `VISION_AI_API_KEY` / `CONTENT_AI_API_KEY`，最后回退旧 `AI_API_KEY`；保存 `vision` 不覆盖 `content`。

```ts
await expect(source.getRuntimeConfig("content")).resolves.toEqual({
  baseUrl: "https://content.example/v1",
  model: "writer",
  apiKey: "content-secret",
});
```

- [ ] **步骤 2：运行配置测试确认失败**

运行：`npm test -- src/cloudflare/ai-settings.test.ts src/settings/settings-service.test.ts src/db/client.test.ts`

预期：FAIL，缺少角色类型、迁移和新接口。

- [ ] **步骤 3：实现角色配置 Schema、仓储和密钥选择**

定义 `AiModelRole = "vision" | "content"`，将本机 `settings` 主键改为角色，`SettingsService.getRuntimeConfig(role)` 只拼装同一角色的 URL、模型和密钥。Cloudflare 辅助模块提供 `getAiRuntimeConfig(env, role)` 与 `settingsView(env)`。

- [ ] **步骤 4：实现 D1 migration**

重建 `settings` 为：

```sql
CREATE TABLE settings_new (
  role TEXT PRIMARY KEY CHECK (role IN ('vision', 'content')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  encrypted_api_key TEXT
);
INSERT INTO settings_new SELECT 'vision', base_url, model, updated_at, encrypted_api_key FROM settings WHERE id = 1;
INSERT INTO settings_new SELECT 'content', base_url, model, updated_at, encrypted_api_key FROM settings WHERE id = 1;
```

同时为 `reviews` 增加 `image_revision`、`ocr_checkpoint`、`report_ocr_revision`，为 `analysis_jobs` 增加 `mode`，并扩展 `progress_stage` 约束所需的表重建。

- [ ] **步骤 5：运行配置和迁移测试**

运行：`npm test -- src/cloudflare/ai-settings.test.ts src/settings/settings-service.test.ts src/db/client.test.ts`

预期：全部 PASS。

- [ ] **步骤 6：提交任务 2**

```bash
git add migrations src/cloudflare/ai-settings.ts src/cloudflare/ai-settings.test.ts src/cloudflare/env.ts src/settings src/db
git commit -m "feat(配置): 支持视觉与内容模型独立配置"
```

### 任务 3：实现视觉 OCR 和纯文本内容适配器

**文件：**
- 创建：`src/ai/vision-ocr-adapter.ts`
- 创建：`src/ai/vision-ocr-adapter.test.ts`
- 创建：`src/ai/composition-review-adapter.ts`
- 创建：`src/ai/composition-review-adapter.test.ts`
- 修改：`src/ai/openai-review-adapter.ts`
- 修改：`src/ai/openai-review-adapter.test.ts`
- 修改：`src/ai/assignment-guidance-adapter.ts`
- 修改：`src/ai/assignment-guidance-adapter.test.ts`

- [ ] **步骤 1：编写失败的视觉适配器测试**

断言请求使用 `vision` 配置、携带图片、要求严格 OCR JSON、不包含评分/范文提示，并拒绝页数不符和越界文本块。

- [ ] **步骤 2：运行视觉测试确认失败**

运行：`npm test -- src/ai/vision-ocr-adapter.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 `VisionOcrAdapter`**

适配器调用 `settings.getRuntimeConfig("vision")`，请求 `response_format: { type: "json_object" }`，验证 `pages.length === imageUrls.length`，输出 `Omit<OcrCheckpoint, "sourceRevision" | "ocrRevision" | "editedAt">` 所需页面数据。无法读取时仍返回页面警告，由流水线决定是否停止。

- [ ] **步骤 4：编写失败的内容适配器测试**

断言请求使用 `content` 配置，只包含页码与 OCR `text`，序列化请求中不存在 `image_url`、`data:image` 和签名文件路径；输出是报告与 `ReviewAnnotationAnchor[]`，不接受模型坐标。

- [ ] **步骤 5：运行内容测试确认失败**

运行：`npm test -- src/ai/composition-review-adapter.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 6：迁移现有提示词和修复逻辑**

复用现有报告校验、家长反馈语义校验和重试逻辑，但主分析入口改为：

```ts
analyzeText(input: {
  config: AssignmentConfig;
  pages: Array<{ pageIndex: number; text: string }>;
  teacherGuidance?: string;
  studentName?: string;
}): Promise<{ report: EvaluationReport; annotationAnchors: ReviewAnnotationAnchor[] }>;
```

保留现有 `OpenAIReviewAdapter` 的重写方法作为内容模型辅助能力，所有运行时设置显式使用 `content` 角色。

- [ ] **步骤 7：运行 AI 适配器测试**

运行：

```bash
npm test -- src/ai/vision-ocr-adapter.test.ts src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts src/ai/assignment-guidance-adapter.test.ts
```

预期：全部 PASS，且隐私断言证明内容请求不含图片。

- [ ] **步骤 8：提交任务 3**

```bash
git add src/ai
git commit -m "feat(AI): 拆分视觉识别与作文内容生成"
```

### 任务 4：持久化 OCR 检查点并保护版本一致性

**文件：**
- 创建：`src/cloudflare/d1-ocr-checkpoint.ts`
- 创建：`src/cloudflare/d1-ocr-checkpoint.test.ts`
- 修改：`src/cloudflare/d1-review-reader.ts`
- 修改：`src/cloudflare/d1-review-reader.test.ts`
- 修改：`src/cloudflare/d1-review-writer.ts`
- 修改：`src/cloudflare/d1-review-writer.test.ts`
- 修改：`src/cloudflare/d1-image-writer.ts`
- 修改：`src/cloudflare/d1-image-writer.test.ts`
- 修改：`app/lib/types.ts`

- [ ] **步骤 1：编写失败的检查点仓储测试**

覆盖模型首次保存 `ocrRevision = 0`、教师按期望版本编辑后加 `1`、版本冲突返回稳定错误、保存模型结果时要求 `sourceRevision === image_revision`、读取时不向浏览器暴露 `blocks`。

- [ ] **步骤 2：运行检查点测试确认失败**

运行：`npm test -- src/cloudflare/d1-ocr-checkpoint.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现检查点仓储与公开视图**

仓储提供 `readInternal`、`saveRecognized`、`editTexts` 和 `publicView`。教师编辑只替换每页 `text`，保留 `blocks/readable/warnings`，并以 D1 条件更新保证 `ocrRevision` 未变化。

- [ ] **步骤 4：让作文详情返回 OCR 一致性状态**

`ReviewView` 新增：

```ts
ocr: { ocrRevision: number; pages: Array<{ pageIndex: number; text: string; readable: boolean; warnings: string[] }> } | null;
reportStale: boolean;
```

`reportStale` 仅在报告存在且 `report_ocr_revision !== ocrRevision` 时为真。

- [ ] **步骤 5：图片变更推进 `image_revision` 并失效 OCR**

上传、裁剪、旋转或排序成功时执行 `image_revision = image_revision + 1, ocr_checkpoint = NULL, report_ocr_revision = NULL`。报告普通编辑不得推进 `image_revision`。

- [ ] **步骤 6：运行仓储回归测试**

运行：

```bash
npm test -- src/cloudflare/d1-ocr-checkpoint.test.ts src/cloudflare/d1-review-reader.test.ts src/cloudflare/d1-review-writer.test.ts src/cloudflare/d1-image-writer.test.ts
```

预期：全部 PASS。

- [ ] **步骤 7：提交任务 4**

```bash
git add src/cloudflare app/lib/types.ts
git commit -m "feat(OCR): 保存检查点并绑定图片与报告版本"
```

### 任务 5：实现 Queue 单任务两阶段流水线

**文件：**
- 修改：`src/cloudflare/d1-analysis-jobs.ts`
- 修改：`src/cloudflare/d1-analysis-jobs.test.ts`
- 修改：`worker/index.ts`
- 修改：`worker/index.test.ts`
- 修改：`src/jobs/analysis-job-repository.ts`
- 修改：`src/jobs/analysis-worker.ts`
- 修改：`src/jobs/analysis-jobs.test.ts`

- [ ] **步骤 1：编写失败的任务模式和进度测试**

新增 `mode: "full" | "content_only"`，阶段为 `queued`、`reading_images`、`saving_ocr`、`generating_review`、`mapping_annotations`、`validating_result`、`saving_result`。断言 `content_only` 必须存在当前 OCR。

- [ ] **步骤 2：编写失败的 Worker 编排测试**

覆盖首次依次调用视觉和内容模型、OCR 已存在时跳过视觉、内容失败保留 OCR、不可读 OCR 不调用内容、教师编辑后 `content_only`、旧任务因图片或 OCR 版本变化不能落库。

- [ ] **步骤 3：运行任务测试确认失败**

运行：`npm test -- src/cloudflare/d1-analysis-jobs.test.ts worker/index.test.ts src/jobs/analysis-jobs.test.ts`

预期：FAIL，缺少新阶段、模式和双适配器调用。

- [ ] **步骤 4：实现 Cloudflare 两阶段编排**

Queue 消费时捕获 `image_revision` 与 `ocrRevision`。完整模式在无当前 OCR 时加载 R2 图片并调用视觉模型，立即保存检查点；随后调用内容模型、映射批注并以 `analysis_run_id + image_revision + ocrRevision` 条件原子保存报告和任务成功。

- [ ] **步骤 5：实现本机兼容任务编排**

本机 `AnalysisWorker` 使用相同领域接口和阶段；保留既有 SQLite 锁、租约和 CAS 行为。它不需要新增 UI，但测试必须证明旧本机流程可运行。

- [ ] **步骤 6：运行任务测试和回归**

运行：

```bash
npm test -- src/cloudflare/d1-analysis-jobs.test.ts worker/index.test.ts src/jobs/analysis-jobs.test.ts src/services/review-service.test.ts
```

预期：全部 PASS。

- [ ] **步骤 7：提交任务 5**

```bash
git add src/cloudflare/d1-analysis-jobs.ts src/cloudflare/d1-analysis-jobs.test.ts worker src/jobs src/services/review-service.test.ts
git commit -m "feat(任务): 编排 OCR 与内容生成两阶段分析"
```

### 任务 6：增加双模型设置与 OCR 教师复核界面

**文件：**
- 创建：`app/components/OcrTextEditor.tsx`
- 创建：`app/components/OcrTextEditor.test.tsx`
- 修改：`app/(protected)/settings/page.tsx`
- 修改：`app/(protected)/settings/page.test.tsx`
- 修改：`app/(protected)/reviews/ReviewPage.tsx`
- 修改：`app/(protected)/reviews/ReviewPage.test.tsx`
- 修改：`app/globals.css`
- 修改：`worker/index.ts`
- 修改：`worker/index.test.ts`

- [ ] **步骤 1：编写失败的双模型设置页面测试**

断言页面同时显示「拍照识图模型」和「作文内容模型」，两个模型名、密钥输入和测试按钮使用独立可访问名称，保存一项只发送该角色。

- [ ] **步骤 2：编写失败的 OCR 编辑器与报告页测试**

断言逐页文本可编辑、保存请求携带 `expectedOcrRevision`、保存后旧报告提示出现、点击「重新生成批改」创建 `content_only` 任务、失败时旧报告仍显示。

- [ ] **步骤 3：运行页面测试确认失败**

运行：

```bash
npm test -- app/'(protected)'/settings/page.test.tsx app/components/OcrTextEditor.test.tsx app/'(protected)'/reviews/ReviewPage.test.tsx
```

预期：FAIL，缺少双配置 UI 和 OCR 组件。

- [ ] **步骤 4：实现按角色设置 API 和页面**

`GET /api/settings` 返回双角色视图；`PUT /api/settings/:role` 和 `POST /api/settings/:role/test` 只处理指定角色。内容测试发纯文本 JSON 请求，视觉测试发最小图片。

- [ ] **步骤 5：实现 OCR API、标签页和过期提示**

增加 `PATCH /api/reviews/:id/ocr` 和 `POST /api/reviews/:id/analyze` 的 `mode` 参数。报告页用语义化 tab/tabpanel 切换「批改报告」与「识别原文」，保存 OCR 后刷新版本但保留旧报告，重新生成成功才替换。

- [ ] **步骤 6：更新阶段文案和响应式样式**

`reading_images/saving_ocr` 显示「正在识别作文」，`generating_review/mapping_annotations/validating_result` 显示「正在生成批改内容」，`saving_result` 显示「正在保存结果」。OCR 文本区在移动端单列，文本不得溢出。

- [ ] **步骤 7：运行页面和 Worker API 测试**

运行：

```bash
npm test -- app/'(protected)'/settings/page.test.tsx app/components/OcrTextEditor.test.tsx app/'(protected)'/reviews/ReviewPage.test.tsx worker/index.test.ts
```

预期：全部 PASS。

- [ ] **步骤 8：提交任务 6**

```bash
git add app worker
git commit -m "feat(复核页): 增加双模型设置与识别原文编辑"
```

### 任务 7：部署文档、安全回归与完整验证

**文件：**
- 修改：`.dev.vars.example`
- 修改：`README.md`
- 修改：`worker-configuration.d.ts`
- 修改：`test/delivery-security.test.ts`
- 修改：`test/static-export.test.ts`
- 修改：`e2e/workbench.spec.ts`

- [ ] **步骤 1：编写或扩展失败的隐私与交付测试**

扫描内容模型请求、日志和错误信封，禁止 `image_url`、`data:image`、API Key 和完整 OCR 正文；静态导出测试继续断言无动态 Route Handler 依赖。

- [ ] **步骤 2：运行交付测试确认新增断言失败**

运行：`npm test -- test/delivery-security.test.ts test/static-export.test.ts`

预期：至少一项新增双模型环境变量或隐私断言 FAIL。

- [ ] **步骤 3：更新环境声明与 README**

`.dev.vars.example` 增加 `VISION_AI_API_KEY` 和 `CONTENT_AI_API_KEY`，保留 `AI_API_KEY` 并标注废弃回退。README 描述双模型职责、配置步骤、OCR 复核与重试行为。

- [ ] **步骤 4：重新生成 Worker 类型**

运行：`npx wrangler types`。

预期：`worker-configuration.d.ts` 包含新的环境字段且命令退出码为 `0`。

- [ ] **步骤 5：运行完整自动化验证**

统一使用 Node 24：

```bash
PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm test
PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm run lint
PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm run build
```

预期：所有测试通过，ESLint 退出码 `0`，Next.js 静态构建退出码 `0`。

- [ ] **步骤 6：运行相关 E2E**

运行：`PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm run test:e2e -- e2e/workbench.spec.ts`

预期：工作台用例全部 PASS；若缺少外部 Cloudflare 测试数据，记录具体未运行原因，不用虚假成功替代。

- [ ] **步骤 7：启动开发服务器并做浏览器视觉检查**

运行：`PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm run dev`。检查桌面与移动宽度下设置页双配置区、OCR tab、长文本换行和按钮状态无重叠。

- [ ] **步骤 8：提交任务 7**

```bash
git add .dev.vars.example README.md worker-configuration.d.ts test e2e
git commit -m "docs(AI): 补充双模型部署与验收说明"
```

## 最终完成标准

- 首次分析按视觉模型 → OCR 检查点 → 内容模型顺序执行。
- 两个模型可使用不同的 Base URL、模型和 API Key。
- 内容模型请求永不包含图片。
- OCR 成功后内容失败可复用检查点。
- 教师修改 OCR 后只重跑内容模型，旧报告在新结果成功前可读。
- 图片变化必然使 OCR 失效，报告编辑不会误伤 OCR。
- 批注只有唯一确定匹配时才落图。
- Node 24 下单测、Lint 和构建全部通过，关键页面完成视觉检查。
