/**
 * The Admin -> Email settings against the real server, through the web client's own API functions
 * and the generated types. The shared contract server must keep email OFF (other tests rely on
 * it: automations refuse send_email, the setup status says email is not configured), so this file
 * never saves a host; delivery, environment precedence and the token rules are covered by the
 * Rust tests (crates/server/tests/admin_email.rs).
 */
import { afterAll, describe, expect, it } from "vitest";
import { api } from "../src/api/endpoints";
import { adminProfile, expectError, failure, newUser, type Profile } from "./support";
import { parse } from "./typecheck";

let admin: Profile;

async function settings() {
  return parse("EmailSettings", await admin.run(api.admin.email));
}

describe("email settings", () => {
  it("reads the effective settings with their sources (email is off here)", async () => {
    admin = await adminProfile();
    const s = await settings();
    expect(s.enabled).toBe(false);
    expect(s.source).toBe("unset");
    expect(s.host ?? null).toBeNull();
    expect(s.port).toBe(587);
    expect(s.security).toBe("starttls");
    expect(s.password_set).toBe(false);
    expect(s.sources).toEqual({ host: "unset", port: "default", security: "default", username: "unset", password: "unset", from: "default" });
    expect(s.budgets).toEqual({ per_user_hour: 100, per_hour: 500 });
  });

  it("is closed to regular users", async () => {
    const user = await newUser(admin, "plain");
    expectError(await failure(user.run(api.admin.email)), 403, "forbidden");
    expectError(await failure(user.run(() => api.admin.updateEmail({ port: 25 }))), 403, "forbidden");
    expectError(await failure(user.run(() => api.admin.sendTestEmail())), 403, "forbidden");
  });

  it("saves settings (without a host) and keeps the password write-only", async () => {
    const saved = parse(
      "EmailSettings",
      await admin.run(() => api.admin.updateEmail({ port: 2525, security: "tls", username: "mailer", from: "Base <base@example.test>", password: "contract-smtp-secret" })),
    );
    expect(saved).toMatchObject({ enabled: false, port: 2525, security: "tls", username: "mailer", from: "Base <base@example.test>", password_set: true });
    expect(saved.sources).toMatchObject({ port: "settings", security: "settings", username: "settings", password: "settings", from: "settings", host: "unset" });
    expect(JSON.stringify(saved)).not.toContain("contract-smtp-secret");
    expect(JSON.stringify(await settings())).not.toContain("contract-smtp-secret");

    // an empty password keeps the saved one, null removes it
    const kept = parse("EmailSettings", await admin.run(() => api.admin.updateEmail({ password: "", port: 587 })));
    expect(kept.password_set).toBe(true);
    expect(kept.port).toBe(587);
    const removed = parse("EmailSettings", await admin.run(() => api.admin.updateEmail({ password: null })));
    expect(removed.password_set).toBe(false);
    expect(removed.sources.password).toBe("unset");
  });

  it("refuses invalid values with a 400 and changes nothing", async () => {
    for (const body of [{ host: "https://smtp.example.test" }, { port: 0 }, { security: "ssl" }, { from: "not an address" }]) {
      expectError(await failure(admin.run(() => api.admin.updateEmail(body))), 400, "bad_request");
    }
    const s = await settings();
    expect(s.enabled).toBe(false);
    expect(s.port).toBe(587);
  });

  it("answers a test email without a mail server as a normal result with the reason", async () => {
    const result = parse("EmailTestResult", await admin.run(() => api.admin.sendTestEmail()));
    expect(result.ok).toBe(false);
    expect(result.to).toBe(admin.user!.email);
    expect(result.error).toMatch(/no SMTP host/);
    const other = parse("EmailTestResult", await admin.run(() => api.admin.sendTestEmail("ops@example.test")));
    expect(other.to).toBe("ops@example.test");
    expectError(await failure(admin.run(() => api.admin.sendTestEmail("not an address"))), 400, "bad_request");
  });

  afterAll(async () => {
    // leave the shared server as it was found
    await admin.run(() => api.admin.updateEmail({ port: 587, security: "starttls", username: null, from: "", password: null }));
  });
});
