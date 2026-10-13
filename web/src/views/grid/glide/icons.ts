/**
 * Column-header icon sprites for Glide, produced from the same lucide icons the rest of the app
 * uses for field types (`FIELD_TYPE_ICONS`). Each icon is rendered once into a detached element
 * at module load (outside any React render) and its SVG markup recoloured on demand.
 */
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { SpriteMap } from "@glideapps/glide-data-grid";
import { FIELD_TYPE_ICONS } from "@/components/ui/field-type-icon";

function render(): SpriteMap {
  const sprites: SpriteMap = {};
  if (typeof document === "undefined") return sprites;
  const host = document.createElement("div");
  for (const [type, Icon] of Object.entries(FIELD_TYPE_ICONS)) {
    try {
      const root = createRoot(host);
      flushSync(() => root.render(createElement(Icon, { size: 20, strokeWidth: 2 })));
      const markup = host.innerHTML;
      root.unmount();
      sprites[type] = ({ fgColor }) => markup.replaceAll("currentColor", fgColor);
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
