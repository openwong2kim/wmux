// Browser panes never get the camera or the microphone. Every session other
// than wmux's own window (the browser profiles' `persist:wmux-*` / `wmux-*`
// partitions, the private one) answers a `media` request and check with no;
// the rest is approved as Electron approves it by default. wmux's own window
// keeps the microphone for voice dictation.
//
// In a copy that may not raise OS toasts (an isolated packaged copy on
// Windows, #2964), every session, wmux's own window included, also refuses
// `notifications`: a page's Notification API reaches the same Electron toast
// setup that would repoint the installed app's Start Menu entry.

import { app, session, type Session } from 'electron';
import { osToastsAllowed } from '../notification/osToastGate';

type PermissionSession = Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>;

function refuse(ses: PermissionSession, refused: ReadonlySet<string>): void {
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(!refused.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => !refused.has(permission));
}

/** Refuse `media` (audio and video) on `ses`, and `notifications` where OS
 *  toasts are not allowed; allow everything else. */
export function denyMediaPermissions(ses: PermissionSession): void {
  refuse(ses, new Set(osToastsAllowed() ? ['media'] : ['media', 'notifications']));
}

/** Every session created from now on, except the default one, refuses media.
 *  The default one refuses only `notifications`, and only where OS toasts are
 *  not allowed. A session with its own stricter handler (the HTML preview's)
 *  replaces this one when it sets its own. Call before the first partition is
 *  opened. */
export function denyMediaOutsideMainWindow(): void {
  app.on('session-created', (ses) => {
    if (ses === session.defaultSession) {
      if (!osToastsAllowed()) refuse(ses, new Set(['notifications']));
      return;
    }
    denyMediaPermissions(ses);
  });
  // Called after ready, the default session already exists and emits nothing.
  if (app.isReady() && !osToastsAllowed()) refuse(session.defaultSession, new Set(['notifications']));
}
