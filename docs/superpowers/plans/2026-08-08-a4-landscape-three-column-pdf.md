# A4 横向三栏 PDF 实现计划

> **面向 AI 代理的工作者：** 使用 `superpowers-zh:executing-plans` 在当前工作区逐项实现。步骤使用复选框（`- [ ]`）跟踪进度。

**目标：** 删除 PDF 摘要页，将作文打印稿恢复为标准 A4 横向三栏，并落实范文红色楷体、其他文字蓝色黑体、原图完整显示。

**架构：** 保留现有 `PrintReviewPage` 的数据读取和 `variant=original` 图片 URL。精简 `PrintReview`，让它只按图片数量输出反馈页；打印尺寸、三栏比例、字体和颜色全部由现有 CSS Module 管理。

**技术栈：** Next.js 16 App Router、React 19、CSS Modules、Vitest、Testing Library、Playwright PDF。

---

## 文件职责

- `app/print/reviews/[id]/PrintReview.test.tsx`：验证打印 DOM 只包含逐页三栏，建议、原图和范文各归其位。
- `app/print/reviews/[id]/PrintReviewPage.test.tsx`：验证打印页加载后仍使用原图 URL，并以三栏内容作为完成标志。
- `app/print/reviews/[id]/print-styles.test.ts`：验证打印页尺寸、字体、颜色和原图缩放规则。
- `app/print/reviews/[id]/PrintReview.tsx`：按作文图片生成三栏反馈页。
- `app/print/reviews/[id]/print.module.css`：定义 A4 横向尺寸、三栏布局和打印视觉规则。
- `src/pdf/pdf-service.test.ts`：验证旧版式缓存不会阻止新 PDF 生成。
- `src/pdf/pdf-service.ts`：记录当前打印版式的发布时间，用于淘汰旧缓存。
- `src/services/review-service.test.ts`：保持缓存读取与教师编辑互斥测试使用当前版式缓存。

### 任务 1：锁定精简后的打印行为

**文件：**
- 修改：`app/print/reviews/[id]/PrintReview.test.tsx`

- [ ] **步骤 1：编写失败的组件测试**

将首个测试改为只期待两张作文图片对应的两张反馈页：

```tsx
it("只按作文图片输出逐页三栏学习页，不生成摘要页", () => {
  const { container } = render(
    <PrintReview
      review={review}
      imageSources={["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"]}
    />,
  );

  expect(container.firstElementChild).toHaveAttribute("data-print-ready", "true");
  expect(
    Array.from(container.querySelectorAll("[data-print-section]")).map(
      (node) => node.getAttribute("data-print-section"),
    ),
  ).toEqual(["feedback-page-1", "feedback-page-2"]);
  expect(container.querySelector('[data-page-kind="summary"]')).toBeNull();
  expect(container.querySelector('[data-print-section="feedback-page-2"]')).toHaveAttribute(
    "data-print-final",
    "true",
  );
});
```

删除 3 个只验证摘要密度、摘要编号和旧评语拆分的测试。保留并修正三栏内容测试的描述，明确左侧为修改建议、右侧为范文。

- [ ] **步骤 2：运行测试并确认红灯**

运行：

```bash
npm test -- 'app/print/reviews/[id]/PrintReview.test.tsx'
```

预期：首个测试失败，因为组件仍输出 `strengths` 和 `improvements` 两张摘要页。

### 任务 2：锁定 A4、字体、颜色和原图规则

**文件：**
- 创建：`app/print/reviews/[id]/print-styles.test.ts`

- [ ] **步骤 1：编写失败的样式契约测试**

```ts
// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  fileURLToPath(new URL("./print.module.css", import.meta.url)),
  "utf8",
);

describe("PDF 打印样式", () => {
  it("使用 A4 横向三栏并完整显示原图", () => {
    expect(css).toMatch(/@page\s*{[^}]*size:\s*A4 landscape;/s);
    expect(css).toMatch(/\.feedbackLayout\s*{[^}]*grid-template-columns:\s*19\.5% 44% 36\.5%;/s);
    expect(css).toMatch(/\.imageFigure img\s*{[^}]*object-fit:\s*contain;/s);
  });

  it("范文使用红色楷体，其他文字使用蓝色黑体", () => {
    expect(css).toMatch(/\.document\s*{[^}]*color:\s*var\(--blue\);[^}]*font-family:\s*var\(--heiti\);/s);
    expect(css).toMatch(/\.modelColumn\s*{[^}]*color:\s*var\(--red\);[^}]*font-family:\s*var\(--kaiti\);/s);
  });
});
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：

```bash
npm test -- 'app/print/reviews/[id]/print-styles.test.ts'
```

预期：两个测试失败，因为当前页面为 16:9、整页楷体，并且建议和范文颜色相反。

### 任务 3：精简组件并恢复打印样式

**文件：**
- 修改：`app/print/reviews/[id]/PrintReview.tsx`
- 修改：`app/print/reviews/[id]/print.module.css`
- 修改：`app/print/reviews/[id]/PrintReviewPage.test.tsx`

- [ ] **步骤 1：实现最小组件改动**

从 `PrintReview.tsx` 删除 `gradeFromLegacyTotal` 导入、摘要辅助函数和两张摘要 `<section>`。保留参数校验、`sampleParagraphsForPage`、逐图反馈页、原生 `<img>` 和最后一页标记。

将 `PrintReviewPage.test.tsx` 的加载完成断言从已删除的「优点」改为保留的「改后范文」，继续验证 `variant=original` 图片 URL。

- [ ] **步骤 2：实现最小样式改动**

将核心样式收敛为：

```css
@page {
  size: A4 landscape;
  margin: 0;
}

.document {
  --blue: #255ab1;
  --red: #c90000;
  --heiti: SimHei, "Heiti SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  --kaiti: STKaiti, KaiTi, "Kaiti SC", "FZKai-Z03", serif;
  min-height: 100%;
  background: #fff;
  color: var(--blue);
  font-family: var(--heiti);
  font-size: 12pt;
  line-height: 1.45;
}

.sheet { min-height: 210mm; break-after: page; }
.feedbackLayout {
  display: grid;
  min-height: 210mm;
  grid-template-columns: 19.5% 44% 36.5%;
}
.suggestionColumn { color: var(--blue); font-family: var(--heiti); }
.modelColumn { color: var(--red); font-family: var(--kaiti); }
.imageFigure, .imageFigure img { height: 210mm; }
.imageFigure img { width: 100%; object-fit: contain; }
```

删除未再使用的摘要、旧报告卡片、批注和页眉样式。保留移动端预览规则，但只覆盖三栏、图片和两侧文字。

- [ ] **步骤 3：运行定向测试并确认绿灯**

运行：

```bash
npm test -- 'app/print/reviews/[id]/PrintReview.test.tsx' 'app/print/reviews/[id]/print-styles.test.ts' 'app/print/reviews/[id]/PrintReviewPage.test.tsx'
```

预期：全部通过，且输出无错误。

### 任务 4：完整验证

- [ ] **步骤 1：使本次版式发布前的 PDF 缓存失效**

先将「作文未修改但 PDF 版式已经升级时不复用旧缓存」的 `exportedAt` 改为本次发布时间之前，确认测试因仍复用缓存而失败；再把 `PDF_LAYOUT_RELEASED_AT` 更新为 `2026-08-08T06:00:00.000Z`，并将有效缓存用例调整到该时间之后。

- [ ] **步骤 2：运行 PDF 相关测试**

```bash
npm test -- 'app/print/reviews/[id]' src/pdf/pdf-service.test.ts src/api/pdf-route.test.ts
```

预期：全部通过。

- [ ] **步骤 3：运行静态检查和构建**

```bash
npm run lint
npm run build
```

预期：两个命令均以退出码 0 完成。

- [ ] **步骤 4：检查打印页视觉结果**

启动本地开发服务器，使用可打印的现有批改记录打开打印路由；确认每页为 A4 横向，三栏无重叠，原图未裁切，右侧范文为红色楷体，其他文字为蓝色黑体。
