/**
 * Loads the definition of a public page (the form, or the shared view) and handles the password
 * gate: a protected link answers 401 until `X-Share-Password` is sent. The password lives only in
 * this hook's state (memory): it is never written to storage, the URL or the query cache, and a
 * reload asks for it again.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { describePublicError, type PublicProblem } from "@/lib/publicErrors";

export type LoadState<T> =
  | { status: "loading" }
  /** The link is protected; `invalid` after a wrong attempt. */
  | { status: "password"; invalid: boolean }
  | { status: "ready"; data: T }
  | { status: "problem"; problem: Exclude<PublicProblem, { kind: "password_required" } | { kind: "password_invalid" }> };

export interface PublicLoad<T> {
  state: LoadState<T>;
  /** The password the visitor entered, for the page's later requests (null for open links). */
  password: string | null;
  /** True while a password attempt is being checked. */
  checking: boolean;
  submitPassword(password: string): void;
  retry(): void;
}

export function usePublicLoad<T>(token: string, what: "form" | "view", load: (token: string, password: string | null, signal: AbortSignal) => Promise<T>): PublicLoad<T> {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [password, setPassword] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  // A wrong password must not stay around as "the" password for later requests.
  const [accepted, setAccepted] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setChecking(true);
    loadRef
      .current(token, password, ctl.signal)
      .then((data) => {
        setAccepted(password);
        setState({ status: "ready", data });
      })
      .catch((e: unknown) => {
        if (ctl.signal.aborted) return;
        const problem = describePublicError(e, what);
        if (problem.kind === "password_required") setState({ status: "password", invalid: false });
        else if (problem.kind === "password_invalid") setState({ status: "password", invalid: true });
        else setState({ status: "problem", problem });
      })
      .finally(() => {
        if (!ctl.signal.aborted) setChecking(false);
      });
    return () => ctl.abort();
  }, [token, what, password, attempt]);

  const submitPassword = useCallback((pw: string) => {
    setPassword(pw);
    setAttempt((n) => n + 1);
  }, []);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { state, password: accepted, checking, submitPassword, retry };
}
