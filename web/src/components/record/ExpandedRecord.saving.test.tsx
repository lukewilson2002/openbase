/** The expanded record's save status, long text that saves while typed, the Share button, and the full-screen editors. */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers, createQueryClient } from "@/providers";
import { PEOPLE, field, makeRecord, makeTable } from "@/test/fields";
import { apiError, makeSchema, mockApi } from "@/test/utils";
import { ExpandedRecord, type ExpandedRecordProps } from "./ExpandedRecord";

const name = field("single_line_text", {}, { id: "fld_name", name: "Name" });
const plain = field("long_text", { rich: false }, { id: "fld_plain", name: "Plain notes" });
const rich = field("long_text", { rich: true }, { id: "fld_rich", name: "Notes" });
const table = makeTable([name, plain, rich]);
const schema = { ...makeSchema("owner"), tables: [table] };
const record = makeRecord({ fld_name: "Launch", fld_plain: "first", fld_rich: "# Plan\n\n- one" }, "rec1");

const PATCH = "PATCH /api/tables/tbl1/records";

function setup(routes: Record<string, unknown> = {}, over: Partial<ExpandedRecordProps> = {}) {
  let current = record;
  const api = mockApi({
    "GET /api/tables/tbl1/records/rec1": () => current,
    "GET /api/records/rec1/comments": [],
    "GET /api/records/rec1/history": [],
    [PATCH]: (call: { body: unknown }) => {
      current = { ...current, values: { ...current.values, ...(call.body as { records: { values: object }[] }).records[0]!.values } };
      return { records: [current] };
    },
    ...routes,
  } as never);
  const props: ExpandedRecordProps = {
    schema,
    table,
    role: "owner",
    recordId: "rec1",
    prevId: null,
    nextId: null,
    onNavigate: vi.fn(),
    onClose: vi.fn(),
    emails: new Map(PEOPLE.map((p) => [p.id, p.email])),
    timeZone: "UTC",
    currentUserId: "usr1",
    collaborators: PEOPLE,
    ...over,
  };
  const { unmount } = render(
    <Providers client={createQueryClient()}>
      <ExpandedRecord {...props} />
    </Providers>,
  );
  return { api, props, unmount };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("ExpandedRecord: save status", () => {
  it("says Saving… while a save is in flight and Saved once it lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setup({
      [PATCH]: async () => {
        await gate;
        return { records: [{ ...record, values: { ...record.values, fld_name: "Ship it" } }] };
      },
    });
    const input = await screen.findByDisplayValue("Launch");
    expect(screen.getByRole("status", { name: "Save status" })).toHaveTextContent("");
    await userEvent.clear(input);
    await userEvent.type(input, "Ship it{Enter}");
    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    release();
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
  });

  it("is a polite live region", async () => {
    setup();
    await screen.findByDisplayValue("Launch");
    expect(screen.getByRole("status", { name: "Save status" })).toHaveAttribute("aria-live", "polite");
  });

  it("says Couldn't save when a save fails, and the field keeps its message", async () => {
    setup({ [PATCH]: apiError(500, "internal", "disk full") });
    const input = await screen.findByDisplayValue("Launch");
    await userEvent.clear(input);
    await userEvent.type(input, "Ship it{Enter}");
    const status = await screen.findByText("Couldn't save");
    expect(status).toBeInTheDocument();
    expect(status.closest("[role=status]")).toHaveClass("text-danger");
    expect(screen.getAllByRole("alert").some((a) => /disk full/.test(a.textContent ?? ""))).toBe(true);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("lets Saved fade after a few seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      setup();
      const input = await screen.findByDisplayValue("Launch");
      await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).type(input, "!{Enter}");
      expect(await screen.findByText("Saved")).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3500);
      });
      expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ExpandedRecord: long text saves while typing", () => {
  it("saves the plain text field once typing pauses, without rebuilding the text area under the caret", async () => {
    const { api } = setup();
    const area = (await screen.findByRole("textbox", { name: "Plain notes" })) as HTMLTextAreaElement;
    await userEvent.click(area);
    await userEvent.type(area, " draft");
    // Nothing yet: typing has not paused.
    expect(api.callsTo(PATCH)).toHaveLength(0);
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1), { timeout: 3000 });
    expect(api.callsTo(PATCH)[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_plain: "first draft" } }] });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    // The same element, still focused and still holding what was typed.
    expect(screen.getByRole("textbox", { name: "Plain notes" })).toBe(area);
    expect(area).toHaveFocus();
    expect(area).toHaveValue("first draft");
    // Leaving the field has nothing left to save.
    await userEvent.tab();
    expect(api.callsTo(PATCH)).toHaveLength(1);
  });

  it("saves on blur at once", async () => {
    const { api } = setup();
    const area = await screen.findByRole("textbox", { name: "Plain notes" });
    await userEvent.type(area, "!");
    await userEvent.tab();
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
  });

  it("saves what is waiting when the record closes", async () => {
    const { api, unmount } = setup();
    const area = await screen.findByRole("textbox", { name: "Plain notes" });
    await userEvent.type(area, "!");
    expect(api.callsTo(PATCH)).toHaveLength(0);
    // The host closes the record before typing paused: the text is saved, not lost.
    unmount();
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1));
    expect(api.callsTo(PATCH)[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_plain: "first!" } }] });
  });

  it("opens the rich text editor lazily, saves its Markdown while typed, and keeps the editor mounted", async () => {
    const { api } = setup();
    const toolbar = await screen.findByRole("toolbar", { name: "Formatting" });
    expect(toolbar).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Preview" })).not.toBeInTheDocument();
    const pm = document.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    expect(pm).toHaveTextContent("Plan");
    expect(pm.querySelector("h1")).not.toBeNull();
    act(() => {
      pm.editor.commands.focus("end");
      pm.editor.commands.insertContent("— done");
    });
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1), { timeout: 3000 });
    const sent = (api.callsTo(PATCH)[0]!.body as { records: { values: Record<string, string> }[] }).records[0]!.values.fld_rich!;
    expect(sent).toMatch(/^# Plan\n\n- one.*done$/);
    expect(document.querySelector(".ProseMirror")).toBe(pm);
  });

  it("opens the rich text editor full screen from the corner button and closes it on Escape without closing the record", async () => {
    const { props } = setup();
    await screen.findByRole("toolbar", { name: "Formatting" });
    await userEvent.click(screen.getAllByRole("button", { name: "Open full screen" })[1]!);
    const full = await screen.findByRole("dialog", { name: "Notes" });
    expect(within(full).getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    expect(within(full).getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(within(full).queryByRole("button", { name: "Open full screen" })).not.toBeInTheDocument();
    // Both views are one value: text typed full screen is in the field behind it.
    const inner = full.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
    act(() => inner.editor.commands.insertContent("extra"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Notes" })).not.toBeInTheDocument());
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".ProseMirror")).toHaveTextContent("extra"));
  });

  it("opens the plain text field full screen from its corner button", async () => {
    const { api } = setup();
    const buttons = await screen.findAllByRole("button", { name: "Open full screen" });
    await userEvent.click(buttons[0]!);
    const full = await screen.findByRole("dialog", { name: "Plain notes" });
    const area = within(full).getByRole("textbox", { name: "Plain notes" });
    expect(area).toHaveValue("first");
    await userEvent.type(area, " more");
    await userEvent.click(within(full).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Plain notes" })).not.toBeInTheDocument());
    await waitFor(() => expect(api.callsTo(PATCH)).toHaveLength(1), { timeout: 3000 });
    expect(api.callsTo(PATCH)[0]!.body).toEqual({ typecast: true, records: [{ id: "rec1", values: { fld_plain: "first more" } }] });
  });
});

describe("ExpandedRecord: Share", () => {
  it("has a Share button, not a link button", async () => {
    setup();
    await screen.findByDisplayValue("Launch");
    expect(screen.getByRole("button", { name: "Share record" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /copy link/i })).not.toBeInTheDocument();
  });

  it("opens the share sheet with the record's address and title where the browser has one", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    window.history.replaceState(null, "", "/base/app1/tbl1/viw1?record=rec1");
    setup();
    await screen.findByDisplayValue("Launch");
    await userEvent.click(screen.getByRole("button", { name: "Share record" }));
    expect(share).toHaveBeenCalledWith({ url: window.location.href, title: "Launch" });
    expect(share.mock.calls[0]![0].url).toContain("?record=rec1");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("says nothing when the person closes the share sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: vi.fn().mockRejectedValue(new DOMException("closed", "AbortError")), configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    setup();
    await screen.findByDisplayValue("Launch");
    await userEvent.click(screen.getByRole("button", { name: "Share record" }));
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
  });

  it("copies the link with a toast where there is no share sheet", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    expect(navigator.share).toBeUndefined();
    setup();
    await screen.findByDisplayValue("Launch");
    await userEvent.click(screen.getByRole("button", { name: "Share record" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(window.location.href));
    expect(await screen.findByText("Link copied")).toBeInTheDocument();
  });
});

describe("ExpandedRecord: phone layout", () => {
  it("is full screen below sm: no inset, no radius, the dynamic viewport height, safe-area padding", async () => {
    setup();
    await screen.findByDisplayValue("Launch");
    const cls = screen.getByRole("dialog").className.split(/\s+/);
    for (const c of ["fixed", "inset-0", "h-dvh", "pt-[env(safe-area-inset-top)]", "pb-[env(safe-area-inset-bottom)]", "pl-[env(safe-area-inset-left)]", "pr-[env(safe-area-inset-right)]"]) expect(cls).toContain(c);
    // The inset and rounded card are for sm and up only.
    expect(cls).not.toContain("inset-2");
    expect(cls).not.toContain("rounded-lg");
    expect(cls).toContain("sm:rounded-lg");
    expect(cls).toContain("sm:inset-6");
  });
});
