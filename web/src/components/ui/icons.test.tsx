import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { Plus } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Icon } from "./icon";
import { IconButton } from "./icon-button";

const UI_DIR = resolve(process.cwd(), "src/components/ui");
/** Every component source in `components/ui`, without tests. */
const sources = readdirSync(UI_DIR)
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
  .map((f) => ({ file: f, text: readFileSync(resolve(UI_DIR, f), "utf8") }));

describe("Icon (DL-4)", () => {
  it("is a stroke icon at width 2, 16 px on desktop and 20 on phone, hidden from assistive technology", () => {
    const { container } = render(<Icon icon={Plus} />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("stroke-width", "2");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveClass("size-4", "max-md:size-5", "pointer-coarse:size-5");
  });

  it("is 12 px when small, and sizes itself when asked to fit", () => {
    const { container, rerender } = render(<Icon icon={Plus} size="sm" />);
    expect(container.querySelector("svg")).toHaveClass("size-3");
    expect(container.querySelector("svg")).not.toHaveClass("size-4");
    rerender(<Icon icon={Plus} size="fit" className="size-6" />);
    expect(container.querySelector("svg")).toHaveClass("size-6");
    expect(container.querySelector("svg")).not.toHaveClass("max-md:size-5");
  });

  it("cannot be given another stroke width, colour or size by type", () => {
    // These lines fail type checking if the props are ever accepted (`tsc --noEmit` runs the check).
    // @ts-expect-error the stroke width is always 2
    render(<Icon icon={Plus} strokeWidth={3} />);
    // @ts-expect-error the icon takes the text colour
    render(<Icon icon={Plus} color="red" />);
    // @ts-expect-error the size is one of the tokens
    render(<Icon icon={Plus} width={30} />);
  });
});

describe("IconButton (DL-4)", () => {
  it("is named by its label", () => {
    render(
      <IconButton label="Add property">
        <Icon icon={Plus} />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Add property" })).toBeInTheDocument();
  });

  it("cannot be written without a label", () => {
    // Fails type checking when `label` stops being required, or an aria-label can stand in for it.
    render(
      // @ts-expect-error label is required: a button with only an icon has no other name
      <IconButton>
        <Icon icon={Plus} />
      </IconButton>,
    );
    render(
      // @ts-expect-error aria-label cannot replace the label
      <IconButton aria-label="Add">
        <Icon icon={Plus} />
      </IconButton>,
    );
  });
});

describe("the core components draw icons through Icon (DL-4)", () => {
  const lucideImports = (text: string) =>
    [...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"lucide-react"/g)].flatMap((m) =>
      m[1]!
        .split(",")
        .map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!)
        .filter(Boolean),
    );

  it("renders no lucide glyph as an element, which would skip the stroke width, size and aria-hidden", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      if (file === "icon.tsx") continue;
      for (const name of lucideImports(text)) {
        if (new RegExp(`<${name}[\\s/>]`).test(text)) offenders.push(`${file}: <${name}>`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sets no stroke width of its own", () => {
    const offenders = sources.filter(({ file, text }) => file !== "icon.tsx" && /strokeWidth\s*=/.test(text)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it("gives every IconButton a label", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/<IconButton\b([^>]*)>/g)) {
        if (!/\blabel=/.test(m[1]!)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no hand-made icon-only button: a button whose only child is an icon names itself", () => {
    const offenders: string[] = [];
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/<button\b([^>]*)>\s*<Icon\b[^>]*\/>\s*<\/button>/g)) {
        if (!/aria-label=/.test(m[1]!)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
