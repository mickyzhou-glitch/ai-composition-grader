import { expect, test } from "@playwright/test";

test("renders the teacher workbench", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "新建作文批改" }),
  ).toBeVisible();
  await expect(
    page.getByText("教师工作台", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "批改历史" })).toBeVisible();
});
