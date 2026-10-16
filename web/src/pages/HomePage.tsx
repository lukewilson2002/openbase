/**
 * `/`: back to the workspace opened last (or the first one). Someone without any workspace, which
 * only happens before the first one is made, gets the page that makes it.
 */
import { useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { SquarePlus } from "lucide-react";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { HomeShell, useCreateWorkspace } from "@/shell/HomeShell";
import { readLastWorkspace } from "./workspace/lastWorkspace";

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
    <div className="flex justify-center px-4 py-8 sm:px-6 sm:py-12">
      <section aria-labelledby="first-workspace-title" className="flex w-full max-w-[520px] flex-col gap-[22px] sm:pt-10">
        <span aria-hidden className="flex size-14 items-center justify-center rounded-2xl bg-primary-soft text-primary">
          <SquarePlus className="size-7" strokeWidth={1.8} />
        </span>
        <div>
          <h1 id="first-workspace-title" className="mb-2 text-[1.75rem] leading-tight tracking-[-0.015em]">
            Create your first workspace
          </h1>
          <p className="text-base leading-relaxed text-muted">A workspace is a separate place with its own bases and its own people.</p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-2">
          <label htmlFor="first-workspace-name" className="text-sm font-semibold">
            Workspace name
          </label>
          <div className="flex flex-wrap gap-2.5">
            <Input
              id="first-workspace-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="For example, Personal"
              maxLength={255}
              autoFocus
              required
              className="h-[46px] min-w-0 flex-[1_1_240px] rounded-[10px] px-3.5 text-base"
            />
            <Button type="submit" variant="primary" size="lg" className="h-[46px] rounded-[10px] px-5 font-semibold max-[420px]:w-full" loading={create.isPending} disabled={!name.trim()}>
              Create workspace
            </Button>
          </div>
          {create.isError && <Notice tone="error">{errorMessage(create.error)}</Notice>}
        </form>
        <p className="text-sm text-muted">Workspaces are private until you invite someone.</p>
      </section>
    </div>
  );
}
