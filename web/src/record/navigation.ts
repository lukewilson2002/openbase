/**
 * Getting to a record's page and back (REC-9). A page is a history entry like any other, so the browser's back
 * (or a phone's back swipe) returns to where it was opened from, and a link to a page works on its own.
 * What the browser cannot tell the page is where "the collection it was opened from" is after several steps
 * (a linked record opened from a linked record), which Escape returns to. So each entry opened from inside the
 * app carries a trail in its history state: the address of that collection screen, and how many history
 * entries back it is. Previous and next replace their entry, so they never add a step.
 *
 * A layout that orders its records its own way (a board by stack, a calendar by day) hands that order over in
 * the trail too, so previous and next step through the records the way the screen showed them. Without it the
 * page asks the server for the opening view's order (`useRecordOrder`).
 */
import { useCallback } from "react";
import { useLocation, useNavigate, type Location } from "react-router";
import { recordPath } from "@/lib/recordPath";
import { isRecordPath } from "@/shell/bottomNav";

export interface RecordTrail {
  /** The collection screen the first page of the trail was opened from (path and query). */
  from: string;
  /** History entries back to it; 0 when it is not in this tab's history (a link opened straight at a page). */
  steps: number;
  /** The record ids of the opening layout in the order it shows them, when that is not the server's order. */
  order?: string[];
}

interface TrailState {
  obRecord?: RecordTrail;
}

export function trailOf(state: unknown): RecordTrail | null {
  const t = (state as TrailState | null)?.obRecord;
  return t && typeof t.from === "string" && typeof t.steps === "number" ? t : null;
}

/** Most ids a trail carries: history state is copied on every step, and a window around the record is all stepping needs. */
const MAX_ORDER = 3000;

/** The ids around `recordId`, at most `MAX_ORDER` of them. */
function windowOf(order: readonly string[], recordId: string): string[] {
  if (order.length <= MAX_ORDER) return [...order];
  const at = Math.max(0, order.indexOf(recordId));
  const start = Math.max(0, Math.min(at - MAX_ORDER / 2, order.length - MAX_ORDER));
  return order.slice(start, start + MAX_ORDER);
}

/** The trail for a page opened from `here`, which is a collection screen or another page. */
function nextTrail(here: Pick<Location, "pathname" | "search" | "state">, fallbackFrom: string, replace: boolean, recordId: string, order: readonly string[] | undefined): RecordTrail {
  if (!isRecordPath(here.pathname)) return { from: here.pathname + here.search, steps: 1, ...(order && { order: windowOf(order, recordId) }) };
  const trail = trailOf(here.state);
  if (!trail) return { from: fallbackFrom, steps: 0 };
  // A replace takes the entry's place, a push adds one; an origin outside the history stays outside. Stepping
  // keeps the order of the layout it started in; a linked record is in another collection, with an order of its own.
  const steps = trail.steps === 0 ? 0 : replace ? trail.steps : trail.steps + 1;
  return { from: trail.from, steps, ...(replace && trail.order && { order: trail.order }) };
}

export interface RecordTarget {
  baseId: string;
  tableId: string;
  recordId: string;
  /** The view whose order previous and next follow. */
  viewId?: string | null;
}

export interface OpenRecordOptions {
  /** Take the current entry's place (previous and next) instead of adding one. */
  replace?: boolean;
  /** Where Escape and the breadcrumb lead when the page was opened straight from a link. */
  fallbackFrom?: string;
  /** The opening layout's own order of the records it shows (previous and next follow it). */
  order?: readonly string[];
}

export interface RecordNavigation {
  /** Opens a record's page. */
  open(target: RecordTarget, options?: OpenRecordOptions): void;
  /** Leaves the page for the collection it was opened from. */
  close(fallback: string): void;
  /** Where `close` leads. */
  origin(fallback: string): string;
  /** The order handed over by the layout this page was opened from, if it did. */
  order: readonly string[] | undefined;
}

export function useRecordNavigation(): RecordNavigation {
  const navigate = useNavigate();
  const location = useLocation();
  const { pathname, search, state } = location;

  const open = useCallback<RecordNavigation["open"]>(
    (target, options) => {
      const replace = options?.replace ?? false;
      const trail = nextTrail({ pathname, search, state }, options?.fallbackFrom ?? `/base/${target.baseId}/${target.tableId}`, replace, target.recordId, options?.order);
      void navigate(recordPath(target.baseId, target.tableId, target.recordId, target.viewId), { replace, state: { obRecord: trail } satisfies TrailState });
    },
    [navigate, pathname, search, state],
  );

  const close = useCallback<RecordNavigation["close"]>(
    (fallback) => {
      const trail = trailOf(state);
      if (trail && trail.steps > 0) void navigate(-trail.steps);
      else void navigate(trail?.from ?? fallback, { replace: true });
    },
    [navigate, state],
  );

  const origin = useCallback<RecordNavigation["origin"]>((fallback) => trailOf(state)?.from ?? fallback, [state]);

  return { open, close, origin, order: trailOf(state)?.order };
}
