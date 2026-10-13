/** A small stand-in for the full Lucide set, and a gate to control when it "loads". Tests only. */
import type { IconNode } from "lucide-react";
import { POPULAR_ICONS } from "./popular";
import type { FullIconSet } from "./registry";

const NODE: IconNode = [["circle", { cx: 12, cy: 12, r: 4 }]];

/** The popular 20, a few named icons to search for, and `filler` generic ones, with two aliases. */
export function fakeIconSet(filler = 300): FullIconSet {
  const names = [
    ...POPULAR_ICONS.map((p) => p.name),
    "chart-pie",
    "chart-line",
    "shopping-bag",
    "map-pin",
    "anchor",
    "zap",
    "umbrella",
    ...Array.from({ length: filler }, (_, i) => `glyph-${String(i + 1).padStart(3, "0")}`),
  ].sort();
  const aliases = new Map<string, readonly string[]>([
    ["house", ["home"]],
    ["chart-column", ["bar-chart-3"]],
  ]);
  const nodes = new Map<string, IconNode>(names.map((n) => [n, NODE]));
  nodes.set("home", NODE);
  nodes.set("bar-chart-3", NODE);
  return { names, nodes, aliases };
}

/** An importer for `resetIconRegistryForTests` that resolves only when `release()` is called. */
export function gatedImporter(set: FullIconSet = fakeIconSet()) {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const calls = { count: 0 };
  return {
    release,
    calls,
    importer: async () => {
      calls.count++;
      await opened;
      return { fullIconSet: set };
    },
  };
}
