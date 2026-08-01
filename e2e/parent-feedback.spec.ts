import { expect, test, type Page } from "@playwright/test";

const appBaseUrl = process.env.PARENT_FEEDBACK_E2E_BASE_URL ?? "http://127.0.0.1:3001";

const parentFeedbacks = [
  { style: "warm", title: "亲切详细", content: "家长您好，孩子这次作文选材真实，第三段可以补清事情的起因。" },
  { style: "professional", title: "专业清晰", content: "家长您好，本次作文选材切题；建议第三段补足冲突起因。" },
  { style: "concise", title: "简短微信版", content: "家长您好，作文选材真实，第三段再补清事情起因。" },
];

const review = {
  id: "review-1",
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
    themeReason: "切题",
    personalizedComment: "选材真实，感受自然。",
    painPoints: ["第三段的事情起因还不够清楚。"],
    commonIssues: ["句式较单一。"],
    revisionSuggestions: ["补写事情起因和人物动作。"],
    scores: {
      themeIntent: 8,
      contentSelection: 8,
      structure: 7,
      languageExpression: 7,
      writingConventions: 3,
      total: 33,
      level: "二类作文",
    },
    sampleParagraphs: [{ title: "示范段", text: "示范正文", suggestion: "修改建议" }],
    parentFeedbacks,
  },
  hasPdf: false,
  pdfFilename: null,
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: "2026-08-01T08:00:00.000Z",
  expiresAt: "2026-08-19T08:00:00.000Z",
};

async function mockReviewApis(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: { id: "owner-1", username: "teacher", role: "teacher", mustChangePassword: false },
        }),
      });
      return;
    }
    if (url.pathname === "/api/reviews/review-1") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: review }),
      });
      return;
    }
    if (url.pathname === "/api/reviews/review-1/analyze/status") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, data: { job: null } }),
      });
      return;
    }
    if (url.pathname === "/api/reviews/review-1/files") {
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      });
      return;
    }

    await route.abort("failed");
  });
}

for (const viewport of [
  { name: "桌面端", width: 1440, height: 1000 },
  { name: "390px 移动端", width: 390, height: 844 },
]) {
  test(`${viewport.name}完整展示家长反馈且不溢出`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockReviewApis(page);
    await page.goto(`${appBaseUrl}/reviews?id=review-1`);

    const panel = page.getByRole("region", { name: "给家长的反馈" });
    const workspace = page.getByRole("region", { name: "作文复核工作区" });
    await expect(panel).toBeVisible();
    await expect(page.getByRole("tab", { name: "亲切详细" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("亲切详细家长反馈")).toBeVisible();

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const panelBox = await panel.boundingBox();
    const workspaceBox = await workspace.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(workspaceBox).not.toBeNull();
    expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(workspaceBox!.y);
    expect(Math.abs(panelBox!.width - workspaceBox!.width)).toBeLessThanOrEqual(1);
  });
}
