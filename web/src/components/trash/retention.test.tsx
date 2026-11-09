import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { deleteRecordsText } from "@/components/record/deleteText";
import { mockApi, renderWithProviders } from "@/test/utils";
import { daysText, movesToTrash, useTrashDays } from "./retention";

function Days() {
  return <p>{useTrashDays()} days</p>;
}

describe("what a deletion says about the trash (APP-16)", () => {
  it("says the real number of days, singular or plural, and who moves", () => {
    expect(daysText(1)).toBe("1 day");
    expect(daysText(30)).toBe("30 days");
    expect(movesToTrash(30)).toBe("It moves to the trash for 30 days. Restore it from Trash until then.");
    expect(movesToTrash(7, "The folder and its collections", true)).toBe("The folder and its collections move to the trash for 7 days. Restore them from Trash until then.");
  });

  it("reads the retention the server publishes, and the server's default until it answers", async () => {
    mockApi({ "GET /api/setup": { needs_setup: false, open_signup: false, email_enabled: false, public_url: "https://base.example.org", passkeys_enabled: false, trash_days: 14 } });
    renderWithProviders(<Days />);
    expect(screen.getByText("30 days")).toBeInTheDocument();
    expect(await screen.findByText("14 days")).toBeInTheDocument();
  });

  it("names the record and quotes the days in the record confirmations, for both kinds of role", () => {
    expect(deleteRecordsText("creator", 1, 14, "Acme Co")).toEqual({
      title: "Delete “Acme Co”?",
      description: "It moves to the trash for 14 days. Restore it from Trash until then, or press Undo right after.",
    });
    expect(deleteRecordsText("editor", 3, 14).description).toBe(
      "They move to the trash for 14 days. Press Undo right after, or restore them later from Trash: editors can restore the records they deleted themselves.",
    );
    expect(deleteRecordsText("creator", 1).title).toBe("Delete this record?");
    expect(deleteRecordsText("creator", 3).title).toBe("Delete 3 records?");
  });
});
