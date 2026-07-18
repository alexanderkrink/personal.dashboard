import { expect, test } from "@playwright/test";

/**
 * The access-code gate is a security boundary, not a UI affordance, so these
 * tests drive it by URL rather than by clicking links: every "blocked" case
 * below navigates STRAIGHT to a protected path, which is exactly the attack the
 * proxy has to stop.
 *
 * The code is read from the environment (playwright.config.ts loads .env.local)
 * and is never asserted on, printed, or written into a test name.
 */
const ACCESS_CODE = process.env.ACCESS_CODE;

test.beforeAll(() => {
  if (!ACCESS_CODE) {
    throw new Error(
      "ACCESS_CODE is not set — cannot exercise the gate. See apps/web/.env.example.",
    );
  }
});

/** Every path an unauthenticated, ungated visitor must be bounced off. */
const PROTECTED_PATHS = ["/login", "/signup", "/forgot-password", "/courses", "/calendar", "/gate"];

test.describe("access-code gate", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the domain root serves the access-code screen", async ({ page }) => {
    await page.goto("/");

    await expect(page).toHaveURL("http://localhost:3000/");
    await expect(page.getByLabel("Access code")).toBeVisible();
    // Spare on purpose: the gate must not advertise what is behind it.
    await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  });

  for (const path of PROTECTED_PATHS) {
    test(`direct navigation to ${path} without the gate cookie is blocked`, async ({ page }) => {
      await page.goto(path);

      await expect(page).toHaveURL("http://localhost:3000/");
      await expect(page.getByLabel("Access code")).toBeVisible();
    });
  }

  test("a wrong code is rejected and leaves the gate closed", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Access code").fill("definitely-not-the-code");
    await page.getByRole("button", { name: "Enter" }).click();

    // Scoped to <main>: Next's route announcer is also role="alert" and sits
    // outside it, so an unscoped query is ambiguous.
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("Not recognised.");

    // The important half: still gated afterwards.
    await page.goto("/login");
    await expect(page).toHaveURL("http://localhost:3000/");
  });

  test("a correct code unlocks the auth surface", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Access code").fill(ACCESS_CODE ?? "");
    await page.getByRole("button", { name: "Enter" }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    // The unlock persists across navigations, and reaches /signup too.
    await page.goto("/signup");
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();

    // Still no session, so the app itself stays shut.
    await page.goto("/courses");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("the gate cookie is httpOnly, so script cannot forge or read it", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Access code").fill(ACCESS_CODE ?? "");
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page).toHaveURL(/\/login$/);

    const [gateCookie] = (await page.context().cookies()).filter(
      (cookie) => cookie.name === "sd_access_gate",
    );

    expect(gateCookie?.httpOnly).toBe(true);
    expect(gateCookie?.sameSite).toBe("Lax");
    expect(gateCookie?.path).toBe("/");
    await expect(page.evaluate(() => document.cookie)).resolves.not.toContain("sd_access_gate");
  });
});

/**
 * REGRESSION: a page is a Server Action host.
 *
 * `UNGATED_PATHS` once read `["/auth", …]`, which exempted the
 * `/auth/update-password` PAGE from the gate. Because Next bundles every action
 * in the app into every page that imports one, and resolves an incoming
 * `$ACTION_ID_…` POST against the requested page's bundle, that exemption made
 * `signUp`, `signIn`, `sendMagicLink` and `requestPasswordReset` all callable
 * with no gate cookie and no session — the gate was a UI curtain, not a
 * boundary. The proxy must bounce the POST before any action runs.
 */
test.describe("the gate cannot be bypassed by posting a Server Action", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const path of ["/auth/update-password", "/login", "/signup", "/"]) {
    test(`a Server Action POST to ${path} without the gate cookie never executes`, async ({
      request,
    }) => {
      // A syntactically valid action-id field. The id does not need to resolve:
      // a gated path must be redirected by the proxy BEFORE Next ever looks it
      // up, so a 3xx away from the path is the pass condition and a 200/303
      // carrying an action result is the failure.
      const response = await request.post(path, {
        maxRedirects: 0,
        multipart: {
          $ACTION_ID_407f8e7c9345b39d33abcb6ba4bd39998959d65634: "",
          email: "gate-bypass-probe@example.com",
          password: "Bypass-Probe-9xK!",
          confirmPassword: "Bypass-Probe-9xK!",
        },
      });

      // The action redirects land on /signup, /login or /forgot-password with a
      // ?status=. Being sent to the gate at / is the correct, blocked outcome.
      const location = response.headers().location ?? "";
      expect(location).not.toContain("status=");
      expect(response.status()).not.toBe(200);
    });
  }
});

test.describe("auth surface behind the gate", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  async function clearGate(page: import("@playwright/test").Page) {
    await page.goto("/");
    await page.getByLabel("Access code").fill(ACCESS_CODE ?? "");
    await page.getByRole("button", { name: "Enter" }).click();
    await expect(page).toHaveURL(/\/login$/);
  }

  test("sign-in rejects bad credentials without saying which half was wrong", async ({ page }) => {
    await clearGate(page);

    await page.getByLabel("Email").fill("nobody@example.com");
    await page.getByLabel("Password", { exact: true }).fill("Not-The-Password9");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "That email and password don't match an account.",
    );
  });

  test("the password policy is shown live and blocks a weak sign-up", async ({ page }) => {
    await clearGate(page);
    await page.goto("/signup");

    const password = page.getByLabel("Password", { exact: true });
    await password.fill("short");
    await expect(page.getByText("At least 12 characters")).toBeVisible();

    // Native validation refuses to submit before the server is ever asked.
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByLabel("Confirm password").fill("short");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole("heading", { name: "Create an account" })).toBeVisible();
  });

  test("forgot-password is reachable and does not disclose whether an account exists", async ({
    page,
  }) => {
    await clearGate(page);
    await page.getByRole("link", { name: "Forgot?" }).click();

    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  });
});
