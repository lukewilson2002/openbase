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

describe("ViewSetupState (a calendar without a date property)", () => {
  it("offers the date property dialog from the footnote, with the date type chosen", async () => {
    const user = userEvent.setup();
    setup("creator");
    expect(await screen.findByRole("heading", { name: "Choose a date property" })).toBeInTheDocument();
    expect(screen.getByText("Need a different date?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add a date property" }));
    const dialog = await screen.findByRole("dialog", { name: "Add property" });
    expect(dialog).toHaveTextContent("Date");
  });

  it("says when the collection has no date property yet and makes adding one the main button", async () => {
    setup("creator", true);
    expect(await screen.findByText("This collection has no date property yet.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Date property" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a date property" })).toBeInTheDocument();
  });

  it("lets editors pick the field but not add one", async () => {
    setup("editor");
    expect(await screen.findByRole("combobox", { name: "Date property" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add a date property" })).not.toBeInTheDocument();
  });

  it("lets people who cannot change the view pick the field too: the choice is a draft only they see", async () => {
    setup("viewer");
    expect(await screen.findByRole("combobox", { name: "Date property" })).toBeInTheDocument();
    expect(screen.queryByText(/Ask someone who can edit this view/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show calendar" })).toBeInTheDocument();
  });
});
