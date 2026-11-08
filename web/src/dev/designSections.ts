/**
 * The sections of the design reference page (`/__dev/design`, DL-2): one per token family and one per core
 * component. The page, its test and the end-to-end spec all read this list, so a section cannot be added
 * without being checked in both themes. Plain data, no imports, so the e2e spec can use it too.
 */
export interface DesignSection {
  id: string;
  title: string;
  group: "Tokens" | "Components";
}

export const DESIGN_SECTIONS: readonly DesignSection[] = [
  { id: "colour", title: "Colour", group: "Tokens" },
  { id: "entity-colours", title: "Choice and entity colours", group: "Tokens" },
  { id: "type", title: "Type scale", group: "Tokens" },
  { id: "spacing", title: "Spacing", group: "Tokens" },
  { id: "radius", title: "Radius", group: "Tokens" },
  { id: "sizes", title: "Control, row and layout sizes", group: "Tokens" },
  { id: "elevation", title: "Elevation", group: "Tokens" },
  { id: "motion", title: "Motion", group: "Tokens" },
  { id: "icons", title: "Icons", group: "Tokens" },
  { id: "button", title: "Button", group: "Components" },
  { id: "icon-button", title: "IconButton", group: "Components" },
  { id: "color-mark", title: "ColorMark", group: "Components" },
  { id: "nav-row", title: "NavRow", group: "Components" },
  { id: "status-chip", title: "StatusChip", group: "Components" },
  { id: "filter-chip", title: "FilterChip", group: "Components" },
  { id: "link-chip", title: "LinkChip", group: "Components" },
  { id: "capture-chip", title: "CaptureChip", group: "Components" },
  { id: "card", title: "Card", group: "Components" },
  { id: "feed-row", title: "FeedRow", group: "Components" },
  { id: "property-list", title: "PropertyList", group: "Components" },
  { id: "filter-bar", title: "FilterBar", group: "Components" },
  { id: "temporary-changes-bar", title: "TemporaryChangesBar", group: "Components" },
  { id: "tabs", title: "Tabs", group: "Components" },
  { id: "popover-menu", title: "Popover and Menu", group: "Components" },
  { id: "sheet", title: "Sheet", group: "Components" },
  { id: "side-panel", title: "SidePanel", group: "Components" },
  { id: "dialog", title: "Dialog and ConfirmDialog", group: "Components" },
  { id: "command-palette", title: "CommandPalette", group: "Components" },
  { id: "empty-state", title: "EmptyState", group: "Components" },
  { id: "skeleton", title: "Skeleton", group: "Components" },
  { id: "toast", title: "Toast", group: "Components" },
  { id: "form-controls", title: "Form controls", group: "Components" },
  { id: "avatar-spinner", title: "Avatar and Spinner", group: "Components" },
];

export const DESIGN_THEMES = ["light", "dark"] as const;
