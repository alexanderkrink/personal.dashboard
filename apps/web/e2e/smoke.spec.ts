import { expect, test } from "@playwright/test";

test("unauthenticated visitor is redirected to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByText("Alex's Study Dashboard")).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
});
