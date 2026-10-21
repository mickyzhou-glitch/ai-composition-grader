import { expect, test } from "@playwright/test";
import sharp from "sharp";

for (const failFirst of [false, true]) {
  test(failFirst ? "分析启动失败后复用已保存作文重试" : "创建上传成功后自动分析并在详情恢复进度", async ({ page }) => {
    const image = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#f5ebd6" } }).jpeg().toBuffer();
    const mutations: string[] = [];
    let config: unknown;
    let analysisAttempts = 0;
    const job = { id: "job-auto", reviewId: "review-auto", status: "queued", progressStage: "queued", message: null, createdAt: new Date().toISOString(), finishedAt: null };
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const reply = (data: unknown, status = 200) => route.fulfill({ status, json: { ok: true, data } });
      if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
      if (path === "/api/auth/me") return reply({ id: "teacher-auto", username: "teacher", role: "teacher", mustChangePassword: false });
      if (path === "/api/classes" || path === "/api/saved-assignments") return reply([]);
      if (path === "/api/reviews" && request.method() === "POST") {
        config = request.postDataJSON().config;
        return reply({ id: "review-auto", revision: 0 }, 201);
      }
      if (path === "/api/reviews/review-auto/images") return reply({ images: [{ id: 1, position: 0 }], revision: 1 });
      if (path === "/api/reviews/review-auto/analyze") {
        analysisAttempts += 1;
        expect(request.postDataJSON()).toEqual({ mode: "full" });
        if (failFirst && analysisAttempts === 1) {
          return route.fulfill({ status: 503, json: { ok: false, error: { code: "UNAVAILABLE", message: "暂时无法启动分析" } } });
        }
        return reply(job, 202);
      }
      if (path === "/api/reviews/review-auto/analyze/status") return reply({ job });
      if (path === "/api/reviews/review-auto/files") return route.fulfill({ contentType: "image/jpeg", body: image });
      if (path === "/api/reviews/review-auto") return reply({
        id: "review-auto", revision: 1, status: "analyzing", studentName: "", config,
        images: [{ id: 1, position: 0, originalName: "作文.jpg", mimeType: "image/jpeg", width: 600, height: 800, rotation: 0, crop: null }],
        annotations: [], report: null, ocr: null, reportStale: false, hasPdf: false, pdfFilename: null,
        teacherReviewedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      return route.abort();
    });
    await page.goto("/new");
    await page.getByRole("button", { name: "下一步：上传作文" }).click();
    await page.getByLabel("选择作文图片").setInputFiles({ name: "作文.jpg", mimeType: "image/jpeg", buffer: image });
    await page.getByRole("button", { name: "下一步：确认提交" }).click();
    await page.getByLabel("确认真实作文上传说明").check();
    await page.getByRole("button", { name: "创建并开始批改" }).click();
    if (failFirst) {
      await expect(page.locator(".error-banner")).toContainText("作文已保存");
      await expect(page).toHaveURL(/\/new$/);
      await page.getByRole("button", { name: "创建并开始批改" }).click();
    }
    await expect(page).toHaveURL(/\/reviews\?id=review-auto$/);
    await expect(page.getByRole("heading", { name: "AI 正在细读作文" })).toBeVisible();
    await expect(page.getByText("AI 分析：排队中")).toBeVisible();
    await expect(page.getByRole("button", { name: "开始 AI 分析", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "AI 正在细读作文" })).toBeVisible();
    expect(mutations).toEqual([
      "POST /api/reviews",
      "POST /api/reviews/review-auto/images",
      "POST /api/reviews/review-auto/analyze",
      ...(failFirst ? ["POST /api/reviews/review-auto/analyze"] : []),
    ]);
  });
}
