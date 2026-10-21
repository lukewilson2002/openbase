import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { User } from "@/api/types";
import { useToastIfAny } from "@/components/ui/toast";
import { DEFAULT_ACCENT, isAccent, type Accent } from "./accents";
import { useTheme } from "./ThemeProvider";

/** The account's accent colour; unset or unknown is the default. */
export function accountAccent(user: Pick<User, "accent">): Accent {
  return isAccent(user.accent) ? user.accent : DEFAULT_ACCENT;
}

/**
 * The accent colour and a setter that paints it at once and saves it on the account, so it
 * follows the person to their other devices. A failed save says so and goes back to the
 * account's colour.
 */
export function useAccent(): { accent: Accent; setAccent: (accent: Accent) => void } {
  const { accent, setAccent: paint } = useTheme();
  const qc = useQueryClient();
  const toast = useToastIfAny();
  const setAccent = useCallback(
    (next: Accent) => {
      const before = qc.getQueryData<User | null>(keys.me);
      paint(next);
      if (!before) return;
      qc.setQueryData<User>(keys.me, { ...before, accent: next === DEFAULT_ACCENT ? null : next });
      api.auth.updateMe({ accent: next === DEFAULT_ACCENT ? "" : next }).then(
        (user) => qc.setQueryData(keys.me, user),
        (e: unknown) => {
          qc.setQueryData(keys.me, before);
          paint(accountAccent(before));
          toast?.error(e, "Could not save the colour");
        },
      );
    },
    [qc, paint, toast],
  );
  return { accent, setAccent };
}

/** Paints the signed-in account's accent colour on this device whenever the profile brings one. */
export function useAccountAccent(user: User | null | undefined): void {
  const { setAccent } = useTheme();
  const accent = user ? accountAccent(user) : null;
  useEffect(() => {
    if (accent) setAccent(accent);
  }, [accent, setAccent]);
}
