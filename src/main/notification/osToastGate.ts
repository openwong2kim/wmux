// Whether this process may raise OS toasts at all (#2964). See
// mayRaiseOsToasts in ../dataIsolation for why an isolated packaged copy on
// Windows must never reach Electron's notification presenter.

import { app } from 'electron';
import { mayRaiseOsToasts } from '../dataIsolation';

let reported = false;

/** Checked before any `Notification` use, `isSupported()` included. */
export function osToastsAllowed(): boolean {
  const allowed = mayRaiseOsToasts(process.platform, app.isPackaged, process.env);
  if (!allowed && !reported) {
    reported = true;
    console.log(
      '[toast] OS toasts are off in this isolated packaged copy (WMUX_DATA_SUFFIX is set): ' +
      "Windows' toast setup would repoint the installed app's Start Menu entry at this copy (#2964)",
    );
  }
  return allowed;
}
