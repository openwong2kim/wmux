/**
 * The members of `window.electronAPI` the browser build implements. Everything
 * else is denied by `createElectronApiShim`. Each entry here is a static value,
 * a subscription that never fires, or — for `pty` only — a forwarder to the
 * page's terminal bridge (webPty.ts), which reads pane streams and, when this
 * caller may type, posts input. `pty.create` / `dispose` / `promote` /
 * `resize` are not members, so they stay denied.
 */
import type { ShimImpl } from './electronApiShim';

/** The flat client: fallback for old browsers, and the token/pairing screens. */
export const CLASSIC_PATH = '/classic';

/** Where the es2022 bundle publishes the terminal bridge (webPty.ts `pty`). */
export const WEB_PTY_BRIDGE_KEY = '__wmuxWebPtyBridge';

/** Map the browser's platform hint onto the Node platform names components switch on. */
export function platformFromNavigator(nav: Pick<Navigator, 'userAgent'> & { platform?: string }): 'darwin' | 'win32' | 'linux' {
  const hint = `${nav.platform ?? ''} ${nav.userAgent}`;
  if (/Win/i.test(hint)) return 'win32';
  if (/Mac|iPhone|iPad|iPod/i.test(hint)) return 'darwin';
  return 'linux';
}

type Bridge = Record<string, (...args: unknown[]) => unknown>;

const PTY_SUBSCRIPTIONS = ['onData', 'onExit', 'onFlushComplete', 'onRestarted'] as const;
const PTY_CALLS = ['setViewerVisibility', 'write', 'list', 'reconnect', 'resync'] as const;

function notReady(): Promise<never> {
  const p = Promise.reject(new Error('terminal bridge not ready'));
  p.catch(() => undefined);
  return p;
}

/**
 * `pty.*` resolved at CALL time: this object is installed by the es2017 boot
 * script, before the bundle that owns the bridge has run.
 */
export function lateBoundPty(get: () => Bridge | undefined): Record<string, (...args: unknown[]) => unknown> {
  const out: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of PTY_SUBSCRIPTIONS) {
    out[name] = (...args) => {
      const bridge = get();
      return bridge ? bridge[name](...args) : () => undefined;
    };
  }
  for (const name of PTY_CALLS) {
    out[name] = (...args) => {
      const bridge = get();
      return bridge ? bridge[name](...args) : notReady();
    };
  }
  return out;
}

export function webElectronApiImpl(
  nav: Pick<Navigator, 'userAgent' | 'language'> & { platform?: string },
  getPtyBridge: () => Bridge | undefined = () => undefined,
): ShimImpl {
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
    // useTerminal reattaches on a daemon (re)connect; the browser has no
    // daemon link of its own to report — its streams reconnect themselves.
    daemon: { onConnected: () => () => undefined },
    pty: lateBoundPty(getPtyBridge),
  };
}

/**
 * `window.clipboardAPI` (the desktop preload's clipboard bridge) on the
 * browser's own clipboard. Reads and writes need a secure context and, for
 * reads, the browser's permission; anything unavailable answers empty.
 */
export function webClipboardApi(nav: Pick<Navigator, 'clipboard'>): Record<string, (...args: never[]) => Promise<unknown>> {
  const clip = nav.clipboard as Clipboard | undefined;
  const writeText = (text: string): Promise<void> => (clip?.writeText
    ? clip.writeText(text)
    : Promise.reject(new Error('clipboard unavailable in this browser context')));
  return {
    writeText,
    readText: () => (clip?.readText ? clip.readText().catch(() => '') : Promise.resolve('')),
    readImage: () => Promise.resolve(null),
    hasImage: () => Promise.resolve(false),
    writeEphemeral: (text: string) => writeText(text),
    keepEphemeral: () => Promise.resolve(),
  };
}
