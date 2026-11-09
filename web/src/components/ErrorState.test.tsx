import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { apiError, mockApi, renderApp, renderWithProviders, USER } from "@/test/utils";
import { AppErrorBoundary } from "./AppErrorBoundary";
import { asSentence } from "./ErrorState";

describe("asSentence", () => {
  it("ends a message in a full stop once", () => {
    expect(asSentence("Failed to fetch")).toBe("Failed to fetch.");
    expect(asSentence("Nothing here. ")).toBe("Nothing here.");
    expect(asSentence("Really?")).toBe("Really?");
  });
});

describe("error screens (APP-17)", () => {
  it("an unknown address says what happened and what to do, and leads Home", async () => {
    mockApi({ "GET /api/auth/me": USER });
    renderApp({ route: "/no/such/page" });
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("That address does not lead anywhere. Check the link, or go to Home and look from there.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/");
  });

  it("a folder that is gone says what happened and what to do, and leads Home", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": [], "GET /api/bases/app1": apiError(404, "not_found", "base not found") });
    renderApp({ route: "/base/app1" });
    expect(await screen.findByRole("heading", { name: "Folder not found" })).toBeInTheDocument();
    expect(screen.getByText("It was deleted, or you do not have access to it. Ask whoever sent the link, or go to Home and look from there.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Home" })).toBeInTheDocument();
  });

  it("a folder that fails to load names the problem and says to reload", async () => {
    mockApi({ "GET /api/auth/me": USER, "GET /api/workspaces": [], "GET /api/bases/app1": apiError(500, "internal", "The database is busy") });
    renderApp({ route: "/base/app1" });
    expect(await screen.findByRole("heading", { name: "Could not load this folder" }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("The database is busy. Reload the page in a moment, or go to Home.")).toBeInTheDocument();
  });

  it("a page that throws while drawing shows the error screen instead of a blank page, and Go to Home gets out of it", async () => {
    const user = userEvent.setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Boom(): never {
      throw new Error("boom");
    }
    renderWithProviders(
      <Routes>
        <Route path="/" element={<p>Home page</p>} />
        <Route
          path="/broken"
          element={
            <AppErrorBoundary>
              <Boom />
            </AppErrorBoundary>
          }
        />
      </Routes>,
      "/broken",
    );
    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByText("This page stopped working. Go to Home, or reload the page to try again.")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Go to Home" }));
    expect(await screen.findByText("Home page")).toBeInTheDocument();
    log.mockRestore();
  });
});
