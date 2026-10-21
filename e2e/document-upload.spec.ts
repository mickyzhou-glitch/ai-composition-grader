import { expect, test } from "@playwright/test";
import { Document, ImageRun, Packer, Paragraph, TextRun } from "docx";
import { jsPDF } from "jspdf";
import sharp from "sharp";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path === "/api/auth/me" ? { id: "test-teacher", username: "测试老师", role: "teacher", mustChangePassword: false }
      : path === "/api/classes" ? ["六（1）班", "六（2）班"] : [];
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.goto("/new");
  await page.getByRole("button", { name: "下一步：上传作文" }).click();
});

test("imports real DOCX text and embedded image, retains preview on invalid PDF, and confirms class", async ({ page }) => {
  const image = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#dcebe2" } }).png().toBuffer();
  const word = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ children: [new TextRun("为自己鼓掌")] }),
    new Paragraph("我曾经害怕站上讲台。那一天，我终于鼓起勇气，向同学们分享自己的故事。".repeat(8)),
    new Paragraph({ children: [new ImageRun({ data: image, type: "png", transformation: { width: 400, height: 200 } })] }),
  ] }] }));
  await page.getByLabel("班级", { exact: true }).fill("六（1）班");
  await page.getByLabel("选择作文文档").setInputFiles({ name: "电子作文.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: word });
  await expect(page.getByText(/已导入：电子作文.docx/)).toBeVisible();
  const preview = page.locator(".image-sort-card img");
  await expect(preview).toHaveCount(1);
  await expect(preview.first()).toHaveJSProperty("naturalWidth", 1440);
  await expect(page.getByRole("group", { name: /裁剪/ })).toHaveCount(0);
  await expect(page.getByRole("spinbutton", { name: /裁剪/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^旋转 / })).toHaveCount(1);
  await page.screenshot({ path: "output/word-upload-preview.png", fullPage: true });
  await page.getByLabel("选择作文文档").setInputFiles({ name: "损坏.pdf", mimeType: "application/pdf", buffer: Buffer.from("broken pdf") });
  await expect(page.locator(".error-banner")).toContainText("文档读取失败");
  await expect(preview).toHaveCount(1);
  await page.getByRole("button", { name: "下一步：确认提交" }).click();
  await expect(page.locator(".confirm-assignment")).toContainText("六（1）班");
});

test("renders a two-page scanned PDF and rejects more than four pages and password protected PDFs", async ({ page }) => {
  const image = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#f0e3cc" } }).png().toBuffer();
  const pdf = new jsPDF();
  pdf.addImage(image.toString("base64"), "PNG", 10, 10, 180, 240);
  pdf.addPage(); pdf.text("Second page of the composition", 20, 20);
  await page.getByLabel("选择作文文档").setInputFiles({ name: "扫描作文.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf.output("arraybuffer")) });
  await expect(page.getByText(/已导入：扫描作文.pdf，共 2 页/)).toBeVisible();
  await expect(page.locator(".image-sort-card img")).toHaveCount(2);
  for (let index = 0; index < 3; index++) pdf.addPage();
  await page.getByLabel("选择作文文档").setInputFiles({ name: "五页作文.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf.output("arraybuffer")) });
  await expect(page.locator(".error-banner")).toContainText("最多 4 页");
  await expect(page.locator(".image-sort-card img")).toHaveCount(2);
  const encrypted = new jsPDF({ encryption: { userPassword: "password", ownerPassword: "owner" } });
  encrypted.text("Protected composition", 20, 20);
  await page.getByLabel("选择作文文档").setInputFiles({ name: "加密.pdf", mimeType: "application/pdf", buffer: Buffer.from(encrypted.output("arraybuffer")) });
  await expect(page.locator(".error-banner")).toContainText("密码");
  await expect(page.getByRole("button", { name: "下一步：确认提交" })).toBeEnabled();
});

test("rejects empty and overlong Word documents without enabling submission", async ({ page }) => {
  const empty = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("")] }] }));
  await page.getByLabel("选择作文文档").setInputFiles({ name: "空白.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: empty });
  await expect(page.locator(".error-banner")).toContainText("没有可导入");
  const long = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("这是一篇需要拆分的长作文。".repeat(1200))] }] }));
  await page.getByLabel("选择作文文档").setInputFiles({ name: "超长.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: long });
  await expect(page.locator(".error-banner")).toContainText("最多 4 页");
  await expect(page.getByRole("button", { name: "下一步：确认提交" })).toBeDisabled();
});
