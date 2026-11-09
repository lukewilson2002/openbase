/**
 * Where undo histories live while a folder is being worked in. A record opens as a page (a route of its own), so
 * the collection screen that did the work unmounts behind it; a history kept inside the screen would be gone by
 * the time Escape brings the person back, and Ctrl/Cmd+Z would have nothing to revert. A history is kept here
 * instead, by folder, and lives as long as some screen of that folder (a collection or a record page) is showing.
 * Leaving the folder for good lets it go, so an edit from last week is never what Ctrl+Z reverts.
 */
import { useEffect } from "react";
import { UndoStack } from "./stack";

interface Scope {
  stacks: Map<string, UndoStack<never>>;
  holders: number;
}

const scopes = new Map<string, Scope>();

function scopeOf(scopeId: string): Scope {
  let scope = scopes.get(scopeId);
  if (!scope) scopes.set(scopeId, (scope = { stacks: new Map(), holders: 0 }));
  return scope;
}

/** The history called `name` in a folder: the same one for every screen that asks, until the folder is left. */
export function undoStackIn<Op>(scopeId: string, name: string): UndoStack<Op> {
  const scope = scopeOf(scopeId);
  let stack = scope.stacks.get(name);
  if (!stack) scope.stacks.set(name, (stack = new UndoStack<never>()));
  return stack as unknown as UndoStack<Op>;
}

/**
 * Keeps a folder's histories while the caller is mounted. Going from a collection to a record page unmounts one
 * holder and mounts the other in the same commit, so the release waits a tick and lets go only when nobody has
 * taken over.
 */
export function useUndoScope(scopeId: string): void {
  useEffect(() => {
    const scope = scopeOf(scopeId);
    scope.holders++;
    return () => {
      scope.holders--;
      setTimeout(() => {
        if (scope.holders === 0 && scopes.get(scopeId) === scope) scopes.delete(scopeId);
      }, 0);
    };
  }, [scopeId]);
}
