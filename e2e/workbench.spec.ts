import { expect, test, type Page } from "@playwright/test";

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

for (const viewport of [
  { name: "桌面端", width: 1440, height: 1000 },
  { name: "390px 移动端", width: 390, height: 844 },
]) {
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

    let currentReview = structuredClone(review);
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
        const body = ocrPatchBody as { pages: Array<{ pageIndex: number; text: string }> };
        currentReview = {
          ...currentReview,
          ocr: { ...currentReview.ocr, ocrRevision: 2, editedAt: "2026-08-13T10:00:00.000Z", pages: currentReview.ocr.pages.map((page, index) => ({ ...page, text: body.pages[index]?.text ?? page.text })) },
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
    const firstPage = page.getByLabel("第 1 页识别原文");
    const secondPage = page.getByLabel("第 2 页识别原文");
    await expect(firstPage).toBeVisible();
    await expect(secondPage).toBeVisible();
    await firstPage.fill("那一天，我第一次勇敢地站上起跑线。");
    await page.getByRole("button", { name: "保存识别原文" }).click();

    await expect(page.getByText("批改报告基于旧版识别原文", { exact: true })).toBeVisible();
    expect(ocrPatchBody).toEqual({
      expectedOcrRevision: 1,
      pages: [
        { pageIndex: 0, text: "那一天，我第一次勇敢地站上起跑线。" },
        { pageIndex: 1, text: "我终于完成比赛，也学会为自己鼓掌。" },
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
