import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { SetupStatus, User } from "@/api/types";

/** Current user: `undefined` while loading, `null` when signed out. */
export function useMe() {
  return useQuery<User | null>({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        return await api.auth.me();
      } catch (e) {
        if (isApiError(e) && e.isUnauthorized) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useSetupStatus() {
  return useQuery<SetupStatus>({ queryKey: keys.setup, queryFn: api.setup.status, staleTime: 60_000, retry: false });
}

/** Store the signed-in user in the cache (after login/signup/2FA). */
export function useSetUser() {
  const qc = useQueryClient();
  return useCallback(
    (user: User | null) => {
      qc.setQueryData(keys.me, user);
      // Anything cached before sign-in belongs to nobody (or somebody else).
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" && q.queryKey[0] !== "setup" });
    },
    [qc],
  );
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.auth.logout,
    onSettled: () => {
      qc.clear();
      qc.setQueryData(keys.me, null);
    },
  });
}
