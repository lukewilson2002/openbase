import { readFileSync } from "node:fs";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "@/auth/guards";
import { USER, mockApi, renderWithProviders } from "@/test/utils";
import { ACCENTS } from "./accents";
import { ACCENT_STORAGE_KEY, THEME_STORAGE_KEY, readStoredAccent } from "./theme";

afterEach(() => vi.unstubAllGlobals());

const initScript = readFileSync(`${process.cwd()}/public/theme-init.js`, "utf8");
const runInit = () => new Function(initScript)();

describe("theme-init.js (before first paint)", () => {
  it("knows every accent colour", () => {
    const list = /\^\(([a-z|]+)\)\$/.exec(initScript)?.[1]?.split("|");
    expect(list).toEqual([...ACCENTS]);
  });

  it("paints the stored mode and accent colour, and falls back to blue", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    localStorage.setItem(ACCENT_STORAGE_KEY, "orange");
    runInit();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-accent", "orange");

    localStorage.setItem(ACCENT_STORAGE_KEY, "chartreuse");
    runInit();
    expect(document.documentElement).toHaveAttribute("data-accent", "blue");
    expect(readStoredAccent()).toBe("blue");
  });
});

describe("the account's accent colour", () => {
  it("is painted when the profile arrives and remembered for the next first paint", async () => {
    mockApi({ "GET /api/auth/me": { ...USER, accent: "green" } });
    renderWithProviders(
      <RequireAuth>
        <p>Signed in</p>
      </RequireAuth>,
    );
    expect(await screen.findByText("Signed in")).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-accent", "green"));
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("green");
  });

  it("goes back to blue on a device that had another account's colour", async () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, "pink");
    mockApi({ "GET /api/auth/me": { ...USER, accent: null } });
    renderWithProviders(
      <RequireAuth>
        <p>Signed in</p>
      </RequireAuth>,
    );
    expect(await screen.findByText("Signed in")).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-accent", "blue"));
  });
});
