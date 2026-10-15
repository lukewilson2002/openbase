import { Suspense, lazy, useEffect } from "react";
import { BrowserRouter, Link, Outlet, Route, Routes, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { setUnauthorizedHandler } from "@/api/client";
import { keys } from "@/api/keys";
import { RequireAdmin, RequireAuth } from "@/auth/guards";
import { BaseShell } from "@/base/BaseShell";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { HomePage } from "@/pages/HomePage";
import { WorkspacePage } from "@/pages/workspace/WorkspacePage";
import { IntroGate, IntroProvider } from "@/onboarding/IntroContext";
import { LoginPage } from "@/pages/LoginPage";
import { TwoFactorLoginPage } from "@/pages/TwoFactorLoginPage";
import { PageSpinner } from "@/components/ui/spinner";

// Rarely visited pages load on demand to keep the first paint small.
const AccountPage = lazy(() => import("@/pages/account/AccountPage").then((m) => ({ default: m.AccountPage })));
// The page an app's "connect" request lands on (opened by the server's /oauth/authorize).
const OAuthConsentPage = lazy(() => import("@/pages/oauth/OAuthConsentPage").then((m) => ({ default: m.OAuthConsentPage })));
const MembersPage = lazy(() => import("@/pages/workspace/MembersPage").then((m) => ({ default: m.MembersPage })));
const WorkspaceSettingsPage = lazy(() => import("@/pages/workspace/WorkspaceSettingsPage").then((m) => ({ default: m.WorkspaceSettingsPage })));
const TrashPage = lazy(() => import("@/pages/workspace/TrashPage").then((m) => ({ default: m.TrashPage })));
const AdminPage = lazy(() => import("@/pages/admin/AdminPage").then((m) => ({ default: m.AdminPage })));
// Pages a person meets once (first-run setup, sign-up, an invite, a password reset) stay out of the shell too.
const SetupPage = lazy(() => import("@/pages/SetupPage").then((m) => ({ default: m.SetupPage })));
const SignupPage = lazy(() => import("@/pages/SignupPage").then((m) => ({ default: m.SignupPage })));
const InvitePage = lazy(() => import("@/pages/InvitePage").then((m) => ({ default: m.InvitePage })));
const ForgotPasswordPage = lazy(() => import("@/pages/PasswordResetPages").then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import("@/pages/PasswordResetPages").then((m) => ({ default: m.ResetPasswordPage })));
// Dev-only harnesses for the mock API (`VITE_MOCK=1 npm run dev`); `import.meta.env.DEV` drops them from builds.
const DevSharePage = import.meta.env.DEV ? lazy(() => import("@/dev/DevSharePage")) : null;
// Public pages for people without an account: their own chunks, outside the app shell.
const PublicFormPage = lazy(() => import("@/public/form/PublicFormPage"));
const PublicSharePage = lazy(() => import("@/public/view/PublicSharePage"));

/** Routes without a router of their own (tests wrap this in a MemoryRouter). */
export function AppRoutes() {
  return (
    <IntroProvider>
      <Suspense fallback={<PageSpinner />}>
        <Routes>
          {/* Public links: no RequireAuth, no redirects. /s and /f are the paths the API reports. */}
          <Route path="/form/:token" element={<PublicFormPage />} />
          <Route path="/f/:token" element={<PublicFormPage />} />
          <Route path="/share/:token" element={<PublicSharePage />} />
          <Route path="/s/:token" element={<PublicSharePage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/login/2fa" element={<TwoFactorLoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          {/* The signed-in app: one RequireAuth and one IntroGate for every page in it. */}
          <Route element={<SignedInArea />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/workspace/:workspaceId" element={<WorkspacePage />} />
            <Route path="/workspace/:workspaceId/members" element={<MembersPage />} />
            <Route path="/workspace/:workspaceId/settings" element={<WorkspaceSettingsPage />} />
            <Route path="/trash" element={<TrashPage />} />
            {DevSharePage && import.meta.env.VITE_MOCK && <Route path="/__dev/share" element={<DevSharePage />} />}
            <Route path="/account" element={<AccountPage />} />
            <Route
              path="/admin"
              element={
                <RequireAdmin>
                  <AdminPage />
                </RequireAdmin>
              }
            />
            <Route path="/base/:baseId/automations/:automationId?/:tab?" element={<BaseShell section="automations" />} />
            <Route path="/base/:baseId/:tableId?/:viewId?" element={<BaseShell />} />
          </Route>
          {/*
            Behind the login like every app page (the login redirect brings the person back here), but
            outside SignedInArea: someone connecting an app mid-way should not meet the intro first.
          */}
          <Route
            path="/oauth/consent"
            element={
              <RequireAuth>
                <OAuthConsentPage />
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
    </IntroProvider>
  );
}

function SignedInArea() {
  return (
    <RequireAuth>
      <IntroGate />
      <Outlet />
    </RequireAuth>
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
