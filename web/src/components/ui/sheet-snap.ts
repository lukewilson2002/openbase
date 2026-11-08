/**
 * Where a bottom sheet can come to rest, and which of those a release picks. Offsets are how far down the
 * sheet is moved from its open position, in px: 0 is full, the last point is closed (its whole height).
 */

/** How long a released sheet is assumed to keep coasting at the speed of the finger. */
const COAST_MS = 200;

/**
 * The resting points of a sheet `height` px tall on a screen `viewport` px tall: full (0), half when the
 * sheet is taller than half the screen (so there is a half to rest at), and closed (`height`).
 */
export function sheetSnapPoints(height: number, viewport: number): number[] {
  if (height <= 0) return [0];
  const half = height - viewport / 2;
  // A sheet that already fits in half the screen has no separate half; it is full or closed.
  return half > height * 0.1 ? [0, half, height] : [0, height];
}

/**
 * The point a sheet settles at when the finger lets go at `offset` moving at `velocity` px/ms (positive
 * is down): the one nearest where it would stop if it coasted on. A slow release goes to the nearest point,
 * a flick goes on to the next one in its direction, and a long fast pull skips to the end.
 */
export function settleSheet({ offset, velocity, points }: { offset: number; velocity: number; points: readonly number[] }): number {
  const projected = offset + velocity * COAST_MS;
  let best = points[0] ?? 0;
  for (const p of points) if (Math.abs(p - projected) < Math.abs(best - projected)) best = p;
  return best;
}

/** Above the open position a pull meets resistance, so the sheet gives a little and no more. */
export function rubberBand(offset: number): number {
  return offset >= 0 ? offset : Math.max(-24, offset * 0.2);
}
