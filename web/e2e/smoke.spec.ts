import { expect, test } from "@playwright/test";

// Skeleton: runs only against a live server (OPENGRID_E2E=1). Later workstreams grow this into
// the journeys from the plan: setup -> create base -> add fields -> edit cells -> filter/sort ->
// kanban drag -> form submit -> share link.
test.skip(!process.env.OPENGRID_E2E, "set OPENGRID_E2E=1 and start an opengrid server to run E2E tests");

test("the app shell loads without CSP violations and shows the first-run or login screen", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && /content security policy/i.test(msg.text())) violations.push(msg.text());
  });
  page.on("pageerror", (err) => violations.push(err.message));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Set up OpenGrid|Log in/ })).toBeVisible();
  expect(violations).toEqual([]);
});

test("unknown API paths return the JSON error format", async ({ request }) => {
  const res = await request.get("/api/does-not-exist");
  expect(res.status()).toBe(404);
  expect((await res.json()).error.code).toBe("not_found");
});
