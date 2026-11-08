/** The two embeds of the record page's Page (REC-6): alive on the page, a table each, and what a reader may and may not see. */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaseSchema, Field, Table, TableRecord, View, WorkspaceSummary } from "@/api/types";
import { field, makeRecord, makeTable } from "@/test/fields";
import { apiError, makeSchema, makeView, makeWorkspace, USER } from "@/test/utils";
import { PATCH_RECORDS, renderRecordPage } from "@/test/recordPage";
import { readDraft } from "@/views/drafts/store";

const FIELD = "fldInvoicesAbCde";
const VIEW_HERE = "viwOverdueAbCdef";
const VIEW_ELSEWHERE = "viwHiringAbCdefg";
const VIEW_PERSONAL = "viwMineAbCdefgh";
const VIEW_UNOPENED = "viwSecretAbCdefg";

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const page = field("rich_text", {}, { id: "fld_page", name: "Page" });
const invoices = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_client", single: false }, { id: FIELD, name: "Invoices" });

const invName = field("text", { multiline: false }, { id: "fld_inv_name", name: "Invoice" });
const amount = field("currency", { precision: 2, symbol: "$", allow_negative: false }, { id: "fld_amount", name: "Amount" });
const status = field("text", { multiline: false }, { id: "fld_inv_status", name: "Status" });
const due = field("text", { multiline: false }, { id: "fld_due", name: "Due" });
const extra = field("text", { multiline: false }, { id: "fld_extra", name: "Notes" });
const client = field("link", { linked_table_id: "tbl1", inverse_field_id: FIELD, single: false }, { id: "fld_client", name: "Client" });

const clients: Table = makeTable([name, invoices, page], { id: "tbl1", name: "Clients", record_noun: "client", body_field_id: "fld_page", primary_field_id: "fld_name" });
const invoiceViews: View[] = [
  { ...makeView({ id: "viw_inv_default", name: "Grid" }), table_id: "tbl2", is_default: true },
  { ...makeView({ id: VIEW_HERE, name: "Overdue" }), table_id: "tbl2", config: { ...makeView({ id: "x" }).config, hidden_fields: ["fld_inv_status"] } },
  { ...makeView({ id: VIEW_PERSONAL, name: "Mine" }), table_id: "tbl2", personal: true },
];
const invoiceTable: Table = {
  ...makeTable([invName, amount, status, due, extra, client], { id: "tbl2", name: "Invoices", primary_field_id: "fld_inv_name", record_noun: "invoice" }),
  views: invoiceViews,
  fields: [invName, amount, status, due, extra, client].map((f) => ({ ...f, table_id: "tbl2" }) as Field),
};

const inv = (id: string, label: string, cents: number): TableRecord => ({ ...makeRecord({ fld_inv_name: label, fld_amount: cents, fld_inv_status: "Open", fld_due: "Nov 14", fld_extra: "n" }, id), table_id: "tbl2" });
const INV1 = inv("rec_inv1", "INV-1", 600);
const INV2 = inv("rec_inv2", "INV-2", 120);
const INV3 = inv("rec_inv3", "INV-3", 99);

const linkedBlock = `\`\`\`openbase\n{"embed":"linked","field":"${FIELD}"}\n\`\`\``;
const viewBlock = (id: string, limit = 10) => `\`\`\`openbase\n{"embed":"view","view":"${id}","limit":${limit}}\n\`\`\``;

const otherFolder = (views: View[] = [{ ...makeView({ id: VIEW_ELSEWHERE, name: "Open roles" }), table_id: "tbl9" }]): BaseSchema => ({
  ...makeSchema("owner"),
  id: "app2",
  name: "Hiring",
  tables: [{ ...makeTable([name], { id: "tbl9", base_id: "app2", name: "Roles", color: "teal" }), views }],
});

const QUERY_HERE = `POST /api/views/${VIEW_HERE}/query`;

interface Setup {
  role?: string;
  text: string;
  links?: { id: string; name: string }[];
  routes?: Record<string, unknown>;
  workspaces?: WorkspaceSummary[];
}

function open({ role = "owner", text, links = [{ id: "rec_inv1", name: "INV-1" }, { id: "rec_inv2", name: "INV-2" }], routes = {}, workspaces }: Setup) {
  const folder: BaseSchema = { ...makeSchema(role), tables: [{ ...clients, views: [{ ...makeView({ id: "viw1", name: "All clients" }), is_default: true }] }, invoiceTable] };
  return renderRecordPage({
    table: clients,
    record: makeRecord({ fld_name: "Harper & Co", fld_page: text, ...(links.length ? { [FIELD]: links } : {}) }),
    role,
    routes: {
      "GET /api/bases/app1": () => folder,
      "GET /api/auth/me": USER,
      "GET /api/workspaces": workspaces ?? [makeWorkspace(role, [{ id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role, people: [], tables: [], is_top_level: true }])],
      "POST /api/tables/tbl2/records/get": (call: { body: unknown }) => ({ records: [INV1, INV2, INV3].filter((r) => (call.body as { ids: string[] }).ids.includes(r.id)) }),
      [QUERY_HERE]: { total: 12, offset: 0, records: [INV1, INV2, INV3], groups: [], colors: {} },
      ...routes,
    } as never,
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("Linked records", () => {
  it("is a table of the linked collection's title and first three properties, with a caption counting the links", async () => {
    open({ text: linkedBlock });
    const embed = await screen.findByRole("region", { name: "Invoices · linked to this client, 2" });
    expect(within(embed).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Invoice", "Amount", "Status", "Due"]);
    const rows = within(embed).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByRole("link", { name: "INV-1" })).toHaveAttribute("href", "/base/app1/tbl2/r/rec_inv1");
    expect(rows[0]).toHaveTextContent("$600.00");
    // The fourth property is not on show.
    expect(within(embed).queryByText("Notes")).not.toBeInTheDocument();
    // It is not the embedded text.
    expect(screen.getByRole("region", { name: "Page" })).not.toHaveTextContent(FIELD);
  });

  it("shows live for the viewer who reads the page, with no way to add a link", async () => {
    open({ role: "viewer", text: linkedBlock });
    const embed = await screen.findByRole("region", { name: /^Invoices · linked/ });
    expect(within(embed).getAllByRole("row")).toHaveLength(3);
    expect(within(embed).queryByRole("button", { name: /Link a record/ })).not.toBeInTheDocument();
  });

  it("offers editors a + Link row that opens the link picker", async () => {
    open({ text: linkedBlock, routes: { "GET /api/tables/tbl2/records/lookup": { records: [{ id: "rec_inv3", name: "INV-3" }] } } });
    const embed = await screen.findByRole("region", { name: /^Invoices · linked/ });
    await userEvent.click(within(embed).getByRole("button", { name: /Link a record to Invoices/ }));
    expect(await screen.findByRole("combobox", { name: "Search Invoices" })).toBeInTheDocument();
  });

  it("links the record picked and shows it at once", async () => {
    const { api } = open({ text: linkedBlock, routes: { "GET /api/tables/tbl2/records/lookup": { records: [{ id: "rec_inv3", name: "INV-3" }] } } });
    const embed = await screen.findByRole("region", { name: /^Invoices · linked/ });
    await userEvent.click(within(embed).getByRole("button", { name: /Link a record to Invoices/ }));
    await userEvent.click(await screen.findByRole("option", { name: /INV-3/ }));
    await waitFor(() => expect(api.callsTo(PATCH_RECORDS)).toHaveLength(1));
    const sent = (api.callsTo(PATCH_RECORDS)[0]!.body as { records: { values: Record<string, unknown> }[] }).records[0]!.values[FIELD];
    expect(sent).toEqual(["rec_inv1", "rec_inv2", "rec_inv3"]);
    expect(await screen.findByRole("region", { name: "Invoices · linked to this client, 3" })).toBeInTheDocument();
  });

  it("says so when nothing is linked yet", async () => {
    open({ text: linkedBlock, links: [] });
    const embed = await screen.findByRole("region", { name: "Invoices · linked to this client, 0" });
    expect(within(embed).getByText("Nothing in Invoices yet.")).toBeInTheDocument();
  });

  it("Open goes to the collection and leaves a draft filter on the inverse link, saved nowhere", async () => {
    const { api } = open({ text: linkedBlock });
    const embed = await screen.findByRole("region", { name: /^Invoices · linked/ });
    const openLink = within(embed).getByRole("link", { name: "Open" });
    expect(openLink).toHaveAttribute("href", "/base/app1/tbl2/viw_inv_default");
    await userEvent.click(openLink);
    const draft = readDraft(USER.id, "viw_inv_default");
    expect(draft?.changes.filter).toEqual({ conjunction: "and", items: [{ field_id: "fld_client", op: "has_any_of", value: ["rec1"] }] });
    expect(api.calls.filter((c) => c.method !== "GET" && c.method !== "POST")).toHaveLength(0);
    expect(api.callsTo(PATCH_RECORDS)).toHaveLength(0);
  });

  it("shows only ten rows of a long list and says how many there are", async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `rec_x${i}`, name: `X-${i}` }));
    open({ text: linkedBlock, links: many, routes: { "POST /api/tables/tbl2/records/get": (call: { body: unknown }) => ({ records: (call.body as { ids: string[] }).ids.map((id) => inv(id, id, 1)) }) } });
    const embed = await screen.findByRole("region", { name: "Invoices · linked to this client, 14" });
    await within(embed).findAllByRole("link", { name: /^rec_x/ });
    expect(within(embed).getAllByRole("row")).toHaveLength(11);
    expect(within(embed).getByText("Showing 10 of 14")).toBeInTheDocument();
  });

  it("is a muted box when the property is not one of this record's link properties", async () => {
    for (const id of ["fld_name", "fldNoSuchField1234"]) {
      const { unmount } = open({ text: `\`\`\`openbase\n{"embed":"linked","field":"${id}"}\n\`\`\`` });
      expect(await screen.findByText("This embed can't be shown")).toBeInTheDocument();
      unmount();
    }
  });
});

describe("View", () => {
  it("shows the first records of a saved view of this folder, read-only, with Open view", async () => {
    const { api } = open({ text: viewBlock(VIEW_HERE) });
    const embed = await screen.findByRole("region", { name: "Overdue · 12 invoices" });
    // The view hides Status: the title and the next three visible properties are shown.
    expect(within(embed).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Invoice", "Amount", "Due", "Notes"]);
    expect(within(embed).getAllByRole("row")).toHaveLength(4);
    expect(within(embed).getByRole("link", { name: "INV-2" })).toHaveAttribute("href", `/base/app1/tbl2/${VIEW_HERE}/r/rec_inv2`);
    expect(within(embed).getByRole("link", { name: "Open view" })).toHaveAttribute("href", `/base/app1/tbl2/${VIEW_HERE}`);
    expect(within(embed).getByText("Showing 3 of 12")).toBeInTheDocument();
    expect(within(embed).queryByRole("textbox")).not.toBeInTheDocument();
    // Read-only: the only control on the block is the editor's own Remove.
    expect(within(embed).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Remove embed"]);
    expect((api.callsTo(QUERY_HERE)[0]!.body as { limit: number }).limit).toBe(10);
  });

  it("asks for as many records as the block says", async () => {
    const { api } = open({ text: viewBlock(VIEW_HERE, 3) });
    await screen.findByRole("region", { name: /^Overdue/ });
    expect((api.callsTo(QUERY_HERE)[0]!.body as { limit: number }).limit).toBe(3);
  });

  it("finds a view of another folder of the workspace", async () => {
    const other = otherFolder();
    const { api } = open({
      text: viewBlock(VIEW_ELSEWHERE),
      workspaces: [makeWorkspace("owner", [{ id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role: "owner", people: [], tables: [], is_top_level: true }, { id: "app2", workspace_id: "wsp1", name: "Hiring", color: "blue", role: "owner", people: [], tables: [], is_top_level: false }])],
      routes: {
        "GET /api/bases/app2": other,
        [`POST /api/views/${VIEW_ELSEWHERE}/query`]: { total: 1, offset: 0, records: [{ ...makeRecord({ fld_name: "Designer" }, "rec_role1"), table_id: "tbl9" }], groups: [], colors: {} },
      },
    });
    const embed = await screen.findByRole("region", { name: "Open roles · 1 record" });
    expect(within(embed).getByRole("link", { name: "Designer" })).toHaveAttribute("href", `/base/app2/tbl9/${VIEW_ELSEWHERE}/r/rec_role1`);
    expect(api.callsTo(`POST /api/views/${VIEW_ELSEWHERE}/query`)).toHaveLength(1);
  });

  describe("a view the reader cannot open", () => {
    async function cantOpen(setup: Setup, queryKey: string) {
      const { api } = open(setup);
      expect(await screen.findByText("You can't open this view")).toBeInTheDocument();
      // Nothing about the view or its records: not the name, not a count, not a title, not a request for them.
      const section = screen.getByRole("region", { name: "Page" });
      for (const leak of ["Overdue", "Open roles", "Hiring", "12", "INV-1", "Designer", "Mine"]) expect(section).not.toHaveTextContent(leak);
      expect(api.callsTo(queryKey)).toHaveLength(0);
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    }

    it("a view in a folder the reader has no access to (it is in no list the server gave them)", async () => {
      await cantOpen({ text: viewBlock(VIEW_UNOPENED) }, `POST /api/views/${VIEW_UNOPENED}/query`);
    });

    it("a view of a folder of another workspace", async () => {
      // Another workspace's folder is not among this workspace's folders, whoever the reader is elsewhere.
      await cantOpen(
        { text: viewBlock(VIEW_ELSEWHERE), routes: { "GET /api/bases/app7": otherFolder() }, workspaces: [makeWorkspace("owner", [{ id: "app1", workspace_id: "wsp1", name: "Project tracker", color: "green_dark", role: "owner", people: [], tables: [], is_top_level: true }])] },
        `POST /api/views/${VIEW_ELSEWHERE}/query`,
      );
    });

    it("a personal view, which cannot be embedded, not even the reader's own", async () => {
      await cantOpen({ text: viewBlock(VIEW_PERSONAL) }, `POST /api/views/${VIEW_PERSONAL}/query`);
      expect(screen.getByText("Personal views can't be embedded.")).toBeInTheDocument();
    });

    it("a view the server then refuses (closed since the page was opened)", async () => {
      const { api } = open({ text: viewBlock(VIEW_HERE), routes: { [QUERY_HERE]: apiError(404, "not_found", "view not found") } });
      expect(await screen.findByText("You can't open this view")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Page" })).not.toHaveTextContent("INV-1");
      expect(api.callsTo(QUERY_HERE).length).toBeGreaterThan(0);
    });

    it("a view the server forbids", async () => {
      open({ text: viewBlock(VIEW_HERE), routes: { [QUERY_HERE]: apiError(403, "forbidden", "no") } });
      expect(await screen.findByText("You can't open this view")).toBeInTheDocument();
    });
  });

  it("says it could not load a view when the server fails, not that it cannot be opened", async () => {
    open({ text: viewBlock(VIEW_HERE), routes: { [QUERY_HERE]: apiError(500, "internal", "boom") } });
    expect(await screen.findByText("This view could not be loaded", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText("You can't open this view")).not.toBeInTheDocument();
  });
});

describe("blocks that are not alive", () => {
  it("shows a block that does not read as a muted box, and keeps its text", async () => {
    const { server } = open({ role: "viewer", text: "```openbase\n{\"embed\":\"linked\",\"field\":\"nope\"}\n```\n\nafter" });
    expect(await screen.findByText("This embed can't be shown")).toBeInTheDocument();
    expect(server.record().values.fld_page).toContain('"field":"nope"');
  });

  it("keeps an unreadable block's text when the page is edited around it", async () => {
    const bad = '{"embed":"linked","field":"nope","extra":1}';
    const { api } = open({ text: `\`\`\`openbase\n${bad}\n\`\`\`\n\nafter` });
    const box = await screen.findByRole("textbox", { name: "Page" });
    expect(box.querySelector("pre")).toHaveTextContent(bad);
    expect(api.callsTo(PATCH_RECORDS)).toHaveLength(0);
  });

  it("does not open an embed inside an embedded record's own page", async () => {
    // A record shown in an embedded table shows its rich text as plain text, so a page that embeds itself cannot recurse.
    const loop = { ...INV1, values: { ...INV1.values, fld_extra: linkedBlock } };
    open({ text: viewBlock(VIEW_HERE), routes: { [QUERY_HERE]: { total: 1, offset: 0, records: [loop], groups: [], colors: {} } } });
    const embed = await screen.findByRole("region", { name: /^Overdue/ });
    expect(within(embed).queryByRole("region")).not.toBeInTheDocument();
  });
});
