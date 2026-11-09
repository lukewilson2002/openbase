/** Whether the person asked their system for less motion (A11Y-6). Read when it is needed: the setting can change while the app is open. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The `behavior` of a scroll the app starts itself: gliding unless motion is reduced, when the view jumps. CSS animations have their own rule (styles/index.css). */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
