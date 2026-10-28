import { describe, expect, it } from "vitest";
import { neighbourCard, onLastRow, survivorAfterDelete, type CardBox } from "./galleryNav";

/** Seven cards in rows of three; the last row has one card. */
const boxes: CardBox[] = Array.from({ length: 7 }, (_, i) => ({ left: (i % 3) * 100, top: Math.floor(i / 3) * 80, width: 90 }));

describe("neighbourCard", () => {
  it("steps one card left and right, and stops at the ends", () => {
    expect(neighbourCard(boxes, 2, "ArrowLeft")).toBe(1);
    expect(neighbourCard(boxes, 2, "ArrowRight")).toBe(3);
    expect(neighbourCard(boxes, 0, "ArrowLeft")).toBeNull();
    expect(neighbourCard(boxes, 6, "ArrowRight")).toBeNull();
  });

  it("goes to the first and last card with Home and End", () => {
    expect(neighbourCard(boxes, 4, "Home")).toBe(0);
    expect(neighbourCard(boxes, 4, "End")).toBe(6);
    expect(neighbourCard(boxes, 0, "Home")).toBeNull();
    expect(neighbourCard(boxes, 6, "End")).toBeNull();
  });

  it("keeps to the column going up and down", () => {
    expect(neighbourCard(boxes, 1, "ArrowDown")).toBe(4);
    expect(neighbourCard(boxes, 4, "ArrowUp")).toBe(1);
    expect(neighbourCard(boxes, 0, "ArrowUp")).toBeNull();
  });

  it("goes to the nearest card when the row below is shorter", () => {
    expect(neighbourCard(boxes, 5, "ArrowDown")).toBe(6);
    expect(neighbourCard(boxes, 6, "ArrowDown")).toBeNull();
  });

  it("ignores other keys and unknown cards", () => {
    expect(neighbourCard(boxes, 1, "a")).toBeNull();
    expect(neighbourCard(boxes, 9, "ArrowRight")).toBeNull();
  });
});

describe("onLastRow", () => {
  it("tells the cards of the bottom row", () => {
    expect(onLastRow(boxes, 6)).toBe(true);
    expect(onLastRow(boxes, 5)).toBe(false);
    expect(onLastRow(boxes, 12)).toBe(false);
  });
});

describe("survivorAfterDelete", () => {
  const ids = ["a", "b", "c", "d"];
  it("is the next card, else the one before", () => {
    expect(survivorAfterDelete(ids, new Set(["b"]))).toBe("c");
    expect(survivorAfterDelete(ids, new Set(["d"]))).toBe("c");
    expect(survivorAfterDelete(ids, new Set(["b", "c"]))).toBe("d");
    expect(survivorAfterDelete(ids, new Set(["c", "d"]))).toBe("b");
  });
  it("is null when nothing is left or nothing is deleted", () => {
    expect(survivorAfterDelete(ids, new Set(ids))).toBeNull();
    expect(survivorAfterDelete(ids, new Set(["z"]))).toBeNull();
  });
});
