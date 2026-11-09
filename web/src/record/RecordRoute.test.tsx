/** The record page's route (REC-1, REC-9): what the address says, the way in and out, and the old links that lead here. */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigationType } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { AppRoutes } from "@/App";
import { setUnauthorizedHandler } from "@/api/client";
import { Providers, createQueryClient } from "@/providers";
import { field, makeRecord, makeTable } from "@/test/fields";
import { USER, makeSchema, makeWorkspace, mockApi, stubDesktop, stubPhone } from "@/test/utils";

afterEach(() => setUnauthorizedHandler(null));

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const tasks = makeTable([name], { id: "tbl1", name: "Tasks" });
const people = makeTable([{ ...field("text", { multiline: false }, { id: "fld_pname", name: "Name" }), table_id: "tbl2" }], { id: "tbl2", name: "People", color: "orange" });
const schema = { ...makeSchema("owner"), tables: [tasks, people] };
const rec = (id: string, title: string, table = "tbl1") => ({ ...makeRecord({ [table === "tbl1" ? "fld_name" : "fld_pname"]: title }, id), table_id: table });

function Where() {
  const l = useLocation();
  return (
    <output data-testid="where" data-type={useNavigationType()}>
      {l.pathname + l.search}
    </output>
  );
}

function open(route: string | { pathname: string; state: unknown }[], extra: Record<string, unknown> = {}, phone = false) {
  if (phone) stubPhone();
  else stubDesktop();
  const api = mockApi({
    "GET /api/auth/me": USER,
    "GET /api/bases/app1": schema,
    "GET /api/bases/app1/collaborators": [],
    "GET /api/workspaces": [makeWorkspace("owner", [{ id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role: "owner", is_top_level: false, people: [], tables: [] }])],
    "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://base.example.org", passkeys_enabled: true },
    "GET /api/tables/tbl1/records/rec1": rec("rec1", "Launch"),
    "GET /api/tables/tbl1/records/rec2": rec("rec2", "Ship it"),
    "GET /api/tables/tbl2/records/recP": rec("recP", "Grace", "tbl2"),
    "GET /api/records/rec1/comments": [],
    "GET /api/records/rec2/comments": [],
    "GET /api/records/recP/comments": [],
    "POST /api/views/viw1/query": (call: { body: { neighbours_of?: string } }) => {
      const order = ["rec1", "rec2"];
      const at = order.indexOf(call.body.neighbours_of ?? "");
      return { total: 2, offset: 0, records: [], groups: [], colors: {}, neighbours: { previous: order[at - 1] ?? null, next: at >= 0 ? (order[at + 1] ?? null) : null } };
    },
    ...extra,
  } as never);
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, staleTime: 0, gcTime: 0 } });
  render(
    <Providers client={client}>
      <MemoryRouter initialEntries={typeof route === "string" ? [route] : route} initialIndex={typeof route === "string" ? 0 : route.length - 1}>
        <AppRoutes />
        <Where />
      </MemoryRouter>
    </Providers>,
  );
  return api;
}

const where = () => screen.getByTestId("where");

describe("the record route", () => {
  it("shows a record at its own address, with the view it was opened from in it", async () => {
    open("/base/app1/tbl1/viw1/r/rec1");
    expect(await screen.findByRole("heading", { level: 1, name: "Launch" })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: "Record" })).toBeInTheDocument();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Project tracker" })).toHaveAttribute("href", "/base/app1");
    expect(within(crumbs).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/base/app1/tbl1/viw1");
  });

  it("works without a view in the address, following the collection's default view", async () => {
    open("/base/app1/tbl1/r/rec1");
    expect(await screen.findByRole("heading", { level: 1, name: "Launch" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/base/app1/tbl1/viw1");
  });

  it("steps to the next record in the view's order, replacing the page rather than adding one", async () => {
    const user = userEvent.setup();
    open("/base/app1/tbl1/viw1/r/rec1");
    await screen.findByRole("heading", { level: 1, name: "Launch" });
    const next = screen.getByRole("button", { name: /Next record/ });
    await waitFor(() => expect(next).toBeEnabled());
    await user.click(next);
    expect(await screen.findByRole("heading", { level: 1, name: "Ship it" })).toBeInTheDocument();
    expect(where()).toHaveTextContent("/base/app1/tbl1/viw1/r/rec2");
    await waitFor(() => expect(screen.getByRole("button", { name: /Previous record/ })).toBeEnabled());
  });

  it("answers a record that is not there, or a folder or collection that is gone, inside the shell", async () => {
    open("/base/app1/tbl1/viw1/r/recX", { "GET /api/tables/tbl1/records/recX": { status: 404, json: { error: { code: "not_found", message: "no such record" } } } });
    expect(await screen.findByText("This record could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to Tasks" })).toBeInTheDocument();
  });

  it("says so when the collection in the address does not exist", async () => {
    open("/base/app1/tblGone/r/rec1");
    expect(await screen.findByText("Record not found")).toBeInTheDocument();
  });

  it("has no bottom navigation on a phone, and a header with the way back", async () => {
    open("/base/app1/tbl1/viw1/r/rec1", {}, true);
    await screen.findByRole("heading", { level: 1, name: "Launch" });
    expect(screen.queryByRole("navigation", { name: "Main menu" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Back to Tasks" })).toBeInTheDocument();
  });
});

describe("the way back from a linked record's page", () => {
  const linked = [
    { pathname: "/base/app1/tbl1/viw1", state: null },
    { pathname: "/base/app1/tbl1/viw1/r/rec1", state: { obRecord: { from: "/base/app1/tbl1/viw1", steps: 1 } } },
    { pathname: "/base/app1/tbl2/r/recP", state: { obRecord: { from: "/base/app1/tbl1/viw1", steps: 2 } } },
  ];

  it("has a crumb that names this record's collection and goes to it, not to where the trail began", async () => {
    open(linked);
    await screen.findByRole("heading", { level: 1, name: "Grace" });
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "People" })).toHaveAttribute("href", "/base/app1/tbl2/viw1");
  });

  it("has a phone back link that names the collection it leads to, and leads back to it", async () => {
    const user = userEvent.setup();
    open(linked, {}, true);
    await screen.findByRole("heading", { level: 1, name: "Grace" });
    const back = within(screen.getByRole("banner")).getByRole("link", { name: "Back to Tasks" });
    expect(back).toHaveAttribute("href", "/base/app1/tbl1/viw1");
    await user.click(back);
    await waitFor(() => expect(where()).toHaveTextContent(/^\/base\/app1\/tbl1\/viw1$/));
    // A step back in history, not a new entry on top of the pages (so the system's back goes on from the list).
    expect(where()).toHaveAttribute("data-type", "POP");
  });
});

describe("leaving a record's page", () => {
  it("returns to the collection with Escape, as a link opened straight at the page also does", async () => {
    const user = userEvent.setup();
    open("/base/app1/tbl1/viw1/r/rec1");
    await screen.findByRole("heading", { level: 1, name: "Launch" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(where()).toHaveTextContent(/^\/base\/app1\/tbl1\/viw1$/));
  });

  it("returns to the collection it was opened from, past the linked records opened since", async () => {
    const user = userEvent.setup();
    open([
      { pathname: "/base/app1/tbl1/viw1", state: null },
      { pathname: "/base/app1/tbl1/viw1/r/rec1", state: { obRecord: { from: "/base/app1/tbl1/viw1", steps: 1 } } },
      { pathname: "/base/app1/tbl2/r/recP", state: { obRecord: { from: "/base/app1/tbl1/viw1", steps: 2 } } },
    ]);
    await screen.findByRole("heading", { level: 1, name: "Grace" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(where()).toHaveTextContent(/^\/base\/app1\/tbl1\/viw1$/));
  });
});

describe("a link to a record followed while signed out", () => {
  it("goes through sign-in and comes back to the page", async () => {
    const user = userEvent.setup();
    let signedIn = false;
    open("/base/app1/tbl1/viw1/r/rec1", {
      "GET /api/auth/me": () => (signedIn ? USER : { status: 401, json: { error: { code: "unauthorized", message: "no session" } } }),
      "POST /api/auth/login": () => {
        signedIn = true;
        return { user: USER, two_factor_required: false };
      },
    });
    expect(await screen.findByRole("heading", { name: "Log in" })).toBeInTheDocument();
    expect(where()).toHaveTextContent(`/login?next=${encodeURIComponent("/base/app1/tbl1/viw1/r/rec1")}`);
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Launch" })).toBeInTheDocument();
    expect(where()).toHaveTextContent("/base/app1/tbl1/viw1/r/rec1");
  });
});

describe("old record links", () => {
  it("send ?record= to the page, keeping the view", async () => {
    open("/base/app1/tbl1/viw1?record=rec1");
    expect(await screen.findByRole("heading", { level: 1, name: "Launch" })).toBeInTheDocument();
    expect(where()).toHaveTextContent("/base/app1/tbl1/viw1/r/rec1");
    expect(where()).not.toHaveTextContent("?");
  });

  it("send a link with no view (a notification's, an email's) to the page, which finds the view itself", async () => {
    open("/base/app1/tbl1?record=rec2");
    expect(await screen.findByRole("heading", { level: 1, name: "Ship it" })).toBeInTheDocument();
    expect(where()).toHaveTextContent("/base/app1/tbl1/r/rec2");
  });

  it("send ?linked= to the linked record that was on top", async () => {
    open("/base/app1/tbl1/viw1?record=rec1&linked=tbl2.recP");
    expect(await screen.findByRole("heading", { level: 1, name: "Grace" })).toBeInTheDocument();
    expect(where()).toHaveTextContent("/base/app1/tbl2/r/recP");
  });
});
