import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AttachmentRef } from "@/api/types";
import { Providers, createQueryClient } from "@/providers";
import { ALL_FIELDS, PEOPLE, field } from "@/test/fields";
import { mockApi } from "@/test/utils";
import { AttachmentEditor } from "./AttachmentEditor";
import { ChoiceEditor } from "./ChoiceEditor";
import { EditorEnvProvider, type EditorEnv } from "./env";
import { LinkEditor } from "./LinkEditor";
import { RatingEditor } from "./RatingEditor";
import { UserEditor } from "./UserEditor";

const env: EditorEnv = { baseId: "app1", tableId: "tbl1", collaborators: PEOPLE, timeZone: "UTC", canCreateOptions: false, format: { timeZone: "UTC", userName: () => undefined }, currentUserId: null };
const status = { ...ALL_FIELDS.single_select, id: "fld_status", name: "Status" };
const tags = { ...ALL_FIELDS.multiple_select, id: "fld_tags", name: "Tags" };
const owner = field("user", { multiple: false, notify: false }, { id: "fld_owner", name: "Owner" });
const team = field("user", { multiple: true, notify: false }, { id: "fld_team", name: "Team" });
const requires = field("link", { linked_table_id: "tbl2", inverse_field_id: "fld_inv", single: true }, { id: "fld_req", name: "Requires" });
const rating = { ...ALL_FIELDS.rating, id: "fld_rate", name: "Score" };
const files = { ...ALL_FIELDS.attachment, id: "fld_files", name: "Files" };

function callbacks() {
  return { onChange: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn() };
}

function inEnv(ui: React.ReactElement) {
  return render(
    <Providers client={createQueryClient()}>
      <EditorEnvProvider value={env}>{ui}</EditorEnvProvider>
    </Providers>,
  );
}

describe("a pick shows at once while the editor stays mounted (a form)", () => {
  it("single select shows the picked option and Clear empties it", async () => {
    const cb = callbacks();
    inEnv(<ChoiceEditor field={status} value={null} variant="form" {...cb} />);
    const trigger = screen.getByRole("button", { name: "Status" });
    expect(trigger).toHaveTextContent("Select…");
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("button", { name: "In progress" }));
    expect(cb.onCommit).toHaveBeenCalledWith({ json: "chs2" }, undefined);
    expect(screen.getByRole("button", { name: "Status" })).toHaveTextContent("In progress");
    await userEvent.click(screen.getByRole("button", { name: "Status" }));
    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    expect(cb.onCommit).toHaveBeenLastCalledWith({ json: null }, undefined);
    expect(screen.getByRole("button", { name: "Status" })).toHaveTextContent("Select…");
  });

  it("single person shows the picked person and Clear empties it", async () => {
    const cb = callbacks();
    inEnv(<UserEditor field={owner} value={null} variant="form" {...cb} />);
    expect(screen.getByRole("button", { name: "Owner" })).toHaveTextContent("Assign…");
    await userEvent.click(screen.getByRole("button", { name: "Owner" }));
    await userEvent.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    expect(cb.onCommit).toHaveBeenCalledWith({ json: ["usr2"] }, undefined);
    expect(screen.getByRole("button", { name: "Owner" })).toHaveTextContent("Grace Hopper");
    await userEvent.click(screen.getByRole("button", { name: "Owner" }));
    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    expect(screen.getByRole("button", { name: "Owner" })).toHaveTextContent("Assign…");
  });

  it("several people lose their chips on Clear", async () => {
    inEnv(<UserEditor field={team} value={["usr1", "usr2"]} variant="form" {...callbacks()} />);
    const trigger = screen.getByRole("button", { name: "Team" });
    expect(trigger).toHaveTextContent("Ada Lovelace");
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    expect(screen.getByRole("button", { name: "Team" })).toHaveTextContent("Assign…");
  });

  it("several options lose their pills on Clear", async () => {
    inEnv(<ChoiceEditor field={tags} value={["chs1"]} variant="form" {...callbacks()} />);
    const trigger = screen.getByRole("button", { name: "Tags" });
    expect(trigger).toHaveTextContent("Todo");
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    expect(screen.getByRole("button", { name: "Tags" })).toHaveTextContent("Select…");
  });

  it("single link shows the picked record and Clear empties it", async () => {
    mockApi({ "GET /api/tables/tbl2/records/lookup": { records: [{ id: "recA", name: "Buy the domain" }] } } as never);
    const cb = callbacks();
    inEnv(<LinkEditor field={requires} value={[]} variant="form" {...cb} />);
    expect(screen.getByRole("button", { name: "Requires" })).toHaveTextContent("Link records…");
    await userEvent.click(screen.getByRole("button", { name: "Requires" }));
    await userEvent.click(await screen.findByRole("button", { name: /Buy the domain/ }));
    expect(cb.onCommit).toHaveBeenCalledWith({ json: [{ id: "recA", name: "Buy the domain" }] }, undefined);
    expect(screen.getByRole("button", { name: "Requires" })).toHaveTextContent("Buy the domain");
    await userEvent.click(screen.getByRole("button", { name: "Requires" }));
    await userEvent.click(await screen.findByRole("button", { name: "Clear" }));
    expect(screen.getByRole("button", { name: "Requires" })).toHaveTextContent("Link records…");
  });
});

describe("Tab and Enter in the grid", () => {
  it("Tab in a single select takes the option highlighted after typing, and goes right", async () => {
    const cb = callbacks();
    inEnv(<ChoiceEditor field={status} value="chs1" variant="cell" {...cb} />);
    const search = await screen.findByRole("combobox", { name: /Find an option/ });
    await userEvent.type(search, "do");
    // "Todo" and "Done" both match; arrow to the second.
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Tab}");
    expect(cb.onCommit).toHaveBeenCalledWith({ json: "chs3" }, [1, 0]);
  });

  it("Tab without having looked keeps what is picked, Shift+Tab goes left", async () => {
    const cb = callbacks();
    inEnv(<ChoiceEditor field={status} value="chs2" variant="cell" {...cb} />);
    await screen.findByRole("combobox", { name: /Find an option/ });
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(cb.onCommit).toHaveBeenCalledWith({ json: "chs2" }, [-1, 0]);
  });

  it("Enter in a single select picks and goes down", async () => {
    const cb = callbacks();
    inEnv(<ChoiceEditor field={status} value={null} variant="cell" {...cb} />);
    await screen.findByRole("combobox", { name: /Find an option/ });
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(cb.onCommit).toHaveBeenCalledWith({ json: "chs2" }, [0, 1]);
  });

  it("Tab in a user editor commits the highlighted person, or the picked ones, and goes right", async () => {
    const cb = callbacks();
    inEnv(<UserEditor field={owner} value={["usr1"]} variant="cell" {...cb} />);
    await userEvent.type(await screen.findByRole("combobox", { name: /Find a person/ }), "gra");
    await userEvent.keyboard("{Tab}");
    expect(cb.onCommit).toHaveBeenLastCalledWith({ json: ["usr2"] }, [1, 0]);
    const other = callbacks();
    inEnv(<UserEditor field={team} value={["usr1"]} variant="cell" {...other} />);
    const searches = await screen.findAllByRole("combobox", { name: /Find a person/ });
    searches[searches.length - 1]!.focus();
    await userEvent.keyboard("{Tab}");
    expect(other.onCommit).toHaveBeenCalledWith({ json: ["usr1"] }, [1, 0]);
  });

  it("Enter in a user editor picks one person and goes down; Ctrl+Enter ends a list of people", async () => {
    const cb = callbacks();
    inEnv(<UserEditor field={owner} value={null} variant="cell" {...cb} />);
    await screen.findByRole("combobox", { name: /Find a person/ });
    await userEvent.keyboard("{Enter}");
    expect(cb.onCommit).toHaveBeenCalledWith({ json: ["usr1"] }, [0, 1]);
    const many = callbacks();
    inEnv(<UserEditor field={team} value={["usr2"]} variant="cell" {...many} />);
    const searches = await screen.findAllByRole("combobox", { name: /Find a person/ });
    searches[searches.length - 1]!.focus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(many.onCommit).toHaveBeenCalledWith({ json: ["usr2"] }, [0, 1]);
  });

  it("Tab in a link editor commits the highlighted record, and Enter picks and goes down", async () => {
    mockApi({ "GET /api/tables/tbl2/records/lookup": { records: [{ id: "recA", name: "Buy the domain" }, { id: "recB", name: "Pick a host" }] } } as never);
    const cb = callbacks();
    inEnv(<LinkEditor field={requires} value={[]} variant="cell" {...cb} />);
    const search = await screen.findByRole("combobox", { name: "Search Requires" });
    await screen.findByRole("option", { name: /Pick a host/ });
    search.focus();
    await userEvent.keyboard("{ArrowDown}{Tab}");
    expect(cb.onCommit).toHaveBeenCalledWith({ json: [{ id: "recB", name: "Pick a host" }] }, [1, 0]);
    cb.onCommit.mockClear();
    // The highlight is still on the second record.
    await userEvent.keyboard("{Enter}");
    expect(cb.onCommit).toHaveBeenCalledWith({ json: [{ id: "recB", name: "Pick a host" }] }, [0, 1]);
  });

  it("Tab and Enter in an attachment editor commit the files and move on", async () => {
    const cb = callbacks();
    const pdf: AttachmentRef = { id: "att1", filename: "Pricing.pdf", mime: "application/pdf", size: 1024 };
    inEnv(<AttachmentEditor field={files} value={[pdf]} variant="cell" {...cb} />);
    const panel = await screen.findByRole("list", { name: "Files in Files" });
    const upload = within(panel.parentElement!).getByRole("button", { name: /Upload/ });
    upload.focus();
    await userEvent.keyboard("{Tab}");
    expect(cb.onCommit).toHaveBeenLastCalledWith({ json: [pdf] }, [1, 0]);
    // Enter on a button presses it; with Ctrl it is done.
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(cb.onCommit).toHaveBeenLastCalledWith({ json: [pdf] }, [0, 1]);
    cb.onCommit.mockClear();
    await userEvent.keyboard("{Enter}");
    expect(cb.onCommit).not.toHaveBeenCalled();
  });
});

describe("RatingEditor", () => {
  const setup = (value: unknown, over: { initialText?: string; variant?: "cell" | "form" } = {}) => {
    const cb = callbacks();
    render(<RatingEditor field={rating} value={value} variant={over.variant ?? "cell"} initialText={over.initialText} {...cb} />);
    return cb;
  };

  it("takes the digit typed to open it as the rating, and tells the grid", () => {
    const cb = setup(null, { initialText: "3" });
    expect(cb.onChange).toHaveBeenCalledWith({ json: 3 });
    expect(screen.getByRole("radio", { name: "3 of 5" })).toBeChecked();
    expect(cb.onCommit).not.toHaveBeenCalled();
  });

  it("caps a typed digit at the most stars and ignores other characters", () => {
    const cb = setup(2, { initialText: "9" });
    expect(cb.onChange).toHaveBeenCalledWith({ json: 5 });
    const other = setup(2, { initialText: "x" });
    expect(other.onChange).not.toHaveBeenCalled();
  });

  it("keeps a full rating on ArrowRight and steps with the arrows without ending the edit", () => {
    const cb = setup(5);
    const group = screen.getByRole("radiogroup", { name: "Score" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(cb.onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "5 of 5" })).toBeChecked();
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(screen.getByRole("radio", { name: "3 of 5" })).toBeChecked();
    expect(cb.onChange).toHaveBeenLastCalledWith({ json: 3 });
    expect(cb.onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(group, { key: "Enter" });
    expect(cb.onCommit).toHaveBeenCalledWith({ json: 3 }, [0, 1]);
  });

  it("clears from the first star with ArrowLeft, and Tab commits and goes right", () => {
    const cb = setup(1);
    const group = screen.getByRole("radiogroup", { name: "Score" });
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(cb.onChange).toHaveBeenLastCalledWith({ json: null });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    fireEvent.keyDown(group, { key: "Tab" });
    expect(cb.onCommit).toHaveBeenCalledWith({ json: 1 }, [1, 0]);
  });

  it("saves each key at once in a form", () => {
    const cb = setup(5, { variant: "form" });
    const group = screen.getByRole("radiogroup", { name: "Score" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(cb.onCommit).toHaveBeenLastCalledWith({ json: 5 });
    fireEvent.keyDown(group, { key: "2" });
    expect(cb.onCommit).toHaveBeenLastCalledWith({ json: 2 });
  });
});
