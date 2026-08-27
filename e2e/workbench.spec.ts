import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

const parentFeedbacks = [
  { style: "warm", title: "亲切详细", content: "家长您好，孩子这次作文选材真实。" },
  { style: "professional", title: "专业清晰", content: "本次作文选材切题，建议补足细节。" },
  { style: "concise", title: "简短微信版", content: "作文选材真实，再补一些动作细节。" },
];

const review = {
  id: "review-dual-model",
  status: "ready_for_review",
  revision: 1,
  studentName: "张小明",
  config: { title: "为自己鼓掌", grade: "五年级", templateType: "custom" },
  images: [{
    id: 1,
    position: 0,
    originalName: "作文.jpg",
    mimeType: "image/jpeg",
    width: 100,
    height: 140,
    rotation: 0,
    crop: null,
  }],
  annotations: [],
  report: {
    themeFit: "fits",
    themeReason: "围绕一次克服困难的经历展开，符合题意。",
    personalizedComment: "选材真实，感受自然。",
    painPoints: ["第三段的动作细节还不够具体。"],
    commonIssues: ["部分句式较单一。"],
    revisionSuggestions: ["补写人物动作和当时的感受。"],
    scores: {
      themeIntent: 8,
      contentSelection: 8,
      structure: 7,
      languageExpression: 7,
      writingConventions: 3,
      total: 33,
      level: "二类作文",
    },
    sampleParagraphs: [{ title: "示范段", text: "我深吸一口气，再次站上起跑线。", suggestion: "补充动作与感受。" }],
    parentFeedbacks,
  },
  ocr: {
    ocrRevision: 1,
    editedAt: null as string | null,
    pages: [
      { pageIndex: 0, text: "那一天，我第一次站上起跑线。", readable: true, warnings: [] },
      { pageIndex: 1, text: "我终于完成比赛，也学会为自己鼓掌。", readable: true, warnings: ["页脚字迹较浅，请复核"] },
    ],
  },
  reportStale: false,
  hasPdf: false,
  pdfFilename: null,
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: "2026-08-01T08:00:00.000Z",
  expiresAt: "2026-08-19T08:00:00.000Z",
};

function json(data: unknown) {
  return JSON.stringify({ ok: true, data });
}

async function mockUser(page: Page, role: "admin" | "teacher") {
  await page.route("**/api/auth/me", (route) => route.fulfill({
    contentType: "application/json",
    body: json({ id: `${role}-1`, username: role, role, mustChangePassword: false }),
  }));
}

async function mockLegacyReview(page: Page, hasPdf: boolean) {
  let analyzeBody: unknown;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth/me") {
      await route.fulfill({
        contentType: "application/json",
        body: json({ id: "teacher-1", username: "teacher", role: "teacher", mustChangePassword: false }),
      });
      return;
    }
    if (pathname === "/api/reviews/review-dual-model") {
      await route.fulfill({
        contentType: "application/json",
        body: json({
          ...review,
          hasPdf,
          pdfFilename: hasPdf ? "旧版批改.pdf" : null,
        }),
      });
      return;
    }
    if (pathname === "/api/reviews/review-dual-model/analyze/status") {
      await route.fulfill({ contentType: "application/json", body: json({ job: null }) });
      return;
    }
    if (pathname === "/api/reviews/review-dual-model/analyze") {
      analyzeBody = request.postDataJSON();
      await route.fulfill({
        contentType: "application/json",
        body: json({
          id: "job-full",
          reviewId: "review-dual-model",
          status: "queued",
          progressStage: "queued",
          message: null,
          createdAt: "2026-08-28T08:00:00.000Z",
          finishedAt: null,
        }),
      });
      return;
    }
    await route.abort("failed");
  });
  return { analyzeBody: () => analyzeBody };
}

const batchReport = {
  version: 2 as const,
  themeFit: "fits",
  themeReason: "围绕一次真实经历展开，符合题意。",
  personalizedComment: "选材贴近生活，关键动作清楚。",
  painPoints: ["第三段补充转折原因。", "结尾回扣前文行动。"],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "B+",
  diagnostics: {
    authenticityAndRelevance: { finding: "主要事件符合生活常识。", action: "核对当天放学时间。" },
    materialAndDetails: { finding: "动作细节略少。", action: "补写一次停顿动作。" },
    structure: { finding: "转折与结果衔接略快。", action: "补充决定改变做法的原因。" },
    language: { finding: "语言通顺。", action: "精简重复句。" },
  },
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "动作细节略少。", advice: "补写一次停顿动作。", example: "我停下脚步，重新想了想。" }],
    revisedText: "我停下脚步，重新想了想，再作出选择。",
  }],
  parentFeedbacks,
};

const paragraphReview = {
  ...review,
  report: {
    ...structuredClone(batchReport),
    paragraphReviews: [
      {
        paragraphId: "paragraph-1",
        suggestions: [{ problem: "动作略快。", advice: "补充起跑前的动作。", example: "我深吸一口气，站上起跑线。" }],
        revisedText: "那一天，我第一次勇敢地站上起跑线。",
      },
      {
        paragraphId: "paragraph-2",
        suggestions: [{ problem: "保留", advice: "保留原文", example: "感悟自然。" }],
        revisedText: "我终于完成比赛，也学会为自己鼓掌。",
      },
    ],
  },
  ocr: {
    version: 2 as const,
    ocrRevision: 1,
    editedAt: null as string | null,
    pages: [
      { pageIndex: 0, text: "那一天，我第一次站上起跑线。", readable: true, warnings: [] },
      { pageIndex: 1, text: "我终于完成比赛，也学会为自己鼓掌。", readable: true, warnings: ["页脚字迹较浅，请复核"] },
    ],
    paragraphs: [
      {
        id: "paragraph-1",
        paragraphIndex: 0,
        text: "那一天，我第一次站上起跑线。",
        segments: [{ pageIndex: 0, x: 0.1, y: 0.12, width: 0.8, height: 0.18 }],
      },
      {
        id: "paragraph-2",
        paragraphIndex: 1,
        text: "我终于完成比赛，也学会为自己鼓掌。",
        segments: [{ pageIndex: 1, x: 0.1, y: 0.12, width: 0.8, height: 0.18 }],
      },
    ],
  },
};

function batchReview(id: string, studentName: string, revision: number) {
  return {
    id,
    status: "ready_for_review",
    revision,
    studentName,
    teacherReviewedAt: null as string | null,
    config: {
      title: `成长中的一次选择 ${id.at(-1)}`,
      grade: "六年级",
      writingRequirements: "写清事情经过",
      targetCharacters: 600,
      structureRequirements: "前后连贯",
      scoringFocus: "真实与逻辑",
      templateType: "custom",
      sampleParagraphCount: 1,
    },
    images: [{
      id: revision,
      position: 0,
      originalName: "作文.jpg",
      mimeType: "image/png",
      width: 800,
      height: 1100,
      rotation: 0,
      crop: null,
    }],
    annotations: [],
    report: structuredClone(batchReport),
    ocr: {
      version: 2 as const,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: `${studentName}的作文识别原文。`, readable: true, warnings: [] }],
      paragraphs: [{
        id: "paragraph-1",
        paragraphIndex: 0,
        text: `${studentName}的作文识别原文。`,
        segments: [{ pageIndex: 0, x: 0.1, y: 0.12, width: 0.8, height: 0.18 }],
      }],
    },
    reportStale: false,
    hasPdf: false,
    pdfFilename: null,
    createdAt: `2026-08-0${revision}T08:00:00.000Z`,
    updatedAt: `2026-08-0${revision}T08:00:00.000Z`,
  };
}

async function mockBatchReviewFlow(page: Page) {
  const reviews = new Map([
    ["review-1", batchReview("review-1", "张小明", 1)],
    ["review-2", batchReview("review-2", "李安然", 2)],
    ["review-3", batchReview("review-3", "王若宁", 3)],
  ]);
  const requestedDetails = new Set<string>();
  const png = await sharp(Buffer.from(`
    <svg width="800" height="1100" xmlns="http://www.w3.org/2000/svg">
      <rect width="800" height="1100" fill="#fffefb"/>
      <rect x="46" y="38" width="708" height="1024" rx="4" fill="none" stroke="#d8d1c4" stroke-width="3"/>
      <text x="400" y="105" text-anchor="middle" font-size="38" font-family="serif" fill="#25211d">成长中的一次选择</text>
      <g stroke="#d8d1c4" stroke-width="2">
        ${Array.from({ length: 16 }, (_, index) => `<line x1="84" x2="716" y1="${165 + index * 52}" y2="${165 + index * 52}"/>`).join("")}
      </g>
      <g fill="#3d3832" font-family="serif" font-size="25">
        <text x="94" y="155">那天放学后，我站在校门口想了很久。</text>
        <text x="94" y="207">雨越下越大，我决定先把伞借给同学。</text>
        <text x="94" y="259">回家的路上，我虽然淋湿了，心里却很踏实。</text>
      </g>
    </svg>
  `)).png().toBuffer();

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth/me") {
      await route.fulfill({ contentType: "application/json", body: json({ id: "teacher-1", username: "teacher", role: "teacher", mustChangePassword: false }) });
      return;
    }
    if (pathname === "/api/reviews") {
      await route.fulfill({ contentType: "application/json", body: json([...reviews.values()]) });
      return;
    }
    if (pathname === "/api/reviews/review-queue") {
      await route.fulfill({
        contentType: "application/json",
        body: json([...reviews.values()].filter(({ teacherReviewedAt }) => !teacherReviewedAt).map(({ id, studentName, config, status, revision, createdAt }) => ({
          id, studentName, title: config.title, status, revision, createdAt,
        }))),
      });
      return;
    }
    if (pathname === "/api/reviews/batch-reanalysis/preview" && request.method() === "POST") {
      await route.fulfill({
        contentType: "application/json",
        body: json({
          matched: [{
            reviewId: "review-1",
            studentName: "张小明",
            title: "成长中的一次选择 1",
            expectedRevision: 1,
            assignmentId: "assignment-latest",
            assignmentUpdatedAt: "2026-08-22T09:30:00.000Z",
          }],
          skipped: [{
            reviewId: "review-2",
            studentName: "李安然",
            title: "成长中的一次选择 2",
            code: "FRAMEWORK_NOT_FOUND",
            reason: "没有找到同名的已保存题目框架",
          }],
        }),
      });
      return;
    }
    if (pathname === "/api/reviews/batch-reanalysis" && request.method() === "POST") {
      await route.fulfill({
        contentType: "application/json",
        body: json({
          submitted: [{ reviewId: "review-1", jobId: "job-reanalysis-1", revision: 2 }],
          skipped: [{
            reviewId: "review-2",
            studentName: "李安然",
            title: "成长中的一次选择 2",
            code: "FRAMEWORK_NOT_FOUND",
            reason: "没有找到同名的已保存题目框架",
          }],
        }),
      });
      return;
    }
    const teacherReview = /^\/api\/reviews\/(review-\d)\/teacher-review$/u.exec(pathname);
    if (teacherReview) {
      const current = reviews.get(teacherReview[1])!;
      const saved = {
        ...current,
        ...request.postDataJSON(),
        revision: current.revision + 1,
        teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      };
      reviews.set(saved.id, saved);
      await route.fulfill({ contentType: "application/json", body: json(saved) });
      return;
    }
    if (pathname === "/api/reviews/export-check") {
      await route.fulfill({ contentType: "application/json", body: json({ eligible: true }) });
      return;
    }
    const image = /^\/api\/reviews\/(review-\d)\/files$/u.exec(pathname);
    if (image) {
      await route.fulfill({ contentType: "image/png", body: png });
      return;
    }
    const detail = /^\/api\/reviews\/(review-\d)$/u.exec(pathname);
    if (detail) {
      requestedDetails.add(detail[1]);
      await route.fulfill({ contentType: "application/json", body: json(reviews.get(detail[1])) });
      return;
    }
    await route.abort("failed");
  });

  return { requestedDetails };
}

test("renders the teacher workbench", async ({ page }) => {
  await mockUser(page, "teacher");
  await page.route("**/api/reviews", (route) => route.fulfill({
    contentType: "application/json",
    body: json([]),
  }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "新建作文批改" })).toBeVisible();
  await expect(page.getByText("教师工作台", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "批改历史" })).toBeVisible();
});

test("旧报告只提供同 revision 缓存 PDF，不伪装为新格式导出", async ({ page }) => {
  await mockLegacyReview(page, true);
  await page.goto("/reviews?id=review-dual-model");

  await expect(page.getByText("旧版示范段落报告需要完整重新分析后才能导出新格式")).toBeVisible();
  await expect(page.getByRole("button", { name: "完整重新分析" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载已生成的旧版 PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "导出" })).toHaveCount(0);
});

test("无缓存旧报告完整重新分析时显式提交 full 模式", async ({ page }) => {
  const legacy = await mockLegacyReview(page, false);
  await page.goto("/reviews?id=review-dual-model");

  await expect(page.getByText("旧版示范段落报告需要完整重新分析后才能导出新格式")).toBeVisible();
  await expect(page.getByRole("button", { name: "下载已生成的旧版 PDF" })).toHaveCount(0);
  await page.getByRole("button", { name: "完整重新分析" }).click();

  await expect.poll(legacy.analyzeBody).toEqual({ mode: "full" });
});

for (const viewport of [
  { name: "桌面端", width: 1440, height: 1000 },
  { name: "390px 移动端", width: 390, height: 844 },
]) {
  test(`${viewport.name}可预览并提交按最新框架批量重分析`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockBatchReviewFlow(page);

    await page.goto("/");
    await page.getByRole("checkbox", { name: "选择《成长中的一次选择 1》" }).check();
    await page.getByRole("checkbox", { name: "选择《成长中的一次选择 2》" }).check();
    await page.getByRole("button", { name: "按最新框架重新分析" }).click();

    await expect(page.getByRole("heading", { name: "按最新框架重新分析" })).toBeVisible();
    await expect(page.getByText("没有找到同名的已保存题目框架", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "确认重新分析 1 篇" }).click();
    await expect(page.locator(".batch-reanalysis-summary")).toHaveText("已提交 1 篇重新分析任务，1 篇保留选择");
    await expect(page.getByText("已选择 1 篇", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test(`${viewport.name}可按学生姓名连续审核并核对待导出修改意见`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { requestedDetails } = await mockBatchReviewFlow(page);

    await page.goto("/");
    const studentSearch = page.getByRole("searchbox", { name: "搜索学生姓名" });
    await studentSearch.fill("李安然");
    await expect(page.getByText("学生：李安然")).toBeVisible();
    await expect(page.getByText("学生：张小明")).toHaveCount(0);
    await studentSearch.clear();
    await page.getByRole("link", { name: "开始批量审核" }).click();

    await expect(page.getByRole("heading", { name: "张小明" })).toBeVisible();
    await expect.poll(() => requestedDetails.size).toBe(3);
    await page.getByRole("button", { name: "审核通过并进入下一篇" }).click();
    await expect(page.getByRole("heading", { name: "李安然" })).toBeVisible();
    await expect(page.getByText("正在展开作文与批改报告")).toHaveCount(0);

    await page.getByRole("link", { name: "返回历史" }).click();
    await expect(page.getByRole("heading", { name: "批改历史" })).toBeVisible();
    await page.getByRole("link", { name: "开始批量审核" }).click();
    await expect(page.getByRole("button", { name: "已复核待导出清单 (1)" })).toBeVisible();
    await page.getByRole("button", { name: "已复核待导出清单 (1)" }).click();
    await expect(page.getByRole("heading", { name: "张小明" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "生活常识与真实度" })).toBeVisible();
    await expect(page.getByText("修改：核对当天放学时间。")).toBeVisible();
    await expect(page.getByRole("heading", { name: "前后逻辑与结构" })).toBeVisible();
    await expect(page.getByText("修改：补充决定改变做法的原因。")).toBeVisible();
    await page.getByRole("button", { name: "连续审核" }).click();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole("button", { name: "审核通过并进入下一篇" })).toBeVisible();
    const compositionImage = page.getByRole("img", { name: "作文第 1 页" });
    await expect(compositionImage).toBeVisible();
    await expect.poll(() => compositionImage.evaluate((image: HTMLImageElement) => (
      image.complete && image.naturalWidth >= 800 && image.naturalHeight >= 1100
    ))).toBe(true);
    const screenshotPath = testInfo.outputPath(`batch-review-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach(`批量审核-${viewport.name}`, { path: screenshotPath, contentType: "image/png" });
  });

  test(`${viewport.name}双模型设置独立显示且布局不溢出`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockUser(page, "admin");
    await page.route("**/api/settings", (route) => route.fulfill({
      contentType: "application/json",
      body: json({
        vision: { baseUrl: "https://vision.example.com/v1", model: "vision-ocr", keyConfigured: true },
        content: { baseUrl: "https://content.example.com/v1", model: "composition-writer", keyConfigured: true },
      }),
    }));

    await page.goto("/settings");

    const visionHeading = page.getByRole("heading", { name: "拍照识图模型" });
    const contentHeading = page.getByRole("heading", { name: "作文内容模型" });
    await expect(visionHeading).toBeVisible();
    await expect(contentHeading).toBeVisible();
    await expect(page.getByLabel("拍照识图模型名称")).toHaveValue("vision-ocr");
    await expect(page.getByLabel("作文内容模型名称")).toHaveValue("composition-writer");
    await expect(page.getByRole("button", { name: "测试拍照识图模型" })).toBeVisible();
    await expect(page.getByRole("button", { name: "测试作文内容模型" })).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const visionBox = await visionHeading.locator("xpath=ancestor::form").boundingBox();
    const contentBox = await contentHeading.locator("xpath=ancestor::form").boundingBox();
    expect(visionBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    if (viewport.width === 390) {
      expect(visionBox!.y + visionBox!.height).toBeLessThanOrEqual(contentBox!.y);
    } else {
      expect(Math.abs(visionBox!.y - contentBox!.y)).toBeLessThanOrEqual(1);
      expect(visionBox!.x + visionBox!.width).toBeLessThanOrEqual(contentBox!.x);
    }
  });

  test(`${viewport.name}可复核 OCR 并只重新生成内容`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockUser(page, "teacher");

    let currentReview = structuredClone(paragraphReview);
    let ocrPatchBody: unknown;
    let analyzeBody: unknown;
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/api/auth/me") {
        await route.fulfill({
          contentType: "application/json",
          body: json({ id: "teacher-1", username: "teacher", role: "teacher", mustChangePassword: false }),
        });
        return;
      }
      if (url.pathname === "/api/reviews/review-dual-model") {
        await route.fulfill({ contentType: "application/json", body: json(currentReview) });
        return;
      }
      if (url.pathname === "/api/reviews/review-dual-model/ocr") {
        ocrPatchBody = request.postDataJSON();
        const body = ocrPatchBody as { paragraphs: Array<{ paragraphId: string; text: string }> };
        currentReview = {
          ...currentReview,
          ocr: {
            ...currentReview.ocr,
            ocrRevision: 2,
            editedAt: "2026-08-13T10:00:00.000Z",
            paragraphs: currentReview.ocr.paragraphs.map((paragraph, index) => ({
              ...paragraph,
              text: body.paragraphs[index]?.text ?? paragraph.text,
            })),
          },
          reportStale: true,
        };
        await route.fulfill({ contentType: "application/json", body: json(currentReview) });
        return;
      }
      if (url.pathname === "/api/reviews/review-dual-model/analyze/status") {
        await route.fulfill({ contentType: "application/json", body: json({ job: null }) });
        return;
      }
      if (url.pathname === "/api/reviews/review-dual-model/analyze") {
        analyzeBody = request.postDataJSON();
        await route.fulfill({
          contentType: "application/json",
          body: json({
            id: "job-content-only",
            reviewId: "review-dual-model",
            status: "queued",
            progressStage: "queued",
            message: null,
            createdAt: "2026-08-13T10:01:00.000Z",
            finishedAt: null,
          }),
        });
        return;
      }
      if (url.pathname === "/api/reviews/review-dual-model/files") {
        await route.fulfill({
          contentType: "image/png",
          body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
        });
        return;
      }
      await route.abort("failed");
    });

    await page.goto("/reviews?id=review-dual-model");
    const reportTab = page.getByRole("tab", { name: "批改报告" });
    const ocrTab = page.getByRole("tab", { name: "识别原文" });
    await expect(reportTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "批改报告" })).toBeVisible();

    await ocrTab.click();
    await expect(ocrTab).toHaveAttribute("aria-selected", "true");
    const firstPage = page.getByLabel("第 1 段识别原文");
    const secondPage = page.getByLabel("第 2 段识别原文");
    await expect(firstPage).toBeVisible();
    await expect(secondPage).toBeVisible();
    await firstPage.fill("那一天，我第一次勇敢地站上起跑线。");
    await page.getByRole("button", { name: "保存识别原文" }).click();

    await expect(page.getByText("批改报告基于旧版识别原文", { exact: true })).toBeVisible();
    expect(ocrPatchBody).toEqual({
      expectedOcrRevision: 1,
      paragraphs: [
        { paragraphId: "paragraph-1", text: "那一天，我第一次勇敢地站上起跑线。" },
        { paragraphId: "paragraph-2", text: "我终于完成比赛，也学会为自己鼓掌。" },
      ],
    });

    await page.getByRole("button", { name: "重新生成批改" }).click();
    expect(analyzeBody).toEqual({ mode: "content_only" });
    await expect(page.getByRole("status").filter({ hasText: "AI 分析已提交" })).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const firstBox = await firstPage.boundingBox();
    const secondBox = await secondPage.boundingBox();
    const firstPageBox = await firstPage.locator("xpath=ancestor::label").boundingBox();
    const secondPageBox = await secondPage.locator("xpath=ancestor::label").boundingBox();
    expect(firstBox).not.toBeNull();
    expect(secondBox).not.toBeNull();
    expect(firstPageBox).not.toBeNull();
    expect(secondPageBox).not.toBeNull();
    if (viewport.width === 390) {
      expect(firstPageBox!.y + firstPageBox!.height).toBeLessThanOrEqual(secondPageBox!.y);
    } else {
      expect(Math.abs(firstPageBox!.y - secondPageBox!.y)).toBeLessThanOrEqual(1);
      expect(firstBox!.x + firstBox!.width).toBeLessThanOrEqual(secondBox!.x);
    }
  });
}
