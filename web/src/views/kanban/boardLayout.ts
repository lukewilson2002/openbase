/**
 * Test helper: a virtual layout for the kanban board in jsdom.
 *
 * dnd-kit's keyboard coordinates come from element rects and jsdom has no layout, so this lays the
 * board out virtually: stacks side by side (300 px apart, 288 wide), cards stacked inside each
 * stack (100 px apart, 90 high). The drag overlay (a clone of the picked-up card) reports the
 * rectangle given to `overlayAt`; by default the first card of the first stack.
 */
function rect(x: number, y: number, w: number, h: number): DOMRect {
  return { x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect;
}

export interface BoardLayout {
  /** Where the picked-up card sits (stack column and row in the layout above). */
  overlayAt(column: number, row?: number): void;
  restore(): void;
}

export function installBoardLayout(): BoardLayout {
  const real = Element.prototype.getBoundingClientRect;
  let overlay = rect(8, 48, 272, 90);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.closest("[data-drag-overlay]")) return overlay;
    const stack = this.closest<HTMLElement>("[data-stack-key]");
    if (!stack) return rect(0, 0, 0, 0);
    const col = [...(stack.parentElement?.children ?? [])].indexOf(stack);
    if (this === stack) return rect(col * 300, 0, 288, 600);
    const card = this.closest<HTMLElement>("[data-record-id]");
    if (card && this === card) {
      const row = [...(card.parentElement?.children ?? [])].indexOf(card);
      return rect(col * 300 + 8, 48 + row * 100, 272, 90);
    }
    return rect(col * 300, 0, 0, 0);
  };
  return {
    overlayAt: (column, row = 0) => {
      overlay = rect(column * 300 + 8, 48 + row * 100, 272, 90);
    },
    restore: () => {
      Element.prototype.getBoundingClientRect = real;
    },
  };
}
