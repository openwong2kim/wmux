// ---------------------------------------------------------------------------
// Per-page pointer position for the chrome lane.
//
// The geometry itself is shared with the main-process webview lane and lives in
// `src/shared/pointerPath`. What is specific to this lane is remembering where
// the pointer was left, so the next click approaches from there instead of
// starting over: a pointer that teleports home between every click is as
// distinctive as one that never moves.
// ---------------------------------------------------------------------------

import type { Point } from '../../shared/pointerPath';

export {
  clickPointInBox,
  defaultStartPoint,
  distance,
  pathPoints,
  stepsForDistance,
  INNER_FRACTION,
  MAX_STEPS,
  MIN_STEPS,
} from '../../shared/pointerPath';
export type { Box, Point } from '../../shared/pointerPath';

// Keyed on the page object: two pages in the same session have separate
// pointers, and a page that goes away takes its entry with it.
const lastPointerByPage = new WeakMap<object, Point>();

export function getLastPointer(page: object): Point | undefined {
  return lastPointerByPage.get(page);
}

export function setLastPointer(page: object, point: Point): void {
  lastPointerByPage.set(page, { x: point.x, y: point.y });
}
