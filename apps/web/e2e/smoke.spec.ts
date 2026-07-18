import { expect, test } from "@playwright/test";

/**
 * Was "unauthenticated visitor is redirected to /login" until the access-code
 * gate landed (M1 item 12). /login is now unreachable without a valid code, so
 * the root of the app is the gate, not the sign-in form.
 */
test("unauthenticated visitor lands on the access-code gate", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL("http://localhost:3000/");
  // The wordmark renders the dot motif for sighted users and the real name for
  // screen readers; match the latter, which is the unambiguous one.
  await expect(page.getByText("Alex's Study Dashboard")).toBeAttached();
  await expect(page.getByLabel("Access code")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enter" })).toBeVisible();
});
