/**
 * A shared List view: the signed-in List's own outline (`ListOutline`), told it only shows. Folding a group is the
 * visitor's own and nothing is saved. A row has no page to open here, so it does nothing when chosen.
 */
import { useState } from "react";
import type { Field, GroupHeader, TableRecord } from "@/api/types";
import { ListOutline } from "@/views/list/ListOutline";
import { useShare } from "./ShareContext";
import type { SharedFields } from "./publicFields";

const NO_EMAILS: ReadonlyMap<string, string> = new Map();
const noop = () => {};

export interface PublicListProps {
  fields: SharedFields;
  records: readonly TableRecord[];
  groups: readonly GroupHeader[];
  colors: Readonly<Record<string, string>>;
  descriptionField?: Field;
}

export function PublicList({ fields, records, groups, colors, descriptionField }: PublicListProps) {
  const { format } = useShare();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const beside = fields.list.filter((f) => f.id !== fields.title?.id && f.id !== descriptionField?.id);
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <ListOutline
        records={records}
        groups={groups}
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
