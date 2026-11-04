import { PHONE_BROWSER_GEOMETRY, PhoneBrowserViewportChanged, phoneBrowserGeometry, phoneFillScale, phoneBrowserPoint, phoneBrowserScrollPoint, phoneBrowserStreamPoint, phoneBrowserViewportExceeds, type PhoneBrowserGeometry, type PhoneLiveViewport } from './PhoneBrowserGeometry';
import type { PhoneBrowserInputOptions } from './PhoneBrowserInput';
import type { CdpTargetInfo } from '../browser-session/WebviewCdpManager';
import type { RpcResponse } from '../../shared/rpc';
import { browserHelpOrigin } from '../../shared/phoneBrowserHelp';
import { BROWSER_STREAM_KEYS, PhoneBrowserError, type PhoneBrowserBackend, type PhoneBrowserFocus } from '../../shared/phoneBrowserPreview';
import type { PhoneChromeDeps } from './PhoneBrowserChrome';
import { chromeDriver, viewportOf } from './PhoneBrowserChrome';
import type { PhoneStreamTabView } from './PhoneBrowserStream';

// The phone's workspace browser preview: the checks every tab gets, over a
// per-tab driver that talks to the browser.
//
// The checks, whichever browser: the tab is in the request's workspace by
// strict equality (a tab with no workspace is nobody's), only http(s) pages,
// input only on the page the phone last saw (`expectedURL`) at the viewport
// it last saw (`geometry`), and captures inside the pipe's size limit. They
// run again inside the input closure, after any wait for focus.
//
// The drivers: a builtin browser pane (webview, the dependencies below, as
// before), and a tab of a dedicated wmux Chrome profile (PhoneBrowserChrome).
// Live Chrome — the user's own browser — has no driver and is never listed.

interface BrowserDeps {
  backend: () => string;
  clearViewport: (webContentsId: number) => Promise<void>;
  nativeBounds: (webContentsId: number) => Promise<{width:number;height:number}>;
  /** Page.getLayoutMetrics on a builtin pane: a streamed pane's input maps by its frames' geometry. Absent: by the probe, as before. */
  layoutMetrics?: (webContentsId: number) => Promise<unknown>;
  scroll: (webContentsId: number, event: {x:number;y:number;deltaX:number;deltaY:number}) => Promise<void>;
  /**
   * How much larger than its layout a builtin pane is drawn (a phone filling
   * the pane, browser.rpc.ts activeDevicePreset): the scroll anchor goes in at
   * the drawn view's pixels, and the widget bounds are checked as drawn. Absent: 1.
   */
  viewScale?: (webContentsId: number) => number;
  targets: () => CdpTargetInfo[];
  page: (webContentsId: number) => { title: string; url: string } | null;
  input: (webContentsId: number, operation: () => Promise<RpcResponse>, options?: PhoneBrowserInputOptions) => Promise<RpcResponse>;
  invoke: (method: string, params: Record<string, unknown>) => Promise<RpcResponse>;
  /** Make a builtin pane the active tab of its pane (renderer `browser.tabs` select). Absent: focus unsupported. */
  focusBuiltin?: (surfaceId: string, workspaceId: string) => Promise<boolean>;
  /** A builtin pane's history entry one step back (-1) or forward (+1), null when there is none. Absent: no `history`. */
  historyEntry?: (webContentsId: number, offset: -1 | 1) => { url: string; go: () => void } | null;
  /** The desktop's navigation policy for one URL; throws when it refuses. Absent: no `history` on builtin panes. */
  validateNavigation?: (url: string) => Promise<void>;
  /** Dedicated-profile Chrome tabs. Absent: builtin panes only, as before. */
  chrome?: PhoneChromeDeps;
  /** The live browser streams: a streamed tab's URLs and latest geometry. Absent: no stream rules. */
  streams?: { tab(surfaceId: string, workspaceId: string): PhoneStreamTabView | null };
  /** A builtin pane's focused field (PhoneBrowserFocus.readFocus). Absent: a tap reply carries no `focus`. */
  readFocus?: (webContentsId: number) => Promise<PhoneBrowserFocus | undefined>;
}

/** One tab, whichever browser it is in. Every method re-reads the browser. */
export interface PhoneBrowserDriver {
  readonly backend: PhoneBrowserBackend;
  readonly surfaceId: string;
  /** The tab's current page while it is still this workspace's (strict equality), else null. */
  page(): Promise<{ title: string; url: string } | null>;
  /** The viewport, refused when it cannot take input where the phone sees it. */
  geometry(): Promise<PhoneBrowserGeometry>;
  /** Chrome: the visual viewport as it is, pinch scale and browser zoom included. */
  layout?(): Promise<PhoneLiveViewport>;
  shoot(quality: number, scale: number): Promise<{ data: string; mimeType: 'image/jpeg' }>;
  /** A whole capture, inside the driver's own time budget. */
  capture<T>(run: () => Promise<T>): Promise<T>;
  /** One input operation; `focus` holds the tab's input focus around it (typing and keys). */
  input(operation: () => Promise<void>, focus: boolean, options?: PhoneBrowserInputOptions): Promise<void>;
  tap(point: { x: number; y: number }): Promise<void>;
  scroll(event: { x: number; y: number; deltaX: number; deltaY: number }): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string): Promise<void>;
  navigate(url: string): Promise<void>;
  /** The entry `direction` leads to, or null when there is none. `go` checks the desktop's navigation policy, then moves. */
  historyEntry(direction: 'back' | 'forward'): Promise<{ url: string; go(): Promise<void> } | null>;
  /**
   * `fill`: a phone's width drawn larger to fill the pane (the stream's
   * frames), not fitted in its left part; `refit` with it fits the phone
   * already on the pane to the pane's new size, without the reset's reload.
   */
  viewport(mode: 'mobile' | 'desktop', options?: { fill?: boolean; refit?: boolean }): Promise<void>;
  focus(): Promise<void>;
  /** What the focused element takes, right after a tap; undefined when it could not be read in time. */
  readFocus?(): Promise<PhoneBrowserFocus | undefined>;
  /** Chrome: watch for a tab this one opens, armed right before a tap. */
  watchOpened?(): Promise<PhoneOpenedWatch>;
}

/** A tab the tapped tab opens, watched from just before the tap. */
export interface PhoneOpenedWatch {
  /** Its surfaceId: at once when it opened already, within `ms` when the page asked to open one, else undefined. */
  result(ms: number): Promise<string | undefined>;
  stop(): void;
}

/** How long a tap reply waits for the tab the tap asked to open (contract v1.7). */
export const PHONE_TAP_OPENED_MS = 1_000;

/** 700 KiB of base64, so the whole `daemon.phone.complete` envelope stays under
 * the daemon control pipe's 1 MiB per-line limit. */
const CAPTURE_BASE64_LIMIT = 700 * 1024;
/** The longest page URL a capture or a list row carries; input's `expectedURL` has the same limit. */
const PAGE_URL_LIMIT = 4096;
const PREVIEW_COMMANDS = ['browser.capture','browser.viewport','browser.navigate','browser.type','browser.key','browser.tap','browser.scroll','browser.focus'];
const PREVIEW_KEYS = ['Tab','Shift+Tab','Enter','Backspace','Escape','PageUp','PageDown'];

export function pageURL(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = ''; url.password = '';
    return url.href;
  } catch { return null; }
}

/** The phone's URL for open/navigate: credential-free http(s), or a throw. */
function phoneURL(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('Invalid URL');
  const url = new URL(raw);
  if (!pageURL(raw) || url.username || url.password) throw new Error('Only HTTP URLs without embedded credentials are supported');
  return url.href;
}

function webviewDriver(target: CdpTargetInfo, workspaceId: string, deps: BrowserDeps): PhoneBrowserDriver {
  const scope = { surfaceId: target.surfaceId, workspaceId };
  const ok = (result: RpcResponse) => { if (!result.ok) throw new Error('Browser operation failed'); };
  const layoutMetrics = deps.layoutMetrics;
  return {
    backend: 'builtin',
    surfaceId: target.surfaceId,
    page: async () => {
      const owned = deps.targets().some(item => item.surfaceId === target.surfaceId && item.webContentsId === target.webContentsId && item.workspaceId === workspaceId);
      return owned ? deps.page(target.webContentsId) : null;
    },
    // A streamed pane only (pointOn): the visual viewport as Chrome's is read,
    // still refused past the real widget, as geometry() refuses it.
    // Both measured as drawn: a phone drawn larger than its layout takes that much more of the widget.
    ...(layoutMetrics ? { layout: async () => {
      const viewport = viewportOf(await layoutMetrics(target.webContentsId));
      const view = deps.viewScale?.(target.webContentsId) ?? 1;
      if (phoneBrowserViewportExceeds({...viewport,scale:viewport.scale * view}, await deps.nativeBounds(target.webContentsId))) throw new Error('Browser viewport exceeds visible input bounds; reset viewport');
      return viewport;
    } } : {}),
    geometry: async () => {
      const page = phoneBrowserGeometry(await deps.invoke('browser.evaluate',{...scope,expression:PHONE_BROWSER_GEOMETRY}));
      const native = await deps.nativeBounds(target.webContentsId);
      const view = deps.viewScale?.(target.webContentsId) ?? 1;
      if (page.width * view > native.width + 1 || page.height * view > native.height + 1) throw new Error('Browser viewport exceeds visible input bounds; reset viewport');
      return page;
    },
    shoot: async (quality, scale) => {
      const response = await deps.invoke('browser.screenshot', { ...scope, format: 'jpeg', quality, scale, fullPage: false });
      if (!response.ok || !response.result || typeof response.result !== 'object') throw new Error('Browser capture unavailable');
      const shot = response.result as {data?:unknown;mimeType?:unknown};
      if (typeof shot.data !== 'string' || shot.mimeType !== 'image/jpeg') throw new Error('Browser capture exceeds preview limit');
      return shot as {data:string;mimeType:'image/jpeg'};
    },
    capture: run => run(),
    input: async (operation, _focus, options) => {
      ok(await deps.input(target.webContentsId, async () => {
        await operation();
        return {id:'phone-input',ok:true,result:{applied:true}};
      }, options));
    },
    // CSS pixels: browser.click.cdp puts them in at the drawn view's.
    tap: async point => ok(await deps.invoke('browser.click.cdp',{...scope,...point})),
    // The anchor goes in at the drawn view's pixels; wheel deltas stay in CSS pixels.
    scroll: event => {
      const view = deps.viewScale?.(target.webContentsId) ?? 1;
      return deps.scroll(target.webContentsId,{...event,x:event.x * view,y:event.y * view});
    },
    type: async text => ok(await deps.invoke('browser.type.cdp',{...scope,text})),
    key: async key => ok(await deps.invoke('browser.press.cdp',{...scope,key})),
    navigate: async url => ok(await deps.invoke('browser.navigate',{...scope,url})),
    historyEntry: async direction => {
      const validate = deps.validateNavigation;
      if (!deps.historyEntry || !validate) throw new PhoneBrowserError('browser-action-unsupported');
      const entry = deps.historyEntry(target.webContentsId, direction === 'back' ? -1 : 1);
      return entry && { url: entry.url, go: async () => { await validate(entry.url); entry.go(); } };
    },
    viewport: async (mode, options) => {
      const fill = options?.fill === true;
      let result: RpcResponse;
      if (!(fill && options?.refit === true && mode === 'mobile')) {
        result = await deps.invoke('browser.emulate', {...scope,deviceReset:true});
        if (!result.ok) throw new Error('Browser viewport reset failed');
        // Discard the RPC's remembered pre-preset dimensions: the native widget
        // may have been resized since that snapshot.
        await deps.clearViewport(target.webContentsId);
      }
      if (mode === 'mobile') {
        // A viewport taller than the Electron guest can capture pixels outside
        // its input hit-test bounds. Fit the mobile viewport to the real guest.
        const available = await deps.nativeBounds(target.webContentsId);
        // Fill: a pane wider than the phone shows the phone's 390 CSS px
        // drawn that much larger, as tall as the pane, instead of in its left part.
        const scale = fill ? phoneFillScale(available) : 1;
        const width = Math.min(390,Math.floor(available.width));
        const height = fill ? Math.floor(available.height / scale) : Math.min(844,Math.floor(available.height));
        result = await deps.invoke('browser.emulate', {...scope,deviceMetrics:{
          width,height,deviceScaleFactor:1,mobile:true,hasTouch:true,screenWidth:width,screenHeight:height,
          ...(scale !== 1 ? {scale} : {}),
        }});
        ok(result);
      }
    },
    focus: async () => {
      if (!deps.focusBuiltin) throw new PhoneBrowserError('browser-action-unsupported');
      if (!(await deps.focusBuiltin(target.surfaceId, workspaceId))) throw new Error('Browser operation failed');
    },
    readFocus: async () => deps.readFocus?.(target.webContentsId),
  };
}

/**
 * The phone's explicit focus on a builtin pane: make its workspace the active
 * one, then make the pane the active tab of its pane group. Selecting the tab
 * alone leaves a background workspace's pane off-screen (and not painting).
 * True only once both took. Only ever on the phone's `focus` action.
 */
export async function focusBuiltinTab(
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  surfaceId: string,
  workspaceId: string,
): Promise<boolean> {
  const workspace = await send('workspace.focus', { id: workspaceId }) as { ok?: unknown } | undefined;
  if (workspace?.ok !== true) return false;
  const tab = await send('browser.tabs', { action: 'select', workspaceId, surfaceId }) as { ok?: unknown } | undefined;
  return tab?.ok === true;
}

/** Workspace-bound preview, with a closed set of browser operations. Codes
 *  main answers in words travel as `{error:<code>}`; anything else throws. */
export async function handlePhoneBrowser(command: string, payload: Record<string, unknown>, deps: BrowserDeps): Promise<unknown> {
  try {
    return await phoneBrowser(command, payload, deps);
  } catch (err) {
    if (err instanceof PhoneBrowserError) return { error: err.code };
    throw err;
  }
}

/**
 * What a phone's `open` without `backend` makes in this workspace: the
 * desktop's own backend, or null when the phone can open no page here (an
 * external browser, or a workspace bound to the user's own Chrome).
 */
function openBackend(workspaceId: string, deps: BrowserDeps): PhoneBrowserBackend | null {
  const backend = deps.backend();
  if (backend === 'builtin') return 'builtin';
  return backend === 'chrome' && deps.chrome?.canOpen(workspaceId) ? 'chrome' : null;
}

async function phoneBrowser(command: string, payload: Record<string, unknown>, deps: BrowserDeps): Promise<unknown> {
  const workspaceId = payload.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId) throw new Error('Missing workspace');
  const targets = deps.targets().filter(target => target.workspaceId === workspaceId);
  if (command === 'browser.open') {
    // No `backend`: the desktop's own (an older phone, or one that read `openBackend`).
    const backend = payload.backend ?? (deps.backend() === 'chrome' ? 'chrome' : 'builtin');
    if (backend !== 'builtin' && backend !== 'chrome') throw new Error('Invalid browser backend');
    if (backend === 'builtin' && deps.backend() !== 'builtin') throw new Error('Embedded browser backend required');
    const url = phoneURL(payload.url);
    // A dedicated profile only: on a workspace bound to Live Chrome this RPC
    // would dial the user's own browser, which no phone action may do.
    if (backend === 'chrome' && (!deps.chrome || deps.backend() !== 'chrome' || !deps.chrome.canOpen(workspaceId))) throw new PhoneBrowserError('browser-backend-unavailable');
    const opened = await deps.invoke('browser.tabs',{workspaceId,action:'new',url});
    if (!opened.ok) throw new Error('Browser creation unconfirmed');
    const result = opened.result as {ok?:unknown;tab?:{surfaceId?:unknown}} | undefined;
    if (result?.ok !== true || typeof result.tab?.surfaceId !== 'string' || !result.tab.surfaceId) throw new Error('Browser creation unconfirmed');
    return {surfaceId:result.tab.surfaceId};
  }

  if (command === 'browser.list') {
    // `chrome:true` only from a phone that asked (`?chrome=1`): its rows say
    // which browser they are. Without it the reply is what it always was.
    const withChrome = payload.chrome === true;
    // A page whose URL is past PAGE_URL_LIMIT is left out, like a non-http one.
    const pages: Array<{id:string;title:string;url:string;backend?:PhoneBrowserBackend}> = targets.slice(0, 30).flatMap(target => {
      const page = deps.page(target.webContentsId);
      const url = page && pageURL(page.url);
      return page && url && url.length <= PAGE_URL_LIMIT ? [{ id: target.surfaceId, title: page.title.slice(0, 200), url, ...(withChrome ? { backend: 'builtin' as const } : {}) }] : [];
    });
    if (withChrome && deps.chrome && deps.backend() === 'chrome') {
      for (const tab of await deps.chrome.tabs(workspaceId)) {
        if (pages.length >= 30) break;
        const url = pageURL(tab.url);
        if (url && url.length <= PAGE_URL_LIMIT) pages.push({ id: tab.surfaceId, title: tab.title.slice(0, 200), url, backend: 'chrome' });
      }
    }
    const opens = withChrome ? openBackend(workspaceId, deps) : null;
    return { pages, ...(opens ? { openBackend: opens } : {}) };
  }
  // `stream:true` comes only from a daemon whose desktop announced
  // BROWSER_STREAM_CAPABILITY. It brings `history`, the stream's keys, the
  // size-only scroll check and the 409 codes; without it every answer is as before.
  const stream = payload.stream === true;
  if (!PREVIEW_COMMANDS.includes(command) && !(stream && command === 'browser.history')) throw new Error('Unsupported browser operation');
  const surfaceId = payload.surfaceId;
  if (typeof surfaceId !== 'string') throw new Error('Missing surface');
  const driver = await driverFor(surfaceId, workspaceId, targets, deps);
  const current = await driver.page();
  if (!current || !pageURL(current.url)) throw new Error('Only HTTP browser previews are supported');

  if (command === 'browser.capture') {
    return driver.capture(async () => {
      // A geometry the viewport cannot take input at still allows a readable
      // capture; only a code (the tab went away or stopped answering) ends it.
      const optional = (err: unknown) => { if (err instanceof PhoneBrowserError) throw err; return null; };
      const before = await driver.geometry().catch(optional);
      let capture = await driver.shoot(65, 0.75);
      // The reply travels as ONE line on the daemon control pipe, whose reader
      // drops the connection past MAX_LINE_BUFFER (1 MiB, DaemonPipeServer.ts).
      // A capture that fits an old 2 MiB check therefore cost the desktop its
      // daemon connection rather than the phone a preview. Keep the base64 far
      // enough under the line limit that the rest of the envelope still fits;
      // if the first shot is over, retake once smaller, then give up in words.
      if (capture.data.length > CAPTURE_BASE64_LIMIT) capture = await driver.shoot(50, 0.5);
      if (capture.data.length > CAPTURE_BASE64_LIMIT) throw new Error('Browser capture too large for preview');
      const after = await driver.geometry().catch(optional);
      let capturedGeometry;
      if (before && after) {
        try { phoneBrowserPoint(0,0,before,after); capturedGeometry = after; } catch { /* Preview remains readable, but cannot be tapped. */ }
      }
      const page = await driver.page();
      if (!page || pageURL(page.url) !== pageURL(current.url)) throw new Error('Browser page changed during capture');
      const url = pageURL(page.url);
      // A longer URL could never come back as `expectedURL`, so it is left
      // out, and the geometry only input could use goes with it. This also
      // keeps the whole reply inside the bridge's capture allowance.
      if (url && url.length > PAGE_URL_LIMIT) return { data: capture.data, mimeType: 'image/jpeg', capturedAt: Date.now() };
      return { data: capture.data, mimeType: 'image/jpeg', capturedAt: Date.now(), geometry:capturedGeometry, pageURL:url };
    });
  }
  if (command === 'browser.focus') {
    // Only on the phone's explicit tap: nothing else brings a tab forward.
    await driver.focus();
    return { applied: true };
  }
  if (command === 'browser.viewport') {
    if (payload.mode !== 'mobile' && payload.mode !== 'desktop') throw new Error('Invalid viewport');
    await driver.viewport(payload.mode, { fill: payload.fill === true, refit: payload.refit === true });
    return { applied: true };
  }
  if (command === 'browser.navigate') {
    await driver.navigate(phoneURL(payload.url));
    return { applied: true };
  }
  // A streamed tab (stream input only): its stream's committed URL is the
  // live one, and an earlier URL of the same document still takes typing,
  // keys and scroll. A tap or history step must name the live URL; an
  // earlier one of this document is a 409 the phone resends on its next frame.
  const streamed = () => stream ? deps.streams?.tab(surfaceId, workspaceId) ?? null : null;
  const exactURL = command === 'browser.tap' || command === 'browser.history';
  const sameDocument = (page: { url: string }, expected: string) => {
    const view = streamed();
    const live = view?.url ?? pageURL(page.url);
    if (expected === live) return;
    if (view?.url && view.docUrls.has(expected)) {
      if (exactURL) throw new PhoneBrowserError('browser-page-changed');
      return;
    }
    throw new Error('Browser page changed; refresh before input');
  };
  if (typeof payload.expectedURL !== 'string') throw new Error('Browser page changed; refresh before input');
  const expectedURL = payload.expectedURL;
  sameDocument(current, expectedURL);
  // Help-card typing: the origin the daemon's help row showed, never the body's.
  const helpOrigin = command === 'browser.type' && payload.helpOrigin !== undefined ? payload.helpOrigin : undefined;
  if (helpOrigin !== undefined && typeof helpOrigin !== 'string') throw new PhoneBrowserError('browser-help-origin-changed');
  const unchanged = async () => {
    const page = await driver.page();
    if (!page) throw new Error('Browser page changed; refresh before input');
    sameDocument(page, expectedURL);
    return page;
  };
  /**
   * The phone's point on the live viewport, and the CSS pixels one normalized
   * unit spans (scroll deltas). A streamed tab maps it with the latest
   * frame's geometry while the live viewport agrees (phoneBrowserStreamPoint).
   * A mismatch on stream input is a 409 the phone resends on its next frame.
   */
  const pointOn = async (): Promise<{ x: number; y: number; spanX: number; spanY: number }> => {
    try {
      const view = streamed();
      if (view && driver.layout) {
        return phoneBrowserStreamPoint(payload.x, payload.y, payload.geometry, view.geometry, await driver.layout(), command === 'browser.scroll' ? 'scroll' : 'tap');
      }
      const point = (stream && command === 'browser.scroll' ? phoneBrowserScrollPoint : phoneBrowserPoint)(payload.x,payload.y,payload.geometry,await driver.geometry());
      const size = payload.geometry as {width:number;height:number};
      return { ...point, spanX: size.width, spanY: size.height };
    } catch (err) {
      if (stream && err instanceof PhoneBrowserViewportChanged) throw new PhoneBrowserError('browser-viewport-changed');
      throw err;
    }
  };
  // Stream tap/scroll: the viewport recheck runs with the lock held but before
  // anything focuses or raises the tab, so a 409 leaves the desktop as it
  // was. Focus may move the viewport, so the same checks run again after it,
  // right before the input.
  const recheck = async () => { await unchanged(); await pointOn(); };
  const streamPointer = (operation: () => Promise<void>) => driver.input(async () => { await recheck(); await unchanged(); await operation(); }, false, {
    codeBusy: true,
    beforeFocus: recheck,
  });
  const input = (operation: () => Promise<void>) => stream && (command === 'browser.tap' || command === 'browser.scroll') ? streamPointer(operation) : driver.input(async () => {
    // The last checks before the input, after any wait for the lock and focus.
    const page = await unchanged();
    if (helpOrigin !== undefined && browserHelpOrigin(page.url) !== helpOrigin) throw new PhoneBrowserError('browser-help-origin-changed');
    if (command === 'browser.tap' || command === 'browser.scroll') {
      await pointOn();
      await unchanged();
    }
    await operation();
  }, command === 'browser.type' || command === 'browser.key', stream ? { codeBusy: true } : undefined);
  if (command === 'browser.tap' || command === 'browser.scroll') {
    const { x, y, spanX, spanY } = await pointOn();
    if (command === 'browser.scroll') {
      if (typeof payload.deltaX !== 'number' || !Number.isFinite(payload.deltaX) || Math.abs(payload.deltaX) > 1 ||
          typeof payload.deltaY !== 'number' || !Number.isFinite(payload.deltaY) || Math.abs(payload.deltaY) > 1) throw new Error('Invalid browser scroll');
      const event = {x,y,deltaX:payload.deltaX * spanX,deltaY:payload.deltaY * spanY};
      await input(() => driver.scroll(event));
    } else {
      // What the tap focused (contract v1.6), read right after it with the
      // input still held, and the tab it opened (v1.7), watched from just
      // before it and waited for after the input is released.
      const read: { focus?: PhoneBrowserFocus; watching?: Promise<PhoneOpenedWatch> } = {};
      try {
        await input(async () => {
          read.watching = driver.watchOpened?.();
          await read.watching;
          await driver.tap({x,y});
          read.focus = await driver.readFocus?.();
        });
        const opened = await (await read.watching)?.result(PHONE_TAP_OPENED_MS);
        return { applied: true, ...(read.focus ? { focus: read.focus } : {}), ...(opened ? { opened: { surfaceId: opened } } : {}) };
      } finally {
        // Also when the input ran out of time with the watch still being set up.
        void read.watching?.then((watch) => watch.stop(), () => undefined);
      }
    }
  } else if (command === 'browser.type') {
    // eslint-disable-next-line no-control-regex
    if (typeof payload.text !== 'string' || !payload.text || payload.text.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(payload.text)) throw new Error('Invalid browser text');
    const text = payload.text;
    await input(() => driver.type(text));
  } else if (command === 'browser.history') {
    if (payload.direction !== 'back' && payload.direction !== 'forward') throw new Error('Invalid browser history');
    const direction = payload.direction;
    let applied = true;
    await input(async () => {
      const entry = await driver.historyEntry(direction);
      if (!entry) { applied = false; return; }
      // The entry it leads to is held to the preview's own rule: http(s) pages only.
      if (!pageURL(entry.url)) throw new Error('Only HTTP browser previews are supported');
      await entry.go();
    });
    return { applied };
  } else {
    if (!PREVIEW_KEYS.includes(payload.key as string) && !(stream && BROWSER_STREAM_KEYS.includes(payload.key as string))) throw new Error('Unsupported browser key');
    const key = payload.key as string;
    await input(() => driver.key(key));
  }
  return { applied: true };
}

/** The tab's driver: a builtin pane of the workspace, else a dedicated Chrome tab of it. */
async function driverFor(surfaceId: string, workspaceId: string, targets: CdpTargetInfo[], deps: BrowserDeps): Promise<PhoneBrowserDriver> {
  const target = targets.find(target => target.surfaceId === surfaceId);
  if (target) return webviewDriver(target, workspaceId, deps);
  if (deps.chrome && deps.backend() === 'chrome') {
    const tab = (await deps.chrome.tabs(workspaceId)).find(tab => tab.surfaceId === surfaceId);
    if (tab) return chromeDriver(surfaceId, workspaceId, deps.chrome);
  }
  // A dedicated Chrome surface (`chrome-<uuid>`) that is not this workspace's
  // now: closed, replaced, or never ours — the same answer for each.
  if (deps.chrome && surfaceId.startsWith('chrome-')) throw new PhoneBrowserError(deps.backend() === 'chrome' ? 'browser-tab-gone' : 'browser-backend-unavailable');
  throw new Error('Browser does not belong to workspace');
}
