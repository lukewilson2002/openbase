// Runs before first paint (loaded synchronously from index.html) so the page
// never flashes the wrong theme or accent colour. Keep in sync with src/theme/theme.ts
// and the accent names in src/theme/accents.ts.
(function () {
  var mode = "system";
  var accent = "blue";
  try {
    var stored = localStorage.getItem("ob-theme");
    if (stored === "light" || stored === "dark" || stored === "system") mode = stored;
    var storedAccent = localStorage.getItem("ob-accent");
    if (/^(blue|cyan|teal|green|yellow|orange|red|pink|purple|gray)$/.test(storedAccent || "")) accent = storedAccent;
  } catch (e) {
    /* storage blocked: fall back to system and blue */
  }
  var dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  document.documentElement.setAttribute("data-accent", accent);
})();
