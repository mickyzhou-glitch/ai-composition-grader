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

const batchReport = {
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
  sampleParagraphs: [{ title: "示范段", text: "我停下脚步，重新想了想。", suggestion: "补充动作和原因。" }],
  parentFeedbacks,
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
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: `${studentName}的作文识别原文。`, readable: true, warnings: [] }],
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

for (const viewport of [
  { name: "桌面端", width: 1440, height: 1000 },
  { name: "390px 移动端", width: 390, height: 844 },
]) {
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

    await page.getByRole("button", { name: "待导出清单 (1)" }).click();
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
