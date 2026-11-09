import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Calendar, ChevronRight, Columns3, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CaptureChip } from "@/components/ui/capture-chip";
import { ColorMark } from "@/components/ui/color-mark";
import { FeedRow } from "@/components/ui/feed-row";
import { FilterChip } from "@/components/ui/filter-chip";
import { LinkChip } from "@/components/ui/link-chip";
import { NavRow } from "@/components/ui/nav-row";
import { PropertyList, PropertyRow } from "@/components/ui/property-list";
import { StatusChip } from "@/components/ui/status-chip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TemporaryChangesBar } from "@/components/ui/temporary-changes-bar";
import { cn } from "@/lib/cn";

/*
 * The intro's pictures (APP-3) are the app's own components drawn small: the same cards, chips, rows and color
 * marks a person meets on the real screens, so what the intro shows is what they will see. Nothing in them can be
 * used (`inert`) and none of it is read out: the step's text says everything.
 */

const noop = () => undefined;

/**
 * Draws a picture at its natural size and shrinks it (never grows it) to fit the stage. The pictures are laid out
 * in fixed pixels so the rows line up the way the real screens do; scaling the whole picture keeps that true on a
 * 320 px phone, where reflowing it would squeeze the cards.
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
    <div ref={ref} className="relative size-full overflow-hidden" aria-hidden inert>
      <div className="absolute left-1/2 top-1/2" style={{ width, height, transform: `translate(-50%, -50%) scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

/** Appears after `delay` seconds, one time (the app's rise-in; a fade under reduced motion). */
function Rise({ delay, className, children }: { delay: number; className?: string; children: ReactNode }) {
  const style: CSSProperties = { animationDelay: `${delay}s`, animationFillMode: "both" };
  return (
    <div className={cn("ob-rise-in", className)} style={style}>
      {children}
    </div>
  );
}

/** A line of text standing for a sentence. */
function Line({ className }: { className?: string }) {
  return <span className={cn("block h-2 rounded-pill bg-hover", className)} />;
}

function Box({ checked = false }: { checked?: boolean }) {
  return <span className={cn("size-4 rounded-xs border", checked ? "border-primary bg-primary" : "border-line-strong bg-surface")} />;
}

// ---- 1: Home and capture ------------------------------------------------------------------------

export function HomeArt() {
  return (
    <Fit width={420} height={212}>
      <div className="flex h-full flex-col gap-3">
        <Rise delay={0}>
          <Card className="p-3 shadow-pop">
            <p className="text-read">Call the vet tomorrow</p>
            <div className="mt-2 flex gap-2">
              <CaptureChip static hue="blue" markName="Tasks">
                Goes to Tasks
              </CaptureChip>
              <Rise delay={0.35}>
                <CaptureChip static>Due tomorrow</CaptureChip>
              </Rise>
            </div>
          </Card>
        </Rise>
        <div className="grid grid-cols-2 gap-3">
          <Rise delay={0.6}>
            <Card padded={false} className="py-1">
              <p className="px-2 pt-1 text-label font-semibold">Due soon</p>
              <FeedRow leading={<Box />} title="Call the vet" metaHue="blue" meta="Tasks" trailing="Tomorrow" />
              <FeedRow leading={<Box />} title="Renew passport" metaHue="orange" meta="Errands" trailing="Fri" />
            </Card>
          </Rise>
          <Rise delay={0.8}>
            <Card padded={false} className="py-1">
              <p className="px-2 pt-1 text-label font-semibold">Inbox</p>
              <FeedRow title="Gift ideas for Sam" meta="Draft" />
              <FeedRow title="Book the venue" meta="Draft" />
            </Card>
          </Rise>
        </div>
      </div>
    </Fit>
  );
}

// ---- 2: collections and record pages --------------------------------------------------------------

export function RecordsArt() {
  return (
    <Fit width={460} height={200}>
      <div className="flex h-full items-center gap-3">
        <Rise delay={0} className="w-[9.5rem] shrink-0">
          <Card padded={false} className="p-2">
            <div className="flex items-center gap-2 px-1 pb-2">
              <ColorMark hue="purple" size={14} />
              <span className="text-ui font-semibold">Clients</span>
            </div>
            {[true, false, false, false].map((open, i) => (
              <div key={i} className={cn("flex items-center gap-2 rounded-md px-2 py-2", open && "bg-primary-soft")}>
                <Line className={cn("w-12", open && "bg-primary-soft-line")} />
                <Line className="ml-auto w-5" />
              </div>
            ))}
          </Card>
        </Rise>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-faint" />
        <Rise delay={0.4} className="min-w-0 flex-1">
          <Card className="px-4 py-3">
            <p className="text-h2">Acme Co</p>
            <PropertyList className="mt-1">
              <PropertyRow label="Status">
                <StatusChip hue="green">Active</StatusChip>
              </PropertyRow>
              <PropertyRow label="Owner">Dana</PropertyRow>
              <PropertyRow label="Renewal">Nov 14</PropertyRow>
            </PropertyList>
            <div className="mt-2 flex flex-col gap-2 border-t border-line pt-3">
              <Line className="w-full" />
              <Line className="w-4/5" />
            </div>
          </Card>
        </Rise>
      </div>
    </Fit>
  );
}

// ---- 3: views and drafts --------------------------------------------------------------------------

export function ViewsArt() {
  return (
    <Fit width={420} height={220}>
      <div className="flex h-full flex-col gap-2">
        <div className="flex items-center gap-2.5 pb-1">
          <ColorMark hue="purple" size={24} />
          <span className="text-h2">Clients</span>
        </div>
        <Rise delay={0}>
          <Tabs value="grid">
            <TabsList>
              <TabsTrigger value="grid" icon={<Table2 />}>
                Everyone
              </TabsTrigger>
              <TabsTrigger value="board" icon={<Columns3 />}>
                Pipeline
              </TabsTrigger>
              <TabsTrigger value="calendar" icon={<Calendar />}>
                Renewals
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </Rise>
        <Rise delay={0.3}>
          <div className="flex h-control-lg items-center rounded-md border border-primary bg-surface px-2">
            <FilterChip>Status is Active</FilterChip>
          </div>
        </Rise>
        <Rise delay={0.6}>
          <TemporaryChangesBar shown={3} total={12} noun="clients" onReset={noop} onSaveAsView={noop} />
        </Rise>
      </div>
    </Fit>
  );
}

// ---- 4: workspaces and folders --------------------------------------------------------------------

export function WorkspacesArt() {
  return (
    <Fit width={420} height={200}>
      <div className="flex h-full items-center gap-3">
        <Rise delay={0} className="w-[10.5rem] shrink-0">
          <Card padded={false} className="flex flex-col gap-1 p-2">
            {[
              ["Personal", "blue"],
              ["Studio", "pink"],
              ["Family", "green"],
            ].map(([name, hue], i) => (
              <div key={name} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5", i === 0 && "bg-primary-soft")}>
                <ColorMark hue={hue} size={26} />
                <span className={cn("text-ui", i === 0 ? "font-semibold text-primary-ink" : "font-medium")}>{name}</span>
              </div>
            ))}
          </Card>
        </Rise>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-faint" />
        <Rise delay={0.4} className="min-w-0 flex-1">
          <Card padded={false} className="p-2">
            <NavRow hue="blue" selected>
              Tasks
            </NavRow>
            <NavRow hue="teal" count="12">
              Notes
            </NavRow>
            <p className="px-2 pb-1 pt-2 text-meta font-semibold text-muted">Folders</p>
            <NavRow hue="orange">Clients</NavRow>
            <div className="ml-4 border-l border-line pl-1">
              <NavRow hue="purple">Contacts</NavRow>
              <NavRow hue="red">Invoices</NavRow>
            </div>
          </Card>
        </Rise>
      </div>
    </Fit>
  );
}

// ---- 5: an assistant (optional) ---------------------------------------------------------------------

export function AssistantArt() {
  return (
    <Fit width={420} height={200}>
      <div className="flex h-full flex-col justify-center gap-3">
        <Rise delay={0} className="self-end">
          <p className="max-w-[17rem] rounded-lg bg-primary px-3 py-2 text-ui text-primary-fg">Add a Clients collection with a Status property</p>
        </Rise>
        <Rise delay={0.5} className="self-start">
          <div className="flex max-w-[19rem] flex-col gap-2 rounded-lg border border-line bg-surface px-3 py-2">
            <p className="text-ui">Done. I made Clients in Personal.</p>
            <LinkChip name="Clients" hue="purple" markName="Clients" />
          </div>
        </Rise>
        <Rise delay={1} className="self-start">
          <Card className="flex items-center gap-3 px-3 py-2">
            <span className="text-label font-semibold">Access</span>
            <StatusChip hue="blue">Read and write</StatusChip>
            <Button variant="secondary" size="sm" tabIndex={-1}>
              Change
            </Button>
          </Card>
        </Rise>
      </div>
    </Fit>
  );
}
