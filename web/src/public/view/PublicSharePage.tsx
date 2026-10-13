/**
 * `/share/:token` (and `/s/:token`): a read-only shared view. No account, no app shell, no
 * redirect to the login page. Loads `GET /api/public/shares/{token}` (asking for the password
 * when the link has one, kept in memory), then the records through
 * `POST /api/public/shares/{token}/query`. Only the fields the view shows ever reach the page.
 */
import { useParams } from "react-router";
import type { PublicView } from "@/api/types";
import { publicApi } from "@/api/sharing";
import { EntityLabel } from "@/components/icons/EntityIcon";
import { PasswordPrompt, PublicLoading, PublicProblemScreen, PublicShell } from "../PublicShell";
import { usePublicLoad } from "../usePublicLoad";
import { SharedView } from "./SharedView";

export default function PublicSharePage() {
  const { token = "" } = useParams();
  const load = usePublicLoad<PublicView>(token, "view", (t, password, signal) => publicApi.view(t, password, signal));
  const { state } = load;
  if (state.status === "loading") return <PublicLoading />;
  if (state.status === "password") return <PasswordPrompt what="page" invalid={state.invalid} checking={load.checking} onSubmit={load.submitPassword} />;
  if (state.status === "problem") return <PublicProblemScreen problem={state.problem} onRetry={load.retry} />;
  const view = state.data;
  return (
    <PublicShell
      title={view.name}
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          <EntityLabel icon={view.table_icon}>{view.table_name}</EntityLabel> <span aria-hidden>·</span> <EntityLabel icon={view.base_icon}>{view.base_name}</EntityLabel> <span aria-hidden>·</span> <span>read-only</span>
        </span>
      }
      wide
    >
      <SharedView token={token} password={load.password} view={view} />
    </PublicShell>
  );
}
