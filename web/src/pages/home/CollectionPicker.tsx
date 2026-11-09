/**
 * The "Goes to" chip and its searchable list (HOME-3): the collections the person can add to whose title is text, and
 * Inbox, which keeps a draft to file later. It is a popover on a desktop and a sheet on a phone.
 */
import { useId, useMemo, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { CaptureChip } from "@/components/ui/capture-chip";
import { ColorMark } from "@/components/ui/color-mark";
import { Icon } from "@/components/ui/icon";
import { ListboxOption, useListNav } from "@/components/ui/listbox";
import { Spinner } from "@/components/ui/spinner";
import { PickerShell } from "./PickerShell";
import { sameChoice, type CollectionOption, type TargetChoice } from "./capture";

export interface CollectionPickerProps {
  options: readonly CollectionOption[];
  /** Folders whose collections are still being checked: the list says so rather than looking short. */
  loading: boolean;
  value: TargetChoice;
  onPick: (choice: TargetChoice) => void;
  /** Offer Inbox (the capture box does; filing a draft cannot file it back into the Inbox). */
  withInbox?: boolean;
  /** The chip's words, when "Goes to" is not the right verb. */
  verb?: string;
  /** Told when the list opens or closes (the capture box fetches the other folders only once it opens). */
  onOpenChange?: (open: boolean) => void;
}

interface Row {
  id: string;
  choice: TargetChoice;
  label: string;
  hint?: string;
  color?: string | null;
}

export function CollectionPicker({ options, loading, value, onPick, withInbox = true, verb = "Goes to", onOpenChange }: CollectionPickerProps) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => value.kind === "collection" && o.baseId === value.baseId && o.tableId === value.tableId);
  const label = value.kind === "inbox" ? "Inbox" : (current?.name ?? "a collection");
  return (
    <PickerShell
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
      title="Goes to"
      wide
      trigger={(props) => (
        <CaptureChip {...props} hue={value.kind === "inbox" ? undefined : (current?.color ?? null)} markName={label}>
          {verb} <strong className="font-semibold">{label}</strong>
          <Icon icon={ChevronDown} size="sm" className="text-muted" />
        </CaptureChip>
      )}
    >
      {open && (
        <List
          options={options}
          loading={loading}
          value={value}
          withInbox={withInbox}
          onPick={(c) => {
            setOpen(false);
            onPick(c);
          }}
        />
      )}
    </PickerShell>
  );
}

function List({ options, loading, value, withInbox, onPick }: Pick<CollectionPickerProps, "options" | "loading" | "value" | "onPick"> & { withInbox: boolean }) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const all: Row[] = [
      ...(withInbox ? [{ id: "inbox", choice: { kind: "inbox" } as TargetChoice, label: "Inbox", hint: "File it later" }] : []),
      ...options.map((o) => ({ id: `${o.baseId}.${o.tableId}`, choice: { kind: "collection", baseId: o.baseId, tableId: o.tableId } as TargetChoice, label: o.name, hint: o.folder ?? undefined, color: o.color })),
    ];
    return q ? all.filter((r) => `${r.label} ${r.hint ?? ""}`.toLowerCase().includes(q)) : all;
  }, [options, query, withInbox]);
  const nav = useListNav(rows.map((r) => `${uid}-${r.id}`));
  return (
    <div className="flex flex-col gap-1">
      <input
        role="combobox"
        aria-expanded
        aria-controls={`${uid}-list`}
        aria-activedescendant={nav.activeId}
        aria-label="Search collections"
        placeholder="Search collections"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        data-autofocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || nav.onKeyDown(e)) return;
          if (e.key === "Enter" && rows[nav.index]) {
            e.preventDefault();
            onPick(rows[nav.index]!.choice);
          }
        }}
        // 16 px on touch: anything smaller makes iOS zoom the page on focus.
        className="h-control-lg rounded-md border border-line-strong bg-surface px-2.5 text-ui placeholder:text-faint focus-visible:border-ring max-md:h-control-touch max-md:text-read-phone"
      />
      <div id={`${uid}-list`} role="listbox" aria-label="Collections" className="flex flex-col">
        {rows.map((r, i) => (
          <ListboxOption
            key={r.id}
            id={`${uid}-${r.id}`}
            active={i === nav.index}
            onSelect={() => onPick(r.choice)}
            onHover={() => nav.setActive(i)}
            leading={r.choice.kind === "inbox" ? undefined : <ColorMark hue={r.color ?? null} size={10} name={r.label} />}
            hint={sameChoice(r.choice, value) ? <Icon icon={Check} size="sm" className="text-primary-text" /> : r.hint}
          >
            {r.label}
          </ListboxOption>
        ))}
        {rows.length === 0 && !loading && <p className="px-2.5 py-3 text-label text-muted">No collection matches.</p>}
        {loading && (
          <p className="flex items-center gap-2 px-2.5 py-3 text-label text-muted">
            <Spinner className="size-4" label="Checking folders" /> Checking folders
          </p>
        )}
      </div>
    </div>
  );
}
