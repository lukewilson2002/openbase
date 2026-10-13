/**
 * FullCalendar injects its stylesheet when its modules are imported, and that stylesheet declares an
 * icon font (`fcicons`) as a `data:` URI. The server's Content-Security-Policy (`default-src 'self'`,
 * no `font-src data:`) refuses it, which Chrome reports as a console error every time a calendar opens.
 * The calendar draws its buttons as words (`buttonIcons={false}`) and uses no icon anywhere, so the
 * font is never needed: drop its `@font-face` rule instead of loosening the policy for it. Runs once
 * from the calendar chunk, straight after FullCalendar's own styles are in (before the first style
 * recalculation, so the font is never requested).
 */
export function removeIconFont(doc: Document = document): number {
  let removed = 0;
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a cross-origin sheet
    }
    for (let i = rules.length - 1; i >= 0; i--) {
      const text = rules[i]!.cssText;
      if (text.startsWith("@font-face") && text.includes("fcicons")) {
        sheet.deleteRule(i);
        removed++;
      }
    }
  }
  return removed;
}
