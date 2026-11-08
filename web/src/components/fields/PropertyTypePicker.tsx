/**
 * The list of property types, in today's groups with a one-line plain description for each (FLD-2). It is
 * one listbox with arrow-key movement, used by the property dialog and by "Change type" in the record
 * page's Add property box; both put it in a popover or inline on a desktop and in a bottom sheet on a phone
 * (PH-3).
 */
import { useRef, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import type { FieldType } from "@/api/types";
import { FIELD_TYPE_ICONS, FIELD_TYPE_LABELS } from "@/components/ui/field-type-icon";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { FIELD_TYPE_GROUPS } from "./fieldKinds";

/** What each type holds, in a sentence a person who has never made a database can follow. */
export const TYPE_DESCRIPTIONS: Record<FieldType, string> = {
  text: "Names, titles and codes: plain text",
  rich_text: "Markdown: text formatting, tables, lists, images and more",
  number: "Whole or decimal numbers",
  currency: "Money, with a symbol",
  percent: "A percentage",
  duration: "Hours, minutes and seconds",
  rating: "Stars or hearts",
  checkbox: "Checked or not",
  single_select: "Pick one option",
  multiple_select: "Pick several options",
  date: "A date, optionally with a time",
  email: "An email address",
  url: "A web link",
  phone: "A phone number",
  attachment: "Files and images",
  link: "Links to records in another collection",
  user: "People who can open this folder",
  formula: "Works out a value from other properties",
  lookup: "Shows a property of the linked records",
  rollup: "Sums up a property of the linked records",
  count: "Counts the linked records",
  created_time: "When the record was created",
  last_modified_time: "When the record last changed",
  created_by: "Who created the record",
  last_modified_by: "Who last changed the record",
  autonumber: "A number that goes up by one for each record",
  barcode: "A barcode value",
  button: "A button that opens a link",
};

export interface PropertyTypeListProps {
  value: FieldType;
  onChange: (type: FieldType) => void;
  /** Why a type cannot be chosen, or null when it can. It stays in the list, dimmed, with the reason in place of its description. */
  unavailable?: (type: FieldType) => string | null;
  label?: string;
  className?: string;
}

export function PropertyTypeList({ value, onChange, unavailable, label = "Property types", className }: PropertyTypeListProps) {
  const list = useRef<HTMLDivElement>(null);

  // One tab stop for the whole list (the chosen type), arrows between the types: 28 buttons in tab order would
  // bury whatever comes after the list.
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const options = [...(list.current?.querySelectorAll<HTMLElement>("[role=option]:not([aria-disabled=true])") ?? [])];
    if (options.length === 0) return;
    const at = options.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : e.key === "ArrowDown" ? Math.min(options.length - 1, at + 1) : Math.max(0, at - 1);
    e.preventDefault();
    options[next]?.focus();
  };

  return (
    <div ref={list} role="listbox" aria-label={label} onKeyDown={move} className={cn("flex flex-col gap-3", className)}>
      {FIELD_TYPE_GROUPS.map((group) => (
        <div key={group.label} role="group" aria-label={group.label}>
          <p aria-hidden className="mb-1 px-2 text-meta font-semibold text-muted">
            {group.label}
          </p>
          <div className="flex flex-col">
            {group.types.map((type) => {
              const why = unavailable?.(type) ?? null;
              const selected = type === value;
              return (
                <button
                  key={type}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={why ? true : undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => !why && onChange(type)}
                  className={cn(
                    "flex min-h-9 w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover max-md:min-h-control-touch max-md:items-center",
                    selected && "bg-primary-soft",
                    why && "cursor-not-allowed opacity-60 hover:bg-transparent",
                  )}
                >
                  <Icon icon={FIELD_TYPE_ICONS[type]} className="mt-0.5 shrink-0 text-muted max-md:mt-0" />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-ui", selected && "font-semibold text-primary-ink")}>{FIELD_TYPE_LABELS[type]}</span>
                    <span className="block text-meta text-muted">{why ?? TYPE_DESCRIPTIONS[type]}</span>
                  </span>
                  {selected && <Icon icon={Check} className="mt-0.5 shrink-0 text-primary-text max-md:mt-0" />}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
