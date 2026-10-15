import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { Avatar, initials } from "./avatar";
import { Button } from "./button";
import { ColorSwatchPicker } from "./color-swatch-picker";
import { ConfirmDialog } from "./confirm-dialog";
import { FIELD_TYPE_ICONS, FIELD_TYPE_LABELS } from "./field-type-icon";
import { Field, Input } from "./input";
import { ToastProvider, useToast } from "./toast";
import { COLORS } from "@/lib/colors";
import { ThemeProvider, useTheme } from "@/theme/ThemeProvider";

describe("Button", () => {
  it("is disabled and announces busy while loading", () => {
    render(<Button loading>Save</Button>);
    const b = screen.getByRole("button", { name: /Save/ });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute("aria-busy", "true");
  });
  it("defaults to type=button so it never submits a form by accident", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });
  it("has a soft variant: the primary colour on its soft background", () => {
    render(<Button variant="soft">New base</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-primary-soft", "text-primary");
  });
});

describe("Field", () => {
  it("associates label, hint and error with the control", () => {
    render(
      <Field label="Email" error="Required">
        {(ctl) => <Input {...ctl} />}
      </Field>,
    );
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Required");
  });
});

describe("Avatar", () => {
  it("derives initials from name or email", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada")).toBe("A");
    expect(initials("", "grace.hopper@example.com")).toBe("GH");
    expect(initials(null, null)).toBe("?");
    render(<Avatar name="Ada Lovelace" />);
    expect(screen.getByRole("img", { name: "Ada Lovelace" })).toHaveTextContent("AL");
  });
});

describe("ColorSwatchPicker", () => {
  it("offers all 20 palette colours as a radio group and reports the choice", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ColorSwatchPicker value="blue" onChange={onChange} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(COLORS.length);
    expect(screen.getByRole("radio", { name: "Blue" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Dark red" }));
    expect(onChange).toHaveBeenCalledWith("red_dark");
  });
});

describe("FieldTypeIcon tables", () => {
  it("covers all 28 field types with an icon and a label", () => {
    expect(Object.keys(FIELD_TYPE_ICONS)).toHaveLength(28);
    expect(Object.keys(FIELD_TYPE_LABELS)).toHaveLength(28);
    for (const icon of Object.values(FIELD_TYPE_ICONS)) expect(icon).toBeTruthy();
  });
});

describe("ConfirmDialog", () => {
  function Harness({ onConfirm }: { onConfirm: () => Promise<unknown> | void }) {
    const [open, setOpen] = useState(true);
    return <ConfirmDialog open={open} onOpenChange={setOpen} title="Delete it?" confirmLabel="Delete" destructive onConfirm={onConfirm} />;
  }

  it("closes after a successful confirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("stays open and shows the error when the action fails", async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={() => Promise.reject(new ApiError(403, "forbidden", "You may not delete this"))} />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("You may not delete this");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("cancels without running the action", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("Toast", () => {
  function Trigger() {
    const { toast, error } = useToast();
    return (
      <>
        <button onClick={() => toast({ title: "Saved", variant: "success", durationMs: 1000 })}>ok</button>
        <button onClick={() => error(new Error("Boom"), "Failed")}>fail</button>
      </>
    );
  }

  it("announces toasts and dismisses them after their duration", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <ToastProvider>
          <Trigger />
        </ToastProvider>,
      );
      await user.click(screen.getByText("ok"));
      expect(screen.getByRole("status")).toHaveTextContent("Saved");
      act(() => void vi.advanceTimersByTime(1100));
      expect(screen.queryByText("Saved")).not.toBeInTheDocument();

      await user.click(screen.getByText("fail"));
      expect(screen.getByRole("alert")).toHaveTextContent("Boom");
      await user.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ThemeProvider", () => {
  function Probe() {
    const { mode, resolved, setMode } = useTheme();
    return (
      <>
        <span data-testid="state">{`${mode}/${resolved}`}</span>
        <button onClick={() => setMode("dark")}>dark</button>
        <button onClick={() => setMode("light")}>light</button>
        <button onClick={() => setMode("system")}>system</button>
      </>
    );
  }

  it("applies and persists the manual toggle", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent("system/light");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    await user.click(screen.getByText("dark"));
    expect(screen.getByTestId("state")).toHaveTextContent("dark/dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem("ob-theme")).toBe("dark");

    await user.click(screen.getByText("system"));
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem("ob-theme")).toBe("system");
  });

  it("restores the stored choice and follows the system preference in system mode", () => {
    localStorage.setItem("ob-theme", "system");
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          matches: true,
          addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.push(l),
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent("system/dark");
    act(() => listeners.forEach((l) => l({ matches: false })));
    expect(screen.getByTestId("state")).toHaveTextContent("system/light");
  });
});
