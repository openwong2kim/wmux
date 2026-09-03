// ---------------------------------------------------------------------------
// Touch input for the chrome lane.
//
// The gesture itself is shared with the main-process webview lane and lives in
// `src/shared/touchInput`. What is specific to this lane is where the events go
// out: on the CDP session `ua-emulation` is already holding open for the page.
//
// Reusing that session rather than opening one is not an economy. A session
// opened for the tap and detached afterwards would reset `navigator.platform`
// back to the host's on the way out — measured, and the whole reason that
// module holds its sessions instead of using them and leaving.
// ---------------------------------------------------------------------------

import type { Page } from 'playwright-core';
import { activeTouchSession } from './ua-emulation';
import { dispatchTouchDrag, dispatchTouchTap } from '../../shared/touchInput';
import type { Point } from './pointer-path';

export { dispatchTouchDrag, dispatchTouchTap } from '../../shared/touchInput';
export type { TouchSender } from '../../shared/touchInput';

/** Is a device preset with a touchscreen currently emulated on `page`? */
export function hasTouchEmulation(page: Page): boolean {
  return activeTouchSession(page) !== undefined;
}

/**
 * A tap function for `page`, or undefined when no touchscreen is emulated on it
 * — in which case every caller keeps the mouse path it had before.
 */
export function touchTapFor(page: Page): ((point: Point) => Promise<void>) | undefined {
  const session = activeTouchSession(page);
  if (!session) return undefined;
  return (point: Point) => dispatchTouchTap(session, point);
}

/** The drag equivalent of `touchTapFor`. */
export function touchDragFor(page: Page): ((from: Point, to: Point) => Promise<void>) | undefined {
  const session = activeTouchSession(page);
  if (!session) return undefined;
  return (from: Point, to: Point) => dispatchTouchDrag(session, from, to);
}
