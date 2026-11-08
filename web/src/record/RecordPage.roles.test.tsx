/** What each role gets on the record page (REC-10): viewers read, commenters comment, editors edit, creators also configure properties. */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ALL_FIELDS, CHOICES, field, makeRecord, makeTable } from "@/test/fields";
import { PATCH_RECORDS, PATCH_VIEW, renderRecordPage } from "@/test/recordPage";

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const company = field("text", { multiline: false }, { id: "fld_company", name: "Company" });
const status = field("single_select", { choices: CHOICES }, { id: "fld_status", name: "Status" });
const done = field("checkbox", { icon: "check", color: "green" }, { id: "fld_done", name: "Done" });
const score = { ...ALL_FIELDS.formula, id: "fld_score", name: "Score" };
const secret = field("text", { multiline: false }, { id: "fld_secret", name: "Secret" });
const table = makeTable([name, company, status, done, score, secret]);
const record = makeRecord({ fld_name: "Harper & Co", fld_company: "Acme", fld_status: "chs2", fld_done: true, fld_score: 24, fld_secret: "hush" });
const layout = { field_order: [], hidden_fields: ["fld_secret"] };

const ready = () => screen.findByRole("heading", { level: 1, name: "Harper & Co" });
const props = () => within(screen.getByRole("region", { name: "Properties" }));

describe("viewers", () => {
  it("see everything rendered, with nothing to edit", async () => {
    renderRecordPage({ table, record, layout, role: "viewer" });
    await ready();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Harper & Co");
    expect(props().getByText("Acme")).toBeInTheDocument();
    expect(props().getByText("In progress")).toBeInTheDocument();
    expect(props().getByText("24.0")).toBeInTheDocument();
    // No editor to open, no checkbox to toggle, no hover tint.
    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Properties" }).innerHTML).not.toContain("hover:bg-hover");
  });

  it("have plain labels with no menu, and the folds to read what is hidden", async () => {
    renderRecordPage({ table, record, layout, role: "viewer" });
    await ready();
    expect(props().queryByRole("button", { name: "Company" })).not.toBeInTheDocument();
    expect(props().getByText("Company")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show 1 hidden property" }));
    expect(props().getByText("hush")).toBeInTheDocument();
    expect(props().queryByRole("button", { name: /Secret|Edit/ })).not.toBeInTheDocument();
  });

  it("cannot comment, duplicate or delete", async () => {
    renderRecordPage({ table, record, layout, role: "viewer" });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(await screen.findByText(/You can read comments but not write them/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    expect(await screen.findByRole("menuitem", { name: /Duplicate record/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: /Delete record/ })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("commenters", () => {
  it("read the page as viewers do, and can comment", async () => {
    renderRecordPage({ table, record, layout, role: "commenter" });
    await ready();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit / })).not.toBeInTheDocument();
    expect(props().queryByRole("button", { name: "Company" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Comments" }));
    expect(await screen.findByRole("textbox", { name: "Write a comment" })).toBeInTheDocument();
  });
});

describe("editors", () => {
  it("edit the title and the values, but not computed ones", async () => {
    const { api } = renderRecordPage({ table, record, layout, role: "editor" });
    const title = await screen.findByRole("textbox", { name: "Name" });
    await userEvent.clear(title);
    await userEvent.type(title, "Globex");
    await userEvent.tab();
    await userEvent.click(screen.getByRole("button", { name: "Edit Company" }));
    await userEvent.type(await screen.findByRole("textbox", { name: "Company" }), "!{Enter}");
    await waitFor(() => expect(api.callsTo(PATCH_RECORDS)).toHaveLength(2));
    expect(api.callsTo(PATCH_RECORDS).map((c) => (c.body as { records: { values: object }[] }).records[0]!.values)).toEqual([{ fld_name: "Globex" }, { fld_company: "Acme!" }]);
    expect(screen.queryByRole("button", { name: "Edit Score" })).not.toBeInTheDocument();
  });

  it("get Hide from pages and Show on pages from a label, and nothing that changes the properties themselves", async () => {
    const { api } = renderRecordPage({ table, record, layout, role: "editor" });
    await ready();
    await userEvent.click(props().getByRole("button", { name: "Company" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent?.trim())).toEqual(["Hide from pages"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide from pages" }));
    await waitFor(() => expect(api.callsTo(PATCH_VIEW)).toHaveLength(1));
    await userEvent.click(await screen.findByRole("button", { name: "Show 2 hidden properties" }));
    await userEvent.click(props().getByRole("button", { name: "Secret" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent?.trim())).toEqual(["Show on pages"]);
  });

  it("see a computed property as read-only, as creators do", async () => {
    renderRecordPage({ table, record, layout, role: "editor" });
    await ready();
    expect(props().getByText(/computed, read-only/)).toBeInTheDocument();
  });
});

describe("creators", () => {
  it("also rename, edit and delete properties", async () => {
    renderRecordPage({ table, record, layout, role: "creator" });
    await ready();
    await userEvent.click(props().getByRole("button", { name: "Score" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent?.trim())).toEqual(["Rename", "Edit property", "Use as title", "Hide from pages", "Delete property"]);
  });

  it("do so for a property that is hidden from pages, with Show on pages in place of Hide", async () => {
    renderRecordPage({ table, record, layout, role: "creator" });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Show 1 hidden property" }));
    await userEvent.click(props().getByRole("button", { name: "Secret" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent?.trim())).toEqual(["Rename", "Edit property", "Use as title", "Show on pages", "Delete property"]);
  });
});
