import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Filter, ViewConfig } from "@/api/types";
import type { ViewConfigApi } from "../grid/useViewConfig";
import { viewWithConfig } from "./viewTestUtils";
import { useResetFilters } from "./useResetFilters";

const done: Filter = { conjunction: "and", items: [{ type: "condition", field_id: "fld2", operator: "is", value: "Done" } as never] };
const view = viewWithConfig("viw1", "list", { filter: done });

function reset(opts: { draftFilter?: boolean; search?: string }) {
  const update = vi.fn();
  const setSearch = vi.fn();
  const cfg = { update, draft: opts.draftFilter ? { v: 1, base: null, started: 0, changes: { filter: null } } : null } as unknown as ViewConfigApi;
  const { result } = renderHook(() => useResetFilters(cfg, view, opts.search ?? "", setSearch));
  result.current();
  const applied = update.mock.calls[0]?.[0] as ((c: ViewConfig) => ViewConfig) | undefined;
  return { filter: applied?.(view.config).filter, setSearch };
}

describe("Reset in the filtered-empty state", () => {
  it("keeps the saved view's filter when a search narrowed it to nothing, and clears the search", () => {
    const r = reset({ search: "zzz" });
    expect(r.filter).toEqual(done);
    expect(r.setSearch).toHaveBeenCalledWith("");
  });

  it("puts the saved filter back when a draft chip changed it", () => {
    expect(reset({ draftFilter: true }).filter).toEqual(done);
  });

  it("lifts the saved filter, as a draft, only when it alone leaves nothing", () => {
    expect(reset({}).filter).toBeNull();
  });
});
