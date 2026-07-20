import { expect, test } from "@playwright/test";

test("renders the teacher workbench", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "AI 作业批改助手" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "教师工作台" }),
  ).toBeVisible();
  await expect(page.getByText("系统准备就绪")).toBeVisible();
});
