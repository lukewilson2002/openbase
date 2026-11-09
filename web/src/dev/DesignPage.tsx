/**
 * The design reference page (UX overhaul DL-2): every token and every core component from
 * `components/ui`, in every state, with the light and dark themes side by side. Phase 7's screenshots
 * come from here. It is built in dev and, with VITE_DESIGN_PAGE=1, in the end-to-end build; a release build
 * leaves it out (see the route in App.tsx).
 */
import { Fragment } from "react";
import { DESIGN_SECTIONS } from "./designSections";
import { ButtonSection, AvatarSpinnerSection, CaptureChipSection, CardSection, ColorMarkSection, EmptyStateSection, FeedRowSection, FilterBarSection, FilterChipSection, FormControlsSection, IconButtonSection, LinkChipSection, NavRowSection, PropertyListSection, SkeletonSection, StatusChipSection, TabsSection, TemporaryChangesBarSection } from "./design/ComponentSections";
import { CommandPaletteSection, DialogSection, PopoverMenuSection, SheetSection, SidePanelSection, ToastSection } from "./design/OverlaySections";
import { ColourSection, ElevationSection, EntityColoursSection, IconsSection, MotionSection, RadiusSection, SizesSection, SpacingSection, TypeSection } from "./design/TokenSections";

/** In the order of DESIGN_SECTIONS, which is also the order of the index at the top. */
const SECTION_VIEWS: Record<string, () => React.JSX.Element> = {
  colour: ColourSection,
  "entity-colours": EntityColoursSection,
  type: TypeSection,
  spacing: SpacingSection,
  radius: RadiusSection,
  sizes: SizesSection,
  elevation: ElevationSection,
  motion: MotionSection,
  icons: IconsSection,
  button: ButtonSection,
  "icon-button": IconButtonSection,
  "color-mark": ColorMarkSection,
  "nav-row": NavRowSection,
  "status-chip": StatusChipSection,
  "filter-chip": FilterChipSection,
  "link-chip": LinkChipSection,
  "capture-chip": CaptureChipSection,
  card: CardSection,
  "feed-row": FeedRowSection,
  "property-list": PropertyListSection,
  "filter-bar": FilterBarSection,
  "temporary-changes-bar": TemporaryChangesBarSection,
  tabs: TabsSection,
  "popover-menu": PopoverMenuSection,
  sheet: SheetSection,
  "side-panel": SidePanelSection,
  dialog: DialogSection,
  "command-palette": CommandPaletteSection,
  "empty-state": EmptyStateSection,
  skeleton: SkeletonSection,
  toast: ToastSection,
  "form-controls": FormControlsSection,
  "avatar-spinner": AvatarSpinnerSection,
};

export default function DesignPage() {
  return (
    <main className="min-h-dvh bg-bg px-gutter pb-16 text-fg">
      <header className="mx-auto max-w-7xl py-8">
        <h1 className="text-title">Design reference</h1>
        <p className="mt-1 max-w-3xl text-ui text-muted">
          Every token and core component of the Notebook design language, in every state, with light and dark side by side. Resize the window to see the phone layouts: the page follows its own width. Dev and end-to-end builds only.
        </p>
        <nav aria-label="Sections" className="mt-4 flex flex-col gap-2 text-label">
          {(["Tokens", "Components"] as const).map((group) => (
            <p key={group} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-semibold text-muted">{group}</span>
              {DESIGN_SECTIONS.filter((s) => s.group === group).map((s) => (
                <a key={s.id} href={`#${s.id}`} className="inline-flex min-h-6 items-center">
                  {s.title}
                </a>
              ))}
            </p>
          ))}
        </nav>
      </header>
      <div className="mx-auto flex max-w-7xl flex-col gap-14">
        {DESIGN_SECTIONS.map((s) => {
          const View = SECTION_VIEWS[s.id];
          return <Fragment key={s.id}>{View ? <View /> : null}</Fragment>;
        })}
      </div>
    </main>
  );
}
