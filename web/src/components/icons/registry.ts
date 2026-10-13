/**
 * Lazy access to the full Lucide set (~1,900 icons, a chunk of its own).
 *
 * Nothing here imports the set statically: `loadFullIconSet()` does a dynamic `import()` the first
 * time the picker opens or an icon outside the bundled popular 20 has to be drawn, then keeps the
 * result for the rest of the session. `<EntityIcon>` and the picker subscribe to the load.
 */
import type { IconNode } from "lucide-react";

export interface FullIconSet {
  /** Canonical kebab-case names in alphabetical order. */
  names: readonly string[];
  /** Drawing data by name; also answers to every alias ("home" for "house"). */
  nodes: ReadonlyMap<string, IconNode>;
  /** Canonical name -> its aliases (for search). */
  aliases: ReadonlyMap<string, readonly string[]>;
}

type Importer = () => Promise<{ fullIconSet: FullIconSet }>;
const defaultImporter: Importer = () => import("./fullSet");
let importer: Importer = defaultImporter;

let loaded: FullIconSet | null = null;
let pending: Promise<FullIconSet> | null = null;
let failedAt = 0;
const listeners = new Set<() => void>();

/** How long after a failed load `<EntityIcon>` waits before asking again. */
const RETRY_AFTER_MS = 15_000;

export function peekFullIconSet(): FullIconSet | null {
  return loaded;
}

export function subscribeIconSet(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Load (once) and return the full set. Rejects if the chunk cannot be fetched; a later call retries. */
export function loadFullIconSet(): Promise<FullIconSet> {
  if (loaded) return Promise.resolve(loaded);
  pending ??= importer().then(
    (m) => {
      loaded = m.fullIconSet;
      listeners.forEach((l) => l());
      return loaded;
    },
    (e: unknown) => {
      pending = null;
      failedAt = Date.now();
      throw e;
    },
  );
  return pending;
}

/** Fire-and-forget load for components that only need the set to draw an icon; failures are swallowed. */
export function requestFullIconSet(): void {
  if (loaded || pending) return;
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return;
  loadFullIconSet().catch(() => {});
}

/** Test hook: forget the cached set, and optionally replace the dynamic import (to gate or fake the load). */
export function resetIconRegistryForTests(replaceImporter?: Importer): void {
  importer = replaceImporter ?? defaultImporter;
  loaded = null;
  pending = null;
  failedAt = 0;
  listeners.forEach((l) => l());
}
