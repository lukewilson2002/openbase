import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, mockApi, renderWithProviders } from "@/test/utils";
import { ExportCsvButton } from "./ExportCsvButton";

const saveBlob = vi.hoisted(() => vi.fn());
vi.mock("@/lib/download", async (orig) => ({ ...(await orig<typeof import("@/lib/download")>()), saveBlob }));

afterEach(() => {
  vi.unstubAllGlobals();
  saveBlob.mockReset();
});

describe("Download CSV", () => {
  it("asks for the view's CSV in the viewer's time zone and saves it under the name the server gives", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /api/views/viw1/export.csv": { status: 200, text: "﻿Name\r\nAnn\r\n", headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="Team tasks.csv"; filename*=UTF-8\'\'Team%20tasks.csv' } } });
    renderWithProviders(<ExportCsvButton view={{ id: "viw1", name: "Team tasks" }} timeZone="Europe/Berlin" />);
    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(api.callsTo("GET /api/views/viw1/export.csv")[0]!.query.get("timezone")).toBe("Europe/Berlin");
    const [blob, filename] = saveBlob.mock.calls[0] as [Blob, string];
    expect(filename).toBe("Team tasks.csv");
    expect(await blob.text()).toContain("Ann");
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeEnabled();
  });

  it("falls back to the view's name when the server suggests none", async () => {
    const user = userEvent.setup();
    mockApi({ "GET /api/views/viw1/export.csv": { status: 200, text: "a\r\n", headers: { "Content-Type": "text/csv" } } });
    renderWithProviders(<ExportCsvButton view={{ id: "viw1", name: "Team: tasks?" }} />);
    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalled());
    expect(saveBlob.mock.calls[0]![1]).toBe("Team_ tasks_.csv");
  });

  it("is disabled while the file is being prepared and reports a failure without saving anything", async () => {
    const user = userEvent.setup();
    let fail: (v: unknown) => void = () => {};
    mockApi({ "GET /api/views/viw1/export.csv": () => new Promise((r) => (fail = r)) });
    renderWithProviders(<ExportCsvButton view={{ id: "viw1", name: "Tasks" }} />);
    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    const busy = await screen.findByRole("button", { name: /Preparing/ });
    expect(busy).toBeDisabled();
    fail(apiError(403, "forbidden", "You cannot export this view."));
    expect(await screen.findByText("You cannot export this view.")).toBeInTheDocument();
    expect(saveBlob).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeEnabled();
  });
});
