import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AddRecordProvider, useAddRecord, useRegisterAddRecord } from "./addRecord";

function Header() {
  const add = useAddRecord();
  return (
    <button type="button" disabled={!add.available} onClick={add.run}>
      New record
    </button>
  );
}

function Layout({ onAdd }: { onAdd?: () => void }) {
  useRegisterAddRecord(onAdd);
  return null;
}

describe("how the header's New button reaches the open layout", () => {
  it("is disabled until a layout offers a way to add, and runs that way", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(
      <AddRecordProvider>
        <Header />
        <Layout onAdd={onAdd} />
      </AddRecordProvider>,
    );
    await user.click(screen.getByRole("button", { name: "New record" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("stays disabled for a layout with no way to add", () => {
    render(
      <AddRecordProvider>
        <Header />
        <Layout />
      </AddRecordProvider>,
    );
    expect(screen.getByRole("button", { name: "New record" })).toBeDisabled();
  });

  it("takes the way back when the layout goes, and runs the latest one while it is there", async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    function Page() {
      const [shown, setShown] = useState(true);
      const [which, setWhich] = useState(1);
      return (
        <AddRecordProvider>
          <Header />
          {shown && <Layout onAdd={which === 1 ? first : second} />}
          <button type="button" onClick={() => setWhich(2)}>
            Swap
          </button>
          <button type="button" onClick={() => setShown(false)}>
            Leave
          </button>
        </AddRecordProvider>
      );
    }
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Swap" }));
    await user.click(screen.getByRole("button", { name: "New record" }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Leave" }));
    expect(screen.getByRole("button", { name: "New record" })).toBeDisabled();
  });

  it("does nothing outside a provider", () => {
    render(<Header />);
    expect(screen.getByRole("button", { name: "New record" })).toBeDisabled();
  });
});
