import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn with the design tokens", () => {
  it("keeps a type-scale size next to a text colour", () => {
    expect(cn("text-ui text-muted")).toBe("text-ui text-muted");
    expect(cn("text-muted text-label")).toBe("text-muted text-label");
    expect(cn("text-record-phone md:text-record text-fg")).toBe("text-record-phone md:text-record text-fg");
  });

  it("lets a later size replace an earlier one, token or not", () => {
    expect(cn("text-ui", "text-label")).toBe("text-label");
    expect(cn("text-sm", "text-h2")).toBe("text-h2");
    expect(cn("text-meta", "text-sm")).toBe("text-sm");
  });

  it("merges the radius, control height, width and gutter tokens with Tailwind's own", () => {
    expect(cn("rounded-lg", "rounded-pill")).toBe("rounded-pill");
    expect(cn("h-9", "h-control-md")).toBe("h-control-md");
    expect(cn("h-control-sm", "h-control-lg")).toBe("h-control-lg");
    expect(cn("px-4", "px-gutter")).toBe("px-gutter");
    expect(cn("w-64", "w-sidebar")).toBe("w-sidebar");
    expect(cn("w-72", "w-panel")).toBe("w-panel");
    expect(cn("max-w-2xl", "max-w-record")).toBe("max-w-record");
  });

  it("merges the motion tokens", () => {
    expect(cn("duration-150", "duration-base")).toBe("duration-base");
    expect(cn("duration-fast", "duration-slow")).toBe("duration-slow");
    expect(cn("ease-out", "ease-enter")).toBe("ease-enter");
  });
});
