/** Addresses of share links and public forms. Both spellings of each route are served by the app. */
import type { ShareKind, ShareLink } from "@/api/types";

/** App path of the public page: `/share/<token>` for read-only views, `/form/<token>` for forms. */
export function publicPath(kind: ShareKind, token: string): string {
  return `${kind === "form" ? "/form/" : "/share/"}${encodeURIComponent(token)}`;
}

/**
 * The link to hand out: the server's configured public address (`OPENGRID_PUBLIC_URL`, which is
 * what `link.url` starts with) when it has one, else the address this page was opened on.
 */
export function publicLink(link: Pick<ShareLink, "kind" | "token" | "url">, pageOrigin: string): string {
  let origin = pageOrigin;
  try {
    origin = new URL(link.url).origin;
  } catch {
    /* a relative or missing url: use the page's own origin */
  }
  return `${origin}${publicPath(link.kind, link.token)}`;
}

/** Password rules of the server (`MIN_SHARE_PASSWORD`, `MAX_SHARE_PASSWORD`). */
export const SHARE_PASSWORD_MIN = 4;
export const SHARE_PASSWORD_MAX = 256;

export function sharePasswordProblem(password: string): string | null {
  const n = [...password].length;
  if (n < SHARE_PASSWORD_MIN) return `Use at least ${SHARE_PASSWORD_MIN} characters.`;
  if (n > SHARE_PASSWORD_MAX) return `Use at most ${SHARE_PASSWORD_MAX} characters.`;
  return null;
}
