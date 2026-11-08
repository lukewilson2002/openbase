import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmptyRecords } from "./EmptyRecords";

describe("EmptyRecords", () => {
  it("says there are no <plural> yet, with New <record name>", async () => {
    const onAdd = vi.fn();
    render(<EmptyRecords table={{ record_noun: "client" }} filtered={false} onAdd={onAdd} onReset={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "No clients yet" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "New client" }));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Reset" })).not.toBeInTheDocument();
  });

  it("says no <plural> match these filters, with Reset and no New", async () => {
    const onReset = vi.fn();
    render(<EmptyRecords table={{ record_noun: "company" }} filtered onAdd={vi.fn()} onReset={onReset} />);
    expect(screen.getByRole("heading", { name: "No companies match these filters" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New company" })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("calls the records 'records' when the collection has no name for them", () => {
    render(<EmptyRecords table={{ record_noun: "" }} filtered={false} onAdd={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "No records yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New record" })).toBeInTheDocument();
  });

  it("offers nothing to people who cannot add", () => {
    render(<EmptyRecords table={{ record_noun: "client" }} filtered={false} />);
    expect(screen.getByRole("heading", { name: "No clients yet" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
