import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countsChanged } from "@/api/records";
import { OWN_COUNT_REFRESH_MS, useOwnRecordCounts } from "./useCountRefresh";

function Probe() {
  useOwnRecordCounts();
  return null;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useOwnRecordCounts", () => {
  const setup = () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const view = render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    const workspaces = () => spy.mock.calls.filter((c) => JSON.stringify(c[0]) === JSON.stringify({ queryKey: ["workspaces"] })).length;
    return { view, workspaces };
  };

  it("refreshes the counts shortly after this tab's own record writes, once for a burst", async () => {
    const { workspaces } = setup();
    await act(async () => {
      await countsChanged(Promise.resolve());
      await countsChanged(Promise.resolve());
      await countsChanged(Promise.resolve());
    });
    expect(workspaces()).toBe(0);
    vi.advanceTimersByTime(OWN_COUNT_REFRESH_MS);
    expect(workspaces()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(workspaces()).toBe(1);
  });

  it("does nothing for a write that failed", async () => {
    const { workspaces } = setup();
    await act(async () => {
      await countsChanged(Promise.reject(new Error("no"))).catch(() => {});
    });
    vi.advanceTimersByTime(10_000);
    expect(workspaces()).toBe(0);
  });

  it("stops listening, and drops a refresh still waiting, when the shell goes", async () => {
    const { view, workspaces } = setup();
    await act(async () => {
      await countsChanged(Promise.resolve());
    });
    view.unmount();
    vi.advanceTimersByTime(10_000);
    expect(workspaces()).toBe(0);
    await countsChanged(Promise.resolve());
    vi.advanceTimersByTime(10_000);
    expect(workspaces()).toBe(0);
  });
});
