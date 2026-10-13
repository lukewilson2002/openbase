import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { PageSpinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ShieldAlert } from "lucide-react";
import { useMe } from "./useAuth";

/** Renders children only for a signed-in user; otherwise sends the visitor to /login. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: user, isPending, isError, error } = useMe();
  const location = useLocation();
  if (isPending) return <PageSpinner label="Loading your account" />;
  if (isError) {
    return (
      <EmptyState title="Cannot reach OpenBase" description={error instanceof Error ? error.message : "Try again in a moment."} />
    );
  }
  if (!user) {
    const next = location.pathname + location.search;
    return <Navigate to={next && next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login"} replace />;
  }
  return <>{children}</>;
}

/** Instance administrators only (the server enforces this too). */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { data: user } = useMe();
  if (!user?.is_admin) {
    return <EmptyState icon={<ShieldAlert />} title="Administrators only" description="You need administrator access to view this page." />;
  }
  return <>{children}</>;
}
