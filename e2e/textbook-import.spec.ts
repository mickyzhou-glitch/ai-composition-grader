import { expect, test } from "@playwright/test";
import sharp from "sharp";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path === "/api/auth/me" ? { id: "test-teacher", username: "测试老师", role: "teacher", mustChangePassword: false } : [];
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.goto("/new");
  await page.getByRole("button", { name: "自定义题目", exact: true }).click();
});

test("imports textbook photos through real browser compression and fills editable assignment fields", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const image = await sharp({ create: { width: 2400, height: 3200, channels: 3, background: "#f5ebd6" } })
    .composite([{ input: Buffer.from('<svg width="2400" height="3200"><text x="180" y="300" font-size="120">习作：我的拿手好戏</text><text x="180" y="550" font-size="70">把重点部分写具体。500 字。</text></svg>') }]).png().toBuffer();
  const input = page.getByLabel("选择课本图片");
  await input.setInputFiles({ name: "课本第一页.png", mimeType: "image/png", buffer: image });
  await input.setInputFiles({ name: "课本第二页.png", mimeType: "image/png", buffer: image });
  await expect(page.locator(".textbook-previews img")).toHaveCount(2);
  await expect(page.locator(".textbook-previews img").first()).toHaveJSProperty("naturalWidth", 2400);
  await page.getByRole("button", { name: "移除课本图片 课本第二页.png" }).click();
  await page.screenshot({ path: "output/textbook-import-desktop.png", fullPage: true });

  let requestBody: { title: string; textbookImages: string[] } | undefined;
  await page.route("**/api/assignment-guidance", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, data: {
      title: "我的拿手好戏", targetCharacters: 500,
      writingRequirements: "把重点部分写具体。", structureRequirements: "先介绍，再写具体事例。", scoringFocus: "详略得当，重点突出。",
    } } });
  });
  await page.getByRole("button", { name: "AI 生成要求" }).click();
  await expect(page.getByLabel("作文题目", { exact: true })).toHaveValue("我的拿手好戏");
  await expect(page.getByLabel("目标字数")).toHaveValue("500");
  expect(requestBody?.title).toBe("");
  expect(requestBody?.textbookImages).toHaveLength(1);
  const url = requestBody!.textbookImages[0];
  expect(url).toMatch(/^data:image\/jpeg;base64,/);
  const metadata = await sharp(Buffer.from(url.split(",")[1], "base64")).metadata();
  expect(metadata.height).toBe(2000);
  expect(metadata.width).toBe(1500);
  await page.getByLabel("写作要求").fill("教师核对后补充的要求。");
  await page.getByRole("button", { name: "下一步：上传作文" }).click();
  await expect(page.getByText("0/4 张")).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile upload fits the screen and retains textbook photos and teacher input after recognition failure", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const image = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#eee4d0" } }).jpeg().toBuffer();
  await page.getByLabel("选择课本图片").setInputFiles({ name: "课本.jpg", mimeType: "image/jpeg", buffer: image });
  await page.getByLabel("写作要求").fill("已有的教师要求");
  await page.route("**/api/assignment-guidance", async (route) => {
    await route.fulfill({ status: 502, json: { ok: false, error: { code: "AI_INVALID_RESPONSE", message: "课本图片不清晰，请重新选择" } } });
  });
  await page.getByRole("button", { name: "AI 生成要求" }).click();
  await expect(page.locator(".error-banner")).toContainText("课本图片不清晰");
  await expect(page.getByLabel("写作要求")).toHaveValue("已有的教师要求");
  await expect(page.locator(".textbook-previews img")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "AI 生成要求" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "output/textbook-import-mobile.png", fullPage: true });
});
