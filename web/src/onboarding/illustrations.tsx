import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, Heart, ListChecks, Receipt, Table2, Users, Wallet, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { colorHue } from "@/lib/colors";

type Motion = "rise" | "fade" | "pop" | "slide" | "drop" | "turn" | "unfold" | "draw" | "grow-y" | "typing";

/** Class and delay for one animated element (see intro.css). */
function anim(motion: Motion, delay: number, duration?: number): { className: string; style: CSSProperties } {
  return {
    className: `ob-intro-anim ob-intro-${motion}`,
    style: { animationDelay: `${delay}s`, ...(duration ? { animationDuration: `${duration}s` } : {}) },
  };
}

function Animated({ motion, delay, duration, className, children, style }: { motion: Motion; delay: number; duration?: number; className?: string; children?: ReactNode; style?: CSSProperties }) {
  const a = anim(motion, delay, duration);
  return (
    <div className={cn(a.className, className)} style={{ ...style, ...a.style }}>
      {children}
    </div>
  );
}

/**
 * Draws an illustration at its natural size and shrinks it (never grows it) to fit the stage.
 * The pictures are laid out in fixed pixels so the arrows and outlines land exactly on the cells
 * they point at; scaling the whole picture keeps that true on a 320 px phone, where reflowing it
 * would move the cells out from under the arrows. Pictures are hidden from screen readers unless
 * they are `interactive` (the views step's buttons must stay reachable).
 */
export function Fit({ width, height, interactive = false, children }: { width: number; height: number; interactive?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      // 12 px of breathing room on each side; jsdom reports 0, which must not collapse the picture.
      const s = Math.min(1, (el.clientWidth - 24) / width, (el.clientHeight - 24) / height);
      setScale(s > 0 ? s : 1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);
  return (
    <div ref={ref} className="relative size-full overflow-hidden" aria-hidden={interactive ? undefined : true}>
      <div className="absolute left-1/2 top-1/2" style={{ width, height, transform: `translate(-50%, -50%) scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

/** A base tile: a soft tint of its colour with the icon in the strong shade. */
function BaseTile({ icon: Icon, color, className, iconClassName }: { icon: LucideIcon; color: string; className?: string; iconClassName?: string }) {
  return (
    <span className={cn("tint inline-flex shrink-0 items-center justify-center", className)} style={{ "--tint": colorHue(color) } as CSSProperties}>
      <Icon className={iconClassName} />
    </span>
  );
}

/** A person's face: their colour, a white initial. */
function Face({ letter, color, className }: { letter: string; color: string; className?: string }) {
  return (
    <span className={cn("flex items-center justify-center rounded-full font-bold text-white", className)} style={{ background: colorHue(color) }}>
      {letter}
    </span>
  );
}

// ---- Step 1: a base unfolds into its tables ------------------------------------------------------

const WEDDING_TABLES = [
  { name: "Guests", count: "84 items" },
  { name: "Vendors", count: "7 items" },
  { name: "To-dos", count: "23 items" },
];

export function BasesArt() {
  return (
    <Fit width={300} height={216}>
      <Animated motion="rise" delay={0.05} className="w-[300px] overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_12px_32px_rgb(15_20_30/0.12)]">
        <div className="flex items-center gap-3 px-4 py-3.5">
          <BaseTile icon={Heart} color="pink" className="size-10 rounded-[10px]" iconClassName="size-[22px]" />
          <div className="min-w-0 flex-1 text-[0.9375rem] font-[650] text-fg">Wedding</div>
          <Animated motion="turn" delay={0.4} duration={0.35} className="text-muted">
            <ChevronRight className="size-[18px]" />
          </Animated>
        </div>
        <Animated motion="unfold" delay={0.45} duration={0.5} className="flex flex-col gap-1.5 border-t border-line bg-bg p-2">
          {WEDDING_TABLES.map((t, i) => (
            <Animated key={t.name} motion="slide" delay={0.55 + i * 0.15} duration={0.5} className="flex items-center gap-2.5 rounded-[10px] border border-line bg-surface px-2.5 py-[9px] text-[0.8125rem]">
              <Table2 className="size-4 shrink-0 text-primary" strokeWidth={1.8} />
              <span className="min-w-0 flex-1 truncate font-semibold text-fg">{t.name}</span>
              <span className="shrink-0 text-muted">{t.count}</span>
            </Animated>
          ))}
        </Animated>
      </Animated>
    </Fit>
  );
}

// ---- Step 2: a table with "A field" and "A record" called out ------------------------------------

const AMBER = "#db871b";
const AMBER_INK = "#8a4b00";
// Column widths and row heights the overlays and arrows are measured against.
const COLS = [120, 80, 108];
const TABLE_X = 5;
const TABLE_Y = 52;
const HEAD_H = 30;
const ROW_H = 36;
const CHORE_ROWS = [
  { chore: "Take out trash", who: "Sam", often: "Weekly", color: "blue" },
  { chore: "Water plants", who: "Alex", often: "Every 3 days", color: "green" },
  { chore: "Change filters", who: "Sam", often: "Monthly", color: "yellow" },
];

export function TablesArt() {
  const grid = { gridTemplateColumns: COLS.map((w) => `${w}px`).join(" ") };
  const whoX = TABLE_X + 1 + COLS[0]!;
  const whoW = COLS[1]!;
  const whoMid = whoX + whoW / 2;
  const tableH = HEAD_H + ROW_H * CHORE_ROWS.length + 2;
  const lastRowY = TABLE_Y + 1 + HEAD_H + ROW_H * (CHORE_ROWS.length - 1);
  const recordX = 62;
  return (
    <Fit width={320} height={252}>
      <div className="relative h-[252px] w-[320px]">
        {/* The table itself. */}
        <Animated motion="rise" delay={0.05} className="absolute overflow-hidden rounded-lg border border-line bg-surface shadow-pop" style={{ left: TABLE_X, top: TABLE_Y, width: 310 }}>
          <div className="grid border-b border-line bg-subtle text-[0.6875rem] font-semibold text-muted" style={{ ...grid, height: HEAD_H }}>
            {["Chore", "Who", "How often"].map((h, i) => (
              <div key={h} className={cn("flex items-center px-2", i > 0 && "border-l border-line")}>
                {h}
              </div>
            ))}
          </div>
          {CHORE_ROWS.map((r, i) => (
            <Animated key={r.chore} motion="fade" delay={0.3 + i * 0.12} duration={0.4} className={cn("grid text-xs text-fg", i > 0 && "border-t border-line")} style={{ ...grid, height: ROW_H }}>
              <div className="flex items-center truncate px-2 font-medium">{r.chore}</div>
              <div className="flex items-center border-l border-line px-2">{r.who}</div>
              <div className="flex items-center border-l border-line px-1.5">
                <span className={cn("choice truncate rounded-full px-1.5 py-0.5 text-[0.6875rem] leading-none", `choice-${r.color}`)}>{r.often}</span>
              </div>
            </Animated>
          ))}
        </Animated>

        {/* "A field": the Who column, outlined in amber. */}
        <Animated
          motion="fade"
          delay={0.9}
          duration={0.4}
          className="absolute rounded-[5px]"
          style={{ left: whoX - 1, top: TABLE_Y - 1, width: whoW + 2, height: tableH + 2, outline: `2px solid ${AMBER}`, background: "rgb(219 135 27 / 0.13)" }}
        />
        <Animated motion="drop" delay={0.85} duration={0.4} className="absolute flex justify-center" style={{ left: whoMid - 60, top: 0, width: 120 }}>
          <span className="whitespace-nowrap rounded-lg px-2 py-1.5 text-xs font-bold text-white" style={{ background: AMBER_INK }}>
            A field / column
          </span>
        </Animated>
        <svg className="absolute overflow-visible" style={{ left: 0, top: 0 }} width={320} height={252} fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path
            {...anim("draw", 1.0, 0.5)}
            pathLength={1}
            stroke={AMBER}
            strokeWidth={2}
            d={`M ${whoMid} 25 L ${whoMid} ${TABLE_Y - 6} M ${whoMid - 5} ${TABLE_Y - 12} L ${whoMid} ${TABLE_Y - 6} L ${whoMid + 5} ${TABLE_Y - 12}`}
          />
          <path
            {...anim("draw", 1.65, 0.5)}
            pathLength={1}
            stroke="var(--primary)"
            strokeWidth={2}
            d={`M ${recordX} 226 L ${recordX} ${TABLE_Y + tableH + 6} M ${recordX - 5} ${TABLE_Y + tableH + 12} L ${recordX} ${TABLE_Y + tableH + 6} L ${recordX + 5} ${TABLE_Y + tableH + 12}`}
          />
        </svg>

        {/* "A record": the last row, outlined in blue. */}
        <Animated
          motion="fade"
          delay={1.55}
          duration={0.4}
          className="absolute rounded-[5px]"
          style={{ left: TABLE_X - 1, top: lastRowY - 1, width: 312, height: ROW_H + 2, outline: "2px solid var(--primary)", background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}
        />
        <Animated motion="rise" delay={1.5} duration={0.4} className="absolute" style={{ left: 8, top: 226 }}>
          <span className="whitespace-nowrap rounded-lg bg-primary px-2.5 py-1.5 text-xs font-bold text-primary-fg">A record / row</span>
        </Animated>
      </div>
    </Fit>
  );
}

// ---- Step 3: the same chores as a table, a board, a calendar, a timeline or a form ----------------

const VIEW_NAMES = ["Table", "Kanban", "Calendar", "Timeline", "Form"] as const;
type ViewName = (typeof VIEW_NAMES)[number];

const PILL = "choice inline-block whitespace-nowrap rounded-full px-[7px] py-px";

/**
 * The one picture people can play with: five buttons switch the chores between views. The intro's
 * text points at them ("Tap Table, Kanban… above"), so they are real buttons, reachable by keyboard.
 */
export function ViewsArt() {
  const [view, setView] = useState<ViewName>("Kanban");
  return (
    <Fit width={340} height={224} interactive>
      <div className="flex w-[340px] flex-col gap-2">
        <div role="group" aria-label="Show the chores as" className="grid grid-cols-5 gap-[3px] rounded-xl border border-line bg-surface p-1">
          {VIEW_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={view === name}
              onClick={() => setView(name)}
              className="h-8 rounded-lg px-0.5 text-xs font-semibold text-muted transition-colors hover:text-fg aria-pressed:bg-primary aria-pressed:text-primary-fg"
            >
              {name}
            </button>
          ))}
        </div>
        <div key={view} aria-hidden className="relative h-[176px]">
          {view === "Table" && <ChoresTable />}
          {view === "Kanban" && <ChoresBoard />}
          {view === "Calendar" && <ChoresCalendar />}
          {view === "Timeline" && <ChoresTimeline />}
          {view === "Form" && <ChoreForm />}
        </div>
      </div>
    </Fit>
  );
}

const CHORES = [
  { chore: "Take out trash", who: "Sam", often: "Weekly", color: "blue" },
  { chore: "Water plants", who: "Alex", often: "Every 3 days", color: "green" },
  { chore: "Change filters", who: "Sam", often: "Monthly", color: "yellow" },
];

function ChoresTable() {
  const grid = "grid grid-cols-[130px_90px_1fr] items-center";
  return (
    <Animated motion="rise" delay={0} className="overflow-hidden rounded-xl border border-line bg-surface text-[0.8125rem] text-fg">
      <div className={cn(grid, "h-[34px] border-b border-line bg-bg font-semibold text-muted")}>
        <span className="px-2.5">Chore</span>
        <span className="px-2.5">Who</span>
        <span className="px-2.5">How often</span>
      </div>
      {CHORES.map((c, i) => (
        <Animated key={c.chore} motion="slide" delay={0.1 + i * 0.15} className={cn(grid, "h-10", i < CHORES.length - 1 && "border-b border-line/60")}>
          <span className="whitespace-nowrap px-2.5">{c.chore}</span>
          <span className="px-2.5">{c.who}</span>
          <span className="px-2.5">
            <span className={cn(PILL, "text-xs", `choice-${c.color}`)}>{c.often}</span>
          </span>
        </Animated>
      ))}
    </Animated>
  );
}

function ChoresBoard() {
  const stacks = [
    { who: "Sam", color: "blue", cards: [CHORES[0]!, CHORES[2]!] },
    { who: "Alex", color: "pink", cards: [CHORES[1]!] },
  ];
  let n = 0;
  return (
    <Animated motion="rise" delay={0} className="grid grid-cols-2 gap-2.5 text-[0.8125rem] text-fg">
      {stacks.map((s) => (
        <div key={s.who} className="flex flex-col gap-1.5 rounded-xl bg-subtle p-2">
          <div className="flex items-center gap-1.5 px-1 py-0.5 text-xs font-bold text-muted">
            <Face letter={s.who[0]!} color={s.color} className="size-[18px] text-[0.625rem]" />
            {s.who} · {s.cards.length}
          </div>
          {s.cards.map((c) => (
            <Animated key={c.chore} motion="slide" delay={0.1 + n++ * 0.15} className="rounded-[9px] border border-line bg-surface px-2.5 py-2">
              <div className="font-semibold">{c.chore}</div>
              <span className={cn(PILL, "mt-1 text-[0.6875rem]", `choice-${c.color}`)}>{c.often}</span>
            </Animated>
          ))}
        </div>
      ))}
    </Animated>
  );
}

const CALENDAR: Record<number, { label: string; color: string }> = {
  13: { label: "Trash", color: "blue" },
  15: { label: "Plants", color: "green" },
  18: { label: "Plants", color: "green" },
  20: { label: "Trash", color: "blue" },
  21: { label: "Plants", color: "green" },
  24: { label: "Filters", color: "yellow" },
};

function ChoresCalendar() {
  const days = Array.from({ length: 14 }, (_, i) => 12 + i);
  let n = 0;
  return (
    <Animated motion="rise" delay={0} className="overflow-hidden rounded-xl border border-line bg-surface text-[0.6875rem]">
      <div className="border-b border-line/60 px-2.5 py-[7px] text-xs font-bold text-fg">October</div>
      <div className="grid grid-cols-7 border-b border-line/60 py-1 text-center font-semibold text-muted">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d, i) => {
          const e = CALENDAR[d];
          return (
            <span key={d} className={cn("h-[52px] p-[3px] text-faint", i % 7 < 6 && "border-r border-line/60", i < 7 && "border-b border-line/60")}>
              {d}
              {e && (
                <Animated motion="pop" delay={0.1 + n++ * 0.15} className={cn("choice mt-[3px] overflow-hidden whitespace-nowrap rounded px-[3px] py-0.5 text-[0.625rem] font-semibold", `choice-${e.color}`)}>
                  {e.label}
                </Animated>
              )}
            </span>
          );
        })}
      </div>
    </Animated>
  );
}

function ChoresTimeline() {
  const bars = [
    { left: "25%", width: "22%", color: "var(--primary)" },
    { left: "30%", width: "40%", color: "var(--success)" },
    { left: "55%", width: "38%", color: "#db871b" },
  ];
  return (
    <Animated motion="rise" delay={0} className="overflow-hidden rounded-xl border border-line bg-surface text-xs text-fg">
      <div className="grid grid-cols-[104px_repeat(4,minmax(0,1fr))] border-b border-line/60 text-[0.6875rem] font-semibold text-muted">
        <span className="px-2.5 py-[7px]">Chore</span>
        {["Oct 6", "Oct 13", "Oct 20", "Oct 27"].map((d) => (
          <span key={d} className="border-l border-line/60 px-1 py-[7px]">
            {d}
          </span>
        ))}
      </div>
      {CHORES.map((c, i) => (
        <div key={c.chore} className={cn("grid h-11 grid-cols-[104px_1fr] items-center", i < CHORES.length - 1 && "border-b border-line/60")}>
          <span className="whitespace-nowrap px-2.5 font-semibold">{c.chore}</span>
          <span className="relative h-full">
            <Animated motion="unfold" delay={0.45 + i * 0.1} className="absolute top-[13px] h-5 rounded-md" style={{ left: bars[i]!.left, width: bars[i]!.width, background: bars[i]!.color }} />
          </span>
        </div>
      ))}
    </Animated>
  );
}

function ChoreForm() {
  const rows = [
    ["Chore", "Wash the car"],
    ["Who", "Alex"],
    ["How often", "Monthly"],
  ];
  return (
    <Animated motion="rise" delay={0} className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-xs text-fg">
      <div className="text-[0.8125rem] font-bold">Add a chore</div>
      {rows.map(([label, value], i) => (
        <Animated key={label} motion="slide" delay={0.1 + i * 0.15} className="grid grid-cols-[74px_1fr] items-center gap-2">
          <span className="font-semibold text-muted">{label}</span>
          <span className="flex h-6 items-center rounded-md border border-line-strong px-2">{value}</span>
        </Animated>
      ))}
      <Animated motion="pop" delay={0.7} className="mt-0.5 flex items-center justify-between gap-2">
        <span className="text-muted">Each answer becomes a new record</span>
        <span className="rounded-[7px] bg-primary px-3 py-1.5 font-bold text-primary-fg">Submit</span>
      </Animated>
    </Animated>
  );
}

/** "Try me!" and an arrow at the view buttons, drawn over the card's top edge. */
export function TryMe() {
  const arrow = anim("fade", 0.85, 0.25);
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[3]">
      <svg
        width={44}
        height={44}
        viewBox="0 0 44 44"
        className={cn(arrow.className, "absolute -top-[26px] left-[calc(50%+28px)] overflow-visible max-[400px]:left-[calc(50%-8px)]")}
        style={arrow.style}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path {...anim("draw", 0.85, 0.6)} pathLength={1} d="M40 8 C 26 9, 14 16, 11 34" />
        <path {...anim("fade", 1.35, 0.2)} d="M5 29 L 11 36 L 17 30" />
      </svg>
      <Animated motion="pop" delay={0.85} className="absolute -top-[34px] left-[calc(50%+70px)] max-[400px]:left-[calc(50%+34px)]">
        <span className="block whitespace-nowrap rounded-full bg-primary px-3 py-1.5 text-[0.8125rem] font-bold text-primary-fg">Try me!</span>
      </Animated>
    </div>
  );
}

// ---- Step 4: two workspaces, each with its own people and bases ----------------------------------

const WORKSPACES = [
  {
    name: "Household",
    color: "green",
    people: [
      { letter: "S", color: "blue" },
      { letter: "A", color: "pink" },
    ],
    bases: [
      { name: "Chores", icon: ListChecks, color: "green" },
      { name: "Budget", icon: Wallet, color: "orange" },
    ],
  },
  {
    name: "Side business",
    color: "blue",
    people: [
      { letter: "S", color: "blue" },
      { letter: "R", color: "purple" },
    ],
    bases: [
      { name: "Clients", icon: Users, color: "blue" },
      { name: "Invoices", icon: Receipt, color: "purple" },
    ],
  },
];

export function WorkspacesArt() {
  return (
    <Fit width={466} height={150}>
      <div className="flex h-[150px] w-[466px] items-stretch gap-[22px] pt-3">
        {WORKSPACES.map((w, wi) => (
          <div key={w.name} className="contents">
            {wi > 0 && <Animated motion="grow-y" delay={0.7} className="w-0.5 rounded-sm bg-[repeating-linear-gradient(var(--faint)_0_6px,transparent_6px_12px)] opacity-70" />}
            <Animated
              motion="rise"
              delay={0.1 + wi * 0.45}
              className="relative flex w-[210px] flex-col gap-2 rounded-[18px] border-2 bg-surface px-3.5 pb-3.5 pt-[34px]"
              style={{ borderColor: `color-mix(in srgb, ${colorHue(w.color)} 40%, var(--surface))` }}
            >
              <span className="absolute -top-[13px] left-3.5 rounded-full px-2.5 py-1 text-xs font-bold text-white" style={{ background: colorHue(w.color) }}>
                {w.name}
              </span>
              <div className="absolute right-2.5 top-2 flex">
                {w.people.map((p, pi) => (
                  <Animated key={p.letter} motion="pop" delay={0.4 + wi * 0.45 + pi * 0.15} className={cn("relative", pi > 0 && "-ml-1.5")} style={{ zIndex: w.people.length - pi }}>
                    <Face letter={p.letter} color={p.color} className="size-6 text-[0.6875rem] ring-2 ring-surface" />
                  </Animated>
                ))}
              </div>
              {w.bases.map((b, bi) => (
                <Animated key={b.name} motion="slide" delay={0.25 + wi * 0.45 + bi * 0.15} className="flex items-center gap-2 rounded-[10px] border border-line p-2 text-[0.8125rem] font-semibold text-fg">
                  <BaseTile icon={b.icon} color={b.color} className="size-[22px] rounded-md" iconClassName="size-[13px]" />
                  {b.name}
                </Animated>
              ))}
            </Animated>
          </div>
        ))}
      </div>
    </Fit>
  );
}

// ---- Closing: an assistant sets things up ---------------------------------------------------------

export function AssistantArt() {
  return (
    <Fit width={500} height={200}>
      <div className="flex h-[200px] w-[500px] flex-col justify-center gap-2.5">
        <Animated motion="rise" delay={0.1} className="max-w-[340px] self-end rounded-2xl rounded-br-[4px] bg-primary px-3.5 py-2.5 text-sm leading-snug text-primary-fg">
          Help me keep track of my clients and when I last talked to them. Add Maria Lopez, <span className="whitespace-nowrap">870-555-0142</span>, we talked today.
        </Animated>
        {/* The typing dots and the reply share one grid cell, so the reply takes the dots' place without a jump. */}
        <div className="grid">
          <Animated motion="typing" delay={0.4} duration={1} className="col-start-1 row-start-1 flex gap-1 self-start justify-self-start rounded-2xl rounded-bl-[4px] border border-line bg-surface px-3.5 py-3">
            {[0, 0.2, 0.4].map((d) => (
              <span key={d} className="ob-intro-dot size-1.5 rounded-full bg-muted" style={{ animationDelay: `${d}s` }} />
            ))}
          </Animated>
          <Animated motion="rise" delay={1.4} className="col-start-1 row-start-1 w-[380px] justify-self-start rounded-2xl rounded-bl-[4px] border border-line bg-surface px-3.5 py-3 text-sm leading-snug text-fg">
            <p>
              Done. I made a <strong>Clients</strong> table and added Maria.
            </p>
            <div className="mt-2.5 grid grid-cols-[1.15fr_1.1fr_0.85fr] overflow-hidden rounded-lg border border-line text-xs text-muted">
              {["Name", "Phone", "Last talked"].map((h) => (
                <span key={h} className="whitespace-nowrap border-b border-line/60 bg-bg px-2 py-1.5 font-semibold">
                  {h}
                </span>
              ))}
              <span className="whitespace-nowrap px-2 py-[7px] font-semibold text-fg">Maria Lopez</span>
              <span className="whitespace-nowrap px-2 py-[7px] text-fg">870-555-0142</span>
              <span className="whitespace-nowrap px-2 py-[7px] text-fg">Today</span>
            </div>
          </Animated>
        </div>
      </div>
    </Fit>
  );
}
