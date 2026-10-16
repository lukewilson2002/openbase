import { Suspense, createContext, lazy, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { User } from "@/api/types";
import { useMe } from "@/auth/useAuth";

// Seen once per account, so it stays out of the main bundle.
const IntroOverlay = lazy(() => import("./IntroOverlay").then((m) => ({ default: m.IntroOverlay })));

export interface IntroApi {
  /** Show the intro again (from the profile menu). Works whatever the account's `intro_seen` says. */
  openIntro: () => void;
}

interface IntroState extends IntroApi {
  replaying: boolean;
  finish: () => void;
}

const IntroContext = createContext<IntroState | null>(null);

/**
 * Owns the intro for the whole route tree. It does not read the signed-in user itself: it wraps
 * the public share and form pages too, and those must not ask the server who is signed in.
 */
export function IntroProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [replaying, setReplaying] = useState(false);

  const finish = useCallback(() => {
    setReplaying(false);
    const me = qc.getQueryData<User | null>(keys.me);
    if (!me || me.intro_seen !== false) return;
    // Hide it at once rather than after the round trip: the person asked to move on.
    const seen: User = { ...me, intro_seen: true };
    qc.setQueryData(keys.me, seen);
    api.auth.updateMe({ intro_seen: true }).then(
      (user) => qc.setQueryData(keys.me, user),
      // A failed save only means the intro comes back on the next visit; an error message in the
      // person's first minute would be worse than that.
      () => undefined,
    );
  }, [qc]);

  const value = useMemo<IntroState>(() => ({ openIntro: () => setReplaying(true), replaying, finish }), [replaying, finish]);

  return (
    <IntroContext.Provider value={value}>
      {children}
      {replaying && (
        <Suspense fallback={null}>
          <IntroOverlay onFinish={finish} />
        </Suspense>
      )}
    </IntroContext.Provider>
  );
}

function useIntroState(): IntroState {
  const ctx = useContext(IntroContext);
  if (!ctx) throw new Error("useIntro() needs an <IntroProvider> above it (AppRoutes provides one).");
  return ctx;
}

/** `openIntro()` replays the intro. */
export function useIntro(): IntroApi {
  const { openIntro } = useIntroState();
  return { openIntro };
}

/**
 * Shows the intro to a signed-in person who has not seen it yet. Mounted once, inside the
 * signed-in area of the routes, so sign-in, setup and public pages never show it.
 */
export function IntroGate() {
  const { replaying, finish } = useIntroState();
  const { data: me } = useMe();
  if (me?.intro_seen !== false || replaying) return null;
  return (
    <Suspense fallback={null}>
      <IntroOverlay onFinish={finish} />
    </Suspense>
  );
}
