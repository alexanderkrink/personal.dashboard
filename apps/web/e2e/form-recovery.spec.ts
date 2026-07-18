import { expect, type Page, test } from "@playwright/test";

/**
 * REGRESSION: a failed submit must not cost the user their typing.
 *
 * Every auth action used to report failure by redirecting to `?status=…`. A
 * redirect remounts the route, so every field emptied and focus fell to
 * `<body>` — WCAG 2.2 SC 3.3.7 *Redundant Entry* (Level A), and PLAN.md's
 * "error = danger border + message below (never wipe the field)".
 *
 * These drive the real browser rather than asserting on markup, because the
 * failure mode was invisible in the component tree: React resets a
 * `<form action={…}>` once its action settles, so a field can be perfectly
 * wired and still come back empty.
 */

const ACCESS_CODE = process.env.ACCESS_CODE;

test.beforeAll(() => {
  if (!ACCESS_CODE) {
    throw new Error(
      "ACCESS_CODE is not set — cannot exercise the gate. See apps/web/.env.example.",
    );
  }
});

async function clearGate(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access code").fill(ACCESS_CODE ?? "");
  await page.getByRole("button", { name: "Enter" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test.describe("failed submits preserve entry", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a rejected access code keeps the code, marks the field and takes focus", async ({
    page,
  }) => {
    await page.goto("/");
    const input = page.getByLabel("Access code");
    await input.fill("definitely-not-the-code");
    await page.getByRole("button", { name: "Enter" }).click();

    await expect(page.getByRole("main").getByRole("alert")).toHaveText("Not recognised.");
    await expect(input).toHaveValue("definitely-not-the-code");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toBeFocused();

    // The rejection is form state, so it never reaches the URL — and the code
    // itself is never echoed back by the server on the failure path.
    await expect(page).toHaveURL("http://localhost:3000/");

    const describedBy = await input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toHaveText("Not recognised.");
  });

  test("a failed sign-in keeps both fields and focuses the announcement", async ({ page }) => {
    await clearGate(page);

    await page.getByLabel("Email").fill("nobody@example.com");
    await page.getByLabel("Password", { exact: true }).fill("Not-The-Password9");
    await page.getByRole("button", { name: "Sign in" }).click();

    const alert = page.getByRole("main").getByRole("alert");
    await expect(alert).toHaveText("That email and password don't match an account.");

    await expect(page.getByLabel("Email")).toHaveValue("nobody@example.com");
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("Not-The-Password9");

    // Neither field is blamed — saying which half was wrong would be an
    // enumeration oracle — so the message itself takes focus rather than a
    // field, and nothing carries aria-invalid.
    await expect(alert).toBeFocused();
    await expect(page.getByLabel("Email")).not.toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("a mismatched sign-up blames the right field and keeps all three values", async ({
    page,
  }) => {
    await clearGate(page);
    await page.goto("/signup");

    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByLabel("Password", { exact: true }).fill("Correct-Horse9aa");
    await page.getByLabel("Confirm password").fill("Different-Horse9aa");
    await page.getByRole("button", { name: "Create account" }).click();

    const confirm = page.getByLabel("Confirm password");
    await expect(confirm).toHaveAttribute("aria-invalid", "true");
    await expect(confirm).toBeFocused();

    const describedBy = await confirm.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toHaveText("Those two passwords do not match.");

    await expect(page.getByLabel("Email")).toHaveValue("someone@example.com");
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("Correct-Horse9aa");
    await expect(confirm).toHaveValue("Different-Horse9aa");
  });

  test("an invalid email on the reset form is blamed on the field, not the form", async ({
    page,
  }) => {
    await clearGate(page);
    await page.goto("/forgot-password");

    const email = page.getByLabel("Email");
    // `someone@nowhere` is deliberate: `type="email"` accepts a bare hostname,
    // so the browser lets the form submit, while `z.email()` requires a dotted
    // domain and rejects it. Anything the browser itself refuses never reaches
    // the action, and would test nothing.
    await email.fill("someone@nowhere");
    await page.getByRole("button", { name: "Send reset link" }).click();

    await expect(email).toHaveValue("someone@nowhere");
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(email).toBeFocused();
  });
});

/**
 * REGRESSION: the focus indicator and the control edge are the two things SC
 * 1.4.11 (non-text contrast, 3:1) actually hangs on, and both were failing.
 * The focus treatment was a 3px ring at 50% alpha; the control edge was the
 * decorative panel hairline.
 */
test.describe("focus and control-edge treatment", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("every focusable gets PLAN's 2px ring at 2px offset", async ({ page }) => {
    await clearGate(page);

    const outlineOf = (selector: string) =>
      page.locator(selector).evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          width: style.outlineWidth,
          style: style.outlineStyle,
          offset: style.outlineOffset,
        };
      });

    // Tab, not `.focus()`: browsers only match `:focus-visible` on a button
    // when focus arrived from the keyboard.
    await page.getByLabel("Email").focus();
    await expect
      .poll(() => outlineOf(":focus"))
      .toMatchObject({
        width: "2px",
        style: "solid",
        offset: "2px",
      });

    await page.keyboard.press("Tab"); // the "Forgot?" link
    await expect.poll(() => outlineOf(":focus")).toMatchObject({ width: "2px", style: "solid" });

    await page.keyboard.press("Tab"); // password
    await page.keyboard.press("Tab"); // the submit button
    await expect(page.locator(":focus")).toHaveText("Sign in");
    await expect
      .poll(() => outlineOf(":focus"))
      .toMatchObject({
        width: "2px",
        style: "solid",
        offset: "2px",
      });
  });

  test("inputs use the 3:1 control edge, not the decorative hairline", async ({ page }) => {
    await clearGate(page);

    const border = await page
      .getByLabel("Email")
      .evaluate((el) => getComputedStyle(el).borderTopColor);
    const panel = await page
      .locator("main div.border-border")
      .first()
      .evaluate((el) => getComputedStyle(el).borderTopColor);

    // The two tokens are deliberately different: the panel keeps PLAN's quiet
    // hairline, the control edge pays SC 1.4.11's 3:1.
    expect(border).not.toBe(panel);
  });
});

/**
 * REGRESSION: 44px is this project's declared touch-target standard (PLAN.md
 * "Mobile / PWA & accessibility"), and it lives on every button size variant
 * behind `pointer-coarse:` so mouse-driven screens keep the compact cockpit
 * density regardless of how narrow the viewport is.
 */
test.describe("touch targets", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const [label, hasTouch, expected] of [
    ["a fine pointer keeps the compact height", false, 36],
    ["a coarse pointer gets the 44px target", true, 44],
  ] as const) {
    test(label, async ({ browser }) => {
      const context = await browser.newContext({
        hasTouch,
        isMobile: hasTouch,
        storageState: { cookies: [], origins: [] },
      });
      const page = await context.newPage();
      await clearGate(page);

      const box = await page.getByRole("button", { name: "Sign in" }).boundingBox();
      expect(box?.height).toBe(expected);

      await context.close();
    });
  }
});
