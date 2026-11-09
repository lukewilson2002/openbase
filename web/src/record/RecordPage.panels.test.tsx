/**
 * Comments and History on the record page (REC-7): a 360 px panel on the right of a desktop, remembered per device, and
 * a full-screen sheet on a phone; the Comments button carries its count.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Comment, HistoryEntry } from "@/api/types";
import { field, makeRecord, makeTable } from "@/test/fields";
import { renderRecordPage } from "@/test/recordPage";
import { RECORD_PANEL_KEY } from "./useRecordPanel";

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const table = makeTable([name]);
const record = makeRecord({ fld_name: "Harper & Co" });

const comments: Comment[] = [
  { id: "cmt1", record_id: "rec1", user_id: "usr2", user_name: "Grace Hopper", body: "Looks good", created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 },
  { id: "cmt2", record_id: "rec1", user_id: "usr1", user_name: "Ada Lovelace", body: "Thanks", created_at: 1_700_000_100_000, updated_at: 1_700_000_100_000 },
];
const history: HistoryEntry[] = [{ id: 1, user_id: "usr1", user_name: "Ada Lovelace", kind: "create", created_at: 1_700_000_000_000, changes: { fld_name: { old: null, new: "Harper & Co" } } }];
const routes = { "GET /api/records/rec1/comments": comments, "GET /api/records/rec1/history": history };

const ready = () => screen.findByRole("textbox", { name: "Name" });
const stored = () => localStorage.getItem(RECORD_PANEL_KEY);

describe("on a desktop", () => {
  it("opens Comments in a 360 px panel beside the page, and the button counts the comments", async () => {
    renderRecordPage({ table, record, routes });
    await ready();
    const button = await screen.findByRole("button", { name: "Comments (2)" });
    expect(button).toHaveTextContent("2");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await userEvent.click(button);
    const panel = await screen.findByRole("complementary", { name: "Comments" });
    expect(panel).toHaveClass("w-panel");
    expect(await within(panel).findByText("Looks good")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "true");
    // The page is still there: the panel is beside it, not over it.
    expect(screen.getByRole("textbox", { name: "Name" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows no count when there are no comments", async () => {
    renderRecordPage({ table, record, routes: { ...routes, "GET /api/records/rec1/comments": [] } });
    await ready();
    expect(screen.getByRole("button", { name: "Comments" })).toBeInTheDocument();
  });

  it("counts a comment as soon as it is posted", async () => {
    let posted = false;
    renderRecordPage({
      table,
      record,
      routes: {
        ...routes,
        "GET /api/records/rec1/comments": () => (posted ? [...comments, { ...comments[1], id: "cmt3", body: "Third" }] : comments),
        "POST /api/records/rec1/comments": () => {
          posted = true;
          return { status: 201, json: { ...comments[1], id: "cmt3", body: "Third" } };
        },
      },
    });
    await ready();
    await userEvent.click(await screen.findByRole("button", { name: "Comments (2)" }));
    const box = await screen.findByRole("textbox", { name: "Write a comment" });
    act(() => box.focus());
    act(() => {
      (box as HTMLElement & { editor: Editor }).editor.commands.insertContent("Third");
    });
    await userEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByRole("button", { name: "Comments (3)" })).toHaveTextContent("3");
  });

  it("remembers which panel was open for the next record, and does not take the keyboard", async () => {
    const first = renderRecordPage({ table, record, routes });
    await ready();
    await userEvent.click(await screen.findByRole("button", { name: "Comments (2)" }));
    await screen.findByRole("complementary", { name: "Comments" });
    expect(stored()).toBe("comments");
    first.unmount();

    renderRecordPage({ table, record, routes });
    const title = await ready();
    expect(await screen.findByRole("complementary", { name: "Comments" })).toBeInTheDocument();
    // It opened by itself: the page keeps the focus it was given.
    expect(screen.getByRole("complementary", { name: "Comments" }).contains(document.activeElement)).toBe(false);
    title.focus();
    expect(title).toHaveFocus();
  });

  it("switches between Comments and History in the same panel, and forgets a panel that was closed", async () => {
    renderRecordPage({ table, record, routes });
    await ready();
    await userEvent.click(await screen.findByRole("button", { name: "Comments (2)" }));
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    const panel = await screen.findByRole("complementary", { name: "History" });
    // The list scrolls and has nothing to focus in it, so it takes the focus itself (axe: scrollable-region-focusable).
    expect(await within(panel).findByRole("list", { name: "Revision history" })).toHaveAttribute("tabindex", "0");
    expect(stored()).toBe("history");
    await userEvent.click(screen.getByRole("button", { name: "Close history" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
    expect(stored()).toBeNull();
  });

  it("ignores a remembered value it does not know", async () => {
    localStorage.setItem(RECORD_PANEL_KEY, "settings");
    renderRecordPage({ table, record, routes });
    await ready();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("closes the panel on Escape and gives the focus back to its button, before the page is left", async () => {
    const { props } = renderRecordPage({ table, record, routes });
    await ready();
    const button = await screen.findByRole("button", { name: "Comments (2)" });
    await userEvent.click(button);
    await screen.findByRole("complementary", { name: "Comments" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("complementary")).not.toBeInTheDocument());
    expect(button).toHaveFocus();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });
});

describe("on a phone", () => {
  it("opens Comments as a full-screen sheet, with the count on the header's button", async () => {
    renderRecordPage({ table, record, routes, phone: true });
    await ready();
    const button = await screen.findByRole("button", { name: "Comments (2)" });
    expect(button).toHaveTextContent("2");
    await userEvent.click(button);
    const sheet = await screen.findByRole("dialog", { name: "Comments" });
    expect(sheet).toHaveClass("inset-x-0");
    expect(await within(sheet).findByText("Looks good")).toBeInTheDocument();
    // The box to write in stays in the sheet, under the thread.
    expect(within(sheet).getByRole("textbox", { name: "Write a comment" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("opens History from More as a full-screen sheet", async () => {
    renderRecordPage({ table, record, routes, phone: true });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "More" }));
    await userEvent.click(await screen.findByRole("button", { name: "History" }));
    const sheet = await screen.findByRole("dialog", { name: "History" });
    expect(await within(sheet).findByRole("list", { name: "Revision history" })).toBeInTheDocument();
  });

  it("gives the focus back to More when the History sheet it opened is closed (the row that opened it is gone)", async () => {
    renderRecordPage({ table, record, routes, phone: true });
    await ready();
    const more = screen.getByRole("button", { name: "More" });
    await userEvent.click(more);
    await userEvent.click(await screen.findByRole("button", { name: "History" }));
    await screen.findByRole("dialog", { name: "History" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "History" })).not.toBeInTheDocument());
    await waitFor(() => expect(more).toHaveFocus());
  });

  it("does not remember a sheet, so a page never opens covered", async () => {
    const first = renderRecordPage({ table, record, routes, phone: true });
    await ready();
    await userEvent.click(await screen.findByRole("button", { name: "Comments (2)" }));
    await screen.findByRole("dialog", { name: "Comments" });
    expect(stored()).toBeNull();
    first.unmount();
    localStorage.setItem(RECORD_PANEL_KEY, "comments");
    renderRecordPage({ table, record, routes, phone: true });
    await ready();
    expect(screen.queryByRole("dialog", { name: "Comments" })).not.toBeInTheDocument();
  });
});
