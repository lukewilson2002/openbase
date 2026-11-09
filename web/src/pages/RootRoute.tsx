/**
 * `/`: opens the last workspace's Home (the one used last on this device while the person still belongs
 * to it, else their first). Someone without any workspace, which only happens before the first one is
 * made, gets the first-run page that makes it.
 */
import { useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { ColorField } from "@/components/ColorField";
import { COLORS } from "@/lib/colors";
import { Notice } from "@/components/layouts";
import { Button } from "@/components/ui/button";
import { ColorMark } from "@/components/ui/color-mark";
import { Field, Input } from "@/components/ui/input";
import { PageSpinner } from "@/components/ui/spinner";
import { HomeShell, useCreateWorkspace } from "@/shell/HomeShell";
import { workspaceToOpen } from "./workspace/lastWorkspace";

export function RootRoute() {
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list });
  if (workspaces.isPending) return <PageSpinner label="Loading workspaces" />;
  if (workspaces.isError)
    return (
      <HomeShell variant="tab">
        <div className="p-6">
          <Notice tone="error">{errorMessage(workspaces.error)}</Notice>
        </div>
      </HomeShell>
    );
  const target = workspaceToOpen(workspaces.data);
  if (target) return <Navigate to={`/workspace/${target.id}`} replace />;
  return (
    <HomeShell variant="tab">
      <FirstWorkspace />
    </HomeShell>
  );
}

function FirstWorkspace() {
  const [name, setName] = useState("");
  // Starts on the first hue, so the mark beside the name is the color the workspace is made with.
  const [color, setColor] = useState<string>(COLORS[0]);
  const create = useCreateWorkspace();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed) create.mutate({ name: trimmed, color });
  };

  return (
    <div className="flex justify-center px-4 py-8 md:px-10 md:py-12">
      <section aria-labelledby="first-workspace-title" className="flex w-full max-w-[32.5rem] flex-col gap-5 md:pt-10">
        <div>
          <h1 id="first-workspace-title" className="mb-2 text-home">
            Create your first workspace
          </h1>
          <p className="text-read text-muted">A workspace is a separate place with its own collections and its own people. Name it and pick a color.</p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Workspace name">
            {(ctl) => (
              <div className="flex items-center gap-3">
                {/* Shows the color the workspace will have, beside the name it will carry. */}
                <ColorMark hue={color} size={28} />
                <Input {...ctl} value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Personal" maxLength={255} autoFocus required className="h-control-lg min-w-0 flex-1 max-md:h-control-touch" />
              </div>
            )}
          </Field>
          <ColorField value={color} onChange={setColor} />
          {create.isError && <Notice tone="error">{errorMessage(create.error)}</Notice>}
          <Button type="submit" variant="primary" size="lg" className="w-full md:w-auto md:self-start" loading={create.isPending} disabled={!name.trim()}>
            Create workspace
          </Button>
        </form>
        <p className="text-label text-muted">Workspaces are private until you invite someone.</p>
      </section>
    </div>
  );
}
