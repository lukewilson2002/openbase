import { useEffect } from "react";
import { PageSpinner } from "@/components/ui/spinner";
import { followRedirect } from "@/lib/oauthAccess";

/** Leaves the web app for a page the server answers itself (a full page load, not a route change). */
export function ServerRedirect({ to }: { to: string }) {
  useEffect(() => {
    followRedirect(to);
  }, [to]);
  return <PageSpinner label="Continuing" />;
}
