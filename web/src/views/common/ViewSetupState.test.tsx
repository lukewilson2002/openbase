import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import CalendarView from "../calendar/CalendarView";
import { isDateLike } from "./wallTime";
import { projectSchema, renderView, viewWithConfig } from "./viewTestUtils";

const unset = viewWithConfig("viw1", "calendar", {});

function setup(role: string, withoutDates = false) {
  const schema = projectSchema(role, [unset]);
  if (withoutDates) schema.tables[0]!.fields = schema.tables[0]!.fields.filter((f) => !isDateLike(f));
  return renderView(CalendarView, { schema, viewId: "viw1" });
}

describe("ViewSetupState (a calendar without a date field)", () => {
  it("offers the date field dialog from the footnote, with the date type chosen", async () => {
    const user = userEvent.setup();
    setup("creator");
    expect(await screen.findByRole("heading", { name: "Choose a date field" })).toBeInTheDocument();
    expect(screen.getByText("Need a different date?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a date field" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a field" });
    expect(dialog).toHaveTextContent("Date");
  });

  it("says when the table has no date field yet and makes adding one the main button", async () => {
    setup("creator", true);
    expect(await screen.findByText("This table has no date field yet.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Date field" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a date field" })).toBeInTheDocument();
  });

  it("lets editors pick the field but not add one", async () => {
    setup("editor");
    expect(await screen.findByRole("combobox", { name: "Date field" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a date field" })).not.toBeInTheDocument();
  });

  it("tells people who cannot change the view whom to ask", async () => {
    setup("viewer");
    expect(await screen.findByText(/Ask someone who can edit this view to set it up/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show calendar" })).not.toBeInTheDocument();
  });
});
