/** Schedule trigger: presets (every few minutes, hourly, daily, weekly, monthly) or a raw cron expression, plus a time zone. */
import { useMemo, useState } from "react";
import { Field, Input, Select } from "@/components/ui/input";
import { formatDateTime, listTimeZones } from "@/lib/format";
import { MINUTE_INTERVALS, PRESET_KINDS, PRESET_LABELS, WEEKDAYS, buildCron, defaultPreset, describeCron, formatTime, parseCron, parseTime, type PresetKind, type SchedulePreset } from "./cron";

export interface ScheduleEditorProps {
  cron: string;
  timezone: string;
  onChange: (value: { cron: string; timezone: string }) => void;
  /** Next fire time of the saved, enabled automation (omitted while there are unsaved changes). */
  nextRunAt?: number | null;
  /** Why no next run is shown (off, unsaved), if known. */
  nextRunNote?: string;
  error?: string;
}

export function ScheduleEditor({ cron, timezone, onChange, nextRunAt, nextRunNote, error }: ScheduleEditorProps) {
  // The picker's kind is its own state: typing a custom expression that happens to look like a preset must not switch the form under the cursor.
  const [kind, setKind] = useState<PresetKind>(() => parseCron(cron).kind);
  const preset: SchedulePreset = kind === "custom" ? { kind, cron } : narrow(parseCron(cron), kind);
  const zones = useMemo(() => {
    const all = listTimeZones();
    return all.includes(timezone) || !timezone ? all : [timezone, ...all];
  }, [timezone]);

  const emit = (p: SchedulePreset) => onChange({ cron: buildCron(p), timezone });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Repeat">
          {(ctl) => (
            <Select
              {...ctl}
              value={kind}
              onChange={(e) => {
                const next = e.target.value as PresetKind;
                setKind(next);
                emit(defaultPreset(next, parseCron(cron)));
              }}
            >
              {PRESET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {PRESET_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Time zone">
          {(ctl) => (
            <Select {...ctl} value={timezone} onChange={(e) => onChange({ cron, timezone: e.target.value })}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <PresetFields preset={preset} onChange={emit} error={error} />

      <div className="rounded-md bg-subtle px-3 py-2 text-[0.8125rem]" aria-live="polite">
        <p>
          <span className="font-medium">{describeCron(cron)}</span> <span className="text-muted">in {timezone || "UTC"}</span>
        </p>
        <p className="mt-0.5 text-xs text-muted">
          Cron expression <code>{cron.trim() || "(empty)"}</code>
          {nextRunAt ? <> · next run {formatDateTime(nextRunAt, timezone)}</> : nextRunNote ? <> · {nextRunNote}</> : null}
        </p>
      </div>
    </div>
  );
}

/** The preset parsed from the cron when it is of the chosen kind, else that kind's defaults. */
function narrow(parsed: SchedulePreset, kind: PresetKind): SchedulePreset {
  return parsed.kind === kind ? parsed : defaultPreset(kind, parsed);
}

function PresetFields({ preset, onChange, error }: { preset: SchedulePreset; onChange: (p: SchedulePreset) => void; error?: string }) {
  switch (preset.kind) {
    case "every_minutes":
      return (
        <Field label="Every" className="max-w-xs">
          {(ctl) => (
            <Select {...ctl} value={preset.minutes} onChange={(e) => onChange({ kind: "every_minutes", minutes: Number(e.target.value) })}>
              {MINUTE_INTERVALS.map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </Select>
          )}
        </Field>
      );
    case "hourly":
      return (
        <Field label="Minutes past the hour" className="max-w-xs">
          {(ctl) => <Input {...ctl} type="number" min={0} max={59} value={preset.minute} onChange={(e) => onChange({ kind: "hourly", minute: Number(e.target.value) })} />}
        </Field>
      );
    case "daily":
      return <TimeField preset={preset} onChange={(t) => onChange({ ...preset, ...t })} />;
    case "weekly":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Day of the week">
            {(ctl) => (
              <Select {...ctl} value={preset.day} onChange={(e) => onChange({ ...preset, day: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <TimeField preset={preset} onChange={(t) => onChange({ ...preset, ...t })} />
        </div>
      );
    case "monthly":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Day of the month" hint="Months without that day are skipped; use 1 to 28 to run every month.">
            {(ctl) => (
              <Select {...ctl} value={preset.dayOfMonth} onChange={(e) => onChange({ ...preset, dayOfMonth: Number(e.target.value) })}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <TimeField preset={preset} onChange={(t) => onChange({ ...preset, ...t })} />
        </div>
      );
    case "custom":
      return (
        <Field
          label="Cron expression"
          error={error}
          hint="Five fields: minute, hour, day of month, month, day of week (a leading seconds field is also accepted). It may not fire more often than every 5 minutes."
        >
          {(ctl) => <Input {...ctl} value={preset.cron} spellCheck={false} onChange={(e) => onChange({ kind: "custom", cron: e.target.value })} className="font-mono" placeholder="0 9 * * 1-5" />}
        </Field>
      );
  }
}

function TimeField({ preset, onChange }: { preset: { hour: number; minute: number }; onChange: (t: { hour: number; minute: number }) => void }) {
  return (
    <Field label="At" className="max-w-xs">
      {(ctl) => (
        <Input
          {...ctl}
          type="time"
          value={formatTime(preset.hour, preset.minute)}
          onChange={(e) => {
            const t = parseTime(e.target.value);
            if (t) onChange(t);
          }}
        />
      )}
    </Field>
  );
}
