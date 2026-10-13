import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ALL_FIELDS } from "@/test/fields";
import { EditorEnvProvider, type EditorEnv } from "./env";
import { TextEditor } from "./TextEditor";

const env: EditorEnv = { baseId: "app1", tableId: "tbl1", collaborators: [], timeZone: "UTC", canCreateOptions: false, format: { timeZone: "UTC", userName: () => undefined }, currentUserId: null };
const number = { ...ALL_FIELDS.number, id: "fld_n", name: "Qty" };

function setup(over: { initialText?: string; value?: unknown } = {}) {
  const calls = { onChange: vi.fn(), onCommit: vi.fn(), onCancel: vi.fn() };
  render(
    <EditorEnvProvider value={env}>
      <TextEditor field={number} value={over.value ?? 10} initialText={over.initialText} variant="cell" {...calls} />
    </EditorEnvProvider>,
  );
  return calls;
}

describe("TextEditor", () => {
  it("reports every keystroke to the host as it happens, even an invalid value", async () => {
    // The grid commits what it was last told when the editor refuses to (invalid text) and Enter falls
    // through to it, so the report must not lag behind the typing.
    const { onChange } = setup();
    const input = screen.getByRole("textbox", { name: "Qty" });
    await userEvent.clear(input);
    onChange.mockClear();
    await userEvent.type(input, "ab");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([{ text: "a" }, { text: "ab" }]);
  });

  it("reports the character that started the edit once, and then the typed ones", async () => {
    const { onChange } = setup({ initialText: "7" });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([{ text: "7" }]);
    await userEvent.type(screen.getByRole("textbox", { name: "Qty" }), "7");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([{ text: "7" }, { text: "77" }]);
  });

  it("does not report anything for a plain open (nothing was edited)", () => {
    const { onChange } = setup();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not let Enter or Tab through to the host's own key handler (the grid's overlay would close the editor on it)", async () => {
    const parent = vi.fn();
    render(
      <EditorEnvProvider value={env}>
        <div onKeyDown={(e) => parent(e.key)}>
          <TextEditor field={number} value={10} initialText="x" variant="cell" onCommit={vi.fn()} onCancel={vi.fn()} />
        </div>
      </EditorEnvProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Qty" });
    await userEvent.type(input, "{Enter}{Tab}");
    // Characters bubble up as before; Enter and Tab do not.
    expect(parent.mock.calls.map((c) => c[0])).not.toContain("Enter");
    expect(parent.mock.calls.map((c) => c[0])).not.toContain("Tab");
    // Escape still does (the overlay's own cancel is harmless).
    await userEvent.type(input, "{Escape}");
    expect(parent.mock.calls.map((c) => c[0])).toContain("Escape");
  });

  it("keeps the editor open on Enter while the value is invalid, and commits a valid one with the move", async () => {
    const { onCommit } = setup({ initialText: "x" });
    const input = screen.getByRole("textbox", { name: "Qty" });
    await userEvent.type(input, "{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/not a number/);
    await userEvent.clear(input);
    await userEvent.type(input, "42{Enter}");
    expect(onCommit).toHaveBeenCalledWith({ text: "42" }, [0, 1]);
  });
});
