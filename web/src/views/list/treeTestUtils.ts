/** The title a record's row draws (a record row is named by everything it draws, so the tests name it by its title). */
export const titleOf = (el: Element): string | null => el.querySelector("span.truncate.font-semibold")?.textContent ?? null;

/** What a tree item is called in the tests: an action row by its label, a record by its title, a heading by its label and count ("Todo, 2 records"). */
export function itemLabel(el: Element): string | null {
  const label = el.getAttribute("aria-label");
  if (label) return label;
  if (el.hasAttribute("data-record-id")) return titleOf(el);
  const heading = /^(.*?)(\d+) records?$/.exec(el.textContent ?? "");
  return heading ? `${heading[1]}, ${heading[2]} ${heading[2] === "1" ? "record" : "records"}` : null;
}
