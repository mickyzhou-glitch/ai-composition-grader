import { expect, test, type Page } from "@playwright/test";

// Every API request is intercepted. These regressions never read or modify real essays.
const title = "测试作文：一次难忘的尝试";
const rules = Array.from({ length: 18 }, (_, index) => `第 ${index + 1} 条原话：写清过程，补充具体动作与心理。\n保留  停顿！`);
const review = {
  id: "dialog-fixture", studentName: "测试学生", className: "测试班", status: "ready_for_review", revision: 1,
  config: { title, grade: "六年级", templateType: "custom", targetCharacters: 600, writingRequirements: "叙事", structureRequirements: "五段", scoringFocus: "细节" },
  createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z",
  images: [], annotations: [], reportStale: false, teacherReviewedAt: null, hasPdf: false, pdfFilename: null,
  ocr: { version: 1, ocrRevision: 1, editedAt: null, pages: [{ pageIndex: 0, text: "虚构测试作文。", readable: true, warnings: [] }] },
  report: {
    themeFit: "fits", themeReason: "符合题意", personalizedComment: "叙事清楚", painPoints: ["补充细节"], commonIssues: [], revisionSuggestions: [], grade: "B+",
    diagnostics: {
      authenticityAndRelevance: { finding: "事件可信", action: "核对时间" }, materialAndDetails: { finding: "动作较少", action: "补充细节" },
      structure: { finding: "转折略快", action: "补充因果" }, language: { finding: "语言通顺", action: "精简长句" },
    },
    sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({ title: `第 ${index + 1} 段`, text: "测试范文。".repeat(25), suggestion: "补充动作" })), parentFeedbacks: [],
  },
};

async function mockApis(page: Page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown;
    if (path === "/api/auth/me") data = { id: "fixture-teacher", username: "测试老师", role: "teacher", mustChangePassword: false };
    else if (path === "/api/reviews/review-queue") data = [{ ...review, title }];
    else if (path === "/api/reviews") data = [review];
    else if (path === "/api/reviews/dialog-fixture") data = review;
    else if (path === "/api/grading-opinions") data = [
      ...rules.map((text, index) => ({ id: `rule-${index}`, text, scope: "standing", sourceTitle: title, category: "结构", sourceStudentName: "测试学生", sourceClassName: "测试班", createdAt: review.createdAt })),
      { id: "other-title", text: "其他题目的规则不能出现", scope: "standing", sourceTitle: "其他题目", category: "结构", sourceStudentName: "测试丁", sourceClassName: "测试班", createdAt: review.createdAt },
      { id: "essay-only", text: "单篇建议不能出现", scope: "essay", sourceTitle: title, category: "内容", sourceStudentName: "测试丁", sourceClassName: "测试班", createdAt: review.createdAt },
    ];
    else if (path === "/api/rule-candidates") data = new URL(route.request().url()).searchParams.has("count") ? { count: 1 } : [{
      id: "legacy-candidate", title, category: "结构", ruleText: "不该显示的 AI 改写文案", createdAt: review.createdAt,
      sources: [{ text: rules[0], studentName: "测试甲" }, { text: rules[1], studentName: "测试乙" }, { text: rules[0], studentName: "测试丙" }],
    }];
    else {
      await route.fulfill({ status: 404, json: { ok: false, error: { message: `未模拟的测试接口：${path}` } } });
      return;
    }
    await route.fulfill({ json: { ok: true, data } });
  });
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "short", width: 1280, height: 480 },
  { name: "mobile", width: 390, height: 844 },
  { name: "narrow-short", width: 320, height: 480 },
  { name: "landscape", width: 844, height: 390 },
]) {
  test(`return dialog ${viewport.name}: opaque, scrollable, editable and keyboard contained`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockApis(page);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/reviews/batch");
    const trigger = page.getByRole("button", { name: "不合适", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "退回后台修改" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("background-color", "rgb(251, 254, 252)");
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
    const options = dialog.getByRole("group", { name: "已通过的长期规则" });
    await expect(options.getByRole("button")).toHaveCount(rules.length);
    const common = dialog.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" });
    const content = dialog.getByRole("textbox", { name: "内容建议（仅当前文章）" });
    await common.fill("老师手写  ");
    await options.getByRole("button").first().click();
    await expect(common).toHaveValue(`老师手写  \n${rules[0]}`);
    await common.fill(`手工修改后的要求。\n${rules[0]}`);
    await content.click();
    await content.pressSequentially("第二框可以点击并输入。");
    await expect(content).toBeFocused();
    await expect(content).toHaveValue("第二框可以点击并输入。");
    const rects = await dialog.evaluate((element) => {
      const body = element.querySelector(".revision-dialog-body")!;
      const footer = element.querySelector(".revision-dialog-actions")!;
      return {
        dialog: element.getBoundingClientRect().toJSON(), body: body.getBoundingClientRect().toJSON(), footer: footer.getBoundingClientRect().toJSON(),
        scrollable: body.scrollHeight > body.clientHeight,
        optionsScrollable: element.querySelector(".revision-rule-options")!.scrollHeight > element.querySelector(".revision-rule-options")!.clientHeight,
        overflowX: element.scrollWidth > element.clientWidth,
      };
    });
    expect(rects.dialog.top).toBeGreaterThanOrEqual(0);
    expect(rects.dialog.bottom).toBeLessThanOrEqual(viewport.height + 1);
    expect(rects.dialog.right).toBeLessThanOrEqual(viewport.width + 1);
    expect(rects.body.bottom).toBeLessThanOrEqual(rects.footer.top + 1);
    expect(rects.scrollable || rects.optionsScrollable).toBe(true);
    if (viewport.height < 600) expect(rects.scrollable).toBe(true);
    expect(rects.overflowX).toBe(false);
    await page.screenshot({ path: `.tmp-ui-shots/fixed-return-${viewport.name}.png` });

    const submit = dialog.getByRole("button", { name: "提交后台修改并继续" });
    await submit.focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await expect(submit).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.locator("body").evaluate((body) => body.style.overflow)).toBe("");
    expect(errors).toEqual([]);
  });
}

test("pending rules show distinct original wording instead of an AI rewrite", async ({ page }) => {
  await mockApis(page);
  await page.goto("/opinions");
  const candidates = page.getByRole("region", { name: "待审批的候选规则" });
  const originals = candidates.getByRole("list", { name: "老师原话" });
  await expect(originals.getByRole("listitem")).toHaveCount(2);
  expect(await originals.getByRole("listitem").first().textContent()).toBe(rules[0]);
  await expect(originals.getByRole("listitem").first()).toHaveCSS("white-space", "pre-wrap");
  await expect(page.getByText("不该显示的 AI 改写文案")).toHaveCount(0);
  await page.screenshot({ path: ".tmp-ui-shots/fixed-pending-rules.png", fullPage: true });
});
