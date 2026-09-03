// ---------------------------------------------------------------------------
// Touch dispatch for a page emulating a device with a touchscreen.
//
// A device preset installs `Emulation.setTouchEmulationEnabled`, so the page
// reports `maxTouchPoints: 5` and matches `(pointer: coarse)` — and then every
// click still arrived as `pointerType: "mouse"`, because an automated click is
// a mouse press whatever the page has been told about its hardware. Two ways
// round that were measured and rejected: `Emulation.setEmitTouchEventsForMouse`
// does convert the press into real touch events, but the mouse dispatch that
// produced them then never returns (>30 s, every click), and building the
// context from a device descriptor would mean a fresh incognito-like context
// with none of the user's cookies, history or extensions.
//
// What is left is to stop asking the mouse. `Input.dispatchTouchEvent` puts a
// real touch sequence into the same input pipeline, and Blink derives the
// pointer, mouse and click events from it exactly as it does for a finger.
//
// Here in `src/shared` for the same reason the pointer path is: the chrome lane
// sends these on the CDP session ua-emulation holds open, the builtin webview
// lane on `webContents.debugger`, and one gesture should not be two
// implementations.
// ---------------------------------------------------------------------------

import { distance, pathPoints, stepsForDistance, type Point } from './pointerPath';

/** The one CDP capability this module needs, structurally. */
export interface TouchSender {
  send(method: string, params?: unknown): Promise<unknown>;
}

/**
 * Contact size, in CSS px. CDP defaults a touch point to a 1 px radius, which
 * is a stylus at best; a fingertip is an order of magnitude wider, and a page
 * sizing its hit testing from `Touch.radiusX` reads the difference.
 */
const TOUCH_RADIUS_PX = 12;

/**
 * How long a tap holds before it lifts. A touchStart and a touchEnd in the same
 * millisecond is not a gesture any hand produces, and a page measuring press
 * duration (long-press menus, hold-to-confirm) sees the zero. Randomised for
 * the same reason the pointer path is.
 */
const TAP_HOLD_MIN_MS = 45;
const TAP_HOLD_MAX_MS = 95;

function tapHoldMs(rng: () => number): number {
  return TAP_HOLD_MIN_MS + rng() * (TAP_HOLD_MAX_MS - TAP_HOLD_MIN_MS);
}

function touchPoint(point: Point): Record<string, number> {
  return {
    x: point.x,
    y: point.y,
    radiusX: TOUCH_RADIUS_PX,
    radiusY: TOUCH_RADIUS_PX,
    force: 1,
    // One finger, one id, held constant across a drag's moves so the sequence
    // describes one contact travelling rather than a new one each frame.
    id: 0,
  };
}

/**
 * One finger down and up at `point`.
 *
 * `touchEnd` carries an empty `touchPoints`: the field lists the contacts still
 * on the glass, and after a single-finger lift there are none.
 */
export async function dispatchTouchTap(
  session: TouchSender,
  point: Point,
  rng: () => number = Math.random,
): Promise<void> {
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [touchPoint(point)],
  });
  await new Promise((resolve) => setTimeout(resolve, tapHoldMs(rng)));
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/**
 * One finger down at `from`, dragged to `to`, lifted there.
 *
 * The intermediate points come from the same shared path a mouse drag walks, so
 * the number of moves is bounded by its `MAX_STEPS` however far the drag runs.
 */
export async function dispatchTouchDrag(
  session: TouchSender,
  from: Point,
  to: Point,
): Promise<void> {
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [touchPoint(from)],
  });
  for (const point of pathPoints(from, to, stepsForDistance(distance(from, to)))) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [touchPoint(point)],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
