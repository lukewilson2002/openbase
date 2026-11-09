import type { Page } from "@playwright/test";

/**
 * Measures a screen on a phone for PH-6 and PH-7, in the page itself.
 *
 * Tap targets: every control that is on screen must be hit by a finger placed anywhere in a 44 x 44 box around its
 * centre. A control that draws smaller than that passes when something that belongs to it (itself, a pseudo-element
 * of it, a child, or the label it sits in) answers at those points, which is how the app widens a small mark. Links
 * inside running text are exempt (WCAG 2.5.8), as are controls scrolled out of view, canvas drawings and clipped
 * screen-reader-only inputs.
 *
 * Page scroll: nothing may poke past the right edge of the screen unless a scroller of its own holds it (a table, a
 * board, a timeline, a row of tabs), and the page itself must not scroll sideways.
 */
export interface TapFailure {
  what: string;
  width: number;
  height: number;
}

export async function tapTargetFailures(page: Page, min = 44): Promise<TapFailure[]> {
  return page.evaluate((min) => {
    const CONTROLS = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="radio"], [role="combobox"]';
    const failures: { what: string; width: number; height: number }[] = [];
    const seen = new Set<string>();
    const name = (el: Element) => {
      const label = el.getAttribute("aria-label") || (el as HTMLElement).innerText?.trim().slice(0, 40) || el.getAttribute("title") || el.getAttribute("placeholder") || "";
      return `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""} "${label}"`;
    };
    const belongs = (hit: Element | null, el: Element) => {
      if (!hit) return false;
      // The bottom bar is over the foot of the screen: a control behind it is not the bar's fault, nor its own.
      if (hit.closest('nav[aria-label="Main menu"]')) return true;
      if (hit === el || el.contains(hit)) return true;
      const label = hit.closest("label");
      return !!label && (label as HTMLLabelElement).control === el;
    };
    for (const el of document.querySelectorAll(CONTROLS)) {
      if (el.closest("canvas, [aria-hidden='true'], [inert]")) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
      if (el instanceof HTMLInputElement && el.type === "file") continue;
      if (el instanceof HTMLAnchorElement) {
        const parent = el.parentElement;
        const own = [...(parent?.childNodes ?? [])].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim().length > 1);
        if (own) continue;
      }
      if (r.width >= min && r.height >= min) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const half = min / 2 - 1;
      // The points of the 44 box that fall on screen and outside the element's own clipped parents.
      const points: [number, number][] = [];
      if (r.width < min) points.push([cx - half, cy], [cx + half, cy]);
      if (r.height < min) points.push([cx, cy - half], [cx, cy + half]);
      let ok = true;
      for (const [x, y] of points) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        if (!belongs(document.elementFromPoint(x, y), el)) {
          ok = false;
          break;
        }
      }
      if (ok) continue;
      const key = name(el);
      if (seen.has(key)) continue;
      seen.add(key);
      failures.push({ what: key, width: Math.round(r.width), height: Math.round(r.height) });
    }
    return failures;
  }, min);
}

export interface OverflowFailure {
  what: string;
  right: number;
}

/** What pokes past the right edge of the screen with no scroller of its own to hold it. */
export async function pageOverflow(page: Page): Promise<{ page: number; elements: OverflowFailure[] }> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const held = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const x = getComputedStyle(p).overflowX;
        if (x === "auto" || x === "scroll" || x === "hidden" || x === "clip") return true;
      }
      return false;
    };
    const elements: { what: string; right: number }[] = [];
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= width + 1) continue;
      const style = getComputedStyle(el);
      if (style.position === "fixed" || style.visibility === "hidden" || style.display === "none" || el.closest("[aria-hidden='true'], canvas")) continue;
      if (held(el)) continue;
      elements.push({ what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className ? `.${el.className.split(" ")[0]}` : ""}`, right: Math.round(r.right) });
      if (elements.length >= 8) break;
    }
    return { page: document.documentElement.scrollWidth - width, elements };
  });
}
