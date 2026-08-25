# 作文逐段批改与 DOCX/PDF 双格式交付实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用 OCR v2 的自然段与裁图替换现有示范段落，提供可复核的逐段建议、确定性红黑修订，以及内容一致的 A4 纵向 PDF 和可编辑 DOCX 单篇/批量导出。

**架构：** 视觉模型输出正文自然段及归一化片段，服务端分配稳定段落 ID；内容模型只接收段落 ID 与文字并生成结构化 `paragraphReviews`。网页预览、PDF 和 DOCX 共用差异函数、裁图构建器和交付模型；旧 OCR/报告继续只读，但只有 OCR v2 与逐段报告能通过新格式导出门禁。同一 revision 已存在的旧版 PDF 缓存只允许原样下载，不参与新格式生成。

**技术栈：** TypeScript、Next.js 16.2 静态导出、React 19、Cloudflare Workers/D1/R2/Queues、SQLite/Drizzle、OpenAI 兼容接口、Zod、`diff`（Myers）、Canvas、jsPDF、`docx`、JSZip、Vitest、Testing Library、Playwright、LibreOffice、Poppler。

---

## 文件结构

### 新建文件

- `src/domain/report-validation.test.ts`：新旧报告联合校验、逐段覆盖与导出前内容完整性测试。
- `src/ocr/analysis-mode.ts`：统一决定首次分析、OCR v1 升级和 OCR v2 仅内容重生成模式。
- `src/ocr/analysis-mode.test.ts`：覆盖 full/content-only 与 OCR v1/v2 的确定性选择规则。
- `src/revisions/revision-diff.ts`：字素级 Myers 差异、标点中性化、调序检测和相邻片段合并。
- `src/revisions/revision-diff.test.ts`：增删换、标点、调序、重复字、换行与 Unicode 边界测试。
- `src/delivery/contracts.ts`：格式无关的 `DeliveryDocument`、版式令牌和交付错误类型。
- `src/delivery/readiness.ts`：逐段报告、OCR v2、教师复核和版本一致性的统一导出门禁。
- `src/delivery/readiness.test.ts`：旧报告、过期报告、缺裁图与完整报告的门禁测试。
- `app/lib/image-crop.ts`：按 OCR 坐标加 1% 安全留白并输出裁图字节。
- `app/lib/image-crop.test.ts`：坐标换算、边界裁剪、跨页和失败页码测试。
- `app/lib/delivery-document.ts`：读取同源受保护图片并构建共享交付模型。
- `app/lib/delivery-document.test.ts`：段落/图片对应、顺序、差异片段和失败原子性测试。
- `app/lib/delivery-pagination.ts`：A4 纵向段落单元分页与续标题规划。
- `app/lib/delivery-pagination.test.ts`：标题跟随、整单元换页、超长单元拆分和空白控制测试。
- `app/lib/docx-download.ts`：用 `docx` 生成嵌图、真实编号列表和可编辑红黑修订。
- `app/lib/docx-download.test.ts`：解包 OOXML 验证媒体、编号、底纹、字体、颜色、删除线和元数据。
- `app/lib/review-export.ts`：单篇/批量 PDF 与 Word 的资格检查、生成、ZIP、下载和导出标记编排，以及旧版 PDF 缓存原样下载。
- `app/lib/review-export.test.ts`：格式路由、文件名、旧缓存下载、顺序生成、失败不标记和批量 ZIP 测试。
- `app/components/RevisionPreview.tsx`：把 `RevisionRun[]` 渲染为楷体黑字、红字和红色删除线。
- `app/components/RevisionPreview.test.tsx`：颜色与删除线语义组件测试。
- `app/components/ParagraphCropPreview.tsx`：加载真实段落裁图并处理跨页续图和错误状态。
- `app/components/ParagraphCropPreview.test.tsx`：裁图顺序、替代文字、续页标签和失败状态测试。
- `app/components/ParagraphReviewEditor.tsx`：严格按原文裁图、修改建议、修改后段落组织逐段编辑。
- `app/components/ParagraphReviewEditor.test.tsx`：顺序、建议编辑、保留项、重写和即时差异预览测试。
- `app/components/ExportMenu.tsx`：可访问且响应式的 PDF/Word 格式菜单。
- `app/components/ExportMenu.test.tsx`：键盘、点击外部关闭、禁用与移动端文案测试。
- `e2e/export-delivery.spec.ts`：用合成多页作文夹具下载 PDF/DOCX，供自动流程与人工逐页 QA。

### 修改文件

- `package.json`、`package-lock.json`：增加 `diff` 与 `docx` 运行时依赖。
- `src/ocr/contracts.ts`、`src/ocr/contracts.test.ts`：加入 OCR v2、自然段、跨页片段、稳定 ID 和 v1/v2 类型守卫。
- `src/ocr/annotation-mapper.ts`、`src/ocr/annotation-mapper.test.ts`：支持按 `paragraphId` 将内容模型锚点映射回页面块。
- `src/domain/contracts.ts`、`src/domain/contracts.test.ts`：把报告改为旧 `sampleParagraphs` 与新 `paragraphReviews` 的联合 Schema。
- `src/domain/report-validation.ts`：按 OCR v2 校验逐段 ID、数量、顺序和内容完整性。
- `src/ai/vision-ocr-adapter.ts`、`src/ai/vision-ocr-adapter.test.ts`：让视觉模型直接输出正文自然段片段。
- `src/ai/composition-review-adapter.ts`、`src/ai/composition-review-adapter.test.ts`：只用段落文本生成新报告，并执行一次完整结构修复。
- `src/ai/openai-review-adapter.ts`、`src/ai/openai-review-adapter.test.ts`：新增单段建议与修改稿重写；旧示范段重写仅保留给旧报告。
- `src/ai/review-semantics.ts`：保留现有等级、诊断和家长反馈语义，并接入逐段覆盖校验。
- `src/cloudflare/d1-ocr-checkpoint.ts`、`src/cloudflare/d1-ocr-checkpoint.test.ts`：保存 OCR v2、只编辑 `paragraph.text`、公开裁图片段且隐藏 blocks。
- `src/cloudflare/cloud-analysis-pipeline.ts`、`src/cloudflare/cloud-analysis-pipeline.test.ts`：以 OCR v2 段落驱动内容模型和批注映射。
- `src/cloudflare/d1-review-reader.ts`、`src/cloudflare/d1-review-reader.test.ts`：读取新旧报告、返回安全 OCR 段落视图和新格式资格状态。
- `src/cloudflare/d1-review-writer.ts`、`src/cloudflare/d1-review-writer.test.ts`：保存逐段报告时绑定 OCR 版本并在复核/导出时复验。
- `src/cloudflare/d1-analysis-jobs.ts`、`src/cloudflare/d1-analysis-jobs.test.ts`：OCR v1 的重新分析必须升级为 full，不能 content-only。
- `src/cloudflare/d1-reanalysis.ts`、`src/cloudflare/d1-reanalysis.test.ts`：旧报告与 OCR v1 强制完整重新识别。
- `src/db/review-repository.ts`、`src/db/review-repository.test.ts`：本机 SQLite 路径保存/读取 OCR v2、复核和导出门禁。
- `src/jobs/analysis-worker.ts`、`src/jobs/analysis-jobs.test.ts`：本机 Worker 传递自然段而不是逐页正文。
- `src/reanalysis/reanalysis-repository.ts`、`src/reanalysis/reanalysis-repository.test.ts`：本机重新分析执行相同 v1/v2 选择规则。
- `src/services/review-service.ts`、`src/services/review-service.test.ts`：提供新单段重写上下文并阻止旧报告进入新导出。
- `src/api/handlers.ts`、`src/api/handlers.test.ts`：增加逐段重写/逐段 OCR 编辑处理器并统一导出错误。
- `scripts/worker.ts`、`worker/index.ts`、`worker/index.test.ts`：接线 OCR v2、逐段重写、D1 复核和导出门禁。
- `app/lib/types.ts`：公开 OCR 版本、段落文字与无文本坐标片段，不公开 blocks。
- `app/components/OcrTextEditor.tsx`、`app/components/OcrTextEditor.test.tsx`：从逐页编辑升级为逐段编辑。
- `app/components/ReportEditor.tsx`、`app/components/ReportEditor.test.tsx`：新报告显示逐段编辑器，旧报告显示明确旧版状态。
- `app/(protected)/reviews/ReviewPage.tsx`、`app/(protected)/reviews/ReviewPage.test.tsx`：接入逐段重写、完整重生成、保存复核、双格式导出和旧版缓存 PDF 下载。
- `app/(protected)/reviews/batch/BatchReviewPage.tsx`、`app/(protected)/reviews/batch/BatchReviewPage.test.tsx`：移除示范段数门禁并加入批量格式选择。
- `app/(protected)/page.tsx`、`app/(protected)/page.test.tsx`：历史单篇和批量导出都支持 PDF/Word。
- `app/components/ReviewExportList.tsx`、`app/components/ReviewExportList.test.tsx`：显示逐段导出资格与具体阻止原因。
- `app/lib/review-queue.ts`、`app/lib/review-queue.test.ts`：复用统一 `deliveryReadiness` 判定，不把旧报告视为新格式可导出。
- `app/lib/pdf-download.ts`、`app/lib/pdf-download.test.ts`：改为共享交付模型驱动的 A4 纵向 PDF 渲染器。
- `app/print/reviews/[id]/PrintReview.tsx`、`PrintReview.test.tsx`、`PrintReviewPage.tsx`、`PrintReviewPage.test.tsx`：本机打印页使用同一逐段交付顺序。
- `app/print/reviews/[id]/print.module.css`、`print-styles.test.ts`：A4 纵向、浅橙建议、楷体红黑修订和分页约束。
- `app/globals.css`：逐段编辑、裁图、建议底色、修订预览和导出菜单的响应式样式。
- `src/pdf/pdf-service.ts`、`src/pdf/pdf-service.test.ts`：推进版式发布日期、统一文件名、拒绝旧报告再生成，并允许同 revision 的旧版缓存 PDF 原样返回。
- `src/pdf/pdf-batch-service.ts`、`src/pdf/pdf-batch-service.test.ts`：保持顺序生成和失败原子性，更新 PDF ZIP 名称。
- `test/delivery-security.test.ts`、`test/static-export.test.ts`：覆盖模型隐私、OOXML 元数据和静态导出边界。
- `e2e/workbench.spec.ts`：更新新报告夹具并验证桌面/移动端无溢出。
- `README.md`：记录 OCR v2、双格式导出、旧报告升级和视觉 QA 方法。

### 明确不修改

- 不新增 D1 列或迁移：OCR v2 和逐段报告继续存入现有 JSON 字段。
- 不新增 Next.js 动态 Route Handler：项目保持 `output: "export"`，生产 API 仍由 `worker/index.ts` 提供。
- 不把参考 DOCX 内容写入产品或测试夹具；它只提供已批准的视觉方向。
- 不实现人工合并、拆分或重新框选段落。

### 核心类型约定

后续任务必须始终使用以下名称，避免同一概念出现多套签名：

```ts
type RevisionRunKind = "unchanged" | "inserted" | "deleted" | "punctuation";

interface RevisionRun {
  kind: RevisionRunKind;
  text: string;
}

interface ParagraphSuggestion {
  problem: string;
  advice: string;
  example: string;
}

interface ParagraphReview {
  paragraphId: string;
  suggestions: ParagraphSuggestion[];
  revisedText: string;
}

type ExportFormat = "pdf" | "docx";
```

## 任务 1：建立 OCR v2 自然段契约与稳定 ID

**文件：**
- 修改：`src/ocr/contracts.ts`
- 测试：`src/ocr/contracts.test.ts`

- [ ] **步骤 1：编写 OCR v2 失败测试**

新增合法单页、合法跨页、教师编辑后来源证据不变，以及空段、断号、越界、错页、乱序片段、段间重叠和初始文字不一致用例。稳定 ID 固定为 `paragraph-1`、`paragraph-2`：

```ts
const checkpoint = createOcrCheckpointV2({
  sourceRevision: 3,
  pages: [page(0), page(1)],
  paragraphs: [{
    paragraphIndex: 0,
    text: "第一段跨页正文",
    segments: [
      { pageIndex: 0, text: "第一段", x: 0.08, y: 0.72, width: 0.82, height: 0.2 },
      { pageIndex: 1, text: "跨页正文", x: 0.08, y: 0.06, width: 0.82, height: 0.18 },
    ],
  }],
});

expect(checkpoint.version).toBe(2);
expect(checkpoint.paragraphs[0].id).toBe("paragraph-1");
expect(checkpoint.paragraphs[0].segments).toHaveLength(2);
```

- [ ] **步骤 2：运行契约测试确认红灯**

运行：`npm test -- src/ocr/contracts.test.ts`

预期：FAIL，提示 `createOcrCheckpointV2`、`ocrCheckpointV2Schema` 或新段落字段不存在。

- [ ] **步骤 3：实现 v1/v2 联合 Schema 与构建器**

保留现有 v1 Schema，并新增以下导出。`superRefine` 校验连续索引、片段阅读顺序、页面引用、坐标和同页段落区域不相交；只有 `editedAt === null` 时要求规范化后的 `paragraph.text` 等于片段文字合并结果：

```ts
export const ocrParagraphSegmentSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  text: z.string().trim().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict()
  .refine((segment) => segment.x + segment.width <= 1, {
    message: "OCR paragraph segment must fit within the page width",
  })
  .refine((segment) => segment.y + segment.height <= 1, {
    message: "OCR paragraph segment must fit within the page height",
  });

export const ocrParagraphSchema = z.object({
  id: z.string().regex(/^paragraph-[1-9]\d*$/u),
  paragraphIndex: z.number().int().nonnegative(),
  text: z.string().trim().min(1),
  segments: z.array(ocrParagraphSegmentSchema).min(1),
}).strict();

export const ocrCheckpointSchema = z.union([
  ocrCheckpointV2Schema,
  ocrCheckpointV1Schema,
]);

export function isOcrCheckpointV2(value: OcrCheckpoint): value is OcrCheckpointV2 {
  return value.version === 2;
}
```

`createOcrCheckpointV2` 必须忽略模型提供的任意 ID，并在业务校验通过后按顺序生成 `paragraph-${index + 1}`。

- [ ] **步骤 4：运行测试确认绿灯并检查类型**

运行：

```bash
npm test -- src/ocr/contracts.test.ts
npx tsc --noEmit
```

预期：OCR 契约测试 PASS，`npx tsc --noEmit` 退出码为 0；不能把联合类型错误延期到后续任务。

- [ ] **步骤 5：提交 OCR 契约**

```bash
git add src/ocr/contracts.ts src/ocr/contracts.test.ts
git commit -m "feat(OCR): 增加自然段与跨页片段契约"
```

## 任务 2：建立新旧报告联合契约和逐段覆盖校验

**文件：**
- 修改：`src/domain/contracts.ts`
- 测试：`src/domain/contracts.test.ts`
- 修改：`src/domain/report-validation.ts`
- 创建：`src/domain/report-validation.test.ts`
- 修改：`src/ai/review-semantics.ts`

- [ ] **步骤 1：编写新旧报告联合 Schema 失败测试**

旧 `sampleParagraphs` 夹具必须继续可读；新报告必须携带 `version: 2` 且不能混入 `sampleParagraphs`：

```ts
const paragraphReport = {
  ...baseReport,
  version: 2,
  grade: "A" as const,
  diagnostics,
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "描写单一", advice: "补充听觉细节", example: "风吹过树叶，沙沙作响。" }],
    revisedText: "风吹过树叶，沙沙作响。",
  }],
};

expect(paragraphEvaluationReportSchema.parse(paragraphReport)).toEqual(paragraphReport);
expect(() => evaluationReportSchema.parse({ ...paragraphReport, sampleParagraphs: [] })).toThrow();
expect(isParagraphEvaluationReport(paragraphReport)).toBe(true);
```

- [ ] **步骤 2：编写逐段覆盖失败测试**

用任务 1 的 OCR v2 夹具测试正确覆盖，并分别拒绝遗漏、重复、乱序、未知 ID、0 条或 5 条建议、空问题/动作/示例和空修改稿：

```ts
expect(validateReport(paragraphReport, { config, ocr: checkpoint })).toEqual(paragraphReport);
expect(() => validateReport({
  ...paragraphReport,
  paragraphReviews: [{ ...paragraphReport.paragraphReviews[0], paragraphId: "paragraph-9" }],
}, { config, ocr: checkpoint })).toThrow("paragraph review coverage");
```

- [ ] **步骤 3：运行报告测试确认红灯**

运行：`npm test -- src/domain/contracts.test.ts src/domain/report-validation.test.ts`

预期：FAIL，缺少逐段 Schema、类型守卫和 OCR 覆盖校验。

- [ ] **步骤 4：实现联合类型和确定性校验**

把不含 `sampleParagraphs`/`paragraphReviews` 的通用字段提取为 `reportContentBaseSchema`；旧报告在它上面保留 `sampleParagraphs`，新报告使用严格对象，现有 40 分历史转换继续包在旧报告分支：

```ts
const reportContentBaseSchema = z.object({
  themeFit: z.enum(["fits", "partial", "off_topic"]),
  themeReason: z.string().trim().min(1),
  personalizedComment: z.string().trim().min(1),
  painPoints: z.array(z.string()),
  commonIssues: z.array(z.string()),
  revisionSuggestions: z.array(z.string()),
  parentFeedbacks: parentFeedbacksSchema,
});

export const paragraphSuggestionSchema = z.object({
  problem: z.string().trim().min(1),
  advice: z.string().trim().min(1),
  example: z.string().trim().min(1),
}).strict();

export const paragraphEvaluationReportSchema = reportContentBaseSchema.extend({
  version: z.literal(2),
  grade: compositionGradeSchema,
  diagnostics: diagnosticsSchema,
  paragraphReviews: z.array(paragraphReviewSchema).min(1),
}).strict();

export type EvaluationReport = LegacyEvaluationReport | ParagraphEvaluationReport;
```

在 `validateReport` 中仅对旧报告执行 `validateSampleWritingRequirements`；新报告必须收到当前 OCR v2，并逐项比较 `paragraphId`。`problem === "保留"` 仍要求非空 `advice` 与 `example`。

- [ ] **步骤 5：运行报告与现有语义测试**

运行：

```bash
npm test -- src/domain/contracts.test.ts src/domain/report-validation.test.ts src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts
```

预期：新增契约用例 PASS；旧报告和历史 40 分转换用例继续 PASS。

- [ ] **步骤 6：提交报告契约**

```bash
git add src/domain/contracts.ts src/domain/contracts.test.ts src/domain/report-validation.ts src/domain/report-validation.test.ts src/ai/review-semantics.ts
git commit -m "feat(报告): 增加逐段批改联合契约"
```

## 任务 3：让视觉模型直接识别自然段区域

**文件：**
- 修改：`src/ai/vision-ocr-adapter.ts`
- 测试：`src/ai/vision-ocr-adapter.test.ts`

- [ ] **步骤 1：编写视觉请求和响应失败测试**

断言提示词排除题目、姓名、班级、页码、格数说明和教师批注，允许同一段多个跨页片段；模型响应不带可信 ID：

```ts
expect(systemPrompt).toContain("只把作文正文自然段写入 paragraphs");
expect(systemPrompt).toContain("跨页延续使用同一个 paragraphIndex");
expect(systemPrompt).not.toContain("修改建议");
expect(await adapter.recognize({ imageUrls: ["data:image/jpeg;base64,AA=="] }))
  .toEqual({ pages: expect.any(Array), paragraphs: expect.any(Array) });
```

再测试缺段、断号、区域越界、片段页码超出图片数和段落合并文字不一致均返回 `AI_INVALID_RESPONSE`。

- [ ] **步骤 2：运行视觉适配器测试确认红灯**

运行：`npm test -- src/ai/vision-ocr-adapter.test.ts`

预期：FAIL，当前响应 Schema 只有 `pages`。

- [ ] **步骤 3：实现 OCR v2 模型输出解析**

模型响应使用不含 `id` 的 Schema：

```ts
const responseSchema = z.object({
  pages: z.array(ocrPageSchema).min(1).max(MAX_REVIEW_IMAGES),
  paragraphs: z.array(recognizedOcrParagraphSchema).min(1),
}).strict();

export interface VisionOcrResult {
  pages: OcrPage[];
  paragraphs: RecognizedOcrParagraph[];
}
```

适配器先校验图片页数、连续 `pageIndex` 和段落语义，但不在模型边界生成或接受任意 ID；稳定 ID 仍由 `createOcrCheckpointV2` 分配。

- [ ] **步骤 4：运行视觉测试确认绿灯**

运行：`npm test -- src/ai/vision-ocr-adapter.test.ts src/ocr/contracts.test.ts`

预期：两个测试文件全部 PASS。

- [ ] **步骤 5：提交视觉识别变更**

```bash
git add src/ai/vision-ocr-adapter.ts src/ai/vision-ocr-adapter.test.ts
git commit -m "feat(识图): 直接识别作文自然段区域"
```

## 任务 4：让内容模型只用段落文本生成新报告

**文件：**
- 修改：`src/ai/composition-review-adapter.ts`
- 测试：`src/ai/composition-review-adapter.test.ts`
- 修改：`src/ai/review-semantics.ts`
- 测试：`test/delivery-security.test.ts`

- [ ] **步骤 1：编写纯文本模型边界失败测试**

输入改成完整且有序的段落，捕获发给 OpenAI 兼容客户端的请求并递归扫描：

```ts
const input = {
  config,
  paragraphs: [
    { id: "paragraph-1", text: "第一段原文" },
    { id: "paragraph-2", text: "第二段原文" },
  ],
  studentName: "小明",
};

await adapter.analyzeText(input);
const serialized = JSON.stringify(create.mock.calls[0][0]);
expect(serialized).not.toMatch(/image_url|data:image|signed|segments|blocks|\"x\"|\"y\"/u);
expect(serialized).toContain("paragraph-1");
expect(serialized).toContain("第一段原文");
```

- [ ] **步骤 2：编写内容语义和一次修复失败测试**

覆盖每个 ID 恰好一次、1–4 条建议、问题+动作+示例、完整修改稿、具体“保留”项、未知/遗漏/乱序 ID，以及初次无效后一次完整 JSON 修复；第二次仍无效必须抛 `AI_INVALID_RESPONSE`，不得启动旧示范正文字数三次修复循环。

- [ ] **步骤 3：运行内容适配器测试确认红灯**

运行：`npm test -- src/ai/composition-review-adapter.test.ts test/delivery-security.test.ts`

预期：FAIL，当前输入仍为 `pages`，输出仍要求 `sampleParagraphs`。

- [ ] **步骤 4：实现逐段内容提示、Schema 和修复**

采用以下签名并让用户消息只承载数据：

```ts
export interface AnalyzeOcrTextInput {
  config: AssignmentConfig;
  paragraphs: Array<{ id: string; text: string }>;
  teacherGuidance?: string;
  studentName?: string;
}

const resultSchema = z.object({
  report: paragraphEvaluationReportSchema,
  annotationAnchors: z.array(paragraphAnnotationAnchorSchema),
}).strict();
```

系统提示明确学生原文是待分析数据而非指令；普通建议和“保留”建议都必须给具体动作与示例；修复请求仍只包含 `config`、`paragraphs`、无效文本和安全校验码。

- [ ] **步骤 5：运行 AI 与安全测试**

运行：

```bash
npm test -- src/ai/composition-review-adapter.test.ts test/delivery-security.test.ts
```

预期：两个实际存在的测试文件 PASS；逐段语义断言固定写在 `composition-review-adapter.test.ts`。

- [ ] **步骤 6：提交内容模型变更**

```bash
git add src/ai/composition-review-adapter.ts src/ai/composition-review-adapter.test.ts src/ai/review-semantics.ts test/delivery-security.test.ts
git commit -m "feat(内容模型): 按 OCR 自然段生成批改"
```

## 任务 5：持久化 OCR v2 并公开安全段落视图

**文件：**
- 修改：`src/cloudflare/d1-ocr-checkpoint.ts`
- 测试：`src/cloudflare/d1-ocr-checkpoint.test.ts`
- 修改：`src/cloudflare/d1-review-reader.ts`
- 测试：`src/cloudflare/d1-review-reader.test.ts`
- 修改：`src/db/review-repository.ts`
- 测试：`src/db/review-repository.test.ts`
- 修改：`app/lib/types.ts`
- 修改：`src/api/handlers.ts`
- 测试：`src/api/handlers.test.ts`
- 修改：`worker/index.ts`
- 测试：`worker/index.test.ts`

- [ ] **步骤 1：编写保存、编辑和公开视图失败测试**

测试首次保存调用构建器生成 `version: 2`/稳定 ID；教师编辑必须一次提交所有 `paragraphId/text`，只改变 `paragraph.text`、`ocrRevision` 与 `editedAt`：

```ts
const edited = await repository.editParagraphTexts("teacher-1", "review-1", 0, [
  { paragraphId: "paragraph-1", text: "教师修正后的第一段" },
]);

expect(edited.ocrRevision).toBe(1);
expect(edited.paragraphs[0].text).toBe("教师修正后的第一段");
expect(edited.paragraphs[0].segments).toEqual(checkpoint.paragraphs[0].segments);
expect(edited.pages).toEqual(checkpoint.pages);
```

公开视图必须包含 `version`、`paragraphs[].text` 和无 `text` 的裁图坐标，但 JSON 中不能出现 `blocks` 或 `segments[].text`。

- [ ] **步骤 2：运行仓储测试确认红灯**

运行：

```bash
npm test -- src/cloudflare/d1-ocr-checkpoint.test.ts src/cloudflare/d1-review-reader.test.ts src/db/review-repository.test.ts
```

预期：FAIL，当前仓储只保存/编辑逐页文本。

- [ ] **步骤 3：实现 D1 和 SQLite 的 v2 保存与编辑**

统一方法签名：

```ts
saveRecognized(
  ownerId: string,
  reviewId: string,
  sourceRevision: number,
  result: VisionOcrResult,
): Promise<OcrCheckpointV2>;

editParagraphTexts(
  ownerId: string,
  reviewId: string,
  expectedOcrRevision: number,
  edits: Array<{ paragraphId: string; text: string }>,
): Promise<OcrCheckpointV2>;
```

SQLite 同步把 `ReviewRepository.saveRecognizedOcr` 改为接收完整 `VisionOcrResult`。D1 条件更新继续校验 `image_revision` 与 `ocrRevision`，不增加列。

- [ ] **步骤 4：实现详情 DTO 和 OCR PATCH 契约**

`ReviewView["ocr"]` 改为联合公开类型：

```ts
type PublicOcrView =
  | { version: 1; ocrRevision: number; editedAt: string | null; pages: PublicOcrPage[] }
  | {
      version: 2;
      ocrRevision: number;
      editedAt: string | null;
      pages: PublicOcrPage[];
      paragraphs: Array<{
        id: string;
        paragraphIndex: number;
        text: string;
        segments: Array<{ pageIndex: number; x: number; y: number; width: number; height: number }>;
      }>;
    };
```

`PATCH /api/reviews/:id/ocr` 请求使用 `{ expectedOcrRevision, paragraphs }`。v1 返回 `OCR_V2_REQUIRED`，不能把逐页编辑伪装成自然段编辑。

- [ ] **步骤 5：运行仓储、路由和隐私测试**

运行：

```bash
npm test -- src/cloudflare/d1-ocr-checkpoint.test.ts src/cloudflare/d1-review-reader.test.ts src/db/review-repository.test.ts src/api/handlers.test.ts worker/index.test.ts test/delivery-security.test.ts
```

预期：全部 PASS，公开响应扫描不到 `blocks`。

- [ ] **步骤 6：提交 OCR 持久化**

```bash
git add src/cloudflare/d1-ocr-checkpoint.ts src/cloudflare/d1-ocr-checkpoint.test.ts src/cloudflare/d1-review-reader.ts src/cloudflare/d1-review-reader.test.ts src/db/review-repository.ts src/db/review-repository.test.ts app/lib/types.ts src/api/handlers.ts src/api/handlers.test.ts worker/index.ts worker/index.test.ts test/delivery-security.test.ts
git commit -m "feat(OCR): 持久化并复核自然段文字"
```

## 任务 6：迁移分析流水线、批注映射和旧报告升级规则

**文件：**
- 创建：`src/ocr/analysis-mode.ts`
- 创建：`src/ocr/analysis-mode.test.ts`
- 修改：`src/ocr/annotation-mapper.ts`
- 测试：`src/ocr/annotation-mapper.test.ts`
- 修改：`src/cloudflare/cloud-analysis-pipeline.ts`
- 测试：`src/cloudflare/cloud-analysis-pipeline.test.ts`
- 修改：`src/jobs/analysis-worker.ts`
- 测试：`src/jobs/analysis-jobs.test.ts`
- 修改：`scripts/worker.ts`
- 修改：`worker/index.ts`
- 测试：`worker/index.test.ts`
- 修改：`src/cloudflare/d1-analysis-jobs.ts`
- 测试：`src/cloudflare/d1-analysis-jobs.test.ts`
- 修改：`src/cloudflare/d1-reanalysis.ts`
- 测试：`src/cloudflare/d1-reanalysis.test.ts`
- 修改：`src/reanalysis/reanalysis-repository.ts`
- 测试：`src/reanalysis/reanalysis-repository.test.ts`

- [ ] **步骤 1：编写段落锚点映射失败测试**

新内容模型锚点使用 `paragraphId`，映射器按该段片段文字和对应页面 blocks 定位；跨页时只在唯一包含 `anchorText` 的片段落点，重复候选仍放弃：

```ts
expect(mapAnnotationAnchors(checkpointV2, [{
  paragraphId: "paragraph-1",
  category: "structure",
  anchorText: "转折之后",
  comment: "补充因果",
  isHighlight: false,
}])).toEqual([expect.objectContaining({ pageIndex: 1, x: 0.12, y: 0.08 })]);
```

- [ ] **步骤 2：编写流水线和升级模式失败测试**

覆盖以下分支：首次 full 生成 v2；已有 v2 时 content-only 跳过视觉模型；已有 v1 时 full 重新调用视觉模型；v1 的 content-only 返回 `OCR_V2_REQUIRED`；旧 `sampleParagraphs` 的退回/批量重新分析都排 full；OCR v2 教师编辑后 content-only 使用最新 `paragraph.text`。

- [ ] **步骤 3：运行编排测试确认红灯**

运行：

```bash
npm test -- src/ocr/analysis-mode.test.ts src/ocr/annotation-mapper.test.ts src/cloudflare/cloud-analysis-pipeline.test.ts src/jobs/analysis-jobs.test.ts src/cloudflare/d1-analysis-jobs.test.ts src/cloudflare/d1-reanalysis.test.ts src/reanalysis/reanalysis-repository.test.ts worker/index.test.ts
```

预期：FAIL，流水线仍把 `pages[].text` 传给内容模型并复用 OCR v1。

- [ ] **步骤 4：实现统一 v2 选择和内容输入**

在 `src/ocr/analysis-mode.ts` 新增纯函数并在 Cloudflare、本机任务和重新分析仓储复用：

```ts
export function analysisModeForCheckpoint(
  requested: "full" | "content_only",
  checkpoint: OcrCheckpoint | null,
): "full" | "content_only" {
  if (requested === "content_only" && (!checkpoint || checkpoint.version !== 2)) {
    throw Object.assign(new Error("OCR_V2_REQUIRED"), { code: "OCR_V2_REQUIRED" });
  }
  return checkpoint?.version === 2 ? requested : "full";
}
```

内容调用固定为：

```ts
analyzeText({
  config: job.config,
  paragraphs: checkpoint.paragraphs.map(({ id, text }) => ({ id, text })),
  teacherGuidance: job.teacherGuidance,
  studentName: job.studentName,
});
```

保存报告继续用 `analysis_run_id + image_revision + ocrRevision` CAS，报告与 OCR 版本必须同时成功或同时不落库。

- [ ] **步骤 5：运行编排回归测试**

运行步骤 3 的同一命令。

预期：全部 PASS；内容模型 mock 从未收到页图、坐标或 blocks。

- [ ] **步骤 6：提交流水线迁移**

```bash
git add src/ocr/analysis-mode.ts src/ocr/analysis-mode.test.ts src/ocr/annotation-mapper.ts src/ocr/annotation-mapper.test.ts src/cloudflare/cloud-analysis-pipeline.ts src/cloudflare/cloud-analysis-pipeline.test.ts src/jobs/analysis-worker.ts src/jobs/analysis-jobs.test.ts src/cloudflare/d1-analysis-jobs.ts src/cloudflare/d1-analysis-jobs.test.ts src/cloudflare/d1-reanalysis.ts src/cloudflare/d1-reanalysis.test.ts src/reanalysis/reanalysis-repository.ts src/reanalysis/reanalysis-repository.test.ts scripts/worker.ts worker/index.ts worker/index.test.ts
git commit -m "feat(分析): 以 OCR v2 自然段驱动批改"
```

## 任务 7：实现确定性红黑差异

**文件：**
- 修改：`package.json`
- 修改：`package-lock.json`
- 创建：`src/revisions/revision-diff.ts`
- 创建：`src/revisions/revision-diff.test.ts`

- [ ] **步骤 1：安装成熟 Myers diff 依赖**

运行：`npm install diff`

预期：`package.json` 增加 `diff`，锁文件固定实际版本；不得另装手写 diff 替代库。

- [ ] **步骤 2：编写全部边界失败测试**

至少固定以下期望：

```ts
expect(buildRevisionRuns("我很高兴。", "我非常高兴！")).toEqual([
  { kind: "unchanged", text: "我" },
  { kind: "deleted", text: "很" },
  { kind: "inserted", text: "非常" },
  { kind: "unchanged", text: "高兴" },
  { kind: "punctuation", text: "！" },
]);

expect(buildRevisionRuns("你好，世界。", "你好。世界！")).toEqual([
  { kind: "unchanged", text: "你好" },
  { kind: "punctuation", text: "。" },
  { kind: "unchanged", text: "世界" },
  { kind: "punctuation", text: "！" },
]);

expect(buildRevisionRuns("我先整理书桌，再浇花。", "我先浇花，再整理书桌。")).toEqual([
  { kind: "unchanged", text: "我先浇花" },
  { kind: "punctuation", text: "，" },
  { kind: "unchanged", text: "再整理书桌" },
  { kind: "punctuation", text: "。" },
]);
```

另外覆盖纯新增、纯删除、整句调序、重复汉字导致的非唯一移动候选、连续多处修改、CRLF/换行、emoji、代理对和组合字符。

- [ ] **步骤 3：运行差异测试确认红灯**

运行：`npm test -- src/revisions/revision-diff.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 4：实现字素切分、标点中性化和移动检测**

实现顺序必须固定：

```ts
const segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
const isNeutral = (value: string) => /^[\p{P}\p{Z}\s]+$/u.test(value);
const sourceWords = graphemes(source).filter((value) => !isNeutral(value));
const revisedWords = graphemes(revised).filter((value) => !isNeutral(value));
const changes = diffArrays(sourceWords, revisedWords);
```

只渲染修改稿中的标点/空白为 `punctuation`，所以删除标点消失、新增标点为黑色。对基础 diff 的删除/新增连续文字按“完整文本相同且两侧都唯一”配对：新增端改为 `unchanged`，删除端抑制；重复候选不猜移动。剩余删除先于同锚点新增输出，最后合并相邻同类片段并丢弃空字符串。

- [ ] **步骤 5：运行差异测试和类型检查**

运行：

```bash
npm test -- src/revisions/revision-diff.test.ts
npx tsc --noEmit
```

预期：差异测试全部 PASS；不存在把标点标红或把 Unicode 字素拆坏的结果。

- [ ] **步骤 6：提交差异模块**

```bash
git add package.json package-lock.json src/revisions/revision-diff.ts src/revisions/revision-diff.test.ts
git commit -m "feat(修订): 增加确定性红黑差异计算"
```

## 任务 8：建立统一导出门禁、裁图和共享交付模型

**文件：**
- 创建：`src/delivery/contracts.ts`
- 创建：`src/delivery/readiness.ts`
- 创建：`src/delivery/readiness.test.ts`
- 创建：`app/lib/image-crop.ts`
- 创建：`app/lib/image-crop.test.ts`
- 创建：`app/lib/delivery-document.ts`
- 创建：`app/lib/delivery-document.test.ts`
- 修改：`app/lib/review-queue.ts`
- 测试：`app/lib/review-queue.test.ts`
- 修改：`src/cloudflare/d1-review-reader.ts`
- 测试：`src/cloudflare/d1-review-reader.test.ts`
- 修改：`src/cloudflare/d1-review-writer.ts`
- 测试：`src/cloudflare/d1-review-writer.test.ts`
- 修改：`src/db/review-repository.ts`
- 测试：`src/db/review-repository.test.ts`

- [ ] **步骤 1：编写导出门禁失败测试**

统一函数返回具体原因而不是布尔猜测：

```ts
expect(deliveryReadiness({ ...review, report: legacyReport })).toEqual({
  ready: false,
  code: "LEGACY_REPORT",
  message: "旧版示范段落报告需要完整重新分析后才能导出新格式",
});

expect(deliveryReadiness(completeParagraphReview)).toEqual({ ready: true });
```

分别测试未复核、OCR v1、报告过期、段落覆盖不一致、无裁图、越界片段、建议字段缺失、修改稿为空和图片页缺失。旧报告即使带同 revision 的 PDF 缓存，`deliveryReadiness` 仍必须返回 `LEGACY_REPORT`；旧文件原样下载由任务 11 的 `PdfService` 专门处理，不能绕过这里生成新格式。

- [ ] **步骤 2：编写裁图和交付构建失败测试**

用 1000×1500 合成 bitmap 验证 `{x:.1,y:.2,width:.5,height:.3}` 四周增加页面尺寸 1% 后换算为 `{left:90,top:285,width:520,height:480}` 并夹紧边界。构建器必须按 `paragraphIndex` 和 segment 顺序输出：

```ts
expect(document.paragraphs[0]).toMatchObject({
  paragraphNumber: 1,
  crops: [{ pageIndex: 0 }, { pageIndex: 1 }],
  suggestions: paragraphReport.paragraphReviews[0].suggestions,
  revisionRuns: buildRevisionRuns(originalText, revisedText),
});
```

- [ ] **步骤 3：运行门禁与构建测试确认红灯**

运行：

```bash
npm test -- src/delivery/readiness.test.ts app/lib/image-crop.test.ts app/lib/delivery-document.test.ts app/lib/review-queue.test.ts
```

预期：FAIL，新模块不存在，旧 `exportEligibility` 只检查报告和复核时间。

- [ ] **步骤 4：实现交付类型和版式令牌**

```ts
export const DELIVERY_STYLE = {
  page: { widthMm: 210, heightMm: 297, marginXmm: 18, marginYmm: 16 },
  colors: { text: "171717", change: "C91F32", suggestion: "FFF0BD" },
  fontPt: { title: 16, section: 11, suggestion: 10.5, revision: 11.5 },
} as const;

export interface DeliveryDocument {
  title: string;
  studentName: string;
  paragraphs: DeliveryParagraph[];
}
```

`deliveryReadiness` 必须调用任务 2 的 Schema/覆盖校验，并确认 `teacherReviewedAt`、`reportStale`、OCR v2 和图片页映射。

- [ ] **步骤 5：实现一次加载、多段裁剪和原子构建**

`buildDeliveryDocument(review, dependencies)` 每页只请求一次 `variant=ai`，按实际 bitmap 尺寸裁剪，输出 PNG `Uint8Array`；发生任何页加载或 Canvas 错误时抛：

```ts
throw new DeliveryBuildError(
  "CROP_FAILED",
  `第 ${paragraphIndex + 1} 段第 ${segment.pageIndex + 1} 页裁图失败`,
);
```

失败时不得返回部分 `DeliveryDocument`。完成后关闭 `ImageBitmap` 并释放临时 object URL。

- [ ] **步骤 6：把本机和 D1 导出检查接入同一门禁**

D1 `checkExportable` 和 `markExported` 必须读取/解析报告与 OCR，而不是只看时间戳；SQLite `checkTeacherReviewedForExport` 执行同样判断。查询始终带 `owner_id`，返回条目数必须与请求数完全一致。

- [ ] **步骤 7：运行门禁、仓储和构建测试**

运行：

```bash
npm test -- src/delivery/readiness.test.ts app/lib/image-crop.test.ts app/lib/delivery-document.test.ts app/lib/review-queue.test.ts src/cloudflare/d1-review-reader.test.ts src/cloudflare/d1-review-writer.test.ts src/db/review-repository.test.ts
```

预期：全部 PASS；旧报告和缺裁图报告都不能复核为新格式可导出。

- [ ] **步骤 8：提交共享交付模型**

```bash
git add src/delivery/contracts.ts src/delivery/readiness.ts src/delivery/readiness.test.ts app/lib/image-crop.ts app/lib/image-crop.test.ts app/lib/delivery-document.ts app/lib/delivery-document.test.ts app/lib/review-queue.ts app/lib/review-queue.test.ts src/cloudflare/d1-review-reader.ts src/cloudflare/d1-review-reader.test.ts src/cloudflare/d1-review-writer.ts src/cloudflare/d1-review-writer.test.ts src/db/review-repository.ts src/db/review-repository.test.ts
git commit -m "feat(导出): 建立逐段裁图与共享交付模型"
```

## 任务 9：实现单段 AI 重写接口

**文件：**
- 修改：`src/ai/openai-review-adapter.ts`
- 测试：`src/ai/openai-review-adapter.test.ts`
- 修改：`src/services/review-service.ts`
- 测试：`src/services/review-service.test.ts`
- 修改：`src/api/handlers.ts`
- 测试：`src/api/handlers.test.ts`
- 修改：`worker/index.ts`
- 测试：`worker/index.test.ts`

- [ ] **步骤 1：编写单段重写模型边界失败测试**

请求必须携带当前段原文、全文段落上下文、当前建议/修改稿、作文配置和可选要求，且不得含图片或坐标：

```ts
const result = await adapter.rewriteParagraph({
  config,
  paragraphs: [{ id: "paragraph-1", text: "原文" }],
  current: paragraphReview,
  paragraphId: "paragraph-1",
  instruction: "补充听觉细节",
});

expect(result.paragraphId).toBe("paragraph-1");
expect(JSON.stringify(request)).not.toMatch(/image_url|segments|blocks|\"x\"|\"y\"/u);
```

模型返回其他 ID、空字段或 5 条建议必须失败；只允许一次结构修复。

- [ ] **步骤 2：编写服务和 Worker 路由失败测试**

新路由固定为 `POST /api/reviews/:id/paragraph-reviews/:paragraphId`。服务端从租户内 OCR v2 取原文和上下文，使用请求中的当前逐段报告作为教师未保存草稿，但先验证完整覆盖；旧报告返回 `LEGACY_REPORT`，过期 OCR 返回 `REPORT_STALE`。

- [ ] **步骤 3：运行重写测试确认红灯**

运行：

```bash
npm test -- src/ai/openai-review-adapter.test.ts src/services/review-service.test.ts src/api/handlers.test.ts worker/index.test.ts
```

预期：FAIL，尚无 `rewriteParagraph` 和新路由。

- [ ] **步骤 4：实现适配器、服务和两套路由接线**

统一输入输出：

```ts
export interface RewriteParagraphInput {
  config: AssignmentConfig;
  paragraphs: Array<{ id: string; text: string }>;
  current: ParagraphReview;
  paragraphId: string;
  instruction?: string;
}

export type RewriteParagraphResult = ParagraphReview;
```

`src/api/handlers.ts` 和 `worker/index.ts` 使用同一请求 Schema：`{ paragraphReviews, instruction? }`。旧 `/sample-paragraphs/*` 路由保留并显式只服务旧报告；新 UI 不再调用它们。

- [ ] **步骤 5：运行重写与隐私测试**

运行：

```bash
npm test -- src/ai/openai-review-adapter.test.ts src/services/review-service.test.ts src/api/handlers.test.ts worker/index.test.ts test/delivery-security.test.ts
```

预期：全部 PASS；内容模型请求扫描不到图片、URL、Base64、坐标和内部路径。

- [ ] **步骤 6：提交单段重写**

```bash
git add src/ai/openai-review-adapter.ts src/ai/openai-review-adapter.test.ts src/services/review-service.ts src/services/review-service.test.ts src/api/handlers.ts src/api/handlers.test.ts worker/index.ts worker/index.test.ts test/delivery-security.test.ts
git commit -m "feat(复核): 支持 AI 重新生成单段批改"
```

## 任务 10：升级 OCR 与逐段教师复核界面

**文件：**
- 修改：`app/components/OcrTextEditor.tsx`
- 测试：`app/components/OcrTextEditor.test.tsx`
- 创建：`app/components/RevisionPreview.tsx`
- 创建：`app/components/RevisionPreview.test.tsx`
- 创建：`app/components/ParagraphCropPreview.tsx`
- 创建：`app/components/ParagraphCropPreview.test.tsx`
- 创建：`app/components/ParagraphReviewEditor.tsx`
- 创建：`app/components/ParagraphReviewEditor.test.tsx`
- 修改：`app/components/ReportEditor.tsx`
- 测试：`app/components/ReportEditor.test.tsx`
- 修改：`app/(protected)/reviews/ReviewPage.tsx`
- 测试：`app/(protected)/reviews/ReviewPage.test.tsx`
- 修改：`app/(protected)/reviews/batch/BatchReviewPage.tsx`
- 测试：`app/(protected)/reviews/batch/BatchReviewPage.test.tsx`
- 修改：`app/globals.css`

- [ ] **步骤 1：阅读 Next.js 16.2 本地指南后再改组件**

运行：

```bash
sed -n '1,240p' node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md
sed -n '1,240p' node_modules/next/dist/docs/01-app/01-getting-started/11-css.md
sed -n '1,240p' node_modules/next/dist/docs/01-app/01-getting-started/12-images.md
sed -n '1,240p' node_modules/next/dist/docs/01-app/02-guides/static-exports.md
```

预期：确认裁图组件保持 Client Component、受保护图片继续用原生同源请求、CSS 不依赖运行时服务端 API、项目不新增动态 Route Handler。

- [ ] **步骤 2：编写逐段 OCR 编辑失败测试**

OCR v2 渲染一个 textarea/自然段，保存发送：

```ts
expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({
  expectedOcrRevision: 2,
  paragraphs: [
    { paragraphId: "paragraph-1", text: "修正第一段" },
    { paragraphId: "paragraph-2", text: "第二段" },
  ],
});
```

OCR v1 只显示“需要完整重新识别”，不显示可提交的逐页编辑器。

- [ ] **步骤 3：编写严格展示顺序和修订预览失败测试**

用 DOM 顺序断言每段依次出现 `【第 1 段】`、裁图、`【修改建议】`、`【修改后段落】`；建议逐项有“问题描述”“修改动作”“修改示例”字段；`保留`项可保存。`RevisionPreview` 必须把 inserted/deleted 设为 `#C91F32`，deleted 带 `<del>`，unchanged/punctuation 保持黑色。

- [ ] **步骤 4：运行组件测试确认红灯**

运行：

```bash
npm test -- app/components/OcrTextEditor.test.tsx app/components/RevisionPreview.test.tsx app/components/ParagraphCropPreview.test.tsx app/components/ParagraphReviewEditor.test.tsx app/components/ReportEditor.test.tsx
```

预期：FAIL，新组件不存在，旧编辑器仍显示示范段落。

- [ ] **步骤 5：实现逐段编辑组件和实际裁图预览**

`ParagraphReviewEditor` props 固定为：

```ts
interface ParagraphReviewEditorProps {
  reviewId: string;
  report: ParagraphEvaluationReport;
  ocr: Extract<PublicOcrView, { version: 2 }>;
  disabled: boolean;
  onChange: (report: ParagraphEvaluationReport) => void;
  onRewriteParagraph?: (paragraphId: string, instruction?: string) => Promise<void>;
  rewritingParagraphId?: string | null;
}
```

每段允许增加建议至最多 4 条、删除至最少 1 条；跨页片段显示“第 N 页续”。`ParagraphCropPreview` 调用任务 8 的裁图函数和 `variant=ai`，在 effect 清理 object URL。修改稿 textarea 每次变化立即调用 `buildRevisionRuns` 更新预览。

- [ ] **步骤 6：让 ReportEditor 显式分流新旧报告**

新报告渲染 `ParagraphReviewEditor`；旧报告只读展示现有 `sampleParagraphs`、等级、诊断、家长反馈和图片批注，在标题显示“旧版示范段落报告”，且不渲染建议、范文或逐段修改的编辑控件。给父页面 `legacyReport=true` 以禁用新导出；不要把两套段落编辑器同时显示。

- [ ] **步骤 7：接入单篇与批量页面**

移除 `expectedSampleParagraphCount` 和 `sampleParagraphCountMismatch` 对新报告的影响。单段重写把当前 `paragraphReviews` 发送给任务 9 路由；全文重生成调用现有 analyze API 的 `{ mode: "content_only" }`，仅在 OCR v2 且用户确认覆盖未保存修改后执行。缺裁图、报告过期或覆盖错误时显示具体段号并禁用“审核通过”。

- [ ] **步骤 8：实现克制的响应式样式并运行组件测试**

新增样式必须使用黑色正文、`#FFF0BD` 建议底色、`#C91F32` 改动色和楷体预览；逐段单元使用分隔线而不是嵌套卡片。裁图设稳定 `aspect-ratio`/最大高度，移动端按钮和最长字段不溢出。

运行：

```bash
npm test -- app/components/OcrTextEditor.test.tsx app/components/RevisionPreview.test.tsx app/components/ParagraphCropPreview.test.tsx app/components/ParagraphReviewEditor.test.tsx app/components/ReportEditor.test.tsx "app/(protected)/reviews/ReviewPage.test.tsx" "app/(protected)/reviews/batch/BatchReviewPage.test.tsx"
```

预期：全部 PASS。

- [ ] **步骤 9：提交复核界面**

```bash
git add app/components/OcrTextEditor.tsx app/components/OcrTextEditor.test.tsx app/components/RevisionPreview.tsx app/components/RevisionPreview.test.tsx app/components/ParagraphCropPreview.tsx app/components/ParagraphCropPreview.test.tsx app/components/ParagraphReviewEditor.tsx app/components/ParagraphReviewEditor.test.tsx app/components/ReportEditor.tsx app/components/ReportEditor.test.tsx 'app/(protected)/reviews/ReviewPage.tsx' 'app/(protected)/reviews/ReviewPage.test.tsx' 'app/(protected)/reviews/batch/BatchReviewPage.tsx' 'app/(protected)/reviews/batch/BatchReviewPage.test.tsx' app/globals.css
git commit -m "feat(复核页): 按自然段展示裁图与红黑修改"
```

## 任务 11：实现共享分页和 A4 纵向 PDF

**文件：**
- 创建：`app/lib/delivery-pagination.ts`
- 创建：`app/lib/delivery-pagination.test.ts`
- 修改：`app/lib/pdf-download.ts`
- 测试：`app/lib/pdf-download.test.ts`
- 修改：`app/print/reviews/[id]/PrintReview.tsx`
- 测试：`app/print/reviews/[id]/PrintReview.test.tsx`
- 修改：`app/print/reviews/[id]/PrintReviewPage.tsx`
- 测试：`app/print/reviews/[id]/PrintReviewPage.test.tsx`
- 修改：`app/print/reviews/[id]/print.module.css`
- 测试：`app/print/reviews/[id]/print-styles.test.ts`
- 修改：`src/pdf/pdf-service.ts`
- 测试：`src/pdf/pdf-service.test.ts`
- 修改：`src/pdf/pdf-batch-service.ts`
- 测试：`src/pdf/pdf-batch-service.test.ts`

- [ ] **步骤 1：编写分页规划失败测试**

使用毫米版面和可控文本测量器，验证：标题和首图同页；建议标题和首条同页；修改稿标题和至少两行同页；完整单元能放下时不拆；剩余不足时整单元换页；超长单元生成 `第 X 段（续）`/`修改建议（续）`/`修改后段落（续）`；普通页剩余空白不超过一个本可放下的完整单元高度。

- [ ] **步骤 2：编写 PDF 失败测试**

更新 jsPDF mock 断言：

```ts
expect(pdfMock.constructorOptions).toMatchObject({
  orientation: "portrait",
  unit: "pt",
  format: "a4",
});
expect(pdfMock.setProperties).toHaveBeenCalledWith({
  title: "作文题目",
  subject: "作文逐段批改",
  author: "AI 作业批改助手",
});
```

Canvas 调用必须绘制浅橙底、黑色标题、红色新增/删除线和段落裁图；浏览器 `createReviewPdf` 收到旧报告时应在创建 PDF 前抛 `LEGACY_REPORT`。

为服务端 `PdfService` 增加两个顺序敏感用例：旧报告若 `pdfRevision === revision`、文件名/路径一致且缓存文件可读，必须在新格式门禁和浏览器启动前原样返回 `{ cached: true }`，即使缓存早于 `PDF_LAYOUT_RELEASED_AT`；同条件下缓存缺失，或旧报告没有同 revision 缓存，必须抛 `LEGACY_REPORT` 且不得启动浏览器、写文件或调用 `markExported`。

- [ ] **步骤 3：运行分页与 PDF 测试确认红灯**

运行：

```bash
npm test -- app/lib/delivery-pagination.test.ts app/lib/pdf-download.test.ts "app/print/reviews/[id]/PrintReview.test.tsx" "app/print/reviews/[id]/PrintReviewPage.test.tsx" "app/print/reviews/[id]/print-styles.test.ts" src/pdf/pdf-service.test.ts src/pdf/pdf-batch-service.test.ts
```

预期：FAIL，当前 PDF 是 A4 横向三栏。

- [ ] **步骤 4：实现格式无关分页规划器**

规划器输出明确页面块，不持久化：

```ts
type DeliveryPageBlock =
  | { kind: "paragraph-heading"; paragraphNumber: number; continued: boolean }
  | { kind: "crop"; cropIndex: number; widthMm: number; heightMm: number }
  | { kind: "suggestion-heading"; continued: boolean }
  | { kind: "suggestion"; suggestionIndex: number }
  | { kind: "revision-heading"; continued: boolean }
  | { kind: "revision-lines"; runs: RevisionRun[] };
```

版面固定 A4 210×297mm、左右 18mm、上下 16mm。图片保持比例且不得超过可用宽高；不通过缩小到不可读字号解决溢出。

- [ ] **步骤 5：重写浏览器 PDF 渲染器**

每个 A4 页面先按 2× scale 绘制到 Canvas，再整页写入 jsPDF。标题 16pt 楷体居中；三个区标题 11pt 黑色；建议 10.5pt 黑色/浅橙底；修改稿 11.5pt 楷体；deleted 逐 run 计算文字宽度并画红色删除线。PDF 只消费 `DeliveryDocument` 和分页计划，不再读取 `sampleParagraphs` 或整页作文图。

- [ ] **步骤 6：同步本机打印页和 PDF 服务门禁**

`PrintReviewPage` 获取详情后构建 `DeliveryDocument`，完成裁图 object URL 与图片 decode 后才设置 `data-print-ready="true"`。CSS 使用：

```css
@page { size: A4 portrait; margin: 16mm 18mm; }
.revision { font-family: "LXGW WenKai", STKaiti, KaiTi, serif; font-size: 11.5pt; color: #171717; }
.suggestions { background: #fff0bd; }
.inserted, .deleted { color: #c91f32; }
.deleted { text-decoration: line-through; }
```

推进 `PDF_LAYOUT_RELEASED_AT`，并把 `LEGACY_REPORT` 加入 `PdfServiceError`。`PdfService` 读取记录后先尝试“同 revision 旧报告缓存”专用分支：路径/文件名元数据有效且文件可读时原样返回；文件缺失时不降级生成。只有排除该分支后才执行统一新格式门禁，再决定是否启动浏览器。新报告缓存仍遵守版式发布日期；文件名改为 `作文批改-<题目>-<学生>.pdf`，批量为 `作文批改批量导出-PDF.zip`。

- [ ] **步骤 7：运行 PDF 相关测试**

运行步骤 3 的同一命令。

预期：全部 PASS；样式测试不再出现 `landscape`、蓝色标题或三栏 grid。

- [ ] **步骤 8：提交 PDF 纵向交付**

```bash
git add app/lib/delivery-pagination.ts app/lib/delivery-pagination.test.ts app/lib/pdf-download.ts app/lib/pdf-download.test.ts 'app/print/reviews/[id]/PrintReview.tsx' 'app/print/reviews/[id]/PrintReview.test.tsx' 'app/print/reviews/[id]/PrintReviewPage.tsx' 'app/print/reviews/[id]/PrintReviewPage.test.tsx' 'app/print/reviews/[id]/print.module.css' 'app/print/reviews/[id]/print-styles.test.ts' src/pdf/pdf-service.ts src/pdf/pdf-service.test.ts src/pdf/pdf-batch-service.ts src/pdf/pdf-batch-service.test.ts
git commit -m "feat(PDF): 改为 A4 纵向逐段交付"
```

## 任务 12：生成可编辑且可离线打开的 DOCX

**文件：**
- 修改：`package.json`
- 修改：`package-lock.json`
- 创建：`app/lib/docx-download.ts`
- 创建：`app/lib/docx-download.test.ts`

- [ ] **步骤 1：安装 DOCX 生成依赖**

运行：`npm install docx`

预期：`package.json` 增加浏览器可用的 `docx`，锁文件固定实际版本。

- [ ] **步骤 2：编写 OOXML 结构失败测试**

生成包含两段、跨页裁图、普通建议、“保留”、新增、删除、替换、调序和标点的 DOCX，用 JSZip 解包并断言：

```ts
expect(Object.keys(zip.files).filter((name) => name.startsWith("word/media/")))
  .toHaveLength(totalCropCount);
expect(documentXml).toContain("<w:numPr>");
expect(documentXml).toContain('w:fill="FFF0BD"');
expect(documentXml).toContain('w:color w:val="C91F32"');
expect(documentXml).toContain("<w:strike");
expect(documentXml).toMatch(/w:eastAsia="(?:楷体|KaiTi)"/u);
expect(relsXml).not.toContain('TargetMode="External"');
expect(coreXml).not.toMatch(/openai|deepseek|api[_ -]?key|\/Users\//iu);
```

图片 `docPr` 必须含“第 X 段原文裁图，第 N 页”替代文字。

- [ ] **步骤 3：运行 DOCX 测试确认红灯**

运行：`npm test -- app/lib/docx-download.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 4：实现 A4 文档、真实编号和嵌入图片**

`createReviewDocx(delivery, pages)` 使用 `Document`/`Paragraph`/`TextRun`/`ImageRun`/`Packer.toBlob`。section 明确设置 A4 纵向与 18mm/16mm 边距；标题是普通居中段落，不使用 Word 内置 Title 样式；建议使用 `numbering.reference = "paragraph-suggestions"` 的真实编号，不使用 Unicode 假项目符号或表格包装正文。

建议连续段落都设置 `shading: { fill: "FFF0BD", type: ShadingType.CLEAR }`；修改稿按 run 生成：

```ts
new TextRun({
  text: run.text,
  font: { name: "KaiTi", eastAsia: "楷体" },
  size: 23,
  color: run.kind === "inserted" || run.kind === "deleted" ? "C91F32" : "171717",
  strike: run.kind === "deleted",
});
```

每张 `ImageRun` 使用裁图字节和保持比例的 transformation，并提供 `altText`；禁止临时 URL/远程关系。

- [ ] **步骤 5：实现可预测分页和文档属性**

使用任务 11 的页面计划在页间插入显式 page break，并输出续标题；同页通过 `keepNext` 绑定段标题与首图、建议标题与第一项、修改稿标题与首段。creator 固定为“AI 作业批改助手”，title/subject 只用作文题目和产品用途，不写教师账号、模型、密钥或路径。

- [ ] **步骤 6：运行 DOCX 结构测试**

运行：`npm test -- app/lib/docx-download.test.ts`

预期：PASS，所有图片关系均为包内媒体，建议和修改稿是可编辑文本节点。

- [ ] **步骤 7：提交 DOCX 生成器**

```bash
git add package.json package-lock.json app/lib/docx-download.ts app/lib/docx-download.test.ts
git commit -m "feat(Word): 生成可编辑逐段批改文档"
```

## 任务 13：接入单篇与批量双格式导出菜单

**文件：**
- 创建：`app/lib/review-export.ts`
- 创建：`app/lib/review-export.test.ts`
- 创建：`app/components/ExportMenu.tsx`
- 创建：`app/components/ExportMenu.test.tsx`
- 修改：`app/(protected)/reviews/ReviewPage.tsx`
- 测试：`app/(protected)/reviews/ReviewPage.test.tsx`
- 修改：`app/(protected)/reviews/batch/BatchReviewPage.tsx`
- 测试：`app/(protected)/reviews/batch/BatchReviewPage.test.tsx`
- 修改：`app/(protected)/page.tsx`
- 测试：`app/(protected)/page.test.tsx`
- 修改：`app/components/ReviewExportList.tsx`
- 测试：`app/components/ReviewExportList.test.tsx`
- 修改：`app/globals.css`

- [ ] **步骤 1：编写导出编排失败测试**

统一接口：

```ts
await downloadReview("review-1", "docx");
await downloadReviewArchive(["review-1", "review-2"], "pdf");
```

断言 PDF 调用 `createReviewPdf`，Word 调用 `createReviewDocx`；两种新格式都先 fetch 详情和 `/export-check`，再构建、触发下载，最后调用 `/exported`。生成失败、裁图失败、ZIP 失败或下载前失败都不能调用 `/exported`。另测 `downloadLegacyCachedPdf(review)` 只接受 `legacyReport && hasPdf && pdfFilename`，从 `/api/reviews/:id/pdf` 下载既有文件，不调用 `/export-check`、新格式渲染器或 `/exported`。

- [ ] **步骤 2：编写文件名和批量原子性失败测试**

固定安全文件名：

```ts
expect(reviewFilename(review, "docx")).toBe("作文批改-我终于明白了-唐敦林.docx");
expect(archiveFilename("pdf")).toBe("作文批改批量导出-PDF.zip");
expect(archiveFilename("docx")).toBe("作文批改批量导出-Word.zip");
```

批量按输入 ID 顺序逐篇 fetch/build；所有文件成功写入 ZIP 并生成 Blob 后才触发下载和逐篇标记。中途第 2 篇失败时不下载 ZIP、不标记第 1/2/3 篇，并保留调用方选择状态。

- [ ] **步骤 3：编写菜单和页面交互失败测试**

`ExportMenu` 主按钮名为“导出”，菜单项为“PDF”“Word (.docx)”；Escape/点击外部关闭并把焦点还给主按钮。详情页未保存或未复核时，选择任一新格式都先调用 teacher-review；旧/过期/缺裁图报告显示具体原因并禁用新格式菜单。旧报告仅在 `hasPdf && pdfFilename` 时于菜单外显示独立动作“下载已生成的旧版 PDF”；没有有效缓存时只显示“完整重新分析”。历史页、批量页的所选与一键导出都能选择新格式，但旧报告不进入批量新格式导出。

- [ ] **步骤 4：运行导出测试确认红灯**

运行：

```bash
npm test -- app/lib/review-export.test.ts app/components/ExportMenu.test.tsx "app/(protected)/reviews/ReviewPage.test.tsx" "app/(protected)/reviews/batch/BatchReviewPage.test.tsx" "app/(protected)/page.test.tsx" app/components/ReviewExportList.test.tsx
```

预期：FAIL，页面仍直接调用 PDF 函数。

- [ ] **步骤 5：实现格式无关导出编排**

`review-export.ts` 复用 `triggerFileDownload`、任务 8 的构建器和任务 11/12 的渲染器。多篇 Word ZIP 每篇一个 `.docx`，多篇 PDF ZIP 每篇一个 `.pdf`；一篇仍直接下载对应文件。旧版缓存 helper 走已有服务端 PDF GET 路由，只下载响应字节和服务端文件名，绝不传入 `createReviewPdf`。捕获内存错误时返回“生成文件时内存不足，请减少单次批量数量后重试”，不得降低图片质量或丢段。

- [ ] **步骤 6：接入详情、历史和批量页面**

详情保存/复核成功后使用服务端返回的最新 revision 重新 fetch 再导出，避免用旧 revision 做资格检查。`status: exported` 的新报告历史详情仍显示导出菜单，允许补导另一格式；旧报告只显示独立的旧版缓存下载动作或完整重新分析入口。批量页面在成功后刷新 `/api/reviews`；失败时保留全部选中项。

- [ ] **步骤 7：完成菜单响应式样式并运行测试**

菜单定位在按钮下方、z-index 只覆盖同一操作区；390px 宽度下菜单不超出视口，也不遮挡保存、重写或审核按钮。运行步骤 4 的同一测试命令。

预期：全部 PASS。

- [ ] **步骤 8：提交双格式导出交互**

```bash
git add app/lib/review-export.ts app/lib/review-export.test.ts app/components/ExportMenu.tsx app/components/ExportMenu.test.tsx 'app/(protected)/reviews/ReviewPage.tsx' 'app/(protected)/reviews/ReviewPage.test.tsx' 'app/(protected)/reviews/batch/BatchReviewPage.tsx' 'app/(protected)/reviews/batch/BatchReviewPage.test.tsx' 'app/(protected)/page.tsx' 'app/(protected)/page.test.tsx' app/components/ReviewExportList.tsx app/components/ReviewExportList.test.tsx app/globals.css
git commit -m "feat(导出): 支持单篇与批量 PDF Word"
```

## 任务 14：完成兼容、安全、浏览器和真实文档视觉验收

**文件：**
- 创建：`e2e/export-delivery.spec.ts`
- 修改：`e2e/workbench.spec.ts`
- 修改：`test/delivery-security.test.ts`
- 修改：`test/static-export.test.ts`
- 修改：`README.md`

- [ ] **步骤 1：编写旧报告、隐私和静态导出回归测试**

旧报告详情必须出现“旧版示范段落报告”和“完整重新分析”，不能出现可用的新导出菜单；同 revision 有缓存时只额外出现“下载已生成的旧版 PDF”，无缓存时不得出现该动作。OCR v1 的重新分析请求必须是 full。安全测试递归扫描内容模型请求、公开详情、DOCX core/custom properties 和错误响应，禁止图片/坐标/blocks、API Key、模型名、教师账号和内部路径。静态导出继续断言没有 `app/api/**/route.ts`。

- [ ] **步骤 2：建立多页导出 E2E 夹具**

`e2e/export-delivery.spec.ts` mock 一篇 OCR v2 作文：至少两个页面、一个跨页自然段、一个“保留”段、1–4 条建议、长建议、长修改稿、增删换、调序和纯标点变化。mock 文件接口返回非空合成 PNG；测试分别捕获 PDF 和 DOCX 下载，并在设置 `DELIVERY_QA_DIR` 时保存为：

```text
<DELIVERY_QA_DIR>/作文批改-我终于明白了-唐敦林.pdf
<DELIVERY_QA_DIR>/作文批改-我终于明白了-唐敦林.docx
```

- [ ] **步骤 3：运行自动化测试并修复红灯**

运行：

```bash
npm test -- test/delivery-security.test.ts test/static-export.test.ts
npm run test:e2e -- e2e/workbench.spec.ts e2e/export-delivery.spec.ts
```

预期：桌面 1440×1000 与移动 390×844 场景 PASS；每个视口断言 `document.documentElement.scrollWidth <= window.innerWidth`，裁图 canvas 的非透明像素数大于 0。

- [ ] **步骤 4：更新运行文档**

README 明确：新分析写 OCR v2；旧报告需完整重新分析才能生成新格式，但同 revision 已存在的旧版 PDF 可原样下载；内容模型只接收段落文字；单篇/批量支持 PDF 和 Word；DOCX 的建议/修改稿可编辑但下载后不会自动重算红黑差异；导出失败不会标记已导出。

- [ ] **步骤 5：生成真实 QA 文件前登记文档操作**

运行：

```bash
/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node /Users/micky/.codex/plugins/cache/openai-primary-runtime/pdf/26.819.11345/skills/pdf/container_tools/mark_artifact_operation_started.mjs --operation-kind create --expected-output-count 1 --output-format pdf
/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node /Users/micky/.codex/plugins/cache/openai-primary-runtime/documents/26.819.11345/skills/documents/container_tools/mark_artifact_operation_started.mjs --operation-kind create --expected-output-count 1 --output-format docx
```

预期：两个命令退出码均为 0；每个格式在本轮只登记一次。

- [ ] **步骤 6：通过 Playwright 生成 PDF/DOCX QA 文件**

运行：

```bash
DELIVERY_QA_DIR=/private/tmp/paragraph-review-delivery-qa npm run test:e2e -- e2e/export-delivery.spec.ts
```

预期：目录内出现命名正确且非空的 `.pdf` 与 `.docx`；测试退出码为 0。

- [ ] **步骤 7：结构检查并逐页渲染 PDF**

运行：

```bash
/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdfinfo '/private/tmp/paragraph-review-delivery-qa/作文批改-我终于明白了-唐敦林.pdf'
mkdir -p /private/tmp/paragraph-review-delivery-qa/pdf-pages
/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm -png '/private/tmp/paragraph-review-delivery-qa/作文批改-我终于明白了-唐敦林.pdf' /private/tmp/paragraph-review-delivery-qa/pdf-pages/page
```

预期：`pdfinfo` 显示 A4 纵向约 595×842pt；所有页面 PNG 非空。使用 `view_image` 以原始清晰度逐页检查：无裁切/重叠/缺字/黑块/异常大空白，顺序严格为裁图→建议→修改稿，颜色、楷体、底色、删除线和续标题正确。

- [ ] **步骤 8：渲染并逐页检查 DOCX**

运行：

```bash
mkdir -p /private/tmp/paragraph-review-delivery-qa/docx-pages
env TMPDIR=/private/tmp /Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python /Users/micky/.codex/plugins/cache/openai-primary-runtime/documents/26.819.11345/skills/documents/render_docx.py '/private/tmp/paragraph-review-delivery-qa/作文批改-我终于明白了-唐敦林.docx' --output_dir /private/tmp/paragraph-review-delivery-qa/docx-pages --emit_pdf
/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python /Users/micky/.codex/plugins/cache/openai-primary-runtime/documents/26.819.11345/skills/documents/scripts/a11y_audit.py '/private/tmp/paragraph-review-delivery-qa/作文批改-我终于明白了-唐敦林.docx'
```

预期：每页生成 `page-<N>.png`，a11y audit 不报告缺失图片 alt text。使用 `view_image` 以原始清晰度检查每一页：A4 纵向、裁图比例正确、中文无缺字、建议底色连续、编号换行对齐、红色删除线可见、分页无重叠/裁切/整页异常空白。发现缺陷时修改生成器并重复步骤 6–8，直到最新一轮全页通过。

- [ ] **步骤 9：提交安全、E2E 和文档**

```bash
git add e2e/export-delivery.spec.ts e2e/workbench.spec.ts test/delivery-security.test.ts test/static-export.test.ts README.md
git commit -m "test(交付): 覆盖逐段双格式视觉验收"
```

## 任务 15：全量验证与开发服务器交接

**文件：**
- 验证：本计划涉及的全部文件

- [ ] **步骤 1：使用 verification-before-completion 技能**

在宣称完成前完整读取并执行 `superpowers:verification-before-completion`；不得用先前运行记录代替本步骤的新证据。

- [ ] **步骤 2：运行完整单元、组件与 Cloudflare 测试**

运行：

```bash
PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm test
PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm run cf:test
```

预期：全部测试文件通过，0 failed；Cloudflare 专项退出码为 0。

- [ ] **步骤 3：运行静态检查和生产构建**

运行：

```bash
PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm run lint
PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm run build
```

预期：ESLint 无 error；Next.js 16.2 静态导出成功，不产生动态 Route Handler 错误。

- [ ] **步骤 4：运行完整浏览器回归**

运行：

```bash
PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm run test:e2e
```

预期：所有 Playwright 场景 PASS，包括逐段显示、单篇复核、批量复核、PDF/Word 下载、桌面/移动端无溢出。

- [ ] **步骤 5：检查工作区和规格覆盖**

运行：

```bash
git diff --check
git status --short
git log --oneline --decorate -15
```

逐项核对批准规格：自然段数来自 OCR；跨页同 ID；建议具体且含示例；“保留”说明优点；只有文字增删换标红；删除有删除线；调序/标点黑色；内容模型无图无坐标；A4 纵向；DOCX 可编辑且图片内嵌；单篇/批量双格式；旧报告不伪转换；失败不产生半份文件或错误导出标记。

- [ ] **步骤 6：处理任何失败并重新验证**

任何命令失败时，先新增或收紧能复现实际行为的测试，再修改最小实现；从步骤 2 重新运行全部验证。不得把缺少 LibreOffice/Poppler 以外的渲染错误当作可跳过项；若这两个运行时确实缺失，明确记录未完成的视觉 QA，不能声称通过。

- [ ] **步骤 7：启动开发服务器供用户试用**

先运行 `lsof -nP -iTCP:3001 -sTCP:LISTEN`。若无占用，运行：

```bash
PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npm run dev
```

若 3001 已被其他进程占用，运行：

```bash
PATH='/Users/micky/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin':$PATH npx next dev --hostname 127.0.0.1 --port 3002
```

预期：服务器保持运行，并在交接中给出实际 URL；不得结束仍用于用户试用的 exec session。

- [ ] **步骤 8：最终交接**

报告实际测试数量、构建结果、PDF/DOCX 逐页 QA 结果、服务器 URL 和任何仍存在的外部环境限制。只在所有必需步骤完成后称任务完成。
