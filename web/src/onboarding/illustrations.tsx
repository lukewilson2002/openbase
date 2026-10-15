import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, Table2 } from "lucide-react";
import { cn } from "@/lib/cn";

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
 * would move the cells out from under the arrows.
 */
export function Fit({ width, height, children }: { width: number; height: number; children: ReactNode }) {
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
    <div ref={ref} className="relative size-full overflow-hidden" aria-hidden>
      <div className="absolute left-1/2 top-1/2" style={{ width, height, transform: `translate(-50%, -50%) scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

function Tile({ letter, color, className }: { letter: string; color: string; className?: string }) {
  return <span className={cn("choice inline-flex shrink-0 items-center justify-center rounded-lg font-semibold", `choice-${color}`, className)}>{letter}</span>;
}

// ---- Step 1: a base unfolds into its tables ------------------------------------------------------

const CHORE_TABLES = [
  { name: "Chores", count: "4 records" },
  { name: "Shopping list", count: "12 records" },
  { name: "Chore log", count: "30 records" },
];

export function BasesArt() {
  return (
    <Fit width={300} height={216}>
      <Animated motion="rise" delay={0.05} className="w-[300px] overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
        <div className="flex items-center gap-3 p-3">
          <Tile letter="C" color="green_dark" className="size-10 text-lg" />
          <div className="min-w-0 flex-1">
            <div className="text-[0.9375rem] font-semibold text-fg">Chores</div>
            <div className="text-xs text-muted">A base · 3 tables</div>
          </div>
          <Animated motion="turn" delay={0.6} duration={0.4} className="text-muted">
            <ChevronRight className="size-5" />
          </Animated>
        </div>
        <Animated motion="unfold" delay={0.9} duration={0.55} className="border-t border-line bg-subtle px-3 py-2">
          <div className="ml-4 flex flex-col gap-1.5 border-l-2 border-line pl-3">
            {CHORE_TABLES.map((t, i) => (
              <Animated key={t.name} motion="slide" delay={1.1 + i * 0.15} duration={0.4} className="flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-2.5">
                <Table2 className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium text-fg">{t.name}</span>
                <span className="shrink-0 text-xs text-muted">{t.count}</span>
              </Animated>
            ))}
          </div>
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
  { chore: "Change filters", who: "Sam", often: "Monthly", color: "purple" },
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
        <Animated motion="drop" delay={0.85} duration={0.4} className="absolute flex justify-center" style={{ left: whoMid - 50, top: 0, width: 100 }}>
          <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: "#fdecd2", color: AMBER_INK }}>
            A field
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
        <Animated motion="rise" delay={1.5} duration={0.4} className="absolute flex justify-center" style={{ left: recordX - 50, top: 228, width: 100 }}>
          <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: "#dfe8ff", color: "#1a44a8" }}>
            A record
          </span>
        </Animated>
      </div>
    </Fit>
  );
}

// ---- Step 3: two workspaces, each with its own people and bases ----------------------------------

const WORKSPACES = [
  {
    name: "Household",
    pill: "green",
    people: [
      { letter: "S", color: "orange" },
      { letter: "A", color: "purple" },
    ],
    bases: [
      { name: "Chores", letter: "C", color: "green_dark" },
      { name: "Budget", letter: "B", color: "yellow_dark" },
    ],
  },
  {
    name: "Side business",
    pill: "blue",
    people: [
      { letter: "S", color: "orange" },
      { letter: "J", color: "teal" },
    ],
    bases: [
      { name: "Clients", letter: "C", color: "blue_dark" },
      { name: "Invoices", letter: "I", color: "purple_dark" },
    ],
  },
];

export function WorkspacesArt() {
  return (
    <Fit width={396} height={204}>
      <div className="flex h-[204px] w-[396px] items-stretch">
        {WORKSPACES.map((w, wi) => (
          <div key={w.name} className="contents">
            {wi > 0 && (
              <div className="flex w-[36px] shrink-0 justify-center py-2">
                <Animated motion="grow-y" delay={0.45} className="h-full border-l-2 border-dashed border-line-strong" />
              </div>
            )}
            <Animated motion="pop" delay={0.05 + wi * 0.18} className="flex w-[180px] shrink-0 flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5 shadow-pop">
              <span className={cn("choice self-start rounded-full px-2.5 py-0.5 text-xs font-semibold", `choice-${w.pill}`)}>{w.name}</span>
              <div>
                <div className="text-[0.6875rem] font-medium text-muted">People</div>
                <div className="mt-1 flex">
                  {w.people.map((p, pi) => (
                    <Animated key={p.letter} motion="pop" delay={0.6 + wi * 0.18 + pi * 0.1} duration={0.4} className={cn(pi > 0 && "-ml-1.5")}>
                      <span className={cn("choice flex size-7 items-center justify-center rounded-full text-xs font-semibold ring-2 ring-[var(--surface)]", `choice-${p.color}`)}>{p.letter}</span>
                    </Animated>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[0.6875rem] font-medium text-muted">Bases</div>
                <div className="mt-1 flex flex-col gap-1.5">
                  {w.bases.map((b, bi) => (
                    <Animated key={b.name} motion="slide" delay={0.85 + wi * 0.18 + bi * 0.12} duration={0.4} className="flex items-center gap-2">
                      <Tile letter={b.letter} color={b.color} className="size-6 rounded-md text-xs" />
                      <span className="text-[0.8125rem] font-medium text-fg">{b.name}</span>
                    </Animated>
                  ))}
                </div>
              </div>
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
    <Fit width={420} height={224}>
      <div className="flex h-[224px] w-[420px] flex-col justify-center gap-3">
        <Animated motion="rise" delay={0.05} className="max-w-[300px] self-end rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-[0.8125rem] leading-snug text-primary-fg shadow-pop">
          Help me keep track of my clients and when I last talked to them
        </Animated>
        {/* The typing dots and the reply share one grid cell, so the reply takes the dots' place without a jump. */}
        <div className="grid">
          <Animated motion="typing" delay={0.6} className="col-start-1 row-start-1 flex gap-1 self-start justify-self-start rounded-2xl rounded-bl-md border border-line bg-surface px-3.5 py-3">
            {[0, 0.15, 0.3].map((d) => (
              <span key={d} className="ob-intro-dot size-1.5 rounded-full bg-muted" style={{ animationDelay: `${d}s` }} />
            ))}
          </Animated>
          <Animated motion="rise" delay={1.75} className="col-start-1 row-start-1 max-w-[372px] justify-self-start rounded-2xl rounded-bl-md border border-line bg-surface px-3.5 py-2.5 text-[0.8125rem] leading-snug text-fg shadow-pop">
            <p>
              Done. I made a <strong>Clients</strong> base with a table for them.
            </p>
            <div className="mt-2 grid grid-cols-3 overflow-hidden rounded-md border border-line text-[0.6875rem] font-semibold text-muted">
              {["Name", "Phone", "Last talked"].map((h, i) => (
                <div key={h} className={cn("bg-subtle px-2 py-1.5", i > 0 && "border-l border-line")}>
                  {h}
                </div>
              ))}
              {[0, 1, 2].map((i) => (
                <div key={i} className={cn("h-5 border-t border-line", i > 0 && "border-l")} />
              ))}
            </div>
          </Animated>
        </div>
      </div>
    </Fit>
  );
}
