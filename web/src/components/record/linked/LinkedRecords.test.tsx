import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { Providers, createQueryClient } from "@/providers";
import { RecordPage, type RecordPageProps } from "@/record/RecordPage";
import { CHOICES, PEOPLE, field, makeRecord, makeTable } from "@/test/fields";
import { makeSchema, makeView, mockApi, stubDesktop, stubPhone } from "@/test/utils";
import { FloatingRecordPeek, RecordPeek, type FloatingPeekTarget } from "./LinkedRecords";
import { EditorEnvProvider } from "../editors/env";
import { LinkEditor } from "../editors/LinkEditor";

// Tasks (tbl1): Name, Requires -> Tasks of tbl2 ("Setup").
const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const requires = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_req_by", single: false }, { id: "fld_requires", name: "Requires" });
const tasks = makeTable([name, requires]);
// Setup (tbl2): Title, Status, Notes, Due (hidden in its grid), Owner text; its grid puts Notes first.
const title = { ...field("text", { multiline: false }, { id: "fld_title", name: "Title" }), table_id: "tbl2" };
const status = { ...field("single_select", { choices: CHOICES }, { id: "fld_status", name: "Status" }), table_id: "tbl2" };
const notes = { ...field("text", { multiline: true }, { id: "fld_notes", name: "Notes" }), table_id: "tbl2" };
const due = { ...field("date", { include_time: false, date_format: "iso", time_format: "h24" } as never, { id: "fld_due", name: "Due" }), table_id: "tbl2" };
const extra = { ...field("text", { multiline: false }, { id: "fld_extra", name: "Extra" }), table_id: "tbl2" };
const grid2 = makeView({ id: "viw2" });
const setupTable = makeTable([title, status, notes, due, extra], {
  id: "tbl2",
  name: "Setup",
  views: [{ ...grid2, table_id: "tbl2", config: { ...grid2.config, field_order: ["fld_title", "fld_notes", "fld_status"], hidden_fields: ["fld_due"] } }],
});
const schema = { ...makeSchema("owner"), tables: [tasks, setupTable] };
const task = makeRecord({ fld_name: "Build the website", fld_requires: [{ id: "recD", name: "Buy the domain" }] }, "rec1");
const domain = { ...makeRecord({ fld_title: "Buy the domain", fld_status: "chs3", fld_notes: "Registered at Porkbun", fld_due: "2026-10-01", fld_extra: "Renews yearly" }, "recD"), table_id: "tbl2" };

// jsdom reads as a phone; the pop-overs and hover cards under test are the desktop's.
beforeEach(() => stubDesktop());
afterEach(() => vi.useRealTimers());

function setup(over: Partial<RecordPageProps> = {}, shown = task) {
  const api = mockApi({
    "GET /api/tables/tbl1/records/rec1": shown,
    "GET /api/records/rec1/comments": [],
    "GET /api/records/rec1/history": [],
    "POST /api/tables/tbl2/records/get": (call: { body: unknown }) => ({ records: (call.body as { ids: string[] }).ids.includes("recD") ? [domain] : [] }),
    "GET /api/tables/tbl2/records/recD": domain,
    "PATCH /api/tables/tbl1/records": (call: { body: { records: { values: Record<string, unknown> }[] } }) => ({ records: [{ ...task, values: { ...task.values, ...call.body.records[0]!.values } }] }),
  } as never);
  const props: RecordPageProps = {
    schema,
    table: tasks,
    role: "owner",
    recordId: "rec1",
    layoutView: tasks.views[0],
    prevId: null,
    nextId: null,
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    collectionHref: "/base/app1/tbl1/viw1",
    emails: new Map(PEOPLE.map((p) => [p.id, p.email])),
    timeZone: "UTC",
    currentUserId: "usr1",
    collaborators: PEOPLE,
    onOpenLinked: vi.fn(),
    ...over,
  };
  render(
    <Providers client={createQueryClient()}>
      <MemoryRouter>
        <RecordPage {...props} />
      </MemoryRouter>
    </Providers>,
  );
  return { api, props };
}

describe("linked records on the record page", () => {
  /** A linked record's card (not a button: see the first test). */
  const findCard = () => waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-linked-record="recD"]');
    expect(el).not.toBeNull();
    return el!;
  });

  it("shows each linked record as a card with its title, description and labels; a click edits the field", async () => {
    const { api, props } = setup();
    const card = await findCard();
    expect(screen.queryByRole("button", { name: "Open Buy the domain" })).toBeNull();
    // The first text field of its grid describes it, its select is a label; nothing else while it has labels.
    await waitFor(() => expect(card).toHaveTextContent("Registered at Porkbun"));
    expect(within(card).getByText("Done")).toBeInTheDocument();
    expect(card).not.toHaveTextContent("Renews yearly");
    expect(within(card).queryByRole("term")).toBeNull();
    expect(api.calls.find((c) => c.path === "/api/tables/tbl2/records/get")?.body).toEqual({ ids: ["recD"] });
    // A click is an edit of the field, not a way into the record (that is the Open of its details).
    await userEvent.click(card);
    expect(await screen.findByRole("combobox", { name: "Search Requires" })).toBeInTheDocument();
    expect(props.onOpenLinked).not.toHaveBeenCalled();
  });

  it("shows the whole linked record when a finger rests on its card, which opens its page from there", async () => {
    const { props } = setup();
    const card = await findCard();
    vi.useFakeTimers();
    fireEvent.pointerDown(card, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
    const peek = await waitFor(() => {
      const el = document.querySelector("[data-record-peek]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // Every filled field of the grid's layout (Due is hidden there), with the table's name.
    expect(within(peek).getAllByRole("term").map((t) => t.textContent)).toEqual(["Notes", "Status", "Extra"]);
    expect(peek).toHaveTextContent("Setup");
    fireEvent.pointerUp(card, { pointerType: "touch" });
    fireEvent.click(card);
    expect(props.onOpenLinked).not.toHaveBeenCalled();
    // Open page is a link to the record's own page, which a plain click takes through the router.
    const open = within(peek).getByRole("link", { name: /Open page/ });
    expect(open).toHaveAttribute("href", expect.stringContaining("recD"));
    await userEvent.click(open);
    expect(props.onOpenLinked).toHaveBeenCalledWith("tbl2", "recD");
  });

  it("shows the whole linked record in a sheet on a phone, with Open page at its foot", async () => {
    stubPhone();
    const { props } = setup();
    const card = await findCard();
    vi.useFakeTimers();
    fireEvent.pointerDown(card, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
    const sheet = await screen.findByRole("dialog", { name: "Buy the domain" });
    expect(within(sheet).getAllByRole("term").map((t) => t.textContent)).toEqual(["Notes", "Status", "Extra"]);
    // The title is the sheet's heading, not said again in its body.
    expect(within(sheet.querySelector("[data-record-peek]") as HTMLElement).queryByText("Buy the domain")).toBeNull();
    // The sheet is the whole peek: no hover card beside the card as well.
    expect(document.querySelectorAll("[data-record-peek]")).toHaveLength(1);
    expect(within(sheet).getAllByRole("button", { name: /Open page/ })).toHaveLength(1);
    fireEvent.pointerUp(card, { pointerType: "touch" });
    await userEvent.click(within(sheet).getByRole("button", { name: /Open page/ }));
    expect(props.onOpenLinked).toHaveBeenCalledWith("tbl2", "recD");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Buy the domain" })).toBeNull());
  });
});

describe("a property with several links (PH-6)", () => {
  const two = makeRecord({ fld_name: "Build the website", fld_requires: [{ id: "recD", name: "Buy the domain" }, { id: "recE", name: "Pick a host" }] }, "rec1");

  it("shows a linked record when a finger rests on its card, while the grip beside it still only drags", async () => {
    setup({}, two);
    const card = await screen.findByText("Buy the domain").then((el) => el.closest("[data-linked-record]") as HTMLElement);
    // Two links: the cards can be put in order, with a grip each.
    const grip = within(card).getByRole("button", { name: "Move Buy the domain" });
    vi.useFakeTimers();
    fireEvent.pointerDown(grip, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(600));
    fireEvent.pointerUp(grip, { pointerType: "touch" });
    expect(document.querySelector("[data-record-peek]")).toBeNull();
    fireEvent.pointerDown(card, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(500));
    vi.useRealTimers();
    expect(await waitFor(() => document.querySelector("[data-record-peek]"))).not.toBeNull();
  });
});

describe("the link picker", () => {
  it("shows a few fields under each result and searches them too", async () => {
    const api = mockApi({
      "GET /api/tables/tbl2/records/lookup": { records: [{ id: "recD", name: "Buy the domain" }] },
      "POST /api/tables/tbl2/records/get": { records: [domain] },
    } as never);
    const env = { baseId: "app1", tableId: "tbl1", collaborators: PEOPLE, timeZone: "UTC", canCreateOptions: false, format: { timeZone: "UTC", userName: () => undefined }, currentUserId: "usr1", schema };
    render(
      <Providers client={createQueryClient()}>
        <EditorEnvProvider value={env}>
          <LinkEditor field={requires} value={[]} variant="form" onChange={vi.fn()} onCommit={vi.fn()} onCancel={vi.fn()} />
        </EditorEnvProvider>
      </Providers>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Requires/ }));
    const option = await screen.findByRole("option");
    await waitFor(() => expect(option).toHaveTextContent("Registered at Porkbun"));
    expect(option).toHaveTextContent("Buy the domain");
    const lookup = api.calls.find((c) => c.path === "/api/tables/tbl2/records/lookup")!;
    expect(lookup.query.get("fields")).toBe("fld_notes,fld_status,fld_extra");
  });

  it("keeps the picked records in the field as cards while picking more, the pop-over only searching", async () => {
    const domainB = { ...makeRecord({ fld_title: "Pick a host" }, "recH"), table_id: "tbl2" };
    mockApi({
      "GET /api/tables/tbl2/records/lookup": { records: [{ id: "recH", name: "Pick a host" }] },
      "POST /api/tables/tbl2/records/get": (call: { body: unknown }) => ({ records: [domain, domainB].filter((r) => (call.body as { ids: string[] }).ids.includes(r.id)) }),
    } as never);
    const onChange = vi.fn();
    const env = { baseId: "app1", tableId: "tbl1", collaborators: PEOPLE, timeZone: "UTC", canCreateOptions: false, format: { timeZone: "UTC", userName: () => undefined }, currentUserId: "usr1", schema };
    render(
      <Providers client={createQueryClient()}>
        <EditorEnvProvider value={env}>
          <LinkEditor field={requires} value={[{ id: "recD", name: "Buy the domain" }]} variant="form" onChange={onChange} onCommit={vi.fn()} onCancel={vi.fn()} />
        </EditorEnvProvider>
      </Providers>,
    );
    const field = screen.getByRole("button", { name: "Requires" });
    expect(within(field).getByRole("list", { name: "Linked records in Requires" })).toHaveTextContent("Buy the domain");
    await userEvent.click(field);
    const panel = await screen.findByRole("dialog");
    // The pop-over finds and picks; the records picked are not listed again in it, nor can it clear them.
    expect(within(panel).queryByRole("list", { name: "Linked records in Requires" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Clear" })).toBeNull();
    await userEvent.click(await within(panel).findByRole("option", { name: /Pick a host/ }));
    expect(within(field).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("Buy the domain"), expect.stringContaining("Pick a host")]);
    // A card's ✕ removes it, and the pop-over stays open for more.
    await userEvent.click(within(field).getByRole("button", { name: "Remove Buy the domain" }));
    expect(onChange).toHaveBeenLastCalledWith({ json: [{ id: "recH", name: "Pick a host" }] });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Search Requires" })).toHaveFocus();
  });
});

describe("the link picker's list", () => {
  const env = { baseId: "app1", tableId: "tbl1", collaborators: PEOPLE, timeZone: "UTC", canCreateOptions: false, format: { timeZone: "UTC", userName: () => undefined }, currentUserId: "usr1", schema };
  const picker = (onCommit = vi.fn()) =>
    render(
      <Providers client={createQueryClient()}>
        <EditorEnvProvider value={env}>
          <LinkEditor field={requires} value={[]} variant="form" onChange={vi.fn()} onCommit={onCommit} onCancel={vi.fn()} />
        </EditorEnvProvider>
      </Providers>,
    );

  it("lights the first record, moves with the arrows and the pointer, and Enter picks the lit one", async () => {
    const domainB = { ...makeRecord({ fld_title: "Pick a host" }, "recH"), table_id: "tbl2" };
    mockApi({
      "GET /api/tables/tbl2/records/lookup": { records: [{ id: "recD", name: "Buy the domain" }, { id: "recH", name: "Pick a host" }] },
      "POST /api/tables/tbl2/records/get": { records: [domain, domainB] },
    } as never);
    const onCommit = vi.fn();
    picker(onCommit);
    await userEvent.click(screen.getByRole("button", { name: /Requires/ }));
    const search = await screen.findByRole("combobox", { name: "Search Requires" });
    const [first, second] = await screen.findAllByRole("option");
    expect(first).toHaveAttribute("data-active", "true");
    expect(search).toHaveAttribute("aria-activedescendant", first!.id);
    await userEvent.keyboard("{ArrowDown}");
    expect(second).toHaveAttribute("data-active", "true");
    expect(search).toHaveAttribute("aria-activedescendant", second!.id);
    await userEvent.hover(first!);
    expect(first).toHaveAttribute("data-active", "true");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    // A multiple link keeps picking; Enter with a record lit adds it, and the pop-over stays for more.
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("option", { name: /Pick a host/ })).toBeNull();
  });

  it("says when nothing matches, in a polite status", async () => {
    mockApi({ "GET /api/tables/tbl2/records/lookup": { records: [] }, "POST /api/tables/tbl2/records/get": { records: [] } } as never);
    picker();
    await userEvent.click(screen.getByRole("button", { name: /Requires/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("No more records to link.");
    await userEvent.type(screen.getByRole("combobox", { name: "Search Requires" }), "zzz");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No matching records."));
  });

  it("previews a record on hover with no way to leave the picker: its page opens from the cards, not from here", async () => {
    mockApi({
      "GET /api/tables/tbl2/records/lookup": { records: [{ id: "recD", name: "Buy the domain" }] },
      "POST /api/tables/tbl2/records/get": { records: [domain] },
    } as never);
    picker();
    await userEvent.click(screen.getByRole("button", { name: /Requires/ }));
    const option = await screen.findByRole("option");
    await userEvent.hover(option);
    const peek = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-record-peek]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(peek).getAllByRole("term").map((t) => t.textContent)).toEqual(["Notes", "Status", "Extra"]);
    expect(within(peek).queryByRole("button", { name: /Open page/ })).toBeNull();
    expect(within(peek).queryByRole("link", { name: /Open page/ })).toBeNull();
  });
});

describe("the link picker under a field's cards", () => {
  it("still closes when the focus leaves by keyboard after the cards were pressed", async () => {
    mockApi({ "GET /api/tables/tbl2/records/lookup": { records: [] }, "POST /api/tables/tbl2/records/get": { records: [domain] } } as never);
    const env = { baseId: "app1", tableId: "tbl1", collaborators: PEOPLE, timeZone: "UTC", canCreateOptions: false, format: { timeZone: "UTC", userName: () => undefined }, currentUserId: "usr1", schema };
    render(
      <Providers client={createQueryClient()}>
        <EditorEnvProvider value={env}>
          <LinkEditor field={requires} value={[{ id: "recD", name: "Buy the domain" }]} variant="form" onChange={vi.fn()} onCommit={vi.fn()} onCancel={vi.fn()} />
        </EditorEnvProvider>
        <button type="button">Elsewhere</button>
      </Providers>,
    );
    // Opening it is a press on the cards: that press keeps it open, and no more than that...
    await userEvent.click(screen.getByRole("button", { name: "Requires" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // ...so the focus leaving the editor later still closes it.
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("linked records on the record page, edited in place", () => {
  it("removes a record with its card's ✕ and saves it at once, without opening the picker", async () => {
    const { api } = setup();
    await waitFor(() => expect(document.querySelector('[data-linked-record="recD"]')).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Remove Buy the domain" }));
    await waitFor(() => expect(api.callsTo("PATCH /api/tables/tbl1/records")).toHaveLength(1));
    expect(api.callsTo("PATCH /api/tables/tbl1/records")[0]!.body).toMatchObject({ records: [{ id: "rec1", values: { fld_requires: null } }] });
    expect(screen.queryByRole("combobox", { name: "Search Requires" })).toBeNull();
  });
});

describe("the grid's floating record preview", () => {
  const at = (key: string, x: number, open = vi.fn()): FloatingPeekTarget => ({ key, table: setupTable, recordId: "recD", rect: { x, y: 40, width: 80, height: 20 }, open });
  const anchor = () => document.querySelector<HTMLElement>("span.fixed[aria-hidden]");

  it("moves to another chip of the same record, and opens the record of the chip it is on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi({ "GET /api/tables/tbl2/records/recD": domain } as never);
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <Providers client={createQueryClient()}>
        <FloatingRecordPeek at={at("row1", 10, first)} format={{ timeZone: "UTC", userName: () => undefined }} />
      </Providers>,
    );
    await act(() => vi.advanceTimersByTimeAsync(450));
    expect(anchor()).toHaveStyle({ left: "10px" });
    // The same record linked from the next row: the preview follows the pointer there.
    rerender(
      <Providers client={createQueryClient()}>
        <FloatingRecordPeek at={at("row2", 200, second)} format={{ timeZone: "UTC", userName: () => undefined }} />
      </Providers>,
    );
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(anchor()).toHaveStyle({ left: "200px" });
    vi.useRealTimers();
    const peek = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-record-peek]");
      expect(el).not.toBeNull();
      return el!;
    });
    await userEvent.click(await within(peek).findByRole("button", { name: /Open/ }));
    expect(second).toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  });
});

describe("a record's preview while a list scrolls", () => {
  it("opens for a card the keyboard's focus is on once the scrolling stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi({ "GET /api/tables/tbl2/records/recD": domain } as never);
    render(
      <Providers client={createQueryClient()}>
        <RecordPeek table={setupTable} recordId="recD" record={domain} format={{ timeZone: "UTC", userName: () => undefined }}>
          <button type="button">Buy the domain</button>
        </RecordPeek>
      </Providers>,
    );
    window.dispatchEvent(new Event("scroll"));
    act(() => screen.getByRole("button", { name: "Buy the domain" }).focus());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(document.querySelector("[data-record-peek]")).not.toBeNull();
    vi.useRealTimers();
  });
});
