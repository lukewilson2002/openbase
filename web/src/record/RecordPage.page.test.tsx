/** The Page of the record page (REC-5): below a rule, in the editor for editors and rendered for viewers, saved 800 ms after typing pauses. */
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import type { BaseSchema } from "@/api/types";
import { field, makeRecord, makeTable } from "@/test/fields";
import { apiError, makeSchema, makeView } from "@/test/utils";
import { PATCH_RECORDS, renderRecordPage } from "@/test/recordPage";
import { PAGE_AUTOSAVE_MS } from "./PageSection";

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const status = field("text", { multiline: false }, { id: "fld_status", name: "Status" });
const page = field("rich_text", {}, { id: "fld_page", name: "Page" });
const table = makeTable([name, status, page], { body_field_id: "fld_page" });
const bare = makeTable([name, status]);
const record = makeRecord({ fld_name: "Launch", fld_status: "Open", fld_page: "# Plan\n\n- one\n- two" });

const PUT_PAGE = "PUT /api/tables/tbl1/records/rec1/page";
const BODY_FIELD = "POST /api/tables/tbl1/body-field";

/** The page's editor, ready, with a way to type at its end. */
async function editorOf() {
  const box = await screen.findByRole("textbox", { name: "Page" });
  const editor = (box as HTMLElement & { editor: Editor }).editor;
  act(() => box.focus());
  const type = (text: string) => act(() => void editor.chain().focus("end").insertContent(text).run());
  return { box, editor, type };
}

describe("the page on the record page", () => {
  it("sits below a 1 px rule after the properties and holds the Page property's text, not as a property row", async () => {
    renderRecordPage({ table, record });
    const { box } = await editorOf();
    const section = screen.getByRole("region", { name: "Page" });
    expect(section).toHaveClass("border-t", "border-line");
    expect(section).toContainElement(box);
    expect(screen.getByRole("region", { name: "Properties" }).compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(box.querySelector("h1")).toHaveTextContent("Plan");
    expect(box.querySelectorAll("li")).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Properties" })).queryByText("Page")).not.toBeInTheDocument();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
  });

  it("saves 800 ms after typing pauses, as one normal record save of the Page property, and says so in the bar", async () => {
    expect(PAGE_AUTOSAVE_MS).toBe(800);
    const { api } = renderRecordPage({ table, record });
    const { type } = await editorOf();
    type(" more");
    await new Promise((r) => setTimeout(r, 500));
    // Typing again pushes the save back: it is 800 ms after the last keystroke, not the first.
    type(" and more");
    const lastKey = Date.now();
    await new Promise((r) => setTimeout(r, 500));
    expect(api.callsTo(PATCH_RECORDS)).toHaveLength(0);
    await waitFor(() => expect(api.callsTo(PATCH_RECORDS)).toHaveLength(1), { timeout: 3000 });
    expect(Date.now() - lastKey).toBeGreaterThanOrEqual(PAGE_AUTOSAVE_MS - 50);
    expect(api.callsTo(PATCH_RECORDS)[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_page: "# Plan\n\n- one\n- two more and more" } }] });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("says Saving… while the save is on its way", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { server } = renderRecordPage({
      table,
      record,
      routes: {
        [PATCH_RECORDS]: async () => {
          await gate;
          return { records: [record] };
        },
      },
    });
    const { type, box } = await editorOf();
    type("!");
    act(() => box.blur());
    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    release();
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(server.record()).toBeTruthy();
  });

  it("saves at once when the focus leaves the page", async () => {
    const { api } = renderRecordPage({ table, record });
    const { type, box } = await editorOf();
    type("!");
    act(() => box.blur());
    await waitFor(() => expect(api.callsTo(PATCH_RECORDS)).toHaveLength(1), { timeout: 300 });
  });

  it("does not save a page that was only opened: what it shows round-trips and nothing is written", async () => {
    const { api } = renderRecordPage({ table, record });
    const { box } = await editorOf();
    act(() => box.focus());
    act(() => box.blur());
    await new Promise((r) => setTimeout(r, PAGE_AUTOSAVE_MS + 200));
    expect(api.callsTo(PATCH_RECORDS)).toHaveLength(0);
  });

  it("keeps typing that arrives while a save is on its way, and saves it after", async () => {
    let first = true;
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { api, server } = renderRecordPage({
      table,
      record,
      routes: {
        [PATCH_RECORDS]: async (call: { body: unknown }) => {
          const values = (call.body as { records: { values: Record<string, unknown> }[] }).records[0]!.values;
          if (first) {
            first = false;
            await gate;
          }
          return { records: [{ ...server.record(), values: { ...server.record().values, ...values } }] };
        },
      },
    });
    const { type, box, editor } = await editorOf();
    type(" A");
    act(() => box.blur());
    await waitFor(() => expect(api.callsTo(PATCH_RECORDS)).toHaveLength(1));
    // More typing while the first save has not been answered: its echo must not replace the text.
    type("B");
    release();
    await waitFor(() => expect(api.callsTo(PATCH_RECORDS)).toHaveLength(2), { timeout: 3000 });
    expect(editor.getMarkdown().trim()).toBe("# Plan\n\n- one\n- two AB");
    expect((api.callsTo(PATCH_RECORDS)[1]!.body as { records: { values: { fld_page: string } }[] }).records[0]!.values.fld_page).toBe("# Plan\n\n- one\n- two AB");
  });

  it("takes in a change from somewhere else when it is not typing over it", async () => {
    const { client, server } = renderRecordPage({ table, record });
    const { box } = await editorOf();
    expect(box.querySelector("h1")).toHaveTextContent("Plan");
    await act(async () => {
      client.setQueryData(["records", "tbl1", "rec1"].length ? (await import("@/api/records")).recordKeys.record("tbl1", "rec1") : [], { ...server.record(), values: { ...server.record().values, fld_page: "Changed elsewhere" } });
    });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Page" })).toHaveTextContent("Changed elsewhere"));
  });

  it("keeps the text and says what went wrong when it cannot be saved, and the bar says so", async () => {
    renderRecordPage({ table, record, routes: { [PATCH_RECORDS]: () => apiError(422, "validation_failed", "Too long") } });
    const { type, box } = await editorOf();
    type("!");
    act(() => box.blur());
    expect(await screen.findByText("Couldn't save")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("The page could not be saved: Too long");
    expect(screen.getByRole("textbox", { name: "Page" })).toHaveTextContent("two!");
  });

  it("Enter in the title moves to the page", async () => {
    renderRecordPage({ table, record });
    const { box } = await editorOf();
    const title = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.click(title);
    await userEvent.keyboard("{Enter}");
    expect(box).toHaveFocus();
  });

  it("lets the block menu's Property open the Add property box (creators)", async () => {
    renderRecordPage({ table, record });
    const { type } = await editorOf();
    type("\n/prop");
    // The editor finishes taking the focus a frame after `type`; a person never types that fast.
    await act(() => new Promise((r) => requestAnimationFrame(r)));
    await userEvent.keyboard("{Enter}");
    const box = await screen.findByRole("group", { name: "Add property" });
    expect(within(box).getByRole("textbox", { name: "Name" })).toHaveFocus();
  });

  it("offers Linked records this collection's link properties and View the saved views of the folder, personal ones and default grids left out", async () => {
    const link = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_inv", single: false }, { id: "fld_link", name: "Invoices" });
    const withLink = makeTable([name, status, page, link], { body_field_id: "fld_page" });
    const folder: BaseSchema = makeSchema("owner");
    const people = folder.tables.find((t) => t.id === "tbl2")!;
    // Two saved views besides People's default grid, and a personal one.
    const peopleViews = [{ ...makeView({ id: "viw4", name: "Everyone" }), table_id: "tbl2" }, { ...makeView({ id: "viw5", name: "Directory" }), table_id: "tbl2" }, { ...makeView({ id: "viw6", name: "Mine" }), table_id: "tbl2", personal: true }, { ...makeView({ id: "viw7", name: "All people" }), table_id: "tbl2", is_default: true }];
    renderRecordPage({
      table: withLink,
      record,
      routes: { "GET /api/bases/app1": () => ({ ...folder, tables: [{ ...withLink, views: [{ ...withLink.views[0]!, is_default: true }] }, { ...people, views: peopleViews }] }) },
    });
    const { type, editor } = await editorOf();
    type("\n/view");
    await userEvent.keyboard("{Enter}");
    const names = within(await screen.findByRole("listbox", { name: "View to show" }))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names.some((n) => n!.includes("Everyone"))).toBe(true);
    expect(names.some((n) => n!.includes("Directory"))).toBe(true);
    expect(names.some((n) => n!.includes("Mine"))).toBe(false);
    expect(names.some((n) => n!.includes("All people"))).toBe(false);
    await userEvent.keyboard("{Escape}");
    type("\n/linked");
    await userEvent.keyboard("{Enter}");
    expect(editor.getMarkdown()).toContain('{"embed":"linked","field":"fld_link"}');
  });

  it("puts a lone saved view in at once, with no list to choose from", async () => {
    renderRecordPage({ table, record });
    const { type, editor } = await editorOf();
    type("\n/view");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(editor.getMarkdown()).toContain('"embed":"view","view":"viw4","limit":10'));
    expect(screen.queryByRole("listbox", { name: "View to show" })).not.toBeInTheDocument();
  });
});

describe("the page for people who cannot edit", () => {
  it.each(["viewer", "commenter"])("shows a %s the rendered page with no editor and no edit affordance", async (role) => {
    renderRecordPage({ table, record, role });
    const section = await screen.findByRole("region", { name: "Page" });
    expect(section.querySelector("h1")).toHaveTextContent("Plan");
    expect(section.querySelectorAll("li")).toHaveLength(2);
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
    expect(section.querySelector("[contenteditable]")).toBeNull();
    expect(section).toHaveClass("border-t");
    // The existing Markdown renderer, at the page's size.
    expect(section.querySelector(".ob-markdown")).toHaveClass("text-read-phone", "md:text-read");
  });

  it("shows nothing at all when the page is empty", async () => {
    renderRecordPage({ table, record: makeRecord({ fld_name: "Launch", fld_status: "Open" }), role: "viewer" });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("region", { name: "Page" })).not.toBeInTheDocument();
  });

  it("shows nothing for a collection with no Page property", async () => {
    renderRecordPage({ table: bare, record, role: "viewer" });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("region", { name: "Page" })).not.toBeInTheDocument();
  });
});

describe("a collection with no Page property", () => {
  it("offers a creator Add Page property in place of the editor, and the editor once it is there", async () => {
    let made = false;
    const { api, server } = renderRecordPage({
      table: bare,
      record,
      routes: {
        [BODY_FIELD]: () => {
          made = true;
          return { id: "tbl1" };
        },
      },
    });
    const section = await screen.findByRole("region", { name: "Page" });
    expect(within(section).queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "Add Page property" }));
    await waitFor(() => expect(api.callsTo(BODY_FIELD)).toHaveLength(1));
    expect(api.callsTo(BODY_FIELD)[0]!.body).toEqual({ create: true });
    expect(made).toBe(true);
    expect(server.schema()).toBeTruthy();
  });

  it("gives an editor the page editor, and the first save makes Page through the page endpoint", async () => {
    const { api, server } = renderRecordPage({
      table: bare,
      record,
      role: "editor",
      routes: {
        [PUT_PAGE]: () => ({ field_id: "fld_page", created: true, record: { ...server.record(), values: { ...server.record().values, fld_page: "Hello" } } }),
      },
    });
    const { type, box } = await editorOf();
    expect(screen.queryByRole("button", { name: "Add Page property" })).not.toBeInTheDocument();
    type("Hello");
    act(() => box.blur());
    await waitFor(() => expect(api.callsTo(PUT_PAGE)).toHaveLength(1));
    expect(api.callsTo(PUT_PAGE)[0]!.body).toEqual({ text: "Hello" });
    expect(api.callsTo(PATCH_RECORDS)).toHaveLength(0);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("takes the typing that follows through the normal save once Page is there", async () => {
    const withPage = { ...bare, fields: [...bare.fields, page], body_field_id: "fld_page" };
    const base = makeSchema("editor");
    const folder = (t: typeof bare) => ({ ...base, tables: [t, ...base.tables.filter((x) => x.id !== "tbl1")] });
    let tableNow = bare;
    const { api } = renderRecordPage({
      table: bare,
      record,
      role: "editor",
      routes: {
        "GET /api/bases/app1": () => folder(tableNow),
        [PUT_PAGE]: () => {
          tableNow = withPage;
          return { field_id: "fld_page", created: true, record: { ...record, values: { ...record.values, fld_page: "Hello" } } };
        },
      },
    });
    const { type, box, editor } = await editorOf();
    type("Hello");
    act(() => box.blur());
    await waitFor(() => expect(api.callsTo(PUT_PAGE)).toHaveLength(1));
    // The editor stays (no rebuild under the person), and the next save is an ordinary one.
    await waitFor(() => expect(api.callsTo("GET /api/bases/app1").length).toBeGreaterThan(1));
    expect(screen.getByRole("textbox", { name: "Page" })).toBe(box);
    type(" there");
    act(() => box.blur());
    await waitFor(() => expect(api.callsTo(PATCH_RECORDS)).toHaveLength(1), { timeout: 3000 });
    expect(editor.getMarkdown().trim()).toBe("Hello there");
  });
});

describe("the page on a phone", () => {
  it("is the same editor at 16/25, with the formatting bar above the keyboard while it has focus", async () => {
    renderRecordPage({ table, record, phone: true });
    const { box } = await editorOf();
    act(() => box.focus());
    expect(await screen.findByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    expect(box.className).toContain("text-read-phone");
  });
});
