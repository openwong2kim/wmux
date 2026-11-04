// The phone preview's driver for a tab of a DEDICATED wmux Chrome profile
// (PhoneBrowser.ts holds the checks every tab gets). It speaks CDP over a page
// session the profile's launcher attaches on its own browser socket
// (ChromeLauncher.pageSession), so it never opens a second connection and
// never launches Chrome. Live Chrome has no page sessions and no tabs here.
//
// What differs from a builtin pane:
//  - geometry comes from Page.getLayoutMetrics, and the capture is clipped to
//    that visual viewport, so a normalized point means the same pixel;
//  - a whole capture, and each input, has its own budget
//    (PHONE_CHROME_CAPTURE_MS): Chrome may stop painting a background tab, and
//    an action that does not finish says so (`browser-tab-hidden`) instead of
//    running into the bridge's timeout;
//  - nothing brings the tab forward except the phone's explicit `focus`;
//    typing uses focus emulation instead;
//  - viewport emulation does not exist here (`browser-action-unsupported`).
// Typed text is sent once, to Chrome, and is never echoed or put in an error.

import type { PhoneBrowserDriver } from './PhoneBrowser';
import { ChromePageSessionError, chromeTargetWatcherEnabled, type ChromeBackendClient, type ChromePageSession, type ChromeStreamSession, type ChromeTargetInfo } from '../browser-session/ChromeLauncher';
import { LIVE_CHROME_PROFILE } from '../browser-session/ChromeProfileStore';
import { parseKeyPress } from '../pipe/handlers/cdpKeys';
import { readFocus } from './PhoneBrowserFocus';
import { PhoneBrowserError } from '../../shared/phoneBrowserPreview';

/** How long a whole Chrome capture, or one input, may take before the tab reads as hidden. */
export const PHONE_CHROME_CAPTURE_MS = 5_000;

export interface PhoneChromeTab { surfaceId: string; url: string; title: string }

/** Main's dedicated Chrome profiles, as the phone preview may see them. */
export interface PhoneChromeDeps {
  /**
   * The tabs wmux opened in the workspace's own dedicated profile whose
   * recorded workspace is exactly `workspaceId`. Never Live Chrome, never a
   * pane's exclusive profile, never a launch: [] while no Chrome is running.
   */
  tabs(workspaceId: string): Promise<PhoneChromeTab[]>;
  /** A page session on one of those tabs; throws ChromePageSessionError. */
  session(surfaceId: string, workspaceId: string): Promise<ChromePageSession>;
  /** A session of its own on one of those tabs, for the stream's screencast; throws ChromePageSessionError. */
  streamSession?(surfaceId: string, workspaceId: string): Promise<ChromeStreamSession>;
  /** Whether the tab's record still names exactly this workspace. */
  owns?(surfaceId: string, workspaceId: string): boolean;
  /** Bring one of those tabs, and its window, to the front. */
  focus(surfaceId: string, workspaceId: string): Promise<boolean>;
  /** Whether `open` would land in a dedicated profile (never Live Chrome). */
  canOpen(workspaceId: string): boolean;
  /** The desktop's navigation policy for one URL; throws when it refuses. */
  validateNavigation(url: string): Promise<void>;
  /** Test seam for PHONE_CHROME_CAPTURE_MS. */
  captureMs?: number;
}

/** Surfaces with a phone input in flight: one at a time per tab. */
const active = new Set<string>();

function coded(err: unknown): unknown {
  if (err instanceof ChromePageSessionError) {
    return new PhoneBrowserError(err.reason === 'gone' ? 'browser-tab-gone' : 'browser-backend-unavailable');
  }
  return err;
}

interface Viewport { width: number; height: number; scrollX: number; scrollY: number; scale: number; zoom: number }

/** The largest viewport side the preview takes, as for a builtin pane (PhoneBrowserGeometry). */
const MAX_VIEWPORT = 32768;
/** The longest side, in device-independent pixels, a Chrome capture is asked for. */
const MAX_CAPTURE_SIDE = 2048;

function dimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_VIEWPORT;
}

function offset(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** The visual viewport from Page.getLayoutMetrics, in CSS pixels; throws when unusable. A builtin pane's too (PhoneBrowser.ts). */
export function viewportOf(metrics: unknown): Viewport {
  const m = metrics as { cssVisualViewport?: Record<string, unknown>; visualViewport?: Record<string, unknown> } | null;
  const vp = m?.cssVisualViewport ?? m?.visualViewport;
  if (!vp || !dimension(vp.clientWidth) || !dimension(vp.clientHeight) || !offset(vp.pageX) || !offset(vp.pageY)) {
    throw new Error('Unsupported browser geometry');
  }
  return {
    width: vp.clientWidth, height: vp.clientHeight, scrollX: vp.pageX, scrollY: vp.pageY,
    scale: typeof vp.scale === 'number' ? vp.scale : NaN,
    // Browser zoom (Ctrl+): CSS pixels per device-independent pixel. Absent on older Chrome.
    zoom: vp.zoom === undefined ? 1 : typeof vp.zoom === 'number' && vp.zoom > 0 ? vp.zoom : NaN,
  };
}

export function chromeDriver(surfaceId: string, workspaceId: string, deps: PhoneChromeDeps): PhoneBrowserDriver {
  // The tab as the workspace's strict list has it now: null once it is not.
  const tab = async () => (await deps.tabs(workspaceId)).find(t => t.surfaceId === surfaceId) ?? null;
  // One session per request; a dead one answers `gone` rather than being re-found.
  let session: Promise<ChromePageSession> | null = null;
  // Set when a capture ran out of budget: whatever that capture still had
  // queued stops at its next call instead of piling up on Chrome's socket.
  let expired = false;
  const call = async (method: string, params?: Record<string, unknown>) => {
    if (expired) throw new PhoneBrowserError('browser-tab-hidden');
    try {
      session ??= deps.session(surfaceId, workspaceId);
      return await (await session).send(method, params);
    } catch (err) {
      throw coded(err);
    }
  };
  /** A failed write says only that it failed: never Chrome's words, which could quote the input. */
  const write = async (method: string, params: Record<string, unknown>) => {
    try {
      await call(method, params);
    } catch (err) {
      if (err instanceof PhoneBrowserError) throw err;
      throw new Error('Browser operation failed');
    }
  };
  /**
   * One capture or input inside PHONE_CHROME_CAPTURE_MS. Past it the phone
   * hears `browser-tab-hidden` (Chrome is not painting the tab, or not acking
   * its input) and whatever the run still had queued stops at its next call
   * instead of piling up on Chrome's socket, or landing after the phone was
   * told it failed.
   */
  /** Sent past the budget too, best effort: only to undo what this request already did. */
  const always = (method: string, params: Record<string, unknown>) =>
    session?.then((open) => open.send(method, params)).then(() => undefined, () => undefined);
  // The release that matches a press already sent, until it goes out.
  let release: { method: string; params: Record<string, unknown> } | null = null;
  const releaseNow = () => {
    const pending = release;
    release = null;
    return pending ? always(pending.method, pending.params) : undefined;
  };
  /**
   * A press and its release. Once the press is out, the release always
   * follows — at the budget if the press is still unanswered then, or as soon
   * as it fails — so a timed-out tap or key never leaves a button or a key held.
   */
  const pressThenRelease = async (method: string, press: Record<string, unknown>, up: Record<string, unknown>) => {
    // Past the budget no new press goes out, so there is nothing to release.
    if (expired) throw new PhoneBrowserError('browser-tab-hidden');
    release = { method, params: up };
    try {
      await write(method, press);
    } catch (err) {
      await releaseNow();
      throw err;
    }
    // Already sent at the budget: nothing more goes out for this request.
    if (!release) return;
    release = null;
    await write(method, up);
  };
  const bounded = async <T>(run: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        void releaseNow();
        reject(new PhoneBrowserError('browser-tab-hidden'));
      }, deps.captureMs ?? PHONE_CHROME_CAPTURE_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    const running = run();
    // The losing side of the race must never surface as an unhandled rejection.
    running.catch(() => undefined);
    try {
      return await Promise.race([running, hidden]);
    } finally {
      clearTimeout(timer);
    }
  };
  const viewport = async () => viewportOf(await call('Page.getLayoutMetrics'));
  return {
    backend: 'chrome',
    surfaceId,
    page: async () => {
      const found = await tab();
      return found ? { title: found.title, url: found.url } : null;
    },
    layout: () => viewport(),
    geometry: async () => {
      const vp = await viewport();
      // Pinch zoom moves the visual viewport off the layout one, and browser
      // zoom puts the image and the input in different pixels: readable, not tappable.
      if (vp.scale !== 1 || vp.zoom !== 1) throw new Error('Unsupported browser geometry');
      return { width: vp.width, height: vp.height, scrollX: vp.scrollX, scrollY: vp.scrollY };
    },
    shoot: async (quality, scale) => {
      const hidden = (err: unknown) => {
        if (err instanceof PhoneBrowserError) throw err;
        // A listed tab with no usable viewport, or that cannot produce a
        // frame, is one Chrome is not painting (minimized, in the background).
        throw new PhoneBrowserError('browser-tab-hidden');
      };
      const vp = await viewport().catch(hidden);
      // The clip is in device-independent pixels; the metrics are CSS pixels.
      const z = Number.isFinite(vp.zoom) ? vp.zoom : 1;
      const width = vp.width * z;
      const height = vp.height * z;
      // Never ask Chrome to build a frame past the preview's viewport limit,
      // and shrink a large one before it is encoded rather than after.
      if (width > MAX_VIEWPORT || height > MAX_VIEWPORT) throw new Error('Unsupported browser geometry');
      const fitted = Math.min(scale, MAX_CAPTURE_SIDE / Math.max(width, height));
      const shot = await call('Page.captureScreenshot', {
        format: 'jpeg', quality,
        // Document coordinates of what is on screen, so the image is the
        // viewport the geometry describes.
        clip: { x: vp.scrollX * z, y: vp.scrollY * z, width, height, scale: fitted },
      }).catch(hidden);
      const data = (shot as { data?: unknown } | null)?.data;
      if (typeof data !== 'string' || !data) throw new Error('Browser capture unavailable');
      return { data, mimeType: 'image/jpeg' as const };
    },
    capture: run => bounded(run),
    input: async (operation, focus, options = {}) => {
      if (active.has(surfaceId)) throw options.codeBusy ? new PhoneBrowserError('browser-input-busy') : new Error('Browser input unavailable');
      active.add(surfaceId);
      const running = (async () => {
        await options.beforeFocus?.();
        // A background Chrome window has no focused element to type into:
        // emulate focus instead of raising the tab. Set up (attaching the page
        // with it) before the operation's last ownership and URL checks, so
        // the input follows those checks directly.
        if (focus) await write('Emulation.setFocusEmulationEnabled', { enabled: true });
        try {
          await operation();
        } finally {
          // Undone even past the budget: the session outlives this request.
          if (focus) await always('Emulation.setFocusEmulationEnabled', { enabled: false });
        }
      })();
      // Held until the operation itself settles, not until its budget: a send
      // still in flight must not interleave with the next input.
      void running.then(() => active.delete(surfaceId), () => active.delete(surfaceId));
      await bounded(() => running);
    },
    tap: async ({ x, y }) => {
      await write('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      await pressThenRelease('Input.dispatchMouseEvent',
        { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 },
        { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    },
    scroll: async event => {
      // Move first, so Chromium hit-tests the wheel where the phone pointed.
      await write('Input.dispatchMouseEvent', { type: 'mouseMoved', x: event.x, y: event.y, button: 'none', buttons: 0 });
      await write('Input.dispatchMouseEvent', { type: 'mouseWheel', ...event });
    },
    type: text => write('Input.insertText', { text }),
    key: async key => {
      const { keyDown, keyUp } = parseKeyPress(key);
      await pressThenRelease('Input.dispatchKeyEvent', keyDown, keyUp);
    },
    navigate: async url => {
      await deps.validateNavigation(url);
      let result: unknown;
      try {
        result = await call('Page.navigate', { url });
      } catch (err) {
        if (err instanceof PhoneBrowserError) throw err;
        throw new Error('Browser operation failed');
      }
      if ((result as { errorText?: unknown } | null)?.errorText) throw new Error('Browser operation failed');
    },
    historyEntry: async (direction) => {
      // The entry one step away in the tab's history, as Chrome has it now.
      const neighbor = async () => {
        const history = await call('Page.getNavigationHistory') as { currentIndex?: unknown; entries?: unknown } | null;
        if (typeof history?.currentIndex !== 'number' || !Array.isArray(history.entries)) throw new Error('Browser operation failed');
        const entry = history.entries[history.currentIndex + (direction === 'back' ? -1 : 1)] as { id?: unknown; url?: unknown } | undefined;
        if (!entry) return null;
        if (typeof entry.id !== 'number' || typeof entry.url !== 'string') throw new Error('Browser operation failed');
        return { entryId: entry.id, url: entry.url };
      };
      const found = await neighbor();
      if (!found) return null;
      const { entryId, url } = found;
      return {
        url,
        go: async () => {
          await deps.validateNavigation(url);
          // The policy check is asynchronous: go only to the entry it checked,
          // and only while that entry is still one step away.
          const now = await neighbor();
          if (now?.entryId !== entryId || now.url !== url) throw new Error('Browser page changed; refresh before input');
          await write('Page.navigateToHistoryEntry', { entryId });
        },
      };
    },
    viewport: async () => { throw new PhoneBrowserError('browser-action-unsupported'); },
    focus: async () => {
      if (!(await deps.focus(surfaceId, workspaceId))) throw new Error('Browser operation failed');
    },
    readFocus: () => readFocus(call),
  };
}

/** What main's wiring hands phoneChromeTabs: the registry, read-only. */
export interface PhoneChromeRegistry {
  profileFor(workspaceId: string | undefined): string;
  isPaneBound(profile: string): boolean;
  peekLauncher(profile: string): ChromeBackendClient | undefined;
}

function isLive(profile: string): boolean {
  return profile.toLowerCase() === LIVE_CHROME_PROFILE;
}

/**
 * The dedicated Chrome client the workspace's own tabs are in: the profile
 * the workspace (not one of its panes) is bound to, exactly what an operator
 * call with no pane resolves to. Not Live Chrome, not a client with a write
 * scope (that is Live), and not a pane's exclusive profile — a protected
 * pane's browser policy is enforced on its pane's calls, and the phone
 * speaks CDP past it. Never one that does not exist yet: reading a tab must
 * not start a browser.
 */
function clientFor(workspaceId: string, registry: PhoneChromeRegistry): ChromeBackendClient | undefined {
  const profile = registry.profileFor(workspaceId);
  if (isLive(profile) || registry.isPaneBound(profile)) return undefined;
  const client = registry.peekLauncher(profile);
  // A launcher whose tab watcher is off or failed cannot attach a page: its
  // tabs are not the preview's (and help rows say not previewable).
  return client && !client.writeScope && client.pageSession && client.canPageSession?.() !== false ? client : undefined;
}

/**
 * The workspace's dedicated-profile tabs, each with the client that holds it:
 * only tabs whose recorded workspace is exactly this one (listTargets lets a
 * tab with no workspace through). The help table (PhoneBrowserHelp) reads the
 * same list, so a row is previewable exactly when the preview can drive it.
 */
export async function phoneChromeTabs(
  workspaceId: string,
  registry: PhoneChromeRegistry,
): Promise<Array<{ tab: ChromeTargetInfo; client: ChromeBackendClient }>> {
  const client = clientFor(workspaceId, registry);
  return client ? strictTabs(client, workspaceId) : [];
}

async function strictTabs(client: ChromeBackendClient, workspaceId: string): Promise<Array<{ tab: ChromeTargetInfo; client: ChromeBackendClient }>> {
  let tabs: ChromeTargetInfo[];
  try {
    tabs = await client.listTargets(workspaceId);
  } catch {
    return [];
  }
  return tabs.filter((tab) => tab.workspaceId === workspaceId).map((tab) => ({ tab, client }));
}

/**
 * The help table's read of the same tabs: the workspace's own dedicated
 * profile even when a pane is bound to it too (the row still shows where the
 * tab is), each marked with whether the preview may drive it.
 */
export async function phoneChromeHelpTabs(
  workspaceId: string,
  registry: PhoneChromeRegistry,
): Promise<Array<ChromeTargetInfo & { previewable: boolean }>> {
  const profile = registry.profileFor(workspaceId);
  if (isLive(profile)) return [];
  const client = registry.peekLauncher(profile);
  if (!client || client.writeScope) return [];
  const previewable = clientFor(workspaceId, registry) === client;
  return (await strictTabs(client, workspaceId)).map(({ tab }) => ({ ...tab, previewable }));
}

/** main's PhoneChromeDeps over the Chrome registry. */
export function createPhoneChromeDeps(opts: {
  registry: PhoneChromeRegistry;
  validateNavigation: (url: string) => Promise<void>;
}): PhoneChromeDeps {
  const holder = async (surfaceId: string, workspaceId: string) =>
    (await phoneChromeTabs(workspaceId, opts.registry)).find(({ tab }) => tab.surfaceId === surfaceId);
  return {
    tabs: async (workspaceId) => (await phoneChromeTabs(workspaceId, opts.registry))
      .map(({ tab }) => ({ surfaceId: tab.surfaceId, url: tab.url, title: tab.title })),
    // The preview found the tab in this workspace's strict list just before;
    // the session is attached on that same client, with no second list read.
    session: async (surfaceId, workspaceId) => {
      const client = clientFor(workspaceId, opts.registry);
      // The record's own workspace, not only the order of calls before this one.
      if (!client?.pageSession || client.recordFor?.(surfaceId)?.workspaceId !== workspaceId) {
        throw new ChromePageSessionError('gone', 'not a tab of this workspace');
      }
      return client.pageSession(surfaceId);
    },
    // The same checks for the stream's own session.
    streamSession: async (surfaceId, workspaceId) => {
      const client = clientFor(workspaceId, opts.registry);
      if (!client?.streamSession || client.recordFor?.(surfaceId)?.workspaceId !== workspaceId) {
        throw new ChromePageSessionError('gone', 'not a tab of this workspace');
      }
      return client.streamSession(surfaceId);
    },
    owns: (surfaceId, workspaceId) => clientFor(workspaceId, opts.registry)?.recordFor?.(surfaceId)?.workspaceId === workspaceId,
    focus: async (surfaceId, workspaceId) => {
      const found = await holder(surfaceId, workspaceId);
      if (!found?.client.selectSurface || !(await found.client.selectSurface(surfaceId))) return false;
      // The phone's tap is a person's explicit "show me": un-minimize too.
      await found.client.restoreWindow?.(surfaceId);
      return true;
    },
    // A tab the preview could then neither list nor drive is not opened at all:
    // the watcher must be able to attach pages (a launcher not made yet has
    // only the setting to go by).
    canOpen: (workspaceId) => {
      const profile = opts.registry.profileFor(workspaceId);
      if (isLive(profile) || opts.registry.isPaneBound(profile)) return false;
      const client = opts.registry.peekLauncher(profile);
      return client ? !client.writeScope && client.canPageSession?.() !== false : chromeTargetWatcherEnabled();
    },
    validateNavigation: opts.validateNavigation,
  };
}
