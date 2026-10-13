import { afterEach, describe, expect, it } from "vitest";
import { removeIconFont } from "./iconFont";

afterEach(() => {
  document.head.innerHTML = "";
});

function addStyle(css: string): void {
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}

describe("removeIconFont", () => {
  it("drops FullCalendar's data: icon font and leaves every other rule alone", () => {
    addStyle('.fc{display:flex}@font-face{font-family:fcicons;src:url("data:application/x-font-ttf;base64,AAEA") format("truetype")}.fc-icon{font-family:fcicons!important}');
    addStyle('@font-face{font-family:Other;src:url("/fonts/other.woff2")}');
    expect(removeIconFont()).toBe(1);
    const all = [...document.styleSheets].flatMap((s) => [...s.cssRules].map((r) => r.cssText));
    expect(all.some((t) => t.startsWith("@font-face") && t.includes("fcicons"))).toBe(false);
    expect(all.some((t) => t.includes("Other"))).toBe(true);
    expect(all.some((t) => /^\.fc\s*\{/.test(t))).toBe(true);
    expect(removeIconFont()).toBe(0);
  });

  it("does nothing when there is no such rule", () => {
    addStyle(".a{color:red}");
    expect(removeIconFont()).toBe(0);
  });
});
