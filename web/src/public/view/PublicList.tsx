/**
 * A shared List view: the signed-in List's own outline (`ListOutline`), told it only shows. Folding a group is the
 * visitor's own and nothing is saved. A row has no page to open here, so it does nothing when chosen.
 */
import { useMemo, useState } from "react";
import type { Field, GroupHeader, TableRecord } from "@/api/types";
import { ListOutline } from "@/views/list/ListOutline";
import { useShare } from "./ShareContext";
import type { SharedFields } from "./publicFields";

const NO_EMAILS: ReadonlyMap<string, string> = new Map();
const noop = () => {};

/**
 * The group headers that fall inside the records loaded. The server numbers them over the whole result; when only its first
 * records are here (a share with more than the cap), a group that runs past them is cut where the records end, and groups that
 * start after are left out, so no group waits for rows that will never come.
 */
export function groupsWithin(groups: readonly GroupHeader[], loaded: number): GroupHeader[] {
  return groups.filter((g) => g.start < loaded).map((g) => (g.start + g.count > loaded ? { ...g, count: loaded - g.start } : g));
}

export interface PublicListProps {
  fields: SharedFields;
  /** The shared view's records from its first, all in one list: each group header's `start` is an index into it. */
  records: readonly TableRecord[];
  groups: readonly GroupHeader[];
  colors: Readonly<Record<string, string>>;
  descriptionField?: Field;
}

export function PublicList({ fields, records, groups, colors, descriptionField }: PublicListProps) {
  const { format } = useShare();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const inside = useMemo(() => groupsWithin(groups, records.length), [groups, records.length]);
  const beside = fields.list.filter((f) => f.id !== fields.title?.id && f.id !== descriptionField?.id);
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <ListOutline
        records={records}
        groups={inside}
        primary={fields.title}
        fields={beside}
        descriptionField={descriptionField}
        tableFields={fields.list}
        format={format}
        emails={NO_EMAILS}
        colors={colors}
        collapsed={collapsed}
        canEdit={false}
        onToggle={(path) => setCollapsed((cur) => (cur.has(path) ? new Set([...cur].filter((p) => p !== path)) : new Set([...cur, path])))}
        onOpen={noop}
        onAdd={noop}
        newLabel=""
      />
    </div>
  );
}
