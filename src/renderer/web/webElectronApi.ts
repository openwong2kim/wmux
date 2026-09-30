/**
 * The members of `window.electronAPI` the browser build implements. Everything
 * else is denied by `createElectronApiShim`. Each entry here is a static value
 * or a subscription that never fires: the browser reads nothing from, and
 * writes nothing to, a main process it does not have.
 */
import type { ShimImpl } from './electronApiShim';

/** Map the browser's platform hint onto the Node platform names components switch on. */
export function platformFromNavigator(nav: Pick<Navigator, 'userAgent'> & { platform?: string }): 'darwin' | 'win32' | 'linux' {
  const hint = `${nav.platform ?? ''} ${nav.userAgent}`;
  if (/Win/i.test(hint)) return 'win32';
  if (/Mac|iPhone|iPad|iPod/i.test(hint)) return 'darwin';
  return 'linux';
}

export function webElectronApiImpl(nav: Pick<Navigator, 'userAgent' | 'language'> & { platform?: string }): ShimImpl {
  return {
    platform: platformFromNavigator(nav),
    windowsBuildNumber: null,
    systemLocale: nav.language || 'en',
    // uiSlice reads this synchronously at module load; `undefined` means "no
    // sync answer", and the store keeps its default.
    browser: { getBackendSync: () => undefined },
    // Store actions announce pane focus/creation to the desktop's EventBus
    // (events/publisher.ts). The browser has no bus and must not reach the
    // daemon from a tap, so the announcement goes nowhere.
    events: { publish: () => undefined },
  };
}
