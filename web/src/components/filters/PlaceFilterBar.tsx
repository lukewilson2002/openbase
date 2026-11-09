/**
 * The filter bar of the global pages (History and Trash, APP-9, APP-10): the same field as a collection's filter
 * bar, holding a chip for each place or person the page is narrowed to. There is no phrase parsing: what is typed
 * only narrows the list of things to pick from, and picking one adds its chip.
 */
import { useMemo, useState } from "react";
import type { WorkspaceSummary } from "@/api/types";
import { Avatar } from "@/components/ui/avatar";
import { ColorMark } from "@/components/ui/color-mark";
import { FilterBar, type FilterBarSuggestion } from "@/components/ui/filter-bar";
import { foldersOf, topLevelOf } from "@/lib/topLevel";

export type PlacePart = "workspace" | "base" | "table" | "user" | "kind";

export interface PlaceFilterValue {
  workspace: string | null;
  base: string | null;
  table: string | null;
  user: string | null;
  kind: string | null;
}

export interface PlacePerson {
  id: string;
  name: string;
  email: string;
}

export interface PlaceFilterBarProps {
  /** Which kinds of filter the page has, in the order the suggestions list them. */
  parts: readonly PlacePart[];
  workspaces: readonly WorkspaceSummary[];
  people?: readonly PlacePerson[];
  /** What the `kind` filter can be, as the page's own words. */
  kinds?: readonly { value: string; label: string }[];
  value: PlaceFilterValue;
  /** The parts that change; the others stay as they are. */
  onChange: (patch: Partial<PlaceFilterValue>) => void;
  /** Names for ids the lists do not hold (a person who left, a collection in a workspace not loaded). */
  fallbackNames?: Partial<Record<"base" | "table" | "user", string>>;
  label: string;
  placeholder: string;
}

const CATEGORY: Record<PlacePart, string> = { workspace: "Workspace", base: "Folder", table: "Collection", user: "Person", kind: "Kind" };

interface Option {
  part: PlacePart;
  id: string;
  name: string;
  /** Where it sits, shown quietly at the end of the row. */
  hint?: string;
  hue?: string | null;
  email?: string;
  /** The ids it implies: choosing a collection also names its folder and workspace. */
  implies?: Partial<PlaceFilterValue>;
}

const key = (part: PlacePart, id: string) => `${part}:${id}`;

export function PlaceFilterBar({ parts, workspaces, people = [], kinds = [], value, onChange, fallbackNames, label, placeholder }: PlaceFilterBarProps) {
  const [text, setText] = useState("");
  const options = useMemo(() => {
    const out: Option[] = [];
    const several = workspaces.length > 1;
    for (const ws of workspaces) {
      if (parts.includes("workspace")) out.push({ part: "workspace", id: ws.id, name: ws.name, hue: ws.color });
      const top = topLevelOf(ws);
      const places = [...(top ? [{ base: top, name: "Top level" }] : []), ...foldersOf(ws).map((base) => ({ base, name: base.name }))];
      for (const { base, name } of places) {
        const inWorkspace = several ? ws.name : undefined;
        if (parts.includes("base")) out.push({ part: "base", id: base.id, name, hint: inWorkspace, hue: base.color, implies: { workspace: ws.id, table: null } });
        if (parts.includes("table")) {
          for (const t of base.tables) {
            out.push({ part: "table", id: t.id, name: t.name, hint: [inWorkspace, name].filter(Boolean).join(" › "), hue: t.color, implies: { workspace: ws.id, base: base.id } });
          }
        }
      }
    }
    if (parts.includes("user")) for (const p of people) out.push({ part: "user", id: p.id, name: p.name, email: p.email });
    if (parts.includes("kind")) for (const k of kinds) out.push({ part: "kind", id: k.value, name: k.label });
    return out;
  }, [parts, workspaces, people, kinds]);

  const nameOf = (part: PlacePart, id: string): string => {
    const found = options.find((o) => o.part === part && o.id === id)?.name;
    if (found) return found;
    if (part === "workspace") return "This workspace";
    if (part === "kind") return id;
    if (part === "user") return fallbackNames?.user ?? "This person";
    return fallbackNames?.[part] ?? (part === "base" ? "This folder" : "This collection");
  };

  const chips = parts.flatMap((part) => {
    const id = value[part];
    return id ? [{ id: part, label: `${CATEGORY[part]}: ${nameOf(part, id)}` }] : [];
  });

  const suggestions: FilterBarSuggestion[] = useMemo(() => {
    const q = text.trim().toLowerCase();
    const open = options.filter((o) => value[o.part] !== o.id);
    // An empty field offers a few of each kind of filter, so there is something to pick; typing narrows to matches.
    const picked = q
      ? open
          .filter((o) => `${o.name} ${CATEGORY[o.part]}`.toLowerCase().includes(q))
          .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)))
          .slice(0, 8)
      : parts.flatMap((part) => open.filter((o) => o.part === part).slice(0, part === "kind" ? 5 : 2));
    return picked.map((o) => ({
      id: key(o.part, o.id),
      label: (
        <>
          <span className="text-muted">{CATEGORY[o.part]}:</span> {o.name}
        </>
      ),
      hint: o.hint,
      leading: o.part === "user" ? <Avatar name={o.name} email={o.email} size="sm" /> : o.hue !== undefined ? <ColorMark hue={o.hue} name={o.name} size={10} /> : undefined,
    }));
  }, [text, options, value, parts]);

  return (
    <FilterBar
      chips={chips}
      onRemoveChip={(id) => onChange({ [id]: null })}
      text={text}
      onTextChange={setText}
      suggestions={suggestions}
      onApplySuggestion={(s) => {
        const o = options.find((x) => key(x.part, x.id) === s.id);
        if (!o) return;
        const patch: Partial<PlaceFilterValue> = { [o.part]: o.id, ...o.implies };
        if (o.part === "workspace") {
          // A folder or collection chip from another workspace would leave nothing to show.
          for (const narrower of ["base", "table"] as const) {
            const held = value[narrower];
            if (held && options.find((x) => x.part === narrower && x.id === held)?.implies?.workspace !== o.id) patch[narrower] = null;
          }
        }
        onChange(patch);
        setText("");
      }}
      label={label}
      placeholder={placeholder}
    />
  );
}
