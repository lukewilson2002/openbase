import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Plus, Table2 } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { workspaceColor } from "@/lib/workspaceColor";
import { Button } from "./button";
import { CaptureChip } from "./capture-chip";
import { Card } from "./card";
import { ColorMark } from "./color-mark";
import { EmptyState } from "./empty-state";
import { FeedRow, FeedTile } from "./feed-row";
import { FilterChip } from "./filter-chip";
import { IconButton } from "./icon-button";
import { LinkChip } from "./link-chip";
import { NavRow } from "./nav-row";
import { PropertyList, PropertyRow } from "./property-list";
import { Skeleton, SkeletonLines } from "./skeleton";
import { StatusChip } from "./status-chip";
import { Tabs, TabsList, TabsTrigger } from "./tabs";

describe("Button", () => {
  it.each([
    ["primary", ["bg-primary", "text-primary-fg", "font-semibold"]],
    ["secondary", ["bg-surface", "border-line-strong"]],
    ["soft", ["bg-primary-soft", "text-primary-ink", "border-primary-soft-line"]],
    ["ghost", ["hover:bg-hover"]],
    ["danger", ["bg-danger", "text-danger-fg"]],
  ] as const)("has a %s variant", (variant, classes) => {
    render(<Button variant={variant}>Go</Button>);
    expect(screen.getByRole("button")).toHaveClass(...classes);
  });

  it.each([
    ["sm", "h-control-sm"],
    ["md", "h-control-md"],
    ["lg", "h-control-lg"],
  ] as const)("is 30, 34 or 40 tall by size (%s), and 44 on phone", (size, height) => {
    render(<Button size={size}>Go</Button>);
    expect(screen.getByRole("button")).toHaveClass(height, "max-md:h-control-touch");
  });

  it("renders a link with button styling", () => {
    render(
      <Button asChild variant="primary">
        <a href="/x">Open</a>
      </Button>,
    );
    expect(screen.getByRole("link", { name: "Open" })).toHaveClass("bg-primary");
  });
});

describe("IconButton", () => {
  it("is named by its label", () => {
    render(
      <IconButton label="Add property" noTooltip>
        <Plus />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Add property" })).toHaveAttribute("type", "button");
  });

  it("is transparent until hover, 34 px (30 small) and 44 on phone", () => {
    const { rerender } = render(
      <IconButton label="More" noTooltip>
        <Plus />
      </IconButton>,
    );
    const b = screen.getByRole("button");
    expect(b).toHaveClass("size-control-md", "max-md:size-control-touch", "hover:bg-hover", "rounded-md");
    expect(b).not.toHaveClass("bg-surface");
    rerender(
      <IconButton label="More" size="sm" noTooltip>
        <Plus />
      </IconButton>,
    );
    expect(screen.getByRole("button")).toHaveClass("size-control-sm");
  });

  it("cannot be written without a label", () => {
    // @ts-expect-error `label` is required: an icon alone gives the button no name
    const missing = <IconButton noTooltip>{null}</IconButton>;
    expect(missing).toBeTruthy();
  });
});

describe("ColorMark", () => {
  it("is decorative: hidden from assistive technology and empty", () => {
    const { container } = render(<ColorMark hue="teal" />);
    const mark = container.firstElementChild!;
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toBeEmptyDOMElement();
  });

  it("is filled with the hue's solid shade, and a dark variant shares its hue", () => {
    const { container, rerender } = render(<ColorMark hue="teal" />);
    expect(container.firstElementChild).toHaveClass("ob-hue-teal", "ob-solid", "ob-mark");
    rerender(<ColorMark hue="purple_dark" />);
    expect(container.firstElementChild).toHaveClass("ob-hue-purple", "ob-solid");
  });

  it.each([8, 10, 14, 24, 26, 28] as const)("has a %i px size class (radius comes with it from the tokens)", (size) => {
    const { container } = render(<ColorMark hue="blue" size={size} />);
    expect(container.firstElementChild).toHaveClass(`ob-mark-${size}`);
  });

  it("is 14 px by default", () => {
    const { container } = render(<ColorMark hue="blue" />);
    expect(container.firstElementChild).toHaveClass("ob-mark-14");
  });

  it("is never blank: without a stored hue it takes the one its name hashes to", () => {
    const expected = `ob-hue-${workspaceColor({ name: "Garden" }).replace(/_dark$/, "")}`;
    const { container, rerender } = render(<ColorMark name="Garden" />);
    expect(container.firstElementChild).toHaveClass(expected, "ob-solid");
    rerender(<ColorMark hue={null} name="Garden" />);
    expect(container.firstElementChild).toHaveClass(expected, "ob-solid");
    rerender(<ColorMark hue="not-a-colour" name="Garden" />);
    expect(container.firstElementChild).toHaveClass(expected, "ob-solid");
  });
});

describe("NavRow", () => {
  it("marks the selected row as the current one, and only that row", () => {
    render(
      <>
        <NavRow selected>Tasks</NavRow>
        <NavRow>Notes</NavRow>
      </>,
    );
    const selected = screen.getByRole("button", { name: "Tasks" });
    expect(selected).toHaveAttribute("aria-current", "page");
    expect(selected).toHaveClass("bg-primary-soft", "text-primary-ink", "font-semibold");
    expect(screen.getByRole("button", { name: "Notes" })).not.toHaveAttribute("aria-current");
  });

  it("is 34 px with a count at the right, and the mark is not part of its name", () => {
    render(
      <NavRow hue="green" count={12}>
        Tasks
      </NavRow>,
    );
    const row = screen.getByRole("button", { name: /^Tasks\s*12$/ });
    expect(row).toHaveClass("h-control-md", "rounded-md");
    expect(row.querySelector(".ob-mark-14.ob-hue-green")).toHaveAttribute("aria-hidden", "true");
    expect(row.lastElementChild).toHaveTextContent("12");
  });

  it("draws no mark unless a hue is given, and a fallback mark for null", () => {
    const { rerender, container } = render(<NavRow>Tasks</NavRow>);
    expect(container.querySelector(".ob-mark")).toBeNull();
    rerender(<NavRow hue={null}>Tasks</NavRow>);
    expect(container.querySelector(".ob-mark")).not.toBeNull();
  });

  it("styles a router link and keeps its structure", async () => {
    const onClick = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <NavRow asChild selected hue="blue" onClick={onClick}>
        <a href="/base/t1">Tasks</a>
      </NavRow>,
    );
    const link = screen.getByRole("link", { name: "Tasks" });
    expect(link).toHaveAttribute("href", "/base/t1");
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link.querySelector(".ob-mark-14")).not.toBeNull();
    await userEvent.click(link);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("StatusChip", () => {
  it("is a pill in the choice's hue pair", () => {
    render(<StatusChip hue="green">Done</StatusChip>);
    const chip = screen.getByText("Done").parentElement!;
    expect(chip).toHaveClass("choice", "choice-green", "rounded-pill", "font-medium");
  });
  it("falls back to gray for an unknown colour", () => {
    render(<StatusChip hue="nope">Later</StatusChip>);
    expect(screen.getByText("Later").parentElement).toHaveClass("choice-gray");
  });
});

describe("FilterChip", () => {
  it("has a remove button named for the filter", async () => {
    const onRemove = vi.fn();
    render(<FilterChip onRemove={onRemove}>Status is Done</FilterChip>);
    await userEvent.click(screen.getByRole("button", { name: "Remove Status is Done" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
  it("takes an explicit remove label when the text is not a plain string", () => {
    render(
      <FilterChip onRemove={() => {}} removeLabel="Remove the status filter">
        <b>Status</b> is Done
      </FilterChip>,
    );
    expect(screen.getByRole("button", { name: "Remove the status filter" })).toBeInTheDocument();
  });
  it("opens the filter for editing from its text, which is not a button otherwise", async () => {
    const onEdit = vi.fn();
    const { rerender } = render(<FilterChip onEdit={onEdit}>Due before Friday</FilterChip>);
    await userEvent.click(screen.getByRole("button", { name: "Due before Friday" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    rerender(<FilterChip>Due before Friday</FilterChip>);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("uses the accent-soft fill and line at radius 6", () => {
    render(<FilterChip>Text</FilterChip>);
    expect(screen.getByText("Text").parentElement).toHaveClass("rounded-sm", "bg-primary-soft", "border-primary-soft-line", "text-primary-ink");
  });
});

describe("LinkChip", () => {
  it("is plain text when it has nowhere to go", () => {
    render(<LinkChip name="Buy milk" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Buy milk")).toBeInTheDocument();
  });
  it("names an unnamed record Untitled", () => {
    render(<LinkChip name="" />);
    expect(screen.getByText("Untitled")).toBeInTheDocument();
  });
  it("opens the linked record through onOpen", async () => {
    const onOpen = vi.fn();
    render(<LinkChip name="Buy milk" onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: "Buy milk" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("opens it as a link when it has an address, ahead of onOpen", () => {
    render(<LinkChip name="Buy milk" href="/base/b/t/r/rec1" onOpen={() => {}} />);
    expect(screen.getByRole("link", { name: "Buy milk" })).toHaveAttribute("href", "/base/b/t/r/rec1");
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("runs onOpen on a plain click of its link, so the router navigates, and leaves the other ways of using a link to the browser", async () => {
    const onOpen = vi.fn();
    const onCard = vi.fn();
    render(
      <div onClick={onCard}>
        <LinkChip name="Buy milk" href="/base/b/t/r/rec1" onOpen={onOpen} />
      </div>,
    );
    const link = screen.getByRole("link", { name: "Buy milk" });
    await userEvent.click(link);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // A chip on a card is not also a click on the card.
    expect(onCard).not.toHaveBeenCalled();
    fireEvent.click(link, { ctrlKey: true });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("shows the collection's 8 px mark beside the name, not in it", () => {
    const { container } = render(<LinkChip name="Buy milk" hue="orange" onOpen={() => {}} />);
    expect(container.querySelector(".ob-mark-8.ob-hue-orange")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button")).toHaveAccessibleName("Buy milk");
  });
  it("removes the link from its own labelled button", async () => {
    const onRemove = vi.fn();
    render(<LinkChip name="Buy milk" onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove Buy milk" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
  it("sits on the page ground with a line at radius 6", () => {
    render(<LinkChip name="Buy milk" />);
    expect(screen.getByText("Buy milk").closest(".border")).toHaveClass("rounded-sm", "bg-bg", "border-line");
  });
});

describe("CaptureChip", () => {
  it("is a button that opens the choices", async () => {
    const onClick = vi.fn();
    render(<CaptureChip onClick={onClick}>Goes to Tasks</CaptureChip>);
    await userEvent.click(screen.getByRole("button", { name: "Goes to Tasks" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button")).toHaveClass("rounded-pill", "h-control-sm", "max-md:h-9", "border-line");
  });
  it("has a dashed variant for adding a property", () => {
    render(<CaptureChip dashed>Add due date</CaptureChip>);
    expect(screen.getByRole("button")).toHaveClass("border-dashed");
  });
  it("shows the target collection's 10 px mark", () => {
    const { container } = render(<CaptureChip hue="pink">Goes to Plans</CaptureChip>);
    expect(container.querySelector(".ob-mark-10.ob-hue-pink")).not.toBeNull();
  });
});

describe("Card", () => {
  it("is a bordered surface without a shadow, radius 12 (16 on phone)", () => {
    render(<Card data-testid="c">Body</Card>);
    const card = screen.getByTestId("c");
    expect(card).toHaveClass("rounded-lg", "max-md:rounded-xl", "border", "border-line", "bg-surface", "p-4");
    expect(card.className).not.toMatch(/shadow/);
  });
  it("drops its padding for content that brings its own", () => {
    render(
      <Card padded={false} data-testid="c">
        Body
      </Card>,
    );
    expect(screen.getByTestId("c")).not.toHaveClass("p-4");
  });
});

describe("FeedRow", () => {
  it("opens from the title, and a leading control does not", async () => {
    const onOpen = vi.fn();
    const onCheck = vi.fn();
    render(
      <FeedRow
        leading={<input type="checkbox" aria-label="Done" onChange={onCheck} />}
        title="Buy milk"
        meta="Tasks"
        metaHue="green"
        trailing="Today"
        onOpen={onOpen}
      />,
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Done" }));
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Buy milk/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("shows the meta line with an 8 px mark and a trailing time", () => {
    const { container } = render(<FeedRow title="Buy milk" meta="Tasks" metaHue="green" trailing="9:30" />);
    expect(container.querySelector(".ob-mark-8.ob-hue-green")).not.toBeNull();
    expect(screen.getByText("Tasks")).toHaveClass("truncate");
    expect(screen.getByText("9:30")).toHaveClass("text-meta", "text-muted");
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("is a link when it has an address", () => {
    render(<FeedRow title="Buy milk" href="/base/b/t/r/rec1" />);
    expect(screen.getByRole("link", { name: "Buy milk" })).toHaveAttribute("href", "/base/b/t/r/rec1");
  });
  it("runs onOpen on a plain click of its link, so a router can navigate, and leaves the other clicks to the browser", () => {
    const onOpen = vi.fn();
    render(<FeedRow title="Buy milk" href="/base/b/t/r/rec1" onOpen={onOpen} />);
    const link = screen.getByRole("link", { name: "Buy milk" });
    // A click that opens a new tab or window is the browser's.
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { button: 1 });
    expect(onOpen).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("is 44 px tall, 56 on phone", () => {
    const { container } = render(<FeedRow title="Buy milk" />);
    expect(container.firstElementChild).toHaveClass("min-h-row-feed", "max-md:min-h-row-feed-phone");
  });
  it("has a page glyph tile tinted with the hue, hidden from assistive technology", () => {
    const { container } = render(<FeedTile hue="purple" />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.firstElementChild).toHaveClass("ob-hue-purple", "ob-tint");
  });
});

describe("PropertyList", () => {
  it("is a description list: label, then value, per row", () => {
    render(
      <PropertyList>
        <PropertyRow label="Status">Done</PropertyRow>
        <PropertyRow label="Due">Friday</PropertyRow>
      </PropertyList>,
    );
    const terms = screen.getAllByRole("term");
    expect(terms.map((t) => t.textContent)).toEqual(["Status", "Due"]);
    expect(screen.getAllByRole("definition").map((d) => d.textContent)).toEqual(["Done", "Friday"]);
  });
  it("lays rows out at 160 px labels and 36 px (116 and 44 on phone)", () => {
    const { container } = render(
      <PropertyList>
        <PropertyRow label="Status">Done</PropertyRow>
      </PropertyList>,
    );
    const row = container.querySelector("dl > div")!;
    expect(row).toHaveClass("grid-cols-[10rem_minmax(0,1fr)]", "min-h-9", "max-md:grid-cols-[7.25rem_minmax(0,1fr)]", "max-md:min-h-control-touch");
  });
});

describe("Tabs", () => {
  it("selects with aria-selected and underlines the selected tab in the accent", async () => {
    render(
      <Tabs defaultValue="grid">
        <TabsList>
          <TabsTrigger value="grid" icon={<Table2 data-testid="icon" />}>
            Grid
          </TabsTrigger>
          <TabsTrigger value="board">Board</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const grid = screen.getByRole("tab", { name: "Grid" });
    expect(grid).toHaveAttribute("aria-selected", "true");
    expect(grid).toHaveClass("data-[state=active]:border-primary", "border-b-2");
    expect(screen.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "false");
    await userEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(screen.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
  });
  it("keeps the layout icon out of the tab's name", () => {
    render(
      <Tabs defaultValue="grid">
        <TabsList>
          <TabsTrigger value="grid" icon={<Table2 />}>
            Grid
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole("tab")).toHaveAccessibleName("Grid");
    expect(screen.getByRole("tab").querySelector("[aria-hidden='true']")).not.toBeNull();
  });
});

describe("EmptyState", () => {
  it("is a sentence and one action", () => {
    render(<EmptyState title="Records you add show up here." action={<Button variant="primary">Add record</Button>} />);
    expect(screen.getByRole("heading", { name: "Records you add show up here." })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
  it("draws no coloured disc around an icon", () => {
    const { container } = render(<EmptyState title="Nothing" icon={<Table2 />} />);
    expect(container.querySelector(".bg-primary")).toBeNull();
  });
});

describe("Skeleton", () => {
  it("is hidden from assistive technology", () => {
    render(<Skeleton data-testid="s" className="h-4 w-40" />);
    expect(screen.getByTestId("s")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("s")).toHaveClass("ob-skeleton", "h-4", "w-40");
  });
  it("draws lines with the last one shorter", () => {
    const { container } = render(<SkeletonLines lines={3} />);
    const lines = container.querySelectorAll(".ob-skeleton");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toHaveClass("w-2/3");
    expect(lines[0]).toHaveClass("w-full");
  });
});
