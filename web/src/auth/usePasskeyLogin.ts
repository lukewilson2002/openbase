import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError } from "@/api/client";
import { api } from "@/api/endpoints";
import type { LoginResponse, SetupStatus, User } from "@/api/types";
import { atPublicAddress, classifyWebAuthnError, conditionalMediationSupported, getPasskey, passkeysSupported } from "@/lib/webauthn";

/** One passkey sign-in: a challenge from the server, the browser's prompt, the server's verdict. */
async function signInWithPasskey(opts: { mediation?: CredentialMediationRequirement; signal?: AbortSignal }): Promise<LoginResponse | null> {
  const challenge = await api.auth.passkeyLoginStart();
  const credential = await getPasskey(challenge.options, opts);
  if (!credential) return null;
  return api.auth.passkeyLoginFinish({ challenge_id: challenge.challenge_id, credential });
}

/** What to say about a failed passkey sign-in; `null` for the person simply closing the prompt. */
export function passkeyLoginProblem(error: unknown): string | null {
  if (error instanceof ApiError) return error.message;
  const failure = classifyWebAuthnError(error);
  return failure.kind === "cancelled" ? null : failure.message;
}

export interface PasskeyLogin {
  /** The login page should offer the "Sign in with a passkey" button. */
  available: boolean;
  /** The server has passkeys on but this browser cannot use them: say so. */
  unsupported: boolean;
  /** Passkeys also appear in the autofill list of the email field (`autocomplete="username webauthn"`). */
  conditional: boolean;
  /** The button's action; `pending` while the browser prompt or the server is busy. */
  signIn: () => void;
  pending: boolean;
  /** A message for a failed attempt, if there is one to show. */
  problem: string | null;
}

/**
 * Passkey sign-in for the login page. Two ways in, one result: the button opens the browser's
 * passkey dialog; where the browser supports conditional mediation a second request waits in the
 * background and offers the passkeys in the email field's autofill list. Starting the button flow
 * cancels the waiting request (a page can have only one).
 */
export function usePasskeyLogin(setup: SetupStatus | undefined, onSignedIn: (user: User) => void): PasskeyLogin {
  const supported = passkeysSupported();
  const available = !!setup?.passkeys_enabled && supported && atPublicAddress(setup.public_url);
  const [conditional, setConditional] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const waiting = useRef<AbortController | null>(null);
  const done = useRef(onSignedIn);
  done.current = onSignedIn;

  const finish = useCallback((res: LoginResponse | null) => {
    if (res?.user) done.current(res.user);
  }, []);

  const modal = useMutation({
    mutationFn: () => {
      waiting.current?.abort();
      return signInWithPasskey({});
    },
    onMutate: () => setProblem(null),
    onSuccess: finish,
    onError: (e) => setProblem(passkeyLoginProblem(e)),
  });

  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    let live = true;
    void (async () => {
      if (!(await conditionalMediationSupported()) || !live) return;
      setConditional(true);
      waiting.current = controller;
      try {
        const res = await signInWithPasskey({ mediation: "conditional", signal: controller.signal });
        if (live) finish(res);
      } catch (e) {
        // Aborted (the button was used, or the page closed) or dismissed: nothing to report.
        if (live && !controller.signal.aborted) setProblem(passkeyLoginProblem(e));
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [available, finish]);

  return {
    available,
    unsupported: !!setup?.passkeys_enabled && !supported,
    conditional,
    signIn: () => modal.mutate(),
    pending: modal.isPending,
    problem,
  };
}
