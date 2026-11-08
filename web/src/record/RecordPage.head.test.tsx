/** The head of the record page (REC-2): the tile, and the title as the page's one h1, edited in place. */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ALL_FIELDS, field, makeRecord, makeTable } from "@/test/fields";
import { apiError } from "@/test/utils";
import { PATCH_RECORDS, renderRecordPage } from "@/test/recordPage";
import { rememberNewRecord } from "./newRecords";

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const company = field("text", { multiline: false }, { id: "fld_company", name: "Company" });
const photos = field("attachment", {}, { id: "fld_photos", name: "Photos" });
const png = { id: "att1", filename: "logo.png", mime: "image/png", size: 10, width: 4, height: 4 };
const pdf = { id: "att2", filename: "terms.pdf", mime: "application/pdf", size: 10, width: null, height: null };
const table = makeTable([name, company, photos]);
const record = makeRecord({ fld_name: "Harper & Co", fld_company: "Acme" });

const title = () => screen.findByRole("textbox", { name: "Name" });

describe("the record head: tile", () => {
  it("shows the title's initials on the collection's pastel hue", async () => {
    renderRecordPage({ table, record });
    await title();
    const tile = document.querySelector<HTMLElement>(".rounded-tile")!;
    expect(tile).toHaveTextContent("HC");
    // The collection's colour (blue in the fixtures) sets the pair; it is decoration beside the title.
    expect(tile).toHaveClass("choice", "choice-blue", "size-10", "md:size-11");
    expect(tile).toHaveAttribute("aria-hidden", "true");
  });

  it("shows the first file of the first attachment property instead, when it is an image", async () => {
    renderRecordPage({ table, record: makeRecord({ fld_name: "Harper & Co", fld_photos: [png, pdf] }) });
    await title();
    const tile = document.querySelector<HTMLElement>(".rounded-tile")!;
    expect(tile.querySelector("img")).toHaveAttribute("src", "/api/attachments/att1/thumb");
    expect(tile).not.toHaveTextContent("HC");
  });

  it("keeps the initials when the first file is not an image, or its picture will not load", async () => {
    renderRecordPage({ table, record: makeRecord({ fld_name: "Harper & Co", fld_photos: [pdf, png] }) });
    await title();
    expect(document.querySelector(".rounded-tile img")).toBeNull();
    expect(document.querySelector(".rounded-tile")).toHaveTextContent("HC");
  });

  it("has no initials for a record without a title", async () => {
    renderRecordPage({ table, record: makeRecord({ fld_company: "Acme" }) });
    await title();
    expect(document.querySelector(".rounded-tile")).toHaveTextContent("");
  });
});

describe("the record head: title", () => {
  it("is the page's one heading, 34/700 on a desktop and 26 on a phone, holding the primary property's text box", async () => {
    renderRecordPage({ table, record });
    const box = await title();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(heading).toHaveAccessibleName("Harper & Co");
    expect(heading).toContainElement(box);
    expect(heading).toHaveClass("text-record-phone", "md:text-record");
    expect(box).toHaveValue("Harper & Co");
  });

  it("is not listed again among the properties", async () => {
    renderRecordPage({ table, record });
    await title();
    expect(within(screen.getByRole("region", { name: "Properties" })).queryByText("Name")).not.toBeInTheDocument();
  });

  it("saves on its own when focus leaves, and the breadcrumb follows", async () => {
    const { api } = renderRecordPage({ table, record });
    const box = await title();
    await userEvent.clear(box);
    await userEvent.type(box, "Globex");
    await userEvent.tab();
    await waitFor(() => expect(api.callsTo(PATCH_RECORDS)).toHaveLength(1));
    expect(api.callsTo(PATCH_RECORDS)[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_name: "Globex" } }] });
    expect(await within(screen.getByRole("navigation", { name: "Breadcrumb" })).findByText("Globex")).toBeInTheDocument();
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("moves focus on to the page with Enter, saving once", async () => {
    const { api } = renderRecordPage({ table, record });
    const box = await title();
    await userEvent.click(box);
    await userEvent.type(box, "!{Enter}");
    // Until the page has a body of its own the focus goes to the first value.
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Company" })).toHaveFocus());
    await waitFor(() => expect(api.callsTo(PATCH_RECORDS)).toHaveLength(1));
    expect(box).toHaveValue("Harper & Co!");
    await new Promise((r) => setTimeout(r, 50));
    expect(api.callsTo(PATCH_RECORDS)).toHaveLength(1);
  });

  it("goes to a page body that marks itself, when there is one", async () => {
    renderRecordPage({ table, record });
    const box = await title();
    const body = document.createElement("div");
    body.tabIndex = 0;
    body.setAttribute("data-record-page", "");
    document.querySelector("section[aria-label=Properties]")!.after(body);
    await userEvent.click(box);
    await userEvent.keyboard("{Enter}");
    expect(body).toHaveFocus();
  });

  it("never holds a line break: Enter ends the edit and pasted breaks become spaces", async () => {
    renderRecordPage({ table, record });
    const box = await title();
    await userEvent.click(box);
    await userEvent.clear(box);
    await userEvent.paste("one\ntwo");
    expect(box).toHaveValue("one two");
  });

  it("gives up the change with Escape, and leaves the page with the next", async () => {
    const { api, props } = renderRecordPage({ table, record });
    const box = await title();
    await userEvent.click(box);
    await userEvent.type(box, " changed");
    await userEvent.keyboard("{Escape}");
    expect(box).toHaveValue("Harper & Co");
    expect(props.onClose).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    expect(api.callsTo(PATCH_RECORDS)).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("saves nothing when the text is as it was", async () => {
    const { api } = renderRecordPage({ table, record });
    const box = await title();
    await userEvent.click(box);
    await userEvent.tab();
    await new Promise((r) => setTimeout(r, 50));
    expect(api.callsTo(PATCH_RECORDS)).toHaveLength(0);
  });

  it("keeps what could not be saved, with the reason", async () => {
    renderRecordPage({ table, record, routes: { [PATCH_RECORDS]: apiError(500, "internal", "disk full") } });
    const box = await title();
    await userEvent.clear(box);
    await userEvent.type(box, "Lost?");
    await userEvent.tab();
    expect(await screen.findByText("Couldn't save")).toBeInTheDocument();
    expect(screen.getAllByRole("alert").some((a) => /disk full/.test(a.textContent ?? ""))).toBe(true);
    expect(box).toHaveValue("Lost?");
  });

  it("starts focused on a record just added, so it can be named at once", async () => {
    // The page of the test before takes its record back a tick after it closes: that is over first.
    await new Promise((r) => setTimeout(r, 0));
    rememberNewRecord("rec1", {});
    renderRecordPage({ table, record: makeRecord({}) });
    const box = await title();
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAttribute("placeholder", "Untitled");
    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName("Untitled record");
  });

  it("is parsed as its property is: a number title says when it is not one", async () => {
    const amount = field("number", { precision: 0, allow_negative: true }, { id: "fld_amount", name: "Amount" });
    const { api } = renderRecordPage({ table: makeTable([amount]), record: makeRecord({ fld_amount: 12 }) });
    const box = await screen.findByRole("textbox", { name: "Amount" });
    expect(box).toHaveValue("12");
    await userEvent.clear(box);
    await userEvent.type(box, "lots");
    await userEvent.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent(/not a number/);
    expect(api.callsTo(PATCH_RECORDS)).toHaveLength(0);
  });

  it("is a plain heading when the primary property is computed", async () => {
    const auto = { ...ALL_FIELDS.autonumber, id: "fld_auto", name: "Number" };
    renderRecordPage({ table: makeTable([auto, company]), record: makeRecord({ fld_auto: 7, fld_company: "Acme" }) });
    await screen.findByRole("button", { name: "Edit Company" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("7");
    expect(screen.queryByRole("textbox", { name: "Number" })).not.toBeInTheDocument();
  });

  it("stays a row of the list when the primary property needs an editor of its own", async () => {
    const stage = field("single_select", { choices: [{ id: "c1", name: "Draft", color: "gray" }] }, { id: "fld_stage", name: "Stage" });
    renderRecordPage({ table: makeTable([stage, company]), record: makeRecord({ fld_stage: "c1", fld_company: "Acme" }) });
    expect(await screen.findByRole("heading", { level: 1, name: "Draft" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Stage" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Properties" })).getByRole("button", { name: "Edit Stage" })).toBeInTheDocument();
  });

  it("is plain text for people who cannot edit", async () => {
    renderRecordPage({ table, record, role: "commenter" });
    expect(await screen.findByRole("heading", { level: 1, name: "Harper & Co" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });

  it("sits in a 760 px column padded 40/32 on a desktop and 20/16 on a phone", async () => {
    renderRecordPage({ table, record });
    await title();
    const column = document.querySelector<HTMLElement>(".max-w-record")!;
    expect(column).toHaveClass("px-4", "py-5", "md:px-8", "md:py-10");
  });
});
