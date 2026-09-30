/**
 * The first script on the browser build's page (wmux web `/app`), compiled to
 * es2017 so every browser that can open the old page can run it.
 *
 *  1. Credential: take `?token=` into the same storage key the `/` page uses,
 *     then drop it from the URL. No credential at all → `/`, which owns pairing.
 *  2. Install the deny-by-default `window.electronAPI` before the bundle runs.
 *  3. Fallback: the bundle is es2022. A browser that cannot parse it (iOS
 *     before 16.4) never sets `__wmuxAppBooted`; by DOMContentLoaded every
 *     inline script has run, so an unset flag means the app cannot start here
 *     and the page goes to `/`, the flat client every browser supports.
 */
import { createElectronApiShim } from './electronApiShim';
import { webElectronApiImpl } from './webElectronApi';

export const WEB_TOKEN_KEY = 'wmux-web-token';

interface BootWindow extends Window {
  __wmuxAppBooted?: boolean;
  __wmuxWebToken?: string;
  __wmuxDeniedCalls?: string[];
}

(function boot(w: BootWindow) {
  const params = new URLSearchParams(w.location.search);
  const fromUrl = params.get('token') || '';
  let stored = '';
  try {
    if (fromUrl) w.localStorage.setItem(WEB_TOKEN_KEY, fromUrl);
    stored = w.localStorage.getItem(WEB_TOKEN_KEY) || '';
  } catch {
    /* private mode — the URL token still works for this load */
  }
  const token = fromUrl || stored;
  if (fromUrl && w.history && w.history.replaceState) {
    params.delete('token');
    const rest = params.toString();
    w.history.replaceState(null, '', w.location.pathname + (rest ? `?${rest}` : ''));
  }
  if (!token) {
    w.location.replace('/');
    return;
  }
  w.__wmuxWebToken = token;

  const denied: string[] = [];
  w.__wmuxDeniedCalls = denied;
  const api = createElectronApiShim(webElectronApiImpl(w.navigator), (path) => {
    if (denied.length < 200) denied.push(path);
    console.warn(`[wmux web] denied electronAPI.${path}`);
  });
  Object.defineProperty(w, 'electronAPI', { value: api, writable: false, configurable: false });

  w.document.addEventListener('DOMContentLoaded', () => {
    if (w.__wmuxAppBooted) return;
    console.error('[wmux web] the app bundle did not start in this browser; opening the classic page');
    w.location.replace('/');
  });
})(window as BootWindow);
