// ---------------------------------------------------------------------------
// Pointer movement before a click.
//
// `locator.click()` teleports the pointer: the only mouse event a page sees is
// one `mousemove` landing on the exact centre of the target's box, immediately
// followed by the press. A pointer that has never been anywhere else and always
// lands dead centre is trivially separable from a real one.
//
// This module produces the two missing pieces: a short run of intermediate
// points from wherever the pointer last was to the target, and a click point
// that is off-centre but still comfortably inside the element.
//
// These are plain linear interpolations with a little perpendicular jitter.
// They are not curve-fitted to anything and do not claim to be.
//
// The geometry lives in `src/shared` because both lanes need it: the chrome
// lane drives it through Playwright's mouse, the builtin webview lane through
// CDP `Input.dispatchMouseEvent` in the main process.
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fewest intermediate points on any move. */
export const MIN_STEPS = 8;
/** Most intermediate points on any move. */
export const MAX_STEPS = 25;
/** One extra step per this many CSS px of travel. */
const PX_PER_STEP = 45;

/**
 * Fraction of the box the click point may wander over. 0.6 keeps every point
 * inside the middle 60% of the box, so a click never lands on the border or
 * outside a rounded corner.
 */
export const INNER_FRACTION = 0.6;

/** Perpendicular jitter as a fraction of the move's length. */
const JITTER_FRACTION = 0.04;

/** How far apart two points are, in CSS px. */
export function distance(from: Point, to: Point): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}

/**
 * How many intermediate points a move of `dist` px deserves — more for a long
 * traverse, never fewer than MIN_STEPS nor more than MAX_STEPS.
 */
export function stepsForDistance(dist: number): number {
  const scaled = Math.round(MIN_STEPS + dist / PX_PER_STEP);
  return Math.min(MAX_STEPS, Math.max(MIN_STEPS, scaled));
}

/**
 * The intermediate points of a move from `from` to `to`, `to` included as the
 * final element.
 *
 * Jitter is applied strictly perpendicular to the from→to axis and tapers to
 * zero at both ends, so progress along the axis stays monotone and the last
 * point is exactly `to`.
 */
export function pathPoints(
  from: Point,
  to: Point,
  steps: number,
  rng: () => number = Math.random,
): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const count = Math.max(1, Math.round(steps));

  // Unit vector perpendicular to the direction of travel. A zero-length move
  // has no axis to be perpendicular to, so it gets no jitter.
  const px = len === 0 ? 0 : -dy / len;
  const py = len === 0 ? 0 : dx / len;
  const amplitude = len * JITTER_FRACTION;

  const points: Point[] = [];
  for (let i = 1; i <= count; i++) {
    const t = i / count;
    // sin(pi*t) is 0 at both ends and widest in the middle: the pointer drifts
    // off the straight line mid-flight and arrives exactly on target.
    const taper = Math.sin(Math.PI * t);
    const offset = (rng() * 2 - 1) * amplitude * taper;
    points.push({
      x: from.x + dx * t + px * offset,
      y: from.y + dy * t + py * offset,
    });
  }
  // Guard the endpoint against float drift — callers rely on it being exact.
  points[points.length - 1] = { x: to.x, y: to.y };
  return points;
}

/**
 * A click point inside `box`, offset from the centre by a random fraction of
 * the box but never leaving its inner INNER_FRACTION.
 */
export function clickPointInBox(box: Box, rng: () => number = Math.random): Point {
  const spanX = (box.width * INNER_FRACTION) / 2;
  const spanY = (box.height * INNER_FRACTION) / 2;
  return {
    x: box.x + box.width / 2 + (rng() * 2 - 1) * spanX,
    y: box.y + box.height / 2 + (rng() * 2 - 1) * spanY,
  };
}

/**
 * Where the pointer sits when we have never moved it on this page. Off-centre
 * and in the upper-left quadrant, which is where a pointer that has just
 * followed a link or come off the browser chrome tends to be — not (0, 0),
 * which no real pointer rests at.
 */
export function defaultStartPoint(viewport?: { width: number; height: number }): Point {
  const width = viewport?.width ?? 1280;
  const height = viewport?.height ?? 720;
  return { x: Math.round(width * 0.32), y: Math.round(height * 0.28) };
}

/**
 * Convenience for callers that only want the points: resolves the step count
 * from the distance itself.
 */
export function approachPath(
  from: Point,
  to: Point,
  rng: () => number = Math.random,
): Point[] {
  return pathPoints(from, to, stepsForDistance(distance(from, to)), rng);
}
