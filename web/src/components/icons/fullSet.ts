/**
 * The full Lucide set as data. This module is only ever loaded through `registry.ts`'s dynamic
 * `import()`, so Vite makes it (and the ~1,900 icon modules it globs) a lazy chunk.
 *
 * Each `lucide-react/dist/esm/icons/<name>.mjs` is either a canonical icon (exports `__iconData`:
 * `{ name, node, aliases? }`) or a one-line alias file re-exporting another icon; the aliases are
 * recovered from the canonical icons' `aliases` lists. (`__iconData` is Lucide's own data export;
 * the version is pinned by package-lock.json and `icons.test.ts` fails loudly if it ever goes away.)
 */
import type { IconNode } from "lucide-react";
import type { FullIconSet } from "./registry";

interface IconData {
  name: string;
  node: IconNode;
  aliases?: string[];
}

const modules = import.meta.glob<{ __iconData?: IconData }>("/node_modules/lucide-react/dist/esm/icons/*.mjs", { eager: true });

function build(): FullIconSet {
  const nodes = new Map<string, IconNode>();
  const aliases = new Map<string, readonly string[]>();
  const names: string[] = [];
  for (const mod of Object.values(modules)) {
    const data = mod.__iconData;
    if (!data) continue;
    names.push(data.name);
    nodes.set(data.name, data.node);
    if (data.aliases?.length) aliases.set(data.name, data.aliases);
  }
  for (const [name, list] of aliases) {
    for (const alias of list) if (!nodes.has(alias)) nodes.set(alias, nodes.get(name)!);
  }
  names.sort();
  return { names, nodes, aliases };
}

export const fullIconSet: FullIconSet = build();
