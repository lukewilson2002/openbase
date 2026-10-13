import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShareLink, View } from "@/api/types";
import { ALL_FIELDS, field, makeTable } from "@/test/fields";
import { apiError, makeView, mockApi, renderWithProviders } from "@/test/utils";
import { MAX_SHARES_PER_VIEW, ShareViewDialog, canShareView, shareKindOf } from "./ShareViewDialog";

afterEach(() => vi.unstubAllGlobals());

const name = field("single_line_text", {}, { id: "f_name", name: "Name" });
const secret = field("single_line_text", {}, { id: "f_secret", name: "Salary" });
const owner = field("user", { multiple: false, notify: false }, { id: "f_owner", name: "Owner" });
const table = makeTable([name, secret, owner, ALL_FIELDS.attachment!]);

const link = (over: Partial<ShareLink> = {}): ShareLink => ({
  id: "shr1",
  view_id: "viw1",
  kind: "view",
  token: "tok_abc",
  path: "/s/tok_abc",
  url: "https://base.example.com/s/tok_abc",
  enabled: true,
  has_password: false,
  created_by: "usr1",
  created_at: 1_700_000_000_000,
  ...over,
});

function open(view: View, links: ShareLink[], routes: Record<string, unknown> = {}) {
  const api = mockApi({ [`GET /api/views/${view.id}/shares`]: links, ...routes } as never);
  renderWithProviders(<ShareViewDialog open onOpenChange={() => {}} view={view} table={table} />);
  return api;
}

describe("who can share what", () => {
  it("is for creators and owners, never for personal views", () => {
    const shared = makeView({ id: "viw1" });
    expect(canShareView("creator", shared)).toBe(true);
    expect(canShareView("owner", shared)).toBe(true);
    expect(canShareView("editor", shared)).toBe(false);
    expect(canShareView("viewer", shared)).toBe(false);
    expect(canShareView("creator", makeView({ id: "viw2", personal: true }))).toBe(false);
  });

  it("makes form links for form views and read-only links for the rest", () => {
    expect(shareKindOf(makeView({ id: "a", type: "form" }))).toBe("form");
    for (const type of ["grid", "gallery", "kanban", "calendar", "timeline", "list"] as const) expect(shareKindOf(makeView({ id: "a", type }))).toBe("view");
  });
});

describe("a read-only view link", () => {
  const view = makeView({ id: "viw1", name: "Team" });
  view.config.hidden_fields = ["f_secret"];

  it("lists the links with their public address and what they expose", async () => {
    open(view, [link(), link({ id: "shr2", token: "tok_pw", has_password: true, enabled: false, url: "https://base.example.com/s/tok_pw" })]);
    const dialog = await screen.findByRole("dialog", { name: "Share Team" });
    const addresses = await within(dialog).findAllByRole("textbox", { name: "View link" });
    expect(addresses.map((a) => (a as HTMLInputElement).value)).toEqual(["https://base.example.com/share/tok_abc", "https://base.example.com/share/tok_pw"]);
    expect(within(dialog).getByText("Password protected")).toBeInTheDocument();
    expect(within(dialog).getByText(/switched off/)).toBeInTheDocument();
    // The explanation names the visible fields and the hidden one.
    expect(within(dialog).getByText(/the 3 visible fields/)).toBeInTheDocument();
    expect(within(dialog).getByText(/The 1 hidden field never leaves the server/)).toBeInTheDocument();
    expect(within(dialog).getByText(/e-mail addresses and user ids/)).toBeInTheDocument();
  });

  it("creates a link without a password", async () => {
    const user = userEvent.setup();
    const created = link({ id: "shr9" });
    const api = open(view, [], { "POST /api/views/viw1/shares": { status: 201, json: created } });
    await screen.findByText(/No links yet/);
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(api.callsTo("POST /api/views/viw1/shares")).toHaveLength(1));
    expect(api.callsTo("POST /api/views/viw1/shares")[0]!.body).toEqual({ kind: "view" });
  });

  it("creates a password-protected link and checks the length first", async () => {
    const user = userEvent.setup();
    const api = open(view, [], { "POST /api/views/viw1/shares": { status: 201, json: link({ has_password: true }) } });
    await screen.findByText(/No links yet/);
    await user.click(screen.getByRole("switch", { name: "Protect with a password" }));
    await user.type(screen.getByLabelText("Password"), "abc");
    await user.click(screen.getByRole("button", { name: "Create link" }));
    expect(await screen.findByText("Use at least 4 characters.")).toBeInTheDocument();
    expect(api.callsTo("POST /api/views/viw1/shares")).toHaveLength(0);
    await user.type(screen.getByLabelText("Password"), "d");
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(api.callsTo("POST /api/views/viw1/shares")).toHaveLength(1));
    expect(api.callsTo("POST /api/views/viw1/shares")[0]!.body).toEqual({ kind: "view", password: "abcd" });
  });

  it("switches a link off and on again", async () => {
    const user = userEvent.setup();
    const api = open(view, [link()], { "PATCH /api/shares/shr1": link({ enabled: false }) });
    await user.click(await screen.findByRole("switch", { name: "Link enabled" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/shares/shr1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/shares/shr1")[0]!.body).toEqual({ enabled: false });
  });

  it("sets, changes and removes a password", async () => {
    const user = userEvent.setup();
    // A tiny stateful server: the list reflects what the PATCH did.
    let current = link();
    const api = open(view, [], {
      "GET /api/views/viw1/shares": () => [current],
      "PATCH /api/shares/shr1": (call: { body: unknown }) => {
        const body = call.body as { password?: string | null };
        current = { ...current, has_password: typeof body.password === "string" };
        return current;
      },
    });
    await user.click(await screen.findByRole("button", { name: "Set password" }));
    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Save password" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/shares/shr1")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/shares/shr1")[0]!.body).toEqual({ password: "hunter22" });

    await user.click(await screen.findByRole("button", { name: "Remove password" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/shares/shr1")).toHaveLength(2));
    // JSON null removes the password; leaving the key out would keep it.
    expect(api.callsTo("PATCH /api/shares/shr1")[1]!.body).toEqual({ password: null });
    expect(await screen.findByRole("button", { name: "Set password" })).toBeInTheDocument();
  });

  it("deletes a link after confirming", async () => {
    const user = userEvent.setup();
    const api = open(view, [link()], { "DELETE /api/shares/shr1": { status: 204 } });
    await user.click(await screen.findByRole("button", { name: "Delete link" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/not found/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Delete link" }));
    await waitFor(() => expect(api.callsTo("DELETE /api/shares/shr1")).toHaveLength(1));
  });

  it("stops at the server's limit of links per view", async () => {
    const many = Array.from({ length: MAX_SHARES_PER_VIEW }, (_, i) => link({ id: `shr${i}`, token: `tok${i}`, url: `https://base.example.com/s/tok${i}` }));
    open(view, many);
    expect(await screen.findByText(/at most 20 links/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
  });

  it("shows why the links could not be loaded", async () => {
    mockApi({ "GET /api/views/viw1/shares": apiError(403, "forbidden", "Only creators can manage share links.") });
    renderWithProviders(<ShareViewDialog open onOpenChange={() => {}} view={view} table={table} />);
    expect(await screen.findByText("Only creators can manage share links.")).toBeInTheDocument();
  });
});

describe("a form link", () => {
  const form = makeView({ id: "viw1", name: "Sign up", type: "form" });
  form.config.form.fields = [
    { field_id: "f_name", required: true, label: "Your name", help: null },
    { field_id: "f_owner", required: false, label: null, help: null },
  ];

  it("explains what visitors can do and which fields are asked", async () => {
    open(form, [link({ kind: "form", url: "https://base.example.com/f/tok_abc", path: "/f/tok_abc" })]);
    const dialog = await screen.findByRole("dialog", { name: "Share Sign up" });
    expect(within(dialog).getByText(/never see any record/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 field: Your name/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 more \(links and users\) are not collected publicly/)).toBeInTheDocument();
    const address = await within(dialog).findByRole("textbox", { name: "Form link" });
    expect((address as HTMLInputElement).value).toBe("https://base.example.com/form/tok_abc");
  });

  it("creates a form link", async () => {
    const user = userEvent.setup();
    const api = open(form, [], { "POST /api/views/viw1/shares": { status: 201, json: link({ kind: "form" }) } });
    await screen.findByText(/No form links yet/);
    await user.click(screen.getByRole("button", { name: "Create form link" }));
    await waitFor(() => expect(api.callsTo("POST /api/views/viw1/shares")).toHaveLength(1));
    expect(api.callsTo("POST /api/views/viw1/shares")[0]!.body).toEqual({ kind: "form" });
  });

  it("warns when no field can be collected publicly", async () => {
    const onlyUsers = makeView({ id: "viw1", name: "Odd", type: "form" });
    onlyUsers.config.form.fields = [{ field_id: "f_owner", required: false, label: null, help: null }];
    open(onlyUsers, []);
    expect(await screen.findByText(/no fields visitors can fill in/)).toBeInTheDocument();
  });
});
