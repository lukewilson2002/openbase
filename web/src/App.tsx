import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Link, Route, Routes, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { setUnauthorizedHandler } from "@/api/client";
import { keys } from "@/api/keys";
import { RequireAdmin, RequireAuth } from "@/auth/guards";
import { BaseShell } from "@/base/BaseShell";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { HomePage } from "@/pages/HomePage";
import { InvitePage } from "@/pages/InvitePage";
import { LoginPage } from "@/pages/LoginPage";
import { ForgotPasswordPage, ResetPasswordPage } from "@/pages/PasswordResetPages";
import { SetupPage } from "@/pages/SetupPage";
import { SignupPage } from "@/pages/SignupPage";
import { TwoFactorLoginPage } from "@/pages/TwoFactorLoginPage";
import { PageSpinner } from "@/components/ui/spinner";

// Rarely visited pages load on demand to keep the first paint small.
const AccountPage = lazy(() => import("@/pages/account/AccountPage").then((m) => ({ default: m.AccountPage })));
const AdminPage = lazy(() => import("@/pages/admin/AdminPage").then((m) => ({ default: m.AdminPage })));

/** Routes without a router of their own (tests wrap this in a MemoryRouter). */
export function AppRoutes() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/login/2fa" element={<TwoFactorLoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <HomePage />
            </RequireAuth>
          }
        />
        <Route
          path="/account"
          element={
            <RequireAuth>
              <AccountPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin"
          element={
            <RequireAuth>
              <RequireAdmin>
                <AdminPage />
              </RequireAdmin>
            </RequireAuth>
          }
        />
        <Route
          path="/base/:baseId/:tableId?/:viewId?"
          element={
            <RequireAuth>
              <BaseShell />
            </RequireAuth>
          }
        />
        <Route
          path="*"
          element={
            <EmptyState
              title="Page not found"
              description="That address does not exist."
              action={
                <Button asChild variant="primary">
                  <Link to="/">Go home</Link>
                </Button>
              }
              className="min-h-dvh justify-center"
            />
          }
        />
      </Routes>
    </Suspense>
  );
}

/** Sends API 401s through the router (clearing the cached user) instead of a full page load. */
function UnauthorizedBridge() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    setUnauthorizedHandler((returnTo) => {
      qc.setQueryData(keys.me, null);
      navigate(returnTo && returnTo !== "/" ? `/login?next=${encodeURIComponent(returnTo)}` : "/login", { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate, qc]);
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <UnauthorizedBridge />
      <AppRoutes />
    </BrowserRouter>
  );
}
