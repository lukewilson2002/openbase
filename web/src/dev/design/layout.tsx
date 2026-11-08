import { useEffect, useState, type ReactNode } from "react";
import { PortalHost } from "@/components/ui/portal-host";
import { cn } from "@/lib/cn";
import { useTheme } from "@/theme/ThemeProvider";
import { DESIGN_THEMES, type DesignSection } from "../designSections";

/**
 * One block of the page: a heading, a line on what it shows, and the same content twice, once per theme.
 * `data-design-section` / `data-design-theme` are what the test and the e2e spec look for.
 */
export function Section({ section, note, children }: { section: DesignSection; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={section.id} data-design-section={section.id} aria-labelledby={`${section.id}-title`} className="scroll-mt-20">
      <h2 id={`${section.id}-title`} className="text-h2">
        {section.title}
      </h2>
      {note && <p className="mt-1 max-w-3xl text-label text-muted">{note}</p>}
      <div className="mt-4 grid grid-cols-2 gap-4 max-md:grid-cols-1">
        {DESIGN_THEMES.map((theme) => (
          <ThemeColumn key={theme} theme={theme}>
            {children}
          </ThemeColumn>
        ))}
      </div>
    </section>
  );
}

/**
 * A column that forces its theme. `data-theme-scope` lets the theme variables apply to this element instead of
 * only to <html> (styles/index.css), and its own `data-accent` keeps the person's accent colour, so what is
 * shown is what the app shows. Floating panels opened inside it are drawn inside it too (PortalHost), because
 * a panel in <body> would take the page's theme, not the column's.
 */
function ThemeColumn({ theme, children }: { theme: (typeof DESIGN_THEMES)[number]; children: ReactNode }) {
  const { accent } = useTheme();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setElement}
      data-theme-scope
      data-theme={theme}
      data-accent={accent}
      data-design-theme={theme}
      className="relative flex min-w-0 flex-col gap-5 rounded-lg border border-line bg-bg p-4 text-fg"
    >
      <p className="text-meta font-medium uppercase tracking-wide text-muted">{theme === "light" ? "Light" : "Dark"}</p>
      {element && <PortalHost container={element}>{children}</PortalHost>}
    </div>
  );
}

/** A labelled example. The label says which state it is. */
export function State({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <figure className={cn("m-0 flex min-w-0 flex-col items-start gap-1.5", className)}>
      <div className={cn("min-w-0 max-w-full", className?.includes("w-full") && "w-full")}>{children}</div>
      <figcaption className="text-meta text-muted">{label}</figcaption>
    </figure>
  );
}

/** Examples side by side, wrapping when the column is narrow. */
export function Gallery({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-start gap-x-5 gap-y-4", className)}>{children}</div>;
}

/** A small heading inside a section. */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-label font-semibold text-muted">{title}</h3>
      {children}
    </div>
  );
}

/**
 * A rectangle for things that float over a page (a sheet, a dialog, a menu). Everything inside is drawn open, in
 * place: the frame is a containing block for `position: fixed`, so a fixed sheet sits at the frame's bottom,
 * and `inline` turns the modal pieces into non-modal ones so any number of them can be open at once. The
 * scrim stands in for the page's dimmed overlay.
 */
export function Frame({ children, height = "24rem", width, scrim = true, className }: { children: ReactNode; height?: string; width?: string; scrim?: boolean; className?: string }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  return (
    <div
      ref={setElement}
      style={{ height, width }}
      className={cn("relative max-w-full overflow-hidden rounded-lg border border-line bg-bg [contain:layout_paint]", className)}
    >
      {scrim && <div aria-hidden className="absolute inset-0 bg-overlay" />}
      {element && (
        <PortalHost container={element} inline>
          {children}
        </PortalHost>
      )}
    </div>
  );
}

/** The value of a token as the browser computes it here, so the page shows the theme's own number. */
export function useTokenValue(name: string, element: HTMLElement | null): string {
  const { resolved, accent } = useTheme();
  const [value, setValue] = useState("");
  useEffect(() => {
    if (!element) return;
    setValue(getComputedStyle(element).getPropertyValue(name).trim());
  }, [name, element, resolved, accent]);
  return value;
}

export const noop = () => undefined;
