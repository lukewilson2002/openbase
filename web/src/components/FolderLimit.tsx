import { useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/api/client";
import { api } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { Notice } from "@/components/layouts";
import { Checkbox } from "@/components/ui/checkbox";
import { ColorMark } from "@/components/ui/color-mark";
import { Field, Select } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export interface FolderLimitProps {
  limited: boolean;
  onLimitedChange: (limited: boolean) => void;
  baseIds: readonly string[];
  onBaseIdsChange: (ids: string[]) => void;
  /** What a limit costs, said under the list ("cannot have Full control"), when it costs anything. */
  note?: string;
}

/**
 * "All folders I can access" or "Only the folders I select", with the folders to pick from (every folder of
 * every workspace, each beside its color mark). The names say what the API calls a base; the person sees folders.
 * Shared by the consent screen and a new API token.
 */
export function FolderLimit({ limited, onLimitedChange, baseIds, onBaseIdsChange, note }: FolderLimitProps) {
  // Only needed (and only fetched) when the choice is limited to some folders.
  const workspaces = useQuery({ queryKey: keys.workspaces, queryFn: api.workspaces.list, enabled: limited });
  return (
    <>
      <Field label="Folders">
        {(ctl) => (
          <Select
            {...ctl}
            value={limited ? "some" : "all"}
            onChange={(e) => {
              onLimitedChange(e.target.value === "some");
              if (e.target.value !== "some") onBaseIdsChange([]);
            }}
          >
            <option value="all">All folders I can access</option>
            <option value="some">Only the folders I select</option>
          </Select>
        )}
      </Field>
      {limited && (
        <div className="flex flex-col gap-1" role="group" aria-label="Allowed folders">
          {workspaces.isPending ? (
            <Spinner />
          ) : workspaces.isError ? (
            <Notice tone="error">{errorMessage(workspaces.error)}</Notice>
          ) : workspaces.data.every((w) => w.bases.length === 0) ? (
            <p className="text-label text-muted">You have no folders yet.</p>
          ) : (
            workspaces.data.flatMap((w) =>
              w.bases.map((b) => (
                <Checkbox
                  key={b.id}
                  checked={baseIds.includes(b.id)}
                  onCheckedChange={(on) => onBaseIdsChange(on ? [...baseIds, b.id] : baseIds.filter((x) => x !== b.id))}
                  label={
                    <span className="inline-flex items-center gap-2">
                      <ColorMark hue={b.color} name={b.name} size={14} />
                      {`${w.name} / ${b.is_top_level ? "Top level" : b.name}`}
                    </span>
                  }
                />
              )),
            )
          )}
          {note && <p className="text-meta text-muted">{note}</p>}
        </div>
      )}
    </>
  );
}
