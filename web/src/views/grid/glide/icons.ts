/**
 * Column-header icon sprites for Glide, produced from the same lucide icons the rest of the app
 * uses for field types (`FIELD_TYPE_ICONS`). Each icon is rendered once into a detached element
 * at module load (outside any React render) and its SVG markup recoloured on demand.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { SpriteMap } from "@glideapps/glide-data-grid";
import { Plus } from "lucide-react";
import { FIELD_TYPE_ICONS } from "@/components/ui/field-type-icon";

/** Sprite key of the "Add field" column's plus. */
export const ADD_ICON = "__add_field";

function render(): SpriteMap {
  const sprites: SpriteMap = {};
  if (typeof document === "undefined") return sprites;
  const host = document.createElement("div");
  for (const [type, Icon] of [...Object.entries(FIELD_TYPE_ICONS), [ADD_ICON, Plus] as const]) {
    try {
      const root = createRoot(host);
      flushSync(() => root.render(createElement(Icon, { size: 20, strokeWidth: 2 })));
      const markup = host.innerHTML;
      root.unmount();
      // Glide hands sprites a box colour (`bgColor`) and a glyph colour (`fgColor`) for its own
      // filled icons. Lucide icons are bare strokes with no box, so they take the box colour: the
      // glyph colour is meant to sit on that box, and on the bare header it came out white on light
      // and near-black on dark.
      sprites[type] = ({ bgColor }) => markup.replaceAll("currentColor", bgColor);
    } catch {
      /* the header simply shows no icon */
    }
  }
  return sprites;
}

let cached: SpriteMap | null = null;

/** Sprite map keyed by field type (`GridColumn.icon` = field type). */
export function headerIcons(): SpriteMap {
  cached ??= render();
  return cached;
}

// Render eagerly while the module evaluates, never during a component render.
headerIcons();
