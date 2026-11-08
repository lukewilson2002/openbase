import { useState } from "react";
import { ArrowLeft, ArrowUpDown, Calendar, Columns3, Ellipsis, History, LayoutGrid, ListFilter, MessageSquare, Plus, Search, Share2, SquareCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorMark } from "@/components/ui/color-mark";
import { Icon } from "@/components/ui/icon";
import { StatusChip } from "@/components/ui/status-chip";
import { cn } from "@/lib/cn";
import { COLORS } from "@/lib/colors";
import { DESIGN_SECTIONS } from "../designSections";
import { Gallery, Group, Section, State, useTokenValue } from "./layout";

const byId = (id: string) => DESIGN_SECTIONS.find((s) => s.id === id)!;

/** [variable, what it is for]. The numbers beside each come from the browser, so they are the theme's own. */
const COLOUR_TOKENS: [string, string][] = [
  ["bg", "page ground"],
  ["surface", "pages, cards, inputs"],
  ["chrome", "menu and top bar"],
  ["subtle", "quiet fills"],
  ["hover", "hover fill"],
  ["line", "borders"],
  ["line-strong", "input borders"],
  ["fg", "text"],
  ["muted", "secondary text"],
  ["faint", "placeholders"],
  ["primary", "accent"],
  ["primary-hover", "accent, pressed"],
  ["primary-fg", "text on the accent"],
  ["primary-text", "accent as text"],
  ["primary-soft", "selected fill"],
  ["primary-soft-line", "selected border"],
  ["primary-ink", "text on selected"],
  ["danger", "errors, overdue"],
  ["danger-hover", "danger, pressed"],
  ["danger-fg", "text on danger"],
  ["danger-soft", "error fill"],
  ["success", "success"],
  ["success-soft", "success fill"],
  ["warning-soft", "warning fill"],
  ["ring", "focus ring"],
  ["overlay", "dimmed screen"],
];

function Swatch({ name, use }: { name: string; use: string }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const value = useTokenValue(`--${name}`, element);
  return (
    <li className="flex min-w-0 items-center gap-3">
      <div ref={setElement} aria-hidden className="size-control-lg shrink-0 rounded-md border border-line" style={{ background: `var(--${name})` }} />
      <div className="min-w-0">
        <code className="block truncate text-label font-medium">--{name}</code>
        <span className="block truncate text-meta text-muted">
          {use}
          {value ? <span className="num"> · {value}</span> : null}
        </span>
      </div>
    </li>
  );
}

export function ColourSection() {
  return (
    <Section section={byId("colour")} note="The semantic tokens. Every colour in a component is one of these, so a screen is right in both themes by construction.">
      <ul className="m-0 grid list-none grid-cols-2 gap-x-4 gap-y-3 p-0 max-md:grid-cols-1">
        {COLOUR_TOKENS.map(([name, use]) => (
          <Swatch key={name} name={name} use={use} />
        ))}
      </ul>
      <Group title="Pairs that carry text">
        <Gallery>
          <State label="primary / primary-fg">
            <span className="inline-flex h-control-md items-center rounded-md bg-primary px-3 text-ui font-semibold text-primary-fg">Save</span>
          </State>
          <State label="primary-soft / primary-ink">
            <span className="inline-flex h-control-md items-center rounded-md border border-primary-soft-line bg-primary-soft px-3 text-ui font-semibold text-primary-ink">Selected</span>
          </State>
          <State label="danger / danger-fg">
            <span className="inline-flex h-control-md items-center rounded-md bg-danger px-3 text-ui font-semibold text-danger-fg">Delete</span>
          </State>
          <State label="danger-soft / danger">
            <span className="inline-flex h-control-md items-center rounded-md bg-danger-soft px-3 text-ui font-medium text-danger">Overdue</span>
          </State>
          <State label="success-soft / success">
            <span className="inline-flex h-control-md items-center rounded-md bg-success-soft px-3 text-ui font-medium text-success">Saved</span>
          </State>
          <State label="warning-soft / fg">
            <span className="inline-flex h-control-md items-center rounded-md bg-warning-soft px-3 text-ui font-medium text-fg">Heads up</span>
          </State>
        </Gallery>
      </Group>
      <Group title="Text on the page ground">
        <div className="flex flex-col gap-1 text-ui">
          <span className="text-fg">fg: body text</span>
          <span className="text-muted">muted: secondary text</span>
          <span className="text-faint">faint: placeholders and hints</span>
          <a href="#colour" className="w-fit">
            primary-text: a link
          </a>
        </div>
      </Group>
    </Section>
  );
}

const HUES = COLORS.filter((c) => !c.endsWith("_dark"));

export function EntityColoursSection() {
  return (
    <Section
      section={byId("entity-colours")}
      note="The ten hues shared with the server, each with a _dark variant. A choice (status chip) uses its pastel pair; a workspace, folder or collection uses the hue's solid shade as a mark beside its name."
    >
      <Group title="Choice chips, light and dark variants">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 max-md:grid-cols-1">
          {COLORS.map((c) => (
            <div key={c} className="flex items-center gap-2">
              <StatusChip hue={c}>{c.replace("_", " ")}</StatusChip>
            </div>
          ))}
        </div>
      </Group>
      <Group title="Entity marks, 14 px">
        <ul className="m-0 grid list-none grid-cols-2 gap-x-4 gap-y-2 p-0 max-md:grid-cols-1">
          {HUES.map((h) => (
            <li key={h} className="flex items-center gap-2 text-ui">
              <ColorMark hue={h} size={14} />
              {h}
            </li>
          ))}
        </ul>
      </Group>
    </Section>
  );
}

const TYPE_SCALE: { cls: string; token: string; spec: string; use: string }[] = [
  { cls: "text-meta", token: "text-meta", spec: "12 / 16 · 400", use: "counts, timestamps" },
  { cls: "text-label", token: "text-label", spec: "13 / 18 · 400, 600", use: "property labels, secondary buttons" },
  { cls: "text-ui", token: "text-ui", spec: "14 / 20 · 400, 500, 600", use: "default UI text, nav rows" },
  { cls: "text-read", token: "text-read", spec: "15 / 24 · 400", use: "page body on desktop" },
  { cls: "text-read-phone", token: "text-read-phone", spec: "16 / 25 · 400", use: "page body and every input on phone" },
  { cls: "text-h3", token: "text-h3", spec: "16 / 21 · 600", use: "page subheadings" },
  { cls: "text-sheet", token: "text-sheet", spec: "18 / 24 · 600", use: "sheet and dialog titles" },
  { cls: "text-h2", token: "text-h2", spec: "20 / 26 · 600", use: "page headings" },
  { cls: "text-title", token: "text-title", spec: "24 / 29 · 600", use: "collection title" },
  { cls: "text-home-phone", token: "text-home-phone", spec: "26 / 31 · 600", use: "Home title on phone" },
  { cls: "text-home", token: "text-home", spec: "28 / 34 · 600", use: "Home title" },
  { cls: "text-record-phone", token: "text-record-phone", spec: "26 / 31 · 700", use: "record title on phone" },
  { cls: "text-record", token: "text-record", spec: "34 / 39 · 700", use: "record title on desktop" },
  { cls: "text-capture-phone", token: "text-capture-phone", spec: "17 / 24 · 400", use: "capture box on phone" },
  { cls: "text-capture", token: "text-capture", spec: "18 / 26 · 400", use: "capture box on desktop" },
];

export function TypeSection() {
  return (
    <Section section={byId("type")} note="One scale, used everywhere. Each class sets size, line height, weight and letter spacing together.">
      <div className="flex flex-col gap-4">
        {TYPE_SCALE.map((t) => (
          <div key={t.token} className="min-w-0">
            <p className={cn(t.cls, "truncate")}>The quick brown fox</p>
            <p className="text-meta text-muted">
              <code>{t.token}</code> · {t.spec} · {t.use}
            </p>
          </div>
        ))}
        <div className="min-w-0">
          <p className="num text-ui">1,234.50 · 2026-11-08 · $9,876.00</p>
          <p className="text-meta text-muted">
            <code>num</code> · tabular figures for numbers, dates and money
          </p>
        </div>
      </div>
    </Section>
  );
}

const SPACING = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];

export function SpacingSection() {
  return (
    <Section section={byId("spacing")} note="Steps of 4, from 2: --space-2 to --space-64.">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {SPACING.map((n) => (
          <li key={n} className="flex items-center gap-3">
            <code className="w-24 shrink-0 text-meta text-muted">--space-{n}</code>
            <span aria-hidden className="h-3 max-w-full rounded-xs bg-primary" style={{ width: `var(--space-${n})` }} />
            <span className="num text-meta text-muted">{n}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function RadiusSection() {
  const radii: [string, string, string][] = [
    ["rounded-xs", "rounded-xs", "4 · kbd, marks"],
    ["rounded-sm", "rounded-sm", "6 · chips in inputs, link chips"],
    ["rounded-md", "rounded-md", "8 · buttons, inputs, nav rows"],
    ["rounded-lg", "rounded-lg", "12 · cards, popovers, embeds"],
    ["rounded-xl", "rounded-xl", "16 · bottom sheets, phone cards"],
    ["rounded-pill", "rounded-pill", "999 · status chips, avatars"],
  ];
  return (
    <Section section={byId("radius")} note="--radius-xs to --radius-xl and --radius-pill. They replace Tailwind's own steps of the same names.">
      <Gallery>
        {radii.map(([name, cls, spec]) => (
          <State key={name} label={`${name} · ${spec}`} className="w-40">
            <div className={cn("h-16 w-28 border border-line-strong bg-surface", cls)} />
          </State>
        ))}
      </Gallery>
    </Section>
  );
}

export function SizesSection() {
  const controls: [string, string, string][] = [
    ["h-control-sm", "h-control-sm", "30 · small"],
    ["h-control-md", "h-control-md", "34 · default"],
    ["h-control-lg", "h-control-lg", "40 · large"],
    ["h-control-touch", "h-control-touch", "44 · anything tappable on phone"],
    ["h-row-table", "h-row-table", "46 · table row"],
    ["h-row-feed", "h-row-feed", "44 · feed row, desktop"],
    ["h-row-feed-phone", "h-row-feed-phone", "56 · feed row, phone"],
  ];
  const widths: [string, string, string][] = [
    ["--container-sidebar", "var(--container-sidebar)", "256 · sidebar"],
    ["--container-record", "var(--container-record)", "760 max · record page column"],
    ["--container-home", "var(--container-home)", "960 max · Home column"],
    ["--container-panel", "var(--container-panel)", "360 · side panel"],
  ];
  return (
    <Section section={byId("sizes")} note="Heights in rem, so they follow the reader's text size. Widths below are drawn at a quarter of their size.">
      <Group title="Control and row heights">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {controls.map(([name, cls, spec]) => (
            <li key={name} className="flex items-center gap-3">
              <span aria-hidden className={cn("w-20 shrink-0 rounded-md border border-primary-soft-line bg-primary-soft", cls)} />
              <span className="min-w-0 text-meta text-muted">
                <code>{name}</code> · {spec}
              </span>
            </li>
          ))}
        </ul>
      </Group>
      <Group title="Layout widths">
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {widths.map(([name, value, spec]) => (
            <li key={name} className="flex min-w-0 flex-col gap-1">
              <span aria-hidden className="h-3 max-w-full rounded-xs bg-primary" style={{ width: `calc(${value} / 4)` }} />
              <span className="text-meta text-muted">
                <code>{name}</code> · {spec}
              </span>
            </li>
          ))}
          <li className="flex min-w-0 flex-col gap-1">
            <span aria-hidden className="h-3 max-w-full rounded-xs bg-primary" style={{ width: "var(--gutter)" }} />
            <span className="text-meta text-muted">
              <code>--gutter</code> · page side padding, 16 on phone and 40 on desktop (shown at full size)
            </span>
          </li>
        </ul>
      </Group>
    </Section>
  );
}

export function ElevationSection() {
  return (
    <Section section={byId("elevation")} note="Flat by default: cards have a 1 px line and no shadow. Only things that float have a shadow.">
      <Gallery>
        <State label="Card · --line border, no shadow">
          <div className="h-20 w-44 rounded-lg border border-line bg-surface p-3 text-ui">Flat</div>
        </State>
        <State label="Popover, menu, sheet, palette · --shadow">
          <div className="h-20 w-44 rounded-lg border border-line bg-surface p-3 text-ui shadow-pop">Floating</div>
        </State>
        <State label="--overlay · behind a modal">
          <div className="relative h-20 w-44 overflow-hidden rounded-lg border border-line bg-surface">
            <div aria-hidden className="absolute inset-0 bg-overlay" />
          </div>
        </State>
      </Gallery>
    </Section>
  );
}

const DURATIONS = [
  { name: "fast", on: "duration-fast", off: "duration-fast-leave", spec: "120 ms · hover and press" },
  { name: "base", on: "duration-base", off: "duration-base-leave", spec: "180 ms · popovers and menus" },
  { name: "slow", on: "duration-slow", off: "duration-slow-leave", spec: "240 ms · sheets and dialogs" },
];

export function MotionSection() {
  const [moved, setMoved] = useState(false);
  return (
    <Section section={byId("motion")} note="Entering eases out on --ease-enter; leaving is 30% faster. Nothing moves by itself: press Replay. With reduced motion everything is a 120 ms fade.">
      <div>
        <Button variant="secondary" size="sm" aria-pressed={moved} onClick={() => setMoved((m) => !m)}>
          {moved ? "Send back" : "Replay"}
        </Button>
      </div>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {DURATIONS.map((d) => (
          <li key={d.name} className="flex flex-col gap-1">
            <div className="h-5 rounded-pill bg-subtle p-0.5">
              <span
                aria-hidden
                className={cn("block size-4 rounded-pill bg-primary transition-transform ease-enter", moved ? d.on : d.off, moved ? "translate-x-48" : "translate-x-0")}
              />
            </div>
            <span className="text-meta text-muted">
              <code>{d.on}</code> / <code>{d.off}</code> · {d.spec}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const SAMPLE_ICONS = [
  [Search, "Search"],
  [Plus, "Add"],
  [X, "Close"],
  [Ellipsis, "More"],
  [Share2, "Share"],
  [MessageSquare, "Comments"],
  [History, "History"],
  [ArrowLeft, "Back"],
  [ArrowUpDown, "Sort"],
  [ListFilter, "Filter"],
  [LayoutGrid, "Grid layout"],
  [Columns3, "Board layout"],
  [Calendar, "Calendar layout"],
  [SquareCheck, "Checkbox"],
] as const;

export function IconsSection() {
  return (
    <Section
      section={byId("icons")}
      note="Icons mark actions and control state, never places. Stroke width 2, 16 px on desktop and 20 on phone, in the surrounding text colour. Every icon-only button has an aria-label."
    >
      <Group title="Icon · 16 px desktop, 20 px phone">
        <ul className="m-0 grid list-none grid-cols-2 gap-x-4 gap-y-2 p-0 max-md:grid-cols-1">
          {SAMPLE_ICONS.map(([glyph, name]) => (
            <li key={name} className="flex items-center gap-2 text-ui text-muted">
              <Icon icon={glyph} />
              {name}
            </li>
          ))}
        </ul>
      </Group>
      <Group title="Takes the text colour">
        <div className="flex flex-wrap items-center gap-4 text-ui">
          <span className="flex items-center gap-1.5 text-fg">
            <Icon icon={Search} /> fg
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <Icon icon={Search} /> muted
          </span>
          <span className="flex items-center gap-1.5 text-primary-text">
            <Icon icon={Search} /> primary-text
          </span>
          <span className="flex items-center gap-1.5 text-danger">
            <Icon icon={Search} /> danger
          </span>
        </div>
      </Group>
      <Group title="Small · 12 px, inside a control that is the target">
        <div className="flex items-center gap-4 text-ui text-muted">
          <Icon icon={X} size="sm" /> remove on a chip
          <Icon icon={SquareCheck} size="sm" /> tick in a checkbox
        </div>
      </Group>
    </Section>
  );
}
