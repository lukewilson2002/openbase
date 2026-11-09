/**
 * A record just added opens as its page with the title focused, and leaving it with nothing entered takes it back
 * (REC-8): by Escape, by any other way the page goes away, and by closing the tab.
 */
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { field, makeRecord, makeTable } from "@/test/fields";
import { PATCH_RECORDS as PATCH, renderRecordPage } from "@/test/recordPage";
import { isNewRecord, rememberNewRecord } from "./newRecords";

const name = field("text", { multiline: false }, { id: "fld_name", name: "Name" });
const status = field("single_select", { choices: [{ id: "s1", name: "Todo", color: "blue" }] }, { id: "fld_status", name: "Status" });
const table = makeTable([name, status]);

const DISCARD = "POST /api/tables/tbl1/records/rec1/discard";
const discarded = { [DISCARD]: { discarded: true } };
const title = () => screen.findByRole("textbox", { name: "Name" });
const tick = () => new Promise((r) => setTimeout(r, 20));

/** The discard request as the browser was asked to make it. */
const discardRequests = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith("/records/rec1/discard") && init?.method === "POST");

// The page of the test before takes its record back a tick after it closes; that is over before this test notes its own.
beforeEach(() => tick());

const hide = (persisted: boolean) => act(() => void window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted })));

describe("a new record's page", () => {
  it("opens with the title focused", async () => {
    rememberNewRecord("rec1", {});
    renderRecordPage({ table, record: makeRecord({}), routes: discarded });
    const box = await title();
    await waitFor(() => expect(box).toHaveFocus());
  });

  it("is left by Escape in the empty title, and taken back", async () => {
    rememberNewRecord("rec1", {});
    const { props, api, unmount } = renderRecordPage({ table, record: makeRecord({}), routes: discarded });
    const box = await title();
    await waitFor(() => expect(box).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
    // The route change is what unmounts the page; it takes the record back as it goes.
    unmount();
    await waitFor(() => expect(api.callsTo(DISCARD)).toHaveLength(1));
    expect(isNewRecord("rec1")).toBe(false);
  });

  it("gives up typed text first, and a second Escape leaves", async () => {
    rememberNewRecord("rec1", {});
    const { props } = renderRecordPage({ table, record: makeRecord({}), routes: discarded });
    const box = await title();
    await waitFor(() => expect(box).toHaveFocus());
    await userEvent.keyboard("Draft");
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).not.toHaveBeenCalled();
    expect(box).toHaveValue("");
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("does not leave on Escape for a record that was not just added", async () => {
    const { props } = renderRecordPage({ table, record: makeRecord({}), routes: discarded });
    const box = await title();
    box.focus();
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("is taken back when the page goes away, with the values its view filled in counting as nothing", async () => {
    rememberNewRecord("rec1", { fld_status: "s1" });
    const { api, unmount } = renderRecordPage({ table, record: makeRecord({ fld_status: "s1" }), routes: discarded });
    await title();
    unmount();
    await waitFor(() => expect(api.callsTo(DISCARD)).toHaveLength(1));
    // The discard endpoint, not the trash.
    expect(api.callsTo("DELETE /api/tables/tbl1/records")).toHaveLength(0);
  });

  it("keeps a title typed and never committed when the page goes (the browser's Back removes the box without a blur)", async () => {
    rememberNewRecord("rec1", {});
    const { api, unmount, server } = renderRecordPage({ table, record: makeRecord({}), routes: discarded });
    const box = await title();
    await waitFor(() => expect(box).toHaveFocus());
    await userEvent.keyboard("Typed title");
    unmount();
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    expect(api.callsTo(PATCH)[0]!.body).toMatchObject({ records: [{ id: "rec1", values: { fld_name: "Typed title" } }] });
    await tick();
    // The save landed before the page was asked about, so the record is not empty and is not taken back.
    expect(server.record().values).toMatchObject({ fld_name: "Typed title" });
    expect(api.callsTo(DISCARD)).toHaveLength(0);
  });

  it("saves a title being edited on an existing record when the page goes", async () => {
    const { api, unmount } = renderRecordPage({ table, record: makeRecord({ fld_name: "Launch" }) });
    const box = await title();
    await userEvent.click(box);
    await userEvent.keyboard(" plan");
    unmount();
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    expect(api.callsTo(PATCH)[0]!.body).toMatchObject({ records: [{ id: "rec1", values: { fld_name: "Launch plan" } }] });
  });

  it("stays when something was entered", async () => {
    rememberNewRecord("rec1", {});
    const { api, unmount } = renderRecordPage({ table, record: makeRecord({ fld_name: "Launch" }), routes: discarded });
    await title();
    unmount();
    await tick();
    expect(api.callsTo(DISCARD)).toHaveLength(0);
  });

  it("stays when the page is reached some other way", async () => {
    const { api, unmount } = renderRecordPage({ table, record: makeRecord({}), routes: discarded });
    await title();
    unmount();
    await tick();
    expect(api.callsTo(DISCARD)).toHaveLength(0);
  });
});

describe("closing the tab", () => {
  it("takes back an empty new record at once, in a request that outlives the page", async () => {
    rememberNewRecord("rec1", {});
    const { api, unmount } = renderRecordPage({ table, record: makeRecord({}), routes: discarded });
    await title();
    hide(false);
    expect(discardRequests()).toHaveLength(1);
    expect(discardRequests()[0]![1]).toMatchObject({ keepalive: true, credentials: "same-origin" });
    expect(new Headers(discardRequests()[0]![1]!.headers).get("X-OpenBase-CSRF")).toBe("1");
    // Asked for once: the page going away afterwards has nothing left to ask.
    unmount();
    await tick();
    expect(api.callsTo(DISCARD)).toHaveLength(1);
    expect(isNewRecord("rec1")).toBe(false);
  });

  it("leaves a page that is only going into the back-forward cache alone", async () => {
    rememberNewRecord("rec1", {});
    renderRecordPage({ table, record: makeRecord({}), routes: discarded });
    await title();
    hide(true);
    expect(discardRequests()).toHaveLength(0);
    expect(isNewRecord("rec1")).toBe(true);
  });

  it("keeps a record whose title is being typed", async () => {
    rememberNewRecord("rec1", {});
    renderRecordPage({ table, record: makeRecord({}), routes: discarded });
    const box = await title();
    await waitFor(() => expect(box).toHaveFocus());
    await userEvent.keyboard("Half a nam");
    hide(false);
    expect(discardRequests()).toHaveLength(0);
  });

  it("keeps a record that has something in it", async () => {
    rememberNewRecord("rec1", {});
    renderRecordPage({ table, record: makeRecord({ fld_status: "s1" }), routes: discarded });
    await title();
    hide(false);
    expect(discardRequests()).toHaveLength(0);
  });

  it("does nothing for a record that was not just added", async () => {
    renderRecordPage({ table, record: makeRecord({}), routes: discarded });
    await title();
    hide(false);
    expect(discardRequests()).toHaveLength(0);
  });
});
