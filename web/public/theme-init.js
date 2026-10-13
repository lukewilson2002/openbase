// Runs before first paint (loaded synchronously from index.html) so the page
// never flashes the wrong theme. Keep in sync with src/theme/theme.ts.
(function () {
  var mode = "system";
  try {
    var stored = localStorage.getItem("ob-theme");
    if (stored === "light" || stored === "dark" || stored === "system") mode = stored;
  } catch (e) {
    /* storage blocked: fall back to system */
  }
  var dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();
