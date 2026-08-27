import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Download, type Page } from "@playwright/test";
import sharp from "sharp";

const reviewId = "review-delivery";
const expectedFilenames = {
  pdf: "作文批改-我终于明白了-唐敦林.pdf",
  docx: "作文批改-我终于明白了-唐敦林.docx",
} as const;

const longAdvice = "把当时听到的声音、手上的动作和心里的犹豫依次写清楚，让读者能看见选择发生的过程，而不是只读到一句概括性的结果。";
const longExample = "雨点敲在窗沿上，我把已经搭上门把手的手收了回来，又摸了摸口袋里那张被汗水浸软的车票，才转身向走廊尽头跑去。";
const longRevisionTail = Array.from({ length: 6 }, (_, index) => (
  `第 ${index + 1} 次回头时，我都能听见雨点落在伞面的声音，也更清楚自己为什么没有独自离开。`
)).join("");
const paragraphTexts = [
  "我一直以为，明白一个道理只要听别人讲清楚就够了。那天下午，雨突然大了起来，我站在教学楼门口，第一次发现真正的选择不会提前给人答案。",
  "我把书包放下，推开窗户，抬头看见操场边还有一个低年级同学在等家长。犹豫片刻，我拿起伞跑下楼，把他送到了门卫室。",
  "风停了，我也终于明白，所谓成长，就是在可以转身离开的时候仍愿意多走一步。",
  "我笑了。",
];

const review = {
  id: reviewId,
  status: "ready_for_review",
  revision: 7,
  studentName: "唐敦林",
  teacherReviewedAt: "2026-08-28T08:00:00.000Z",
  config: {
    title: "我终于明白了",
    grade: "六年级",
    writingRequirements: "写清一次真实经历和自己的感受。",
    targetCharacters: 600,
    structureRequirements: "叙事完整，前后照应。",
    scoringFocus: "细节真实，感悟自然。",
    templateType: "custom",
  },
  images: [
    { id: 101, position: 0, originalName: "作文-1.png", mimeType: "image/png", width: 1200, height: 1600, rotation: 0, crop: null },
    { id: 102, position: 1, originalName: "作文-2.png", mimeType: "image/png", width: 1200, height: 1600, rotation: 0, crop: null },
  ],
  annotations: [],
  report: {
    version: 2,
    themeFit: "fits",
    themeReason: "围绕一次雨天帮助同学的选择展开，感悟由事件自然产生。",
    personalizedComment: "叙事真诚，结尾能够回扣题目。",
    painPoints: [],
    commonIssues: [],
    revisionSuggestions: [],
    grade: "A",
    diagnostics: {
      authenticityAndRelevance: { finding: "事件符合生活经验。", action: "保留关键选择。" },
      materialAndDetails: { finding: "动作细节仍可展开。", action: "补足手、脚和声音的细节。" },
      structure: { finding: "转折完整。", action: "让结尾照应开头。" },
      language: { finding: "表达流畅。", action: "减少概括句。" },
    },
    paragraphReviews: [
      {
        paragraphId: "paragraph-1",
        suggestions: [
          { problem: "开头的道理略显概括。", advice: longAdvice, example: longExample },
          { problem: "雨势出现得较突然。", advice: "补一句环境变化作为过渡。", example: "刚才还发白的天空忽然压低，雨点一阵紧过一阵。" },
          { problem: "选择前的犹豫可以更具体。", advice: "写出一个停顿动作。", example: "我的脚已经迈出门槛，又慢慢收了回来。" },
          { problem: "末句可以承接下文。", advice: "用一个未完成的动作留下悬念。", example: "我握紧伞柄，却没有立刻走进雨里。" },
        ],
        revisedText: `我曾经以为，明白一个道理只要听别人讲清楚就够了。那天下午，雨点忽然敲响窗沿，我握住门把手又停了下来，第一次发现真正的选择不会提前给人答案。我听见走廊尽头传来急促的脚步声，手心也慢慢渗出了汗。${longRevisionTail}`,
      },
      {
        paragraphId: "paragraph-2",
        suggestions: [
          { problem: "动作顺序可以突出决定。", advice: "把推窗观察提前，把放书包后置。", example: "我推开窗户看见他还在雨里，才把书包放下。" },
          { problem: "帮助过程略短。", advice: longAdvice, example: longExample },
        ],
        revisedText: "我推开窗户，抬头看见操场边还有一个低年级同学在等家长，才把书包放下。犹豫片刻，我拿起伞跑下楼，一路护着他走到了门卫室。",
      },
      {
        paragraphId: "paragraph-3",
        suggestions: [{ problem: "保留", advice: "保留原文", example: "感悟由事件自然生长出来，语气克制。" }],
        revisedText: paragraphTexts[2],
      },
      {
        paragraphId: "paragraph-4",
        suggestions: [{ problem: "句末情绪可以更明确。", advice: "只调整标点，不改文字。", example: "我笑了！" }],
        revisedText: "我笑了！",
      },
    ],
    parentFeedbacks: [],
  },
  ocr: {
    version: 2,
    ocrRevision: 3,
    editedAt: null,
    pages: [
      { pageIndex: 0, text: paragraphTexts[0], readable: true, warnings: [] },
      { pageIndex: 1, text: paragraphTexts.slice(1).join("\n"), readable: true, warnings: [] },
    ],
    paragraphs: [
      {
        id: "paragraph-1",
        paragraphIndex: 0,
        text: paragraphTexts[0],
        segments: [
          { pageIndex: 0, x: 0.08, y: 0.12, width: 0.84, height: 0.42 },
          { pageIndex: 1, x: 0.08, y: 0.08, width: 0.84, height: 0.14 },
        ],
      },
      { id: "paragraph-2", paragraphIndex: 1, text: paragraphTexts[1], segments: [{ pageIndex: 1, x: 0.08, y: 0.27, width: 0.84, height: 0.22 }] },
      { id: "paragraph-3", paragraphIndex: 2, text: paragraphTexts[2], segments: [{ pageIndex: 1, x: 0.08, y: 0.54, width: 0.84, height: 0.16 }] },
      { id: "paragraph-4", paragraphIndex: 3, text: paragraphTexts[3], segments: [{ pageIndex: 1, x: 0.08, y: 0.76, width: 0.84, height: 0.1 }] },
    ],
  },
  reportStale: false,
  hasPdf: false,
  pdfFilename: null,
  createdAt: "2026-08-28T07:00:00.000Z",
  updatedAt: "2026-08-28T08:00:00.000Z",
};

function json(data: unknown) {
  return JSON.stringify({ ok: true, data });
}

const pageImages = Promise.all([0, 1].map(async (pageIndex) => sharp(Buffer.from(`
  <svg width="1200" height="1600" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="1600" fill="#fffefb"/>
    <rect x="70" y="55" width="1060" height="1490" fill="none" stroke="#7c756b" stroke-width="4"/>
    ${Array.from({ length: 22 }, (_, index) => `<line x1="95" x2="1105" y1="${135 + index * 62}" y2="${135 + index * 62}" stroke="#c9c1b5" stroke-width="2"/>`).join("")}
    <circle cx="${pageIndex === 0 ? 220 : 980}" cy="${pageIndex === 0 ? 360 : 1180}" r="42" fill="#d5523f"/>
  </svg>
`)).png().toBuffer()));

async function mockDelivery(page: Page) {
  const images = await pageImages;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({ contentType: "application/json", body: json({ id: "teacher-1", username: "teacher", role: "teacher", mustChangePassword: false }) });
      return;
    }
    if (url.pathname === `/api/reviews/${reviewId}`) {
      await route.fulfill({ contentType: "application/json", body: json(review) });
      return;
    }
    if (url.pathname === `/api/reviews/${reviewId}/analyze/status`) {
      await route.fulfill({ contentType: "application/json", body: json({ job: null }) });
      return;
    }
    if (url.pathname === "/api/reviews/export-check") {
      await route.fulfill({ contentType: "application/json", body: json({ exportable: true }) });
      return;
    }
    if (url.pathname === `/api/reviews/${reviewId}/exported`) {
      await route.fulfill({ contentType: "application/json", body: json({ status: "exported" }) });
      return;
    }
    if (url.pathname === `/api/reviews/${reviewId}/files`) {
      const imageId = Number(url.searchParams.get("imageId"));
      await route.fulfill({ contentType: "image/png", body: images[imageId === 102 ? 1 : 0] });
      return;
    }
    await route.abort("failed");
  });
}

async function saveQaDownload(download: Download) {
  const qaDirectory = process.env.DELIVERY_QA_DIR;
  if (!qaDirectory) return;
  mkdirSync(qaDirectory, { recursive: true });
  await download.saveAs(path.join(qaDirectory, download.suggestedFilename()));
}

async function downloadFormat(page: Page, format: keyof typeof expectedFilenames) {
  await page.getByRole("button", { name: "导出" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: format === "pdf" ? "PDF" : "Word (.docx)" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(expectedFilenames[format]);
  await saveQaDownload(download);
}

for (const viewport of [
  { name: "桌面端", width: 1440, height: 1000 },
  { name: "390px 移动端", width: 390, height: 844 },
]) {
  test(`${viewport.name}生成多页 PDF 和可编辑 Word，裁图与菜单不溢出`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(() => {
      const originalToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type, quality) {
        const context = this.getContext("2d", { willReadFrequently: true });
        if (context && this.width > 0 && this.height > 0) {
          const pixels = context.getImageData(0, 0, this.width, this.height).data;
          let nonTransparent = 0;
          for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index] > 0) nonTransparent += 1;
          }
          const state = window as typeof window & { __deliveryCropPixels?: number };
          state.__deliveryCropPixels = Math.max(state.__deliveryCropPixels ?? 0, nonTransparent);
        }
        return originalToBlob.call(this, callback, type, quality);
      };
    });
    await mockDelivery(page);

    await page.goto(`/reviews?id=${reviewId}`);
    await expect(page.getByRole("heading", { name: "我终于明白了" })).toBeVisible();
    await downloadFormat(page, "pdf");
    await downloadFormat(page, "docx");

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.evaluate(() => (
      window as typeof window & { __deliveryCropPixels?: number }
    ).__deliveryCropPixels ?? 0)).toBeGreaterThan(0);
  });
}
