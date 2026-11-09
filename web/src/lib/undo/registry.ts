/**
 * Where undo histories live while a folder is being worked in. A record opens as a page (a route of its own), so
 * the collection screen that did the work unmounts behind it; a history kept inside the screen would be gone by
 * the time Escape brings the person back, and Ctrl/Cmd+Z would have nothing to revert. A history is kept here
 * instead, by folder, for as long as the person stays in that folder's screens (its collections and record pages).
 * Going anywhere else lets it go, so an edit from last week is never what Ctrl+Z reverts. The router tells
 * where the person is (`useForgetUndoOutsideFolder`), not the screens' mounting: a record page can be a lazily
 * loaded chunk away from the screen it replaces.
 */
import { useEffect } from "react";
import { useLocation } from "react-router";
import { UndoStack } from "./stack";

const scopes = new Map<string, Map<string, UndoStack<never>>>();

/** The history called `name` in a folder: the same one for every screen that asks, until the folder is left. */
export function undoStackIn<Op>(baseId: string, name: string): UndoStack<Op> {
  let stacks = scopes.get(baseId);
  if (!stacks) scopes.set(baseId, (stacks = new Map()));
  let stack = stacks.get(name);
  if (!stack) stacks.set(name, (stack = new UndoStack<never>()));
  return stack as unknown as UndoStack<Op>;
}

/** Lets go of every folder's histories but `keep`'s. */
export function forgetUndoHistories(keep?: string | null): void {
  for (const id of [...scopes.keys()]) if (id !== keep) scopes.delete(id);
}

/** The folder an address is a screen of (`/base/:baseId/...`), if it is one. */
export function folderOf(pathname: string): string | null {
  return /^\/base\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

/** Mount once inside the router: the histories of a folder go when the person leaves its screens. */
export function useForgetUndoOutsideFolder(): void {
  const { pathname } = useLocation();
  useEffect(() => forgetUndoHistories(folderOf(pathname)), [pathname]);
}
