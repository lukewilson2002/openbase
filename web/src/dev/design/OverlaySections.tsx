import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorMark } from "@/components/ui/color-mark";
import { CommandPalette, type CommandGroup } from "@/components/ui/command-palette";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FeedTile } from "@/components/ui/feed-row";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Field, Input } from "@/components/ui/input";
import { ListboxOption } from "@/components/ui/listbox";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { PropertyList, PropertyRow } from "@/components/ui/property-list";
import { Sheet } from "@/components/ui/sheet";
import { SidePanel } from "@/components/ui/side-panel";
import { ToastView, useToast, type ToastItem } from "@/components/ui/toast";
import { DESKTOP_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";
import { DESIGN_SECTIONS } from "../designSections";
import { Frame, Group, noop, Section, State } from "./layout";

const byId = (id: string) => DESIGN_SECTIONS.find((s) => s.id === id)!;

/** A modal piece drawn open inside a frame has to cover the frame on phone; the viewport it would use is the whole screen's. */
const FILL_FRAME = "top-0! h-full!";
/** Stops a piece drawn open from taking focus, which would scroll the page to the last one. */
const keepFocus = (e: Event) => e.preventDefault();

export function PopoverMenuSection() {
  const [sort, setSort] = useState("due");
  return (
    <Section
      section={byId("popover-menu")}
      note="One floating surface: radius 12, the shadow, 6 px padding, rows of 40 px (44 on phone) with the highlighted row in accent-soft. Shown open in a frame; the real components, held open."
    >
      <Group title="Menu">
        <Frame height="24rem" scrim={false}>
          <div className="p-4">
            <DropdownMenu open modal={false} onOpenChange={noop}>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary">Collection actions</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Tasks</DropdownMenuLabel>
                <DropdownMenuItem className="bg-primary-soft">
                  <Icon icon={Pencil} /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem>Duplicate</DropdownMenuItem>
                <DropdownMenuItem disabled>Move to folder</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
                  <DropdownMenuRadioItem value="due">Sort by due date</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="name">Sort by name</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem danger>Delete collection</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </Frame>
      </Group>
      <Group title="Popover holding a form">
        <Frame height="13rem" scrim={false}>
          <div className="p-4">
            <Popover open onOpenChange={noop}>
              <PopoverAnchor asChild>
                <Button variant="secondary">Rename</Button>
              </PopoverAnchor>
              <PopoverContent onOpenAutoFocus={keepFocus} className="p-3">
                <Field label="Name">{(ctl) => <Input {...ctl} defaultValue="Tasks" />}</Field>
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="ghost" size="sm">
                    Cancel
                  </Button>
                  <Button variant="primary" size="sm">
                    Save
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </Frame>
      </Group>
      <Group title="Popover holding options (the filter bar's suggestions)">
        <Frame height="16rem" scrim={false}>
          <div className="p-4">
            <Popover open onOpenChange={noop}>
              <PopoverAnchor asChild>
                <span className="inline-block rounded-md border border-primary bg-surface px-3 py-1.5 text-ui ring-1 ring-inset ring-primary">due</span>
              </PopoverAnchor>
              <PopoverContent onOpenAutoFocus={keepFocus}>
                <div role="listbox" aria-label="Suggestions">
                  <ListboxOption id="demo-s1" active onSelect={noop} hint="Due">
                    Due this week
                  </ListboxOption>
                  <ListboxOption id="demo-s2" active={false} onSelect={noop} hint="Due">
                    Due before today
                  </ListboxOption>
                  <ListboxOption id="demo-s3" active={false} onSelect={noop} hint="Due">
                    Due is empty
                  </ListboxOption>
                  <div aria-hidden className="-mx-1.5 my-1.5 h-px bg-line" />
                  <ListboxOption id="demo-s4" active={false} onSelect={noop}>
                    Advanced filter
                  </ListboxOption>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </Frame>
      </Group>
    </Section>
  );
}

export function SheetSection() {
  return (
    <Section
      section={byId("sheet")}
      note="The phone's bottom sheet: radius 16 on top, a 36 by 5 grab handle, title and Done, over the dimmed screen. Hold the handle or title and it follows the finger. Shown in a phone-width frame."
    >
      <Frame height="26rem" width="24.375rem">
        <Sheet
          open
          onOpenChange={noop}
          title="View options"
          description="Changes here are only for now."
          onOpenAutoFocus={keepFocus}
          footer={
            <>
              <Button variant="secondary">Reset</Button>
              <Button variant="soft">Save as view</Button>
            </>
          }
        >
          <PropertyList>
            <PropertyRow label="Layout">Grid</PropertyRow>
            <PropertyRow label="Sorted by">Due date</PropertyRow>
            <PropertyRow label="Grouped by">Status</PropertyRow>
            <PropertyRow label="Hidden">2 properties</PropertyRow>
          </PropertyList>
        </Sheet>
      </Frame>
    </Section>
  );
}

export function SidePanelSection() {
  return (
    <Section section={byId("side-panel")} note="The desktop right panel, 360 px, for comments and history. It sits in the page's layout, so it is not modal. On phone the same content goes in a sheet.">
      <div className="flex h-72 justify-end overflow-hidden rounded-lg border border-line bg-bg">
        <SidePanel
          open
          onOpenChange={noop}
          title="Comments"
          className="max-w-full"
          actions={
            <IconButton label="Add comment" noTooltip>
              <Icon icon={Plus} />
            </IconButton>
          }
        >
          <ul className="m-0 flex list-none flex-col gap-4 p-4">
            <li>
              <p className="text-label font-semibold">Ada Lovelace</p>
              <p className="text-ui">Moved the launch to Friday.</p>
              <p className="text-meta text-muted">Today, 2:14 pm</p>
            </li>
            <li>
              <p className="text-label font-semibold">Grace Hopper</p>
              <p className="text-ui">Thanks, I'll update the plan.</p>
              <p className="text-meta text-muted">Today, 2:20 pm</p>
            </li>
          </ul>
        </SidePanel>
      </div>
      <Group title="Empty">
        <div className="flex h-56 justify-end overflow-hidden rounded-lg border border-line bg-bg">
          <SidePanel open onOpenChange={noop} title="History" className="max-w-full">
            <EmptyState title="No changes yet." />
          </SidePanel>
        </div>
      </Group>
    </Section>
  );
}

export function DialogSection() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  return (
    <Section
      section={byId("dialog")}
      note="Centered on desktop, a full-screen sheet on phone; a confirmation is a bottom sheet on phone. Only for confirmations and short forms. The layout follows this page's width."
    >
      <Group title="Dialog with a short form">
        <Frame height="24rem">
          <Dialog
            open
            onOpenChange={noop}
            title="New collection"
            description="Name it for what it holds."
            className={desktop ? undefined : FILL_FRAME}
            footer={
              <>
                <Button variant="secondary">Cancel</Button>
                <Button variant="primary">Create collection</Button>
              </>
            }
          >
            <Field label="Name">{(ctl) => <Input {...ctl} defaultValue="Tasks" />}</Field>
          </Dialog>
        </Frame>
      </Group>
      <Group title="ConfirmDialog, destructive">
        <Frame height="18rem">
          <ConfirmDialog open onOpenChange={noop} title="Delete Tasks?" description="Its 31 records move to the trash for 30 days." confirmLabel="Delete collection" destructive onConfirm={noop} />
        </Frame>
      </Group>
    </Section>
  );
}

const PALETTE_GROUPS: CommandGroup[] = [
  {
    id: "records",
    label: "Records",
    items: [
      { id: "r1", label: "Quarterly plan", leading: <FeedTile hue="blue" className="size-6" />, hint: "Notes", onSelect: noop },
      { id: "r2", label: "Send the invoice", leading: <FeedTile hue="green" className="size-6" />, hint: "Tasks", onSelect: noop },
    ],
  },
  {
    id: "collections",
    label: "Collections",
    items: [
      { id: "c1", label: "Tasks", leading: <ColorMark hue="blue" size={14} />, onSelect: noop },
      { id: "c2", label: "Contacts", leading: <ColorMark hue="purple" size={14} />, onSelect: noop },
    ],
  },
  { id: "actions", label: "Actions", items: [{ id: "a1", label: "New collection", leading: <Icon icon={Plus} className="text-muted" />, onSelect: noop }] },
];

function PaletteDemo({ query: initial }: { query: string }) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [query, setQuery] = useState(initial);
  const q = query.trim().toLowerCase();
  const groups = PALETTE_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.label.toLowerCase().includes(q)) }));
  return <CommandPalette open onOpenChange={noop} query={query} onQueryChange={setQuery} groups={groups} className={desktop ? "top-4 max-h-[calc(100%-2rem)] w-[calc(100%-2rem)]" : FILL_FRAME} />;
}

export function CommandPaletteSection() {
  return (
    <Section
      section={byId("command-palette")}
      note="Ctrl K or Cmd K. A field above grouped results, driven from the keyboard: arrows move through the results, Enter runs one. Centered near the top on desktop, the whole screen on phone. These are live."
    >
      <Group title="Results">
        <Frame height="26rem">
          <PaletteDemo query="" />
        </Frame>
      </Group>
      <Group title="Nothing matches">
        <Frame height="16rem">
          <PaletteDemo query="zzz" />
        </Frame>
      </Group>
    </Section>
  );
}

function ToastDemo({ item }: { item: Omit<ToastItem, "id"> }) {
  // A dismissed toast comes back, so the example can be pressed again.
  const [n, setN] = useState(0);
  return <ToastView key={n} item={{ ...item, id: n, durationMs: 0 }} onDismiss={() => setN((x) => x + 1)} />;
}

function ShowToastButtons() {
  const { toast, error } = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" onClick={() => toast({ title: "Moved to Tasks", action: { label: "Undo", onClick: noop } })}>
        Show a toast
      </Button>
      <Button variant="secondary" size="sm" onClick={() => error(new Error("The server did not answer."), "Could not save")}>
        Show an error
      </Button>
    </div>
  );
}

export function ToastSection() {
  return (
    <Section
      section={byId("toast")}
      note="Bottom-left on desktop, above the bottom navigation on phone. Undo where the action can be undone. Waits while hovered or focused. These are held open; the buttons use the real provider."
    >
      <div className="flex max-w-[26rem] flex-col gap-3">
        <State label="Default" className="w-full">
          <ToastDemo item={{ title: "Saved" }} />
        </State>
        <State label="Success" className="w-full">
          <ToastDemo item={{ title: "Record added", variant: "success" }} />
        </State>
        <State label="With Undo" className="w-full">
          <ToastDemo item={{ title: "Moved to Tasks", action: { label: "Undo", onClick: noop } }} />
        </State>
        <State label="Two actions and a description" className="w-full">
          <ToastDemo
            item={{
              title: "Captured",
              description: "Goes to Tasks, due today.",
              actions: [
                { label: "Open", onClick: noop },
                { label: "Undo", onClick: noop },
              ],
            }}
          />
        </State>
        <State label="Error" className="w-full">
          <ToastDemo item={{ title: "Could not save", description: "The server did not answer.", variant: "error" }} />
        </State>
      </div>
      <Group title="The real provider">
        <ShowToastButtons />
      </Group>
    </Section>
  );
}
