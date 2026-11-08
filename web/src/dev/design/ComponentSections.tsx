import { useState } from "react";
import { Calendar, Columns3, LayoutGrid, Plus, Share2, Trash2 } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { CaptureChip } from "@/components/ui/capture-chip";
import { Card } from "@/components/ui/card";
import { Checkbox, Switch } from "@/components/ui/checkbox";
import { ColorMark, type ColorMarkSize } from "@/components/ui/color-mark";
import { EmptyState } from "@/components/ui/empty-state";
import { FeedRow, FeedTile } from "@/components/ui/feed-row";
import { FilterBar, type FilterBarChip, type FilterBarSuggestion } from "@/components/ui/filter-bar";
import { FilterChip } from "@/components/ui/filter-chip";
import { HelpTip } from "@/components/ui/help-tip";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { LinkChip } from "@/components/ui/link-chip";
import { NavRow } from "@/components/ui/nav-row";
import { PropertyList, PropertyRow } from "@/components/ui/property-list";
import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { StatusChip } from "@/components/ui/status-chip";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TemporaryChangesBar } from "@/components/ui/temporary-changes-bar";
import { DESIGN_SECTIONS } from "../designSections";
import { Gallery, Group, noop, Section, State } from "./layout";

const byId = (id: string) => DESIGN_SECTIONS.find((s) => s.id === id)!;

/** A state that needs the keyboard, drawn with the classes the real state sets (`:focus-visible` in styles/index.css). */
const FOCUS = "outline-2 outline-offset-2 outline-ring";

const VARIANTS: ButtonVariant[] = ["primary", "soft", "secondary", "ghost", "danger", "link"];
/** What each variant looks like under the pointer, as classes, since a page cannot hold a real hover. */
const BUTTON_HOVER: Record<ButtonVariant, string> = {
  primary: "bg-primary-hover",
  soft: "bg-[color-mix(in_srgb,var(--primary)_18%,var(--surface))]",
  secondary: "bg-hover",
  ghost: "bg-hover",
  danger: "bg-danger-hover",
  link: "no-underline",
};

export function ButtonSection() {
  return (
    <Section
      section={byId("button")}
      note="Primary, Soft (Save as view), Secondary, Ghost, Danger, and a link-style button. Sizes 30, 34 and 40 on desktop; every size is 44 on phone."
    >
      {VARIANTS.map((v) => (
        <Group key={v} title={v[0]!.toUpperCase() + v.slice(1)}>
          <Gallery>
            <State label="Default">
              <Button variant={v}>Save</Button>
            </State>
            <State label="Hover">
              <Button variant={v} className={BUTTON_HOVER[v]}>
                Save
              </Button>
            </State>
            <State label="Focus">
              <Button variant={v} className={FOCUS}>
                Save
              </Button>
            </State>
            <State label="Disabled">
              <Button variant={v} disabled>
                Save
              </Button>
            </State>
            <State label="Loading">
              <Button variant={v} loading>
                Save
              </Button>
            </State>
          </Gallery>
        </Group>
      ))}
      <Group title="Sizes">
        <Gallery>
          <State label="sm · 30">
            <Button variant="primary" size="sm">
              Small
            </Button>
          </State>
          <State label="md · 34">
            <Button variant="primary" size="md">
              Default
            </Button>
          </State>
          <State label="lg · 40">
            <Button variant="primary" size="lg">
              Large
            </Button>
          </State>
          <State label="With an icon">
            <Button variant="secondary">
              <Icon icon={Plus} /> Add property
            </Button>
          </State>
        </Gallery>
      </Group>
    </Section>
  );
}

export function IconButtonSection() {
  return (
    <Section
      section={byId("icon-button")}
      note="34 px square on desktop, 44 on phone, transparent until hover. The label is the accessible name and the tooltip, and the type requires it."
    >
      {(["ghost", "secondary"] as const).map((variant) => (
        <Group key={variant} title={variant === "ghost" ? "Ghost (default)" : "Secondary"}>
          <Gallery>
            <State label="Default">
              <IconButton label="Add" variant={variant}>
                <Icon icon={Plus} />
              </IconButton>
            </State>
            <State label="Hover">
              <IconButton label="Add" variant={variant} className="bg-hover text-fg">
                <Icon icon={Plus} />
              </IconButton>
            </State>
            <State label="Focus">
              <IconButton label="Add" variant={variant} className={FOCUS}>
                <Icon icon={Plus} />
              </IconButton>
            </State>
            <State label="Disabled">
              <IconButton label="Add" variant={variant} disabled>
                <Icon icon={Plus} />
              </IconButton>
            </State>
          </Gallery>
        </Group>
      ))}
      <Group title="Sizes and help tip">
        <Gallery>
          <State label="sm · 30">
            <IconButton label="Share" size="sm">
              <Icon icon={Share2} />
            </IconButton>
          </State>
          <State label="md · 34">
            <IconButton label="Delete">
              <Icon icon={Trash2} />
            </IconButton>
          </State>
          <State label="HelpTip · opens a popover">
            <HelpTip label="About this setting">Words that explain a setting in a line or two.</HelpTip>
          </State>
        </Gallery>
      </Group>
    </Section>
  );
}

const MARK_SIZES: ColorMarkSize[] = [8, 10, 14, 24, 26, 28];
const MARK_HUES = ["blue", "cyan", "teal", "green", "yellow", "orange", "red", "pink", "purple", "gray"];

export function ColorMarkSection() {
  return (
    <Section
      section={byId("color-mark")}
      note="The colour that identifies a workspace, folder or collection: a solid rounded square with a hairline edge, always beside the name. Decorative, so hidden from assistive technology."
    >
      <Group title="Sizes · 8, 10, 14, 24, 26, 28">
        <div className="flex flex-wrap items-end gap-4">
          {MARK_SIZES.map((s) => (
            <State key={s} label={`${s}`}>
              <ColorMark hue="blue" size={s} />
            </State>
          ))}
        </div>
      </Group>
      <Group title="Hues beside a name">
        <ul className="m-0 grid list-none grid-cols-2 gap-x-4 gap-y-2 p-0 max-md:grid-cols-1">
          {MARK_HUES.map((h) => (
            <li key={h} className="flex items-center gap-2 text-ui">
              <ColorMark hue={h} size={14} />
              {h[0]!.toUpperCase() + h.slice(1)}
            </li>
          ))}
        </ul>
      </Group>
      <Group title="No stored hue: the name picks one, so a mark is never blank">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-ui">
          {["Tasks", "Projects", "Contacts", "Notes"].map((name) => (
            <span key={name} className="flex items-center gap-2">
              <ColorMark hue={null} name={name} size={14} />
              {name}
            </span>
          ))}
        </div>
      </Group>
    </Section>
  );
}

export function NavRowSection() {
  return (
    <Section section={byId("nav-row")} note="34 px, radius 8: mark, name, optional count. The selected row is filled and announced as the current page.">
      <div className="flex max-w-64 flex-col gap-2">
        <State label="Default" className="w-full">
          <NavRow hue="blue" count={12}>
            Tasks
          </NavRow>
        </State>
        <State label="Hover" className="w-full">
          <NavRow hue="green" count={4} className="bg-hover">
            Projects
          </NavRow>
        </State>
        <State label="Selected" className="w-full">
          <NavRow hue="purple" count={31} selected>
            Contacts
          </NavRow>
        </State>
        <State label="Disabled" className="w-full">
          <NavRow hue="gray" disabled>
            Archive
          </NavRow>
        </State>
        <State label="No mark, long name" className="w-full">
          <NavRow count={1200}>A collection with a very long name that truncates</NavRow>
        </State>
      </div>
    </Section>
  );
}

export function StatusChipSection() {
  return (
    <Section section={byId("status-chip")} note="A pill in the choice's own pastel pair, 12 px medium. The colour means the value.">
      <Gallery>
        <State label="Done">
          <StatusChip hue="green">Done</StatusChip>
        </State>
        <State label="In progress">
          <StatusChip hue="blue">In progress</StatusChip>
        </State>
        <State label="Overdue">
          <StatusChip hue="red">Overdue</StatusChip>
        </State>
        <State label="Dark variant">
          <StatusChip hue="orange_dark">Blocked</StatusChip>
        </State>
        <State label="No hue">
          <StatusChip>Unsorted</StatusChip>
        </State>
        <State label="Truncated" className="w-32">
          <StatusChip hue="purple">A choice with a very long name</StatusChip>
        </State>
      </Gallery>
    </Section>
  );
}

export function FilterChipSection() {
  return (
    <Section section={byId("filter-chip")} note="A filter that is on, inside the filter bar: radius 6, accent-soft fill and line, with its own remove button.">
      <Gallery>
        <State label="Default">
          <FilterChip>Status is Done</FilterChip>
        </State>
        <State label="Removable">
          <FilterChip onRemove={noop}>Status is Done</FilterChip>
        </State>
        <State label="Editable and removable">
          <FilterChip onEdit={noop} onRemove={noop}>
            Due before Friday
          </FilterChip>
        </State>
        <State label="Selected (next Backspace removes it)">
          <FilterChip onRemove={noop} selected>
            Assignee is me
          </FilterChip>
        </State>
        <State label="Truncated" className="w-40">
          <FilterChip onRemove={noop}>Description contains a long phrase</FilterChip>
        </State>
      </Gallery>
    </Section>
  );
}

export function LinkChipSection() {
  return (
    <Section section={byId("link-chip")} note="A linked record: radius 6, page-ground fill, a line, the linked collection's 8 px mark, the record's name. Opens that record.">
      <Gallery>
        <State label="Static">
          <LinkChip name="Quarterly plan" hue="blue" />
        </State>
        <State label="Link">
          <LinkChip name="Quarterly plan" hue="blue" href="#link-chip" />
        </State>
        <State label="Button">
          <LinkChip name="Ada Lovelace" hue="purple" onOpen={noop} />
        </State>
        <State label="Removable">
          <LinkChip name="Launch checklist" hue="green" onOpen={noop} onRemove={noop} />
        </State>
        <State label="No mark">
          <LinkChip name="Plain record" />
        </State>
        <State label="Untitled record">
          <LinkChip name="" hue="gray" />
        </State>
      </Gallery>
    </Section>
  );
}

export function CaptureChipSection() {
  return (
    <Section section={byId("capture-chip")} note="A pill, 30 px (36 on phone), saying what the app chose for a capture. Tap to change. The dashed variant adds a property.">
      <Gallery>
        <State label="Default">
          <CaptureChip hue="blue">Goes to Tasks</CaptureChip>
        </State>
        <State label="Hover">
          <CaptureChip hue="blue" className="bg-hover">
            Goes to Tasks
          </CaptureChip>
        </State>
        <State label="Dashed">
          <CaptureChip dashed>
            <Icon icon={Plus} size="sm" /> Add due date
          </CaptureChip>
        </State>
        <State label="Focus">
          <CaptureChip hue="green" className={FOCUS}>
            Due today
          </CaptureChip>
        </State>
        <State label="Disabled">
          <CaptureChip hue="blue" disabled>
            Goes to Tasks
          </CaptureChip>
        </State>
      </Gallery>
    </Section>
  );
}

export function CardSection() {
  return (
    <Section section={byId("card")} note="Surface fill, a 1 px line, radius 12 (16 on phone), no shadow.">
      <State label="Padded" className="w-full">
        <Card className="w-full">
          <p className="text-h3">Today</p>
          <p className="mt-1 text-label text-muted">Three things are due and one needs a reply.</p>
        </Card>
      </State>
      <State label="Holding rows (padded off)" className="w-full">
        <Card padded={false} className="w-full divide-y divide-line">
          <FeedRow title="Send the invoice" meta="Tasks" metaHue="blue" trailing="Today" />
          <FeedRow title="Call the printer" meta="Tasks" metaHue="blue" trailing="Fri" />
        </Card>
      </State>
      <State label="Empty" className="w-full">
        <Card className="w-full">
          <EmptyState title="Nothing due today." />
        </Card>
      </State>
    </Section>
  );
}

export function FeedRowSection() {
  const [done, setDone] = useState(false);
  return (
    <Section section={byId("feed-row")} note="One line of a feed: 44 px tall, 56 on phone. Leading control, title (500), a meta line with an 8 px mark, a trailing date.">
      <Card padded={false} className="w-full divide-y divide-line">
        <FeedRow leading={<FeedTile hue="blue" />} title="Quarterly plan" meta="Notes" metaHue="teal" trailing="2:14 pm" onOpen={noop} />
        <FeedRow
          leading={
            <span className="flex size-8 items-center justify-center">
              <Checkbox checked={done} onCheckedChange={setDone} label={<span className="sr-only">Mark Send the invoice done</span>} />
            </span>
          }
          title="Send the invoice"
          meta="Tasks"
          metaHue="blue"
          trailing="Today"
          onOpen={noop}
        />
        <FeedRow className="bg-hover" leading={<FeedTile hue="orange" />} title="Meeting notes (hover)" meta="Notes" metaHue="orange" trailing="Mon" onOpen={noop} />
        <FeedRow leading={<FeedTile hue="gray" />} title="A record whose title is far too long to fit on the line and keeps going" meta="Inbox" trailing="Nov 8" />
      </Card>
      <Group title="Loading">
        <div aria-busy className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-8 shrink-0" />
              <div className="flex-1">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="mt-1.5 h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      </Group>
      <Group title="Empty">
        <EmptyState title="Nothing here yet." className="py-4" />
      </Group>
    </Section>
  );
}

export function PropertyListSection() {
  return (
    <Section section={byId("property-list")} note="Two columns: 160 px labels (13 px, muted) and values on 36 px rows. On phone the label column is 116 px and rows are 44.">
      <Card>
        <PropertyList>
          <PropertyRow label="Status">
            <StatusChip hue="blue">In progress</StatusChip>
          </PropertyRow>
          <PropertyRow label="Assignee">
            <span className="flex items-center gap-2">
              <Avatar name="Ada Lovelace" size="sm" />
              Ada Lovelace
            </span>
          </PropertyRow>
          <PropertyRow label="Due">
            <span className="num">Nov 14, 2026</span>
          </PropertyRow>
          <PropertyRow label="Project">
            <LinkChip name="Quarterly plan" hue="blue" onOpen={noop} />
          </PropertyRow>
          <PropertyRow label="Notes">
            <span className="text-faint">Empty</span>
          </PropertyRow>
          <PropertyRow label="Estimate">
            <span className="text-danger">Not a number</span>
          </PropertyRow>
          <PropertyRow label="A label that is too long to fit">
            <span className="block truncate">Long values truncate with their editor</span>
          </PropertyRow>
        </PropertyList>
      </Card>
    </Section>
  );
}

const SUGGESTIONS: FilterBarSuggestion[] = [
  { id: "status-done", label: "Status is Done", hint: "Status" },
  { id: "status-open", label: "Status is not Done", hint: "Status" },
  { id: "due-week", label: "Due this week", hint: "Due" },
  { id: "assignee-me", label: "Assignee is me", hint: "Assignee" },
];

function FilterBarDemo({ initial, label }: { initial: FilterBarChip[]; label: string }) {
  const [chips, setChips] = useState(initial);
  const [text, setText] = useState("");
  const shown = text ? SUGGESTIONS.filter((s) => String(s.label).toLowerCase().includes(text.toLowerCase())) : SUGGESTIONS;
  return (
    <FilterBar
      label={label}
      chips={chips}
      onRemoveChip={(id) => setChips((cur) => cur.filter((c) => c.id !== id))}
      text={text}
      onTextChange={setText}
      suggestions={shown}
      onApplySuggestion={(s) => {
        setChips((cur) => [...cur, { id: s.id, label: String(s.label) }]);
        setText("");
      }}
      footerAction={{ label: "Advanced filter", onSelect: noop }}
      className="w-full"
    />
  );
}

export function FilterBarSection() {
  return (
    <Section
      section={byId("filter-bar")}
      note="One field holding filter chips, then free text, with a suggestion popover underneath. These are live: click into a field, use the arrow keys, press Enter. Backspace on an empty field picks the last chip. With focus the border is 2 px blue."
    >
      <State label="Empty" className="w-full">
        <FilterBarDemo label="Filter, empty" initial={[]} />
      </State>
      <State label="With filters on" className="w-full">
        <FilterBarDemo
          label="Filter, with filters"
          initial={[
            { id: "a", label: "Status is Done" },
            { id: "b", label: "Due this week" },
          ]}
        />
      </State>
      <State label="Focus ring, drawn" className="w-full">
        <div className="flex min-h-control-md w-full flex-wrap items-center gap-1.5 rounded-md border border-primary bg-surface py-1 pl-2.5 pr-2 ring-1 ring-inset ring-primary max-md:min-h-control-touch">
          <FilterChip onRemove={noop}>Status is Done</FilterChip>
          <span className="text-ui text-faint">Add a filter</span>
        </div>
      </State>
    </Section>
  );
}

export function TemporaryChangesBarSection() {
  return (
    <Section
      section={byId("temporary-changes-bar")}
      note="A subtle-grey strip: the count, the reminder, Reset (ghost) and Save as view (soft). Keep it mounted and flip open, so the change is announced."
    >
      <State label="Filter" className="w-full">
        <TemporaryChangesBar shown={3} total={12} onReset={noop} onSaveAsView={noop} />
      </State>
      <State label="A change that adds no count" className="w-full">
        <TemporaryChangesBar summary="Sorted by Due date." note="This sort is only for now." onReset={noop} onSaveAsView={noop} />
      </State>
      <State label="A person who may not make views" className="w-full">
        <TemporaryChangesBar shown={0} total={12} onReset={noop} />
      </State>
      <State label="Closed (the live region stays in the page)" className="w-full">
        <TemporaryChangesBar open={false} onReset={noop} />
      </State>
    </Section>
  );
}

export function TabsSection() {
  const [value, setValue] = useState("grid");
  return (
    <Section section={byId("tabs")} note="Text tabs with a 2 px underline on the selected one and a 15 px layout icon, because the icon says how the data is shown.">
      <State label="Selected, default, hover, disabled" className="w-full">
        <Tabs value={value} onValueChange={setValue} className="w-full">
          <TabsList>
            <TabsTrigger value="grid" icon={<Icon icon={LayoutGrid} size="fit" />}>
              Grid
            </TabsTrigger>
            <TabsTrigger value="board" icon={<Icon icon={Columns3} size="fit" />}>
              Board
            </TabsTrigger>
            <TabsTrigger value="calendar" icon={<Icon icon={Calendar} size="fit" />} className="text-fg">
              Calendar
            </TabsTrigger>
            <TabsTrigger value="timeline" disabled className="opacity-50">
              Timeline
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </State>
      <State label="Without icons" className="w-full">
        <Tabs defaultValue="all" className="w-full">
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="mine">Assigned to me</TabsTrigger>
          </TabsList>
        </Tabs>
      </State>
    </Section>
  );
}

export function EmptyStateSection() {
  return (
    <Section section={byId("empty-state")} note="One sentence on what goes here and one primary action. No illustrations.">
      <Card>
        <EmptyState
          title="No records yet."
          action={
            <Button variant="primary">
              <Icon icon={Plus} /> Add a record
            </Button>
          }
        />
      </Card>
      <Card>
        <EmptyState title="Nothing matches this filter." description="Remove a filter, or save the ones you have as a view to come back to them." action={<Button variant="secondary">Reset filters</Button>} />
      </Card>
      <Card>
        <EmptyState title="No comments yet." />
      </Card>
    </Section>
  );
}

export function SkeletonSection() {
  return (
    <Section section={byId("skeleton")} note="Loading placeholders in the shape of the content. No spinners on page loads. They are hidden from assistive technology; the container says aria-busy.">
      <Card>
        <div aria-busy className="flex flex-col gap-4">
          <Skeleton className="h-6 w-1/2" />
          <SkeletonLines lines={3} />
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-pill" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
      </Card>
      <Card padded={false} className="divide-y divide-line">
        {[0, 1, 2].map((i) => (
          <div key={i} aria-busy className="flex min-h-row-feed items-center gap-3 px-2 max-md:min-h-row-feed-phone">
            <Skeleton className="size-8 shrink-0" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="ml-auto h-3 w-12" />
          </div>
        ))}
      </Card>
    </Section>
  );
}

function ControlsDemo() {
  const [checked, setChecked] = useState(true);
  const [off, setOff] = useState(false);
  const [on, setOn] = useState(true);
  return (
    <>
      <Group title="Text input">
        <div className="flex max-w-80 flex-col gap-3">
          <State label="Default" className="w-full">
            <Input aria-label="Default" placeholder="Placeholder" />
          </State>
          <State label="Hover" className="w-full">
            <Input aria-label="Hover" defaultValue="Some text" className="border-faint" />
          </State>
          <State label="Focus" className="w-full">
            <Input aria-label="Focus" defaultValue="Some text" className="border-ring outline-2 -outline-offset-1 outline-ring" />
          </State>
          <State label="Disabled" className="w-full">
            <Input aria-label="Disabled" defaultValue="Some text" disabled />
          </State>
          <State label="Error" className="w-full">
            <Input aria-label="Error" defaultValue="not-an-email" aria-invalid />
          </State>
          <State label="Textarea" className="w-full">
            <Textarea aria-label="Textarea" placeholder="A few lines" />
          </State>
          <State label="Select" className="w-full">
            <Select aria-label="Select" defaultValue="b">
              <option value="a">Option A</option>
              <option value="b">Option B</option>
            </Select>
          </State>
        </div>
      </Group>
      <Group title="Field: label, hint and error">
        <div className="flex max-w-80 flex-col gap-3">
          <Field label="Name" hint="Shown in the sidebar.">
            {(ctl) => <Input {...ctl} defaultValue="Tasks" />}
          </Field>
          <Field label="Email" error="Enter an email address like name@example.com.">
            {(ctl) => <Input {...ctl} defaultValue="name@" />}
          </Field>
        </div>
      </Group>
      <Group title="Checkbox and switch">
        <Gallery>
          <State label="Checked">
            <Checkbox checked={checked} onCheckedChange={setChecked} label="Done" />
          </State>
          <State label="Unchecked">
            <Checkbox checked={false} onCheckedChange={noop} label="Done" />
          </State>
          <State label="Disabled">
            <Checkbox checked={false} onCheckedChange={noop} label="Done" disabled />
          </State>
          <State label="Switch off">
            <Switch checked={off} onCheckedChange={setOff} label="Notify me" />
          </State>
          <State label="Switch on">
            <Switch checked={on} onCheckedChange={setOn} label="Notify me" />
          </State>
          <State label="Switch disabled">
            <Switch checked={false} onCheckedChange={noop} label="Notify me" disabled />
          </State>
        </Gallery>
      </Group>
    </>
  );
}

export function FormControlsSection() {
  return (
    <Section section={byId("form-controls")} note="Inputs are at least 16 px on touch screens, so iOS does not zoom the page on focus.">
      <ControlsDemo />
    </Section>
  );
}

export function AvatarSpinnerSection() {
  return (
    <Section section={byId("avatar-spinner")} note="An avatar is white initials on a solid circle of the person's colour. A spinner is for a small wait inside a control, never for a page load.">
      <Group title="Avatar">
        <Gallery>
          <State label="sm">
            <Avatar name="Ada Lovelace" size="sm" />
          </State>
          <State label="md">
            <Avatar name="Grace Hopper" size="md" />
          </State>
          <State label="lg">
            <Avatar name="Alan Turing" size="lg" />
          </State>
          <State label="Own face">
            <Avatar name="Luke Wilson" own />
          </State>
          <State label="Email only">
            <Avatar email="margaret.hamilton@example.com" />
          </State>
        </Gallery>
      </Group>
      <Group title="Spinner">
        <Gallery>
          <State label="Default">
            <Spinner />
          </State>
          <State label="In a button">
            <Button variant="secondary" loading>
              Saving
            </Button>
          </State>
        </Gallery>
      </Group>
    </Section>
  );
}
