import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, CDPSession, Cookie, Page, TestInfo } from "@playwright/test";
import { totp } from "../contract/totp";
import { expect, newClientContext, skipIntro, test } from "./fixtures";

/**
 * Passkeys in a real browser against the real server, with Chrome's virtual authenticator
 * (the DevTools Protocol's WebAuthn domain: a CTAP2 platform authenticator with resident keys and
 * user verification):
 *
 *   - Account -> Security: add a passkey, see it in the list, sign out, sign in with the passkey and
 *     no password (usernameless: the email field stays empty), see "last used", rename and remove it,
 *     and see the authenticator's leftover credential refused;
 *   - an account with two-factor authentication on signs in with a passkey without a code, while a
 *     password sign-in still asks for one; the login page's background request for the autofill list
 *     signs in the same way;
 *   - an administrator removes another user's passkeys (Administration -> Users) and that user is back
 *     to their password.
 *
 * The authenticator either approves every prompt by itself (`present(true)`, the person's finger on
 * the sensor) or leaves it waiting (`present(false)`, a prompt nobody has answered yet).
 *
 * The e2e server's public URL is `http://localhost:<port>` (globalSetup): WebAuthn needs a domain
 * name, and `localhost` is one that browsers treat as a secure context. Runs only with OPENBASE_E2E=1.
 */
test.skip(!process.env["OPENBASE_E2E"], "set OPENBASE_E2E=1 to run the end-to-end tests (see playwright.config.ts)");
test.use({ viewport: { width: 1280, height: 900 } });

const PASSWORD = "correct horse battery staple 42";
const ADMIN_EMAIL = "journey-admin@example.com";
const CSRF = { "X-OpenBase-CSRF": "1" };

const rand = () => randomBytes(4).toString("hex");
const baseUrl = () => process.env["OPENBASE_E2E_URL"] ?? "http://localhost:8080";

/** Chrome's virtual authenticator, attached to the page's tab. */
interface Virtual {
  cdp: CDPSession;
  id: string;
  present(on: boolean): Promise<void>;
  credentials(): Promise<{ credentialId: string; isResidentCredential: boolean; userHandle?: string; signCount: number }[]>;
}

async function virtualAuthenticator(page: Page): Promise<Virtual> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    cdp,
    id: authenticatorId,
    present: async (enabled) => void (await cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled })),
    credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials,
  };
}

interface Account {
  email: string;
  name: string;
  /** The session cookies of the sign-up. */
  cookies: Cookie[];
}

function freshContext(browser: Browser, testInfo: TestInfo, label: string): Promise<BrowserContext> {
  return newClientContext(browser, testInfo, { baseURL: baseUrl(), viewport: { width: 1280, height: 900 }, storageState: { cookies: [], origins: [] } }, label);
}

/**
 * A new account of this test, signed up through the API (the e2e server has open sign-up) from a
 * throwaway browser profile. Every test makes its own: a retry then never meets what the failed
 * attempt left behind (a passkey the server remembers, whose authenticator is gone). The sign-up
 * and the sign-ins that follow are counted against this test's own client address, not the one the
 * whole suite would share (see fixtures.ts).
 */
async function signUp(browser: Browser, testInfo: TestInfo, name: string): Promise<Account> {
  const ctx = await freshContext(browser, testInfo, "sign-up");
  const email = `e2e-passkey-${rand()}@example.com`;
  const res = await ctx.request.post("/api/auth/signup", { data: { email, name, password: PASSWORD }, headers: CSRF });
  expect(res.ok(), await res.text()).toBeTruthy();
  await skipIntro(ctx.request);
  const cookies = await ctx.cookies();
  await ctx.close();
  return { email, name, cookies };
}

/**
 * Click "Sign in with a passkey" and let the authenticator answer the prompt that opens.
 *
 * The order matters, and it is not the order of the person's actions. Chrome's virtual authenticator
 * decides about user presence when a request reaches it: a request that arrives while presence is
 * off waits for good, switching presence on afterwards does not wake it. Switching it on right after
 * the click is a race with the page (the click, the challenge request, `credentials.get()`), which a
 * fast machine wins and a slow one loses: the prompt then never answers, the button stays on
 * "Working", and the test waits for a sign-in or an error message that never comes. So the challenge
 * request of the button is held until the authenticator is ready, and the page cannot ask it before
 * that. (The login page's own background request is already waiting when this is called; the click
 * cancels it.)
 */
async function signInWithButton(page: Page, auth: Virtual): Promise<void> {
  const challenge = "**/api/auth/passkey-login/start";
  let ready!: () => void;
  const authenticatorReady = new Promise<void>((resolve) => (ready = resolve));
  await page.route(challenge, async (route) => {
    await authenticatorReady;
    await route.continue();
  });
  try {
    const answered = page.waitForResponse((r) => r.url().endsWith("/api/auth/passkey-login/start"));
    answered.catch(() => {}); // reported by the await below, not as an unhandled rejection if the click fails first
    await page.getByRole("button", { name: "Sign in with a passkey" }).click();
    await auth.present(true);
    ready();
    await answered;
  } finally {
    ready();
    await page.unroute(challenge);
  }
}

async function logOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

async function addPasskey(page: Page, name: string): Promise<void> {
  await page.goto("/account?tab=security");
  await expect(page.getByRole("heading", { name: "Passkeys" })).toBeVisible();
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const dialog = page.getByRole("dialog", { name: "Add a passkey" });
  await expect(dialog.getByLabel("Name")).toHaveValue(/Chrome on/); // a default from the browser and system
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Add passkey" }).click();
  await expect(page.getByText("Passkey added")).toBeVisible();
  await expect(page.getByRole("list", { name: "Your passkeys" })).toContainText(name);
}

test("a passkey is added in the account page, signs the person in without a password, and is removed again", async ({ page, context, browser, diagnostics }, testInfo) => {
  // The refused sign-in at the end is a 401 on purpose; Chrome logs every failed fetch.
  diagnostics.allow(/status of 401.*\/api\/auth\/passkey-login\/finish/);
  const account = await signUp(browser, testInfo, "Passkey E2E");
  const { email } = account;
  await context.addCookies(account.cookies);
  const auth = await virtualAuthenticator(page);

  await addPasskey(page, "E2E laptop");
  // The authenticator holds a discoverable credential with the server's user handle.
  const [made] = await auth.credentials();
  expect(made).toMatchObject({ isResidentCredential: true });
  expect(made?.userHandle).toBeTruthy();
  const countBefore = made!.signCount;
  const list = await (await page.request.get("/api/auth/passkeys")).json();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name: "E2E laptop", last_used_at: null, transports: ["internal"] });
  await expect(page.getByRole("list", { name: "Your passkeys" })).toContainText("never used");

  // Sign out and back in with the passkey alone: no email, no password. The authenticator leaves
  // prompts waiting, so the login page's background request does not sign anybody in by itself.
  await auth.present(false);
  const backgroundRequest = page.waitForResponse((r) => r.url().endsWith("/api/auth/passkey-login/start"));
  await logOut(page);
  await expect(page.getByLabel("Email")).toHaveValue("");
  await expect(page.getByLabel("Email")).toHaveAttribute("autocomplete", /webauthn/); // the autofill list is offered
  // The page has asked for its challenge: give the (absent) sign-in a moment to show itself.
  await backgroundRequest;
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/login/);
  await signInWithButton(page, auth);
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  const me = await (await page.request.get("/api/auth/me")).json();
  expect(me.email).toBe(email);
  expect((await auth.credentials())[0]?.signCount).toBeGreaterThan(countBefore);

  // The list now says when it was used; rename it.
  await page.goto("/account?tab=security");
  const row = page.getByRole("list", { name: "Your passkeys" }).getByRole("listitem");
  await expect(row).toContainText("last used");
  await row.getByRole("button", { name: "Rename E2E laptop" }).click();
  const rename = page.getByRole("dialog", { name: "Rename passkey" });
  await rename.getByLabel("Name").fill("Work laptop");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("Work laptop");

  // Remove it, after a confirmation.
  await row.getByRole("button", { name: "Remove Work laptop" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Remove Work laptop?");
  await confirm.getByRole("button", { name: "Remove passkey" }).click();
  await expect(page.getByText("No passkeys yet")).toBeVisible();
  expect(await (await page.request.get("/api/auth/passkeys")).json()).toEqual([]);

  // The authenticator still holds its copy, but the server no longer knows it.
  await auth.present(false);
  await logOut(page);
  expect(await auth.credentials()).toHaveLength(1);
  await signInWithButton(page, auth);
  await expect(page.getByRole("alert")).toContainText("passkey was not accepted");
  await expect(page).toHaveURL(/\/login/);
  // The password still works.
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
});

test("a sign-in with a passkey skips the two-factor code that a password sign-in still asks for", async ({ page, context, browser }, testInfo) => {
  const account = await signUp(browser, testInfo, "Passkey 2FA E2E");
  const { email } = account;
  await context.addCookies(account.cookies);
  const auth = await virtualAuthenticator(page);

  // Two-factor on, set up through the API the way the account page does.
  const setup = await (await page.request.post("/api/auth/2fa/setup", { data: {}, headers: CSRF })).json();
  const enable = await page.request.post("/api/auth/2fa/enable", { data: { code: totp(setup.secret, Date.now() / 1000 - 30) }, headers: CSRF });
  expect(enable.ok(), await enable.text()).toBeTruthy();
  expect((await (await page.request.get("/api/auth/me")).json()).totp_enabled).toBe(true);

  await addPasskey(page, "2FA laptop");
  const countBefore = (await auth.credentials())[0]!.signCount;
  await auth.present(false);
  await logOut(page);

  // The password leads to the code prompt ...
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  // ... the passkey does not.
  await page.goto("/login");
  await signInWithButton(page, auth);
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  const me = await (await page.request.get("/api/auth/me")).json();
  expect(me).toMatchObject({ email, totp_enabled: true });
  expect((await auth.credentials())[0]?.signCount).toBeGreaterThan(countBefore);

  // The login page also asks the browser for the account's passkeys in the background (conditional
  // mediation, for the email field's autofill list) and a real browser completes that request when the
  // person picks the passkey from the list. Chrome's virtual authenticator, once it approves prompts
  // by itself, completes it right away: signed in, with nothing typed, no button and no code.
  const loggedOut = page.waitForResponse((r) => r.url().endsWith("/api/auth/logout"));
  const signedIn = page.waitForResponse((r) => r.url().endsWith("/api/auth/passkey-login/finish"));
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
  expect((await loggedOut).ok()).toBe(true);
  expect((await signedIn).status()).toBe(200);
  await expect(page).not.toHaveURL(/login/);
  await expect(page.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  expect((await (await page.request.get("/api/auth/me")).json()).email).toBe(email);
});

test("an administrator removes another user's passkeys, and that user falls back to their password", async ({ browser, diagnostics }, testInfo) => {
  diagnostics.allow(/status of 401.*\/api\/auth\/passkey-login\/finish/);
  const account = await signUp(browser, testInfo, "Lost Device");
  const { email, name } = account;

  // The user, in their own browser profile with a device that holds a passkey.
  const userContext = await freshContext(browser, testInfo, "user");
  await userContext.addCookies(account.cookies);
  const user = await userContext.newPage();
  const auth = await virtualAuthenticator(user);
  await addPasskey(user, "Lost phone");
  await auth.present(false);
  await logOut(user);

  // The administrator (created by the journey spec) removes it on the Users page.
  const adminContext = await freshContext(browser, testInfo, "admin");
  const login = await adminContext.request.post("/api/auth/login", { data: { email: ADMIN_EMAIL, password: PASSWORD }, headers: CSRF });
  expect(login.ok(), await login.text()).toBeTruthy();
  const admin = await adminContext.newPage();
  await admin.goto("/admin?tab=users");
  const row = admin.getByRole("row").filter({ hasText: email });
  await expect(row).toContainText("1 passkey");
  await row.getByRole("button", { name: `Actions for ${name}` }).click();
  await admin.getByRole("menuitem", { name: /Remove passkeys/ }).click();
  const confirm = admin.getByRole("alertdialog");
  await expect(confirm).toContainText(`Remove all passkeys of ${name}?`);
  await confirm.getByRole("button", { name: "Remove passkeys" }).click();
  await expect(admin.getByText("1 passkey removed")).toBeVisible();
  await expect(row).not.toContainText(/\d passkeys?/);
  await adminContext.close();

  // The device still has its credential; the server no longer accepts it. The password works.
  expect(await auth.credentials()).toHaveLength(1);
  await signInWithButton(user, auth);
  await expect(user.getByRole("alert")).toContainText("passkey was not accepted");
  await user.getByLabel("Email").fill(email);
  await user.getByLabel("Password").fill(PASSWORD);
  await user.getByRole("button", { name: "Log in" }).click();
  await expect(user.getByRole("heading", { name: "Your workspaces" })).toBeVisible();
  await userContext.close();
});
