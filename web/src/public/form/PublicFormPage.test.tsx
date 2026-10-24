import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicForm } from "@/api/types";
import { apiError, mockApi, renderApp, type Handler } from "@/test/utils";

afterEach(() => vi.unstubAllGlobals());

const dateOpts = { include_time: false, date_format: "iso", time_format: "h24", timezone: null };
const form: PublicForm = {
  title: "Join the waitlist",
  description: "We will write back within a day.",
  base_name: "Studio",
  table_name: "Leads",
  submit_label: "Sign me up",
  success_message: "You are on the list!",
  redirect_url: null,
  show_submit_another: true,
  fields: [
    { id: "f_name", label: "Your name", help: "As on your ID", required: true, type: "text", options: { multiline: false } },
    { id: "f_mail", label: "Email", help: null, required: false, type: "email", options: {} },
    { id: "f_size", label: "Team size", help: null, required: false, type: "number", options: { precision: 0, allow_negative: false } },
    { id: "f_plan", label: "Plan", help: null, required: false, type: "single_select", options: { choices: [{ id: "c1", name: "Free", color: "gray" }, { id: "c2", name: "Pro", color: "blue" }] } },
    { id: "f_tags", label: "Interests", help: null, required: false, type: "multiple_select", options: { choices: [{ id: "t1", name: "Grids", color: "gray" }, { id: "t2", name: "Forms", color: "blue" }] } },
    { id: "f_when", label: "Start date", help: null, required: false, type: "date", options: dateOpts },
    { id: "f_ok", label: "Agree to terms", help: null, required: true, type: "checkbox", options: { icon: "check", color: "green" } },
    { id: "f_stars", label: "Rating", help: null, required: false, type: "rating", options: { max: 5, icon: "star", color: "yellow" } },
    { id: "f_files", label: "Files", help: null, required: false, type: "attachment", options: {} },
  ],
};

function open(routes: Record<string, Handler> = {}, f: PublicForm = form, path = "/form/tok_abc") {
  const api = mockApi({ "GET /api/public/forms/tok_abc": f, ...routes });
  const app = renderApp({ route: path });
  return { api, ...app };
}

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/Your name/), "Ada Lovelace");
  await user.click(screen.getByLabelText(/Agree to terms/));
}

describe("a public form", () => {
  it("shows the title, description, labels, help and required markers without any sign-in", async () => {
    const { api, onUnauthorized } = open();
    expect(await screen.findByRole("heading", { name: "Join the waitlist" })).toBeInTheDocument();
    expect(screen.getByText("We will write back within a day.")).toBeInTheDocument();
    expect(screen.getByText("As on your ID")).toBeInTheDocument();
    expect(screen.getByText("Fields marked * are required.")).toBeInTheDocument();
    for (const label of ["Your name", "Email", "Team size", "Plan", "Start date", "Agree to terms"]) expect(screen.getByLabelText(new RegExp(label))).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Interests/ })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Rating" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign me up" })).toBeEnabled();
    expect(screen.getByText("Powered by")).toBeInTheDocument();
    // Only the form was asked for: no session lookup, no login redirect.
    expect(api.calls.map((c) => c.path)).toEqual(["/api/public/forms/tok_abc"]);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("also answers on /f/:token", async () => {
    open({}, form, "/f/tok_abc");
    expect(await screen.findByRole("heading", { name: "Join the waitlist" })).toBeInTheDocument();
  });

  it("sends the answers as field values, then shows the success message and lets the visitor go again", async () => {
    const user = userEvent.setup();
    const { api } = open({ "POST /api/public/forms/tok_abc/submit": { ok: true } });
    await fillRequired(user);
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Team size"), "12");
    await user.selectOptions(screen.getByLabelText("Plan"), "c2");
    await user.click(screen.getByLabelText("Forms"));
    await user.type(screen.getByLabelText("Start date"), "2026-03-01");
    await user.click(screen.getByRole("radio", { name: "4 of 5" }));
    await user.click(screen.getByRole("button", { name: "Sign me up" }));

    expect(await screen.findByText("You are on the list!")).toBeInTheDocument();
    const call = api.callsTo("POST /api/public/forms/tok_abc/submit")[0]!;
    expect(call.body).toEqual({
      values: { f_name: "Ada Lovelace", f_mail: "ada@example.com", f_size: 12, f_plan: "c2", f_tags: ["t2"], f_when: "2026-03-01", f_ok: true, f_stars: 4 },
    });

    await user.click(screen.getByRole("button", { name: "Submit another response" }));
    expect(await screen.findByLabelText(/Your name/)).toHaveValue("");
  });

  it("does not offer another response when the form says not to", async () => {
    const user = userEvent.setup();
    open({ "POST /api/public/forms/tok_abc/submit": { ok: true } }, { ...form, show_submit_another: false });
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Sign me up" }));
    expect(await screen.findByText("You are on the list!")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit another response" })).not.toBeInTheDocument();
  });

  it("checks required fields and values before sending anything", async () => {
    const user = userEvent.setup();
    const { api } = open();
    await user.type(await screen.findByLabelText("Team size"), "lots");
    await user.click(screen.getByRole("button", { name: "Sign me up" }));
    expect(await screen.findByText(/not a number/)).toBeInTheDocument();
    expect(screen.getByText("This field is required.")).toBeInTheDocument();
    expect(screen.getByText("This box must be checked.")).toBeInTheDocument();
    expect(screen.getByText(/Some answers need attention/)).toBeInTheDocument();
    expect(api.callsTo("POST /api/public/forms/tok_abc/submit")).toHaveLength(0);
    // The first problem takes focus.
    expect(screen.getByLabelText(/Your name/)).toHaveFocus();
    // Fixing a field clears its message.
    await user.type(screen.getByLabelText(/Your name/), "Ada");
    expect(screen.queryByText("This field is required.")).not.toBeInTheDocument();
  });

  it("keeps the answers and explains a refusal by the server", async () => {
    const user = userEvent.setup();
    open({ "POST /api/public/forms/tok_abc/submit": apiError(400, "bad_request", 'field "Email" is not valid') });
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Sign me up" }));
    expect(await screen.findByText('field "Email" is not valid')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your name/)).toHaveValue("Ada Lovelace");
    expect(screen.getByRole("button", { name: "Sign me up" })).toBeEnabled();
  });

  it("says so when the visitor submits too often, or the form has been closed meanwhile", async () => {
    const user = userEvent.setup();
    const { api } = open({ "POST /api/public/forms/tok_abc/submit": apiError(429, "too_many_requests", "slow down") });
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Sign me up" }));
    expect(await screen.findByText(/Too many submissions/)).toBeInTheDocument();
    api.set("POST /api/public/forms/tok_abc/submit", apiError(404, "not_found", "share link not found"));
    await user.click(screen.getByRole("button", { name: "Sign me up" }));
    expect(await screen.findByText(/form has been closed/)).toBeInTheDocument();
  });

  it("uploads files for attachment fields through the form's endpoint and submits their references", async () => {
    const user = userEvent.setup();
    const ref = { id: "att1", filename: "cv.pdf", mime: "application/pdf", size: 2048 };
    const { api } = open({ "POST /api/public/forms/tok_abc/attachments": { status: 200, json: ref }, "POST /api/public/forms/tok_abc/submit": { ok: true } });
    await fillRequired(user);
    await user.upload(screen.getByLabelText("Upload files for Files"), new File(["%PDF"], "cv.pdf", { type: "application/pdf" }));
    const list = await screen.findByRole("list", { name: "Files for Files" });
    expect(within(list).getByText("cv.pdf")).toBeInTheDocument();
    expect(api.callsTo("POST /api/public/forms/tok_abc/attachments")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Sign me up" }));
    await screen.findByText("You are on the list!");
    expect((api.callsTo("POST /api/public/forms/tok_abc/submit")[0]!.body as { values: Record<string, unknown> }).values["f_files"]).toEqual([{ ...ref, width: null, height: null }]);
  });

  it("reports an upload that fails and lets the visitor remove a file", async () => {
    const user = userEvent.setup();
    open({ "POST /api/public/forms/tok_abc/attachments": apiError(413, "payload_too_large", "the upload is larger than the limit of 25 MB") });
    await user.upload(await screen.findByLabelText("Upload files for Files"), new File(["x"], "big.bin"));
    expect(await screen.findByText(/big.bin: the upload is larger than the limit/)).toBeInTheDocument();
  });
});

describe("a protected form", () => {
  const protectedRoute = (call: { headers: Headers }) => (call.headers.get("X-Share-Password") === "open sesame" ? form : call.headers.get("X-Share-Password") ? apiError(401, "share_password_invalid", "the password is incorrect") : apiError(401, "share_password_required", "this link is protected by a password"));

  it("asks for the password, rejects a wrong one and then shows the form, sending the password with the submission", async () => {
    const user = userEvent.setup();
    const { api, onUnauthorized } = open({ "GET /api/public/forms/tok_abc": protectedRoute, "POST /api/public/forms/tok_abc/submit": { ok: true } });
    expect(await screen.findByText("This form is password protected")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("That password is not correct. Try again.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "open sesame");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Join the waitlist" })).toBeInTheDocument();

    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Sign me up" }));
    await screen.findByText("You are on the list!");
    expect(api.callsTo("POST /api/public/forms/tok_abc/submit")[0]!.headers.get("X-Share-Password")).toBe("open sesame");
    expect(onUnauthorized).not.toHaveBeenCalled();
    // Memory only: nothing was written to storage or the address bar.
    expect(JSON.stringify({ ...localStorage })).not.toContain("open sesame");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("open sesame");
  });
});

describe("a form that cannot be shown", () => {
  it("says a switched-off or unknown link is not available", async () => {
    const { onUnauthorized } = open({ "GET /api/public/forms/tok_abc": apiError(404, "not_found", "share link not found") });
    expect(await screen.findByRole("heading", { name: "This form is not available" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("offers a retry when the link is rate limited", async () => {
    const user = userEvent.setup();
    const { api } = open({ "GET /api/public/forms/tok_abc": apiError(429, "too_many_requests", "slow down") });
    expect(await screen.findByRole("heading", { name: "Too many requests" })).toBeInTheDocument();
    api.set("GET /api/public/forms/tok_abc", form);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Join the waitlist" })).toBeInTheDocument();
  });

  it("does not bounce a visitor to the login page even if a 401 slips through", async () => {
    const { onUnauthorized } = open({ "GET /api/public/forms/tok_abc": apiError(401, "unauthorized", "nope") });
    await waitFor(() => expect(screen.queryByLabelText("Password")).not.toBeInTheDocument());
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("the redirect after submitting", () => {
  function stubLocation() {
    const assign = vi.fn();
    const real = window.location;
    vi.stubGlobal("location", { ...real, assign, pathname: real.pathname, search: real.search, origin: real.origin });
    return assign;
  }

  it("goes to the configured address at once, in place of the message and without another-response button", async () => {
    const assign = stubLocation();
    const user = userEvent.setup();
    open({ "POST /api/public/forms/tok_abc/submit": { ok: true } }, { ...form, redirect_url: "https://example.com/thanks" });
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Sign me up" }));
    await screen.findByText("Taking you on…");
    expect(assign).toHaveBeenCalledWith("https://example.com/thanks");
    expect(screen.queryByText("You are on the list!")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit another response" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "https://example.com/thanks");
  });

  it("puts the new record's id into {record_id}", async () => {
    const assign = stubLocation();
    const user = userEvent.setup();
    open({ "POST /api/public/forms/tok_abc/submit": { ok: true, record_id: "rec_9/x" } }, { ...form, redirect_url: "https://example.com/thanks?id={record_id}" });
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Sign me up" }));
    await screen.findByText("Taking you on…");
    expect(assign).toHaveBeenCalledWith("https://example.com/thanks?id=rec_9%2Fx");
  });

  it("ignores an address that is not http or https", async () => {
    const assign = stubLocation();
    const user = userEvent.setup();
    open({ "POST /api/public/forms/tok_abc/submit": { ok: true } }, { ...form, redirect_url: "javascript:alert(1)" });
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Sign me up" }));
    await screen.findByText("You are on the list!");
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("icons on a public form", () => {
  it("shows the base and table with their icons above the title", async () => {
    open({}, { ...form, base_icon: "store", table_icon: "clipboard-list" });
    await screen.findByRole("heading", { name: "Join the waitlist" });
    const header = document.querySelector("form header")!;
    expect(header.querySelector("svg.lucide-store")).toBeInTheDocument();
    expect(header.querySelector("svg.lucide-clipboard-list")).toBeInTheDocument();
    expect(header).toHaveTextContent("Studio / Leads");
  });

  it("shows just the names without icons", async () => {
    open();
    await screen.findByRole("heading", { name: "Join the waitlist" });
    expect(document.querySelector("form header svg")).toBeNull();
    expect(document.querySelector("form header")).toHaveTextContent("Studio / Leads");
  });
});
