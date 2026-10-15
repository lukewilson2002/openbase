/**
 * `/`: back to the workspace opened last (or the first one). Someone without any workspace, which
 * only happens before the first one is made, gets the page that makes it.
 */
import { useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { LayoutGrid, Lock } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { HomeShell, useCreateWorkspace } from "@/shell/HomeShell";
import { readLastWorkspace } from "./workspace/lastWorkspace";

const SUGGESTIONS = ["Personal", "Household", "Side business", "Team"];

export function HomePage() {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  if (workspaces.isSuccess && workspaces.data.length > 0) {
    const last = readLastWorkspace();
    const target = workspaces.data.find((w) => w.id === last) ?? workspaces.data[0]!;
    return <Navigate to={`/workspace/${target.id}`} replace />;
  }
  return (
    <HomeShell>
      {workspaces.isPending ? (
        <PageSpinner label="Loading workspaces" />
      ) : workspaces.isError ? (
        <div className="p-6">
          <Notice tone="error">{errorMessage(workspaces.error)}</Notice>
        </div>
      ) : (
        <FirstWorkspace />
      )}
    </HomeShell>
  );
}

function FirstWorkspace() {
  const [name, setName] = useState("");
  const create = useCreateWorkspace();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed) create.mutate({ name: trimmed });
  };

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center px-4 py-12 text-center sm:py-20">
      <span aria-hidden className="flex size-14 items-center justify-center rounded-2xl bg-primary-soft text-primary">
        <LayoutGrid className="size-7" />
      </span>
      <h1 className="mt-5 text-2xl">Create your first workspace</h1>
      <p className="mt-2 text-[0.9375rem] text-muted">A workspace is a separate place with its own bases and its own people. Name it after what goes inside.</p>
      <form onSubmit={submit} className="mt-8 w-full text-left">
        <label htmlFor="first-workspace-name" className="text-[0.8125rem] font-medium">
          Workspace name
        </label>
        <div className="mt-1 flex flex-col gap-2 min-[420px]:flex-row">
          <Input id="first-workspace-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} autoFocus required className="h-10 min-w-0 flex-1" />
          <Button type="submit" variant="primary" size="lg" loading={create.isPending} disabled={!name.trim()}>
            Create workspace
          </Button>
        </div>
        <div role="group" aria-label="Suggestions" className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setName(s)}
              aria-pressed={name === s}
              className="h-8 rounded-full border border-line-strong bg-surface px-3 text-[0.8125rem] text-fg transition-colors hover:bg-hover aria-pressed:border-primary aria-pressed:bg-primary-soft pointer-coarse:h-10"
            >
              {s}
            </button>
          ))}
        </div>
        {create.isError && (
          <div className="mt-3">
            <Notice tone="error">{errorMessage(create.error)}</Notice>
          </div>
        )}
      </form>
      <p className="mt-8 text-[0.8125rem] text-muted">
        <Lock aria-hidden className="-mt-0.5 mr-1.5 inline size-3.5" />
        Only you can see it until you invite someone.
      </p>
    </div>
  );
}
