// Browser panes never get the camera, the microphone or the screen. Every
// session other than wmux's own window (the browser profiles' `persist:wmux-*`
// / `wmux-*` partitions, the private one) answers a `media` or
// `display-capture` request and check with no; the rest is approved as
// Electron approves it by default. wmux's own window keeps the microphone for
// voice dictation.

import { app, session, type Session } from 'electron';

/** Media permissions refused: audio and video, and (as Electron 45 reports it) a screen capture. */
const DENIED = new Set<string>(['media', 'display-capture']);

/** Refuse media and screen capture on `ses`; allow everything else. */
export function denyMediaPermissions(ses: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(!DENIED.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => !DENIED.has(permission));
}

/** Every session created from now on, except the default one, refuses media.
 *  A session with its own stricter handler (the HTML preview's) replaces this
 *  one when it sets its own. Call before the first partition is opened. */
export function denyMediaOutsideMainWindow(): void {
  app.on('session-created', (ses) => {
    if (ses === session.defaultSession) return;
    denyMediaPermissions(ses);
  });
}
