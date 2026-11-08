/**
 * Where drafts are kept (COL-5): on this device, in localStorage, one entry per person and view
 * (`ob-view-draft:<user>:<view>`), so a draft survives a reload and never reaches another person who
 * signs in on the same browser. Storage can be missing, full or blocked (a private window): every access
 * is guarded, and a draft that cannot be stored lasts as long as the page does.
 *
 * Drafts used to be two separate things, `ob-view-local` (layout settings of people who could not save) and
 * `ob-view-transient` (filter, sorts and groups). The first time a person's drafts are read, those entries
 * move into drafts and are deleted.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { ViewConfig } from "@/api/types";
import { useMe } from "@/auth/useAuth";
import { parseDraft, type ViewDraft } from "./draft";

const PREFIX = "ob-view-draft:";
const LEGACY_LOCAL = "ob-view-local:";
const LEGACY_TRANSIENT = "ob-view-transient:";
/** The settings the old local entries held. */
const LEGACY_LOCAL_KEYS = ["hidden_fields", "field_order", "field_widths", "frozen_columns", "row_height"] as const;

export function draftStorageKey(userId: string, viewId: string): string {
  return `${PREFIX}${userId}:${viewId}`;
}

/** Drafts storage refused to take, and drafts of a person whose id is not known yet. */
const unsaved = new Map<string, string | null>();
const listeners = new Set<() => void>();
const parsed = new Map<string, { raw: string | null; draft: ViewDraft | null }>();

function notify(): void {
  for (const l of listeners) l();
}

function readRaw(key: string): string | null {
  if (unsaved.has(key)) return unsaved.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, raw: string | null): void {
  try {
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
    unsaved.delete(key);
  } catch {
    unsaved.set(key, raw);
  }
}

function parseRaw(raw: string | null): ViewDraft | null {
  if (raw === null) return null;
  try {
    return parseDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The draft of `userId` for the view, or null. The same object comes back while the stored text is the same. */
export function readDraft(userId: string | null, viewId: string): ViewDraft | null {
  const key = userId ? draftStorageKey(userId, viewId) : `${PREFIX}-:${viewId}`;
  const raw = readRaw(key);
  const cached = parsed.get(key);
  if (cached && cached.raw === raw) return cached.draft;
  const draft = parseRaw(raw);
  parsed.set(key, { raw, draft });
  return draft;
}

/** Keeps `draft` (null removes it) for the person and view, and tells whoever shows it. */
export function writeDraft(userId: string | null, viewId: string, draft: ViewDraft | null): void {
  const key = userId ? draftStorageKey(userId, viewId) : `${PREFIX}-:${viewId}`;
  const raw = draft ? JSON.stringify(draft) : null;
  // Writing what is already there (a change undone and redone, an adopted draft that kept its settings) tells nobody.
  if (raw === readRaw(key)) return;
  writeRaw(key, raw);
  notify();
}

function onStorage(e: StorageEvent): void {
  // Another tab of the same person changed a draft (or the storage was cleared).
  if (e.key === null || e.key.startsWith(PREFIX)) {
    if (e.key) unsaved.delete(e.key);
    notify();
  }
}

export function subscribeDrafts(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

// ---- moving the old entries over ----

const migrated = new Set<string>();

/** Forgets what this page load knows about drafts: what storage refused, what was parsed, who was migrated (tests). */
export function resetDraftStore(): void {
  migrated.clear();
  unsaved.clear();
  parsed.clear();
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

/**
 * What the old `ob-view-local` and `ob-view-transient` entries of a view said, as draft settings. They are
 * kept whole rather than compared with the view's config (which is not at hand here): the draft takes the
 * view's fingerprint, and drops whatever equals the saved view, the first time it meets the view.
 */
export function legacyChanges(local: unknown, transient: unknown): Partial<ViewConfig> {
  const changes: Record<string, unknown> = {};
  if (isObject(local)) for (const k of LEGACY_LOCAL_KEYS) if (k in local) changes[k] = local[k];
  if (isObject(transient)) {
    // An override filter without items is "no filter".
    if ("filter" in transient) changes.filter = isObject(transient.filter) && Array.isArray(transient.filter.items) && transient.filter.items.length > 0 ? transient.filter : null;
    if (Array.isArray(transient.sorts)) changes.sorts = transient.sorts;
    if (Array.isArray(transient.groups)) changes.groups = transient.groups;
  }
  return changes as Partial<ViewConfig>;
}

/**
 * Moves the `ob-view-local` and `ob-view-transient` entries of this device into `userId`'s drafts and deletes
 * them. A draft the person already has wins over an old entry for the same view. Runs once per person and page
 * load; reading drafts calls it first.
 */
export function migrateLegacyDrafts(userId: string): void {
  if (migrated.has(userId)) return;
  migrated.add(userId);
  try {
    const names: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const name = localStorage.key(i);
      if (name && (name.startsWith(LEGACY_LOCAL) || name.startsWith(LEGACY_TRANSIENT))) names.push(name);
    }
    const views = new Set(names.map((n) => n.slice(n.startsWith(LEGACY_LOCAL) ? LEGACY_LOCAL.length : LEGACY_TRANSIENT.length)));
    for (const viewId of views) {
      const changes = legacyChanges(readJson(LEGACY_LOCAL + viewId), readJson(LEGACY_TRANSIENT + viewId));
      const draft = parseDraft({ v: 1, base: null, started: Date.now(), changes });
      if (draft && readRaw(draftStorageKey(userId, viewId)) === null) writeRaw(draftStorageKey(userId, viewId), JSON.stringify(draft));
      localStorage.removeItem(LEGACY_LOCAL + viewId);
      localStorage.removeItem(LEGACY_TRANSIENT + viewId);
    }
  } catch {
    /* storage blocked: there is nothing to move */
  }
}

// ---- hooks ----

/** The person whose drafts these are; null until they are known. */
export function useDraftUser(): string | null {
  return useMe().data?.id ?? null;
}

/** The signed-in person's draft of a view, kept up to date as it changes here and in other tabs. */
export function useViewDraft(viewId: string): ViewDraft | null {
  const userId = useDraftUser();
  const snapshot = useCallback(() => {
    if (userId) migrateLegacyDrafts(userId);
    return readDraft(userId, viewId);
  }, [userId, viewId]);
  return useSyncExternalStore(subscribeDrafts, snapshot, () => null);
}
