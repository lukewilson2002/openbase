import { expect, test } from "./fixtures";

/**
 * Administration -> Email in a real browser against the real server: an administrator finds the
 * SMTP settings on their own page, saves a mail server (no restart), sees the password as "Saved"
 * and never in the page, and "Send test email" shows the real error of a server that cannot be
 * reached. The instance is left with email off again, so the other specs do not see a change.
 *
 * The journey spec created the first administrator; this one runs after all the others.
 */
test.skip(!process.env["OPENGRID_E2E"], "set OPENGRID_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.use({ viewport: { width: 1360, height: 860 } });

const EMAIL = "journey-admin@example.com";
const PASSWORD = "correct horse battery staple 42";
const CSRF = { "X-OpenGrid-CSRF": "1" };
const SECRET = "e2e-smtp-secret-9f3a";

test("an administrator sets up email, sees a test email fail with the real error, and turns it off", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).not.toHaveURL(/login/);

  await page.goto("/admin");
  await page.getByRole("tab", { name: "Email" }).click();
  await expect(page).toHaveURL(/tab=email/);
  await expect(page.getByText(/Email is off/)).toBeVisible();

  // A port nothing listens on: the loopback port 1 (privileged and unused on any normal machine).
  await page.getByLabel("Host").fill("127.0.0.1");
  await page.getByLabel("Port").fill("1");
  await page.getByLabel("Connection security").selectOption("none");
  await page.getByLabel("Username").fill("mailer");
  await page.getByLabel("Password", { exact: true }).fill(SECRET);
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByText("Email is on")).toBeVisible();
  await expect(page.getByText("Host saved here")).toBeVisible();
  // The password is "Saved" and nowhere in the page or the API answer.
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace" })).toBeVisible();
  expect(await page.content()).not.toContain(SECRET);
  const settings = await page.request.get("/api/admin/email");
  expect(settings.ok()).toBeTruthy();
  expect(await settings.text()).not.toContain(SECRET);
  expect(await settings.json()).toMatchObject({ enabled: true, host: "127.0.0.1", port: 1, security: "none", username: "mailer", password_set: true });
  // The setup status (what the automation editor reads) follows at once.
  expect(await (await page.request.get("/api/setup")).json()).toMatchObject({ email_enabled: true });

  await page.getByRole("button", { name: /Send test email/ }).click();
  const failure = page.getByRole("alert").filter({ hasText: "was not sent" });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText(/refused|connect/i);

  // Turn email off again (clear the host) and forget the password, so the instance is as found.
  await page.getByLabel("Host").fill("");
  await page.getByRole("button", { name: "Remove" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/Email is off/)).toBeVisible();
  expect(await (await page.request.get("/api/admin/email")).json()).toMatchObject({ enabled: false, password_set: false });
  expect(await (await page.request.get("/api/setup")).json()).toMatchObject({ email_enabled: false });
  // restore the defaults for the other fields too
  const reset = await page.request.patch("/api/admin/email", { data: { port: 587, security: "starttls", username: null }, headers: CSRF });
  expect(reset.ok()).toBeTruthy();
});
