/**
 * The filter bar's text field, found by whatever needs to hand focus back to it (the draft bar after Reset). A
 * view has one filter bar; the field registers itself while it is on the page.
 */
let current: HTMLInputElement | null = null;

export function registerFilterInput(input: HTMLInputElement | null): void {
  current = input;
}

export function filterInput(): HTMLInputElement | null {
  return current?.isConnected ? current : null;
}
