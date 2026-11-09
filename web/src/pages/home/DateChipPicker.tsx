/**
 * The capture box's date chip is a button: tap it to change the date the app read from the title (HOME-4). The new date is
 * typed in the same words the box reads ("Friday", "Nov 14, 3pm") or picked on the calendar; both end as a date guess, so the
 * chip, the stored value and the words that come back when the chip is removed all follow one path.
 */
import { useId, useState, type ReactNode } from "react";
import { guessDate } from "@/lib/dateGuess";
import type { YMD } from "@/lib/cells/dates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SheetActions } from "@/components/ui/sheet";
import { PickerShell } from "./PickerShell";

/** The new date; `time` is left out to keep the time the chip has. */
export interface DatePick {
  date: YMD;
  time?: { h: number; mi: number } | null;
}

interface Clock {
  now: number;
  timeZone: string;
  weekStart: 0 | 1;
}

export interface DateChipPickerProps {
  /** The date as the chip says it now ("Due tomorrow"). */
  label: string;
  /** Whether the Home date holds a time of day. */
  includeTime: boolean;
  clock: Clock;
  onPick: (pick: DatePick) => void;
  /** The chip's own face: the label and the remove button live in the caller's chip. */
  children: (props: { onClick?: () => void; "aria-haspopup": "dialog"; "aria-expanded": boolean }) => ReactNode;
}

export function DateChipPicker({ label, includeTime, clock, onPick, children }: DateChipPickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <PickerShell open={open} onOpenChange={setOpen} title="Change date" trigger={children}>
      {open && (
        <Body
          label={label}
          includeTime={includeTime}
          clock={clock}
          onPick={(g) => {
            setOpen(false);
            onPick(g);
          }}
        />
      )}
    </PickerShell>
  );
}

function Body({ label, includeTime, clock, onPick }: Pick<DateChipPickerProps, "label" | "includeTime" | "clock" | "onPick">) {
  const id = useId();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const t = text.trim();
    const g = t ? guessDate(t, clock) : null;
    if (!g || g.phrase !== t || g.kind === "time") return setError("Type a date, such as Friday or Nov 14.");
    if (g.time && !includeTime) return setError("This date has no time of day. Type a day only.");
    onPick({ date: g.date, time: g.time });
  };

  return (
    <div className="flex flex-col gap-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-2"
      >
        <label htmlFor={id} className="text-label font-semibold">
          Date
        </label>
        <Input id={id} data-autofocus autoFocus value={text} onChange={(e) => (setText(e.target.value), setError(null))} placeholder={label} aria-invalid={error ? true : undefined} aria-describedby={`${id}-hint`} autoComplete="off" className="max-md:text-read-phone" />
        <p id={`${id}-hint`} role={error ? "alert" : undefined} className={error ? "text-label text-danger" : "text-label text-muted"}>
          {error ?? "Type a date, such as Friday or Nov 14."}
        </p>
        <SheetActions className="justify-end">
          <Button type="submit" variant="primary" size="sm">
            Change date
          </Button>
        </SheetActions>
      </form>
      <label htmlFor={`${id}-day`} className="text-label font-semibold">
        Or pick a day
      </label>
      <Input
        id={`${id}-day`}
        type="date"
        onChange={(e) => {
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.target.value);
          if (!m) return;
          onPick({ date: { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } });
        }}
        className="max-md:text-read-phone"
      />
    </div>
  );
}
