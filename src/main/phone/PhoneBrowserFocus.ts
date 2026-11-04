// ─── What a phone tap focused, and when that changes (contract v1.6)
//
// The phone raises its keyboard when a tap focused a text field. Main reads
// the page's focused element in an ISOLATED world, so a page script can
// neither see the reader nor change what it reads, and answers only whether
// that element takes typed text and which kind of field it is: never a value,
// name, label, placeholder or id.
//
//  - readFocus(send): one read, for the tap reply. Undefined when it could
//    not be read within READ_FOCUS_MS.
//  - watchFocus(cdp, onChange): the stream's `focus` event. A small detector
//    in an isolated world of every frame nudges main when the frame's own
//    focus may have moved, through a binding main adds to the top frame's
//    world of each document (by executionContextId, so Runtime is never
//    enabled and the page's own world never has it); a child frame's
//    detector nudges through the top frame's world. Main then reads the top
//    frame again. The nudge carries nothing: only main's own read decides
//    the state, so even a forged one could only cause a re-read. Chromium
//    sends a page that is not focused (a dedicated Chrome window behind
//    wmux) no focus events, not even for a script's .focus(), and a page can
//    stop being focused with no event the detector sees: main also reads
//    again every FOCUS_POLL_MS, whatever it heard.
//
// Both run over any CDP session: a dedicated Chrome tab's page or stream
// session, or a builtin pane's webContents.debugger (electronFocusCdp).
// Every expression here is fixed; nothing from the phone goes into one.

import { randomBytes } from 'node:crypto';
import type { Debugger } from 'electron';
import { phoneBrowserFocus, type PhoneBrowserFocus } from '../../shared/phoneBrowserPreview';

/** How long the tap reply waits for the focus read before leaving it out. */
export const READ_FOCUS_MS = 300;
/** How long one of the watcher's reads may take before it is dropped. */
const WATCH_READ_MS = 2_000;
/**
 * How often the watcher reads again whatever it heard: a page that is not
 * focused gets no focus events, and a page can stop being focused with no
 * event its detector sees.
 */
export const FOCUS_POLL_MS = 1_000;
/** The least time between two reads a burst of nudges asks for. */
const READ_GAP_MS = 100;
/** How long stopping waits for the detectors to be taken down. */
const TEARDOWN_MS = 1_000;
/** Takes a frame's detector down (focusDetectorSource), if it has one. */
const TEARDOWN_EXPRESSION = `typeof globalThis.__wmuxFocusTeardown === 'function' && globalThis.__wmuxFocusTeardown()`;
/** The isolated world the tap reply reads in (one per session and document). */
const READ_WORLD = 'wmux-phone-focus';

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** A CDP session as the watcher needs it: ChromeStreamSession, or electronFocusCdp. */
export interface FocusCdp {
  send: CdpSend;
  /** One event of this session; may return its unsubscribe. */
  on(method: string, handler: (params: Record<string, unknown>) => void): void | (() => void);
}

/**
 * The focused element of `doc`, classified. It follows open shadow roots and
 * same-origin frames; a cross-origin frame reads as not editable. Element
 * names, not `instanceof`: a same-origin frame's elements are another realm's.
 */
const CLASSIFY = `(doc) => {
  const TEXT = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];
  let el = doc.activeElement;
  for (let depth = 0; el && depth < 64; depth += 1) {
    const root = el.shadowRoot;
    if (root && root.activeElement) { el = root.activeElement; continue; }
    const name = String(el.localName || '').toLowerCase();
    if (name !== 'iframe' && name !== 'frame') break;
    let inner = null;
    try { inner = el.contentDocument; } catch (e) { inner = null; }
    if (!inner) return { editable: false };
    el = inner.activeElement;
  }
  if (!el) return { editable: false };
  const name = String(el.localName || '').toLowerCase();
  if (name === 'input') {
    const type = String(el.type || 'text').toLowerCase();
    return TEXT.includes(type) && !el.disabled && !el.readOnly ? { editable: true, kind: type } : { editable: false };
  }
  if (name === 'textarea') return !el.disabled && !el.readOnly ? { editable: true, kind: 'textarea' } : { editable: false };
  return el.isContentEditable === true ? { editable: true, kind: 'contenteditable' } : { editable: false };
}`;

/** The read, in the top frame's isolated world. */
export const READ_FOCUS_EXPRESSION = `(${CLASSIFY})(document)`;
/** The watcher's read: the focus, and whether the page is focused (and so gets focus events). */
export const WATCH_FOCUS_EXPRESSION = `[${READ_FOCUS_EXPRESSION}, document.hasFocus()]`;

/** Events after which a frame's focus may have moved. A page that is not focused gets no focus events, but still gets these. */
const DETECTOR_EVENTS = ['focusin', 'focusout', 'pointerdown', 'pointerup', 'click', 'keydown', 'keyup'];

/**
 * The detector, for an isolated world of one frame: after any event that may
 * move focus it classifies the frame's own focus, and on a change nudges main
 * with nothing. The top frame's world holds the nudge, which calls `binding`
 * once main has added it there; a child frame reaches it through `top`, in
 * the same world (a cross-origin top refuses, and is not nudged). `binding`
 * is main's random name, never the phone's.
 */
export function focusDetectorSource(binding: string): string {
  return `(() => {
  if (globalThis.__wmuxFocusDetector) return;
  globalThis.__wmuxFocusDetector = true;
  const isTop = window === window.top;
  if (isTop) {
    globalThis.__wmuxFocusNudge = () => {
      const call = globalThis[${JSON.stringify(binding)}];
      if (typeof call === 'function') { try { call(''); } catch (e) { /* the watcher is gone */ } }
    };
  }
  const nudge = () => {
    try {
      const top = isTop ? globalThis : window.top;
      if (typeof top.__wmuxFocusNudge === 'function') top.__wmuxFocusNudge();
    } catch (e) { /* a cross-origin top */ }
  };
  const classify = ${CLASSIFY};
  let last = '';
  let queued = false;
  const check = () => {
    queued = false;
    let now = '';
    try { now = JSON.stringify(classify(document)); } catch (e) { now = ''; }
    if (now === last) return;
    last = now;
    nudge();
  };
  const later = () => { if (!queued) { queued = true; setTimeout(check, 0); } };
  const types = ${JSON.stringify(DETECTOR_EVENTS)};
  for (const type of types) addEventListener(type, later, { capture: true, passive: true });
  addEventListener('load', later);
  addEventListener('pageshow', later);
  // The watcher stops: this world's detector goes, so a later one starts clean.
  globalThis.__wmuxFocusTeardown = () => {
    for (const type of types) removeEventListener(type, later, { capture: true });
    removeEventListener('load', later);
    removeEventListener('pageshow', later);
    if (isTop) delete globalThis.__wmuxFocusNudge;
    delete globalThis.__wmuxFocusTeardown;
    globalThis.__wmuxFocusDetector = false;
  };
  later();
})()`;
}

/** `frameId`'s `worldName` context: made on first use, then the same one for the document. */
async function worldIn(send: CdpSend, frameId: string, worldName: string): Promise<number> {
  const world = await send('Page.createIsolatedWorld', { frameId, worldName }) as { executionContextId?: unknown } | null;
  if (typeof world?.executionContextId !== 'number') throw new Error('Browser focus unavailable');
  return world.executionContextId;
}

/** The top frame's `worldName` context; undefined when there is none. */
async function topWorld(send: CdpSend, worldName: string): Promise<number | undefined> {
  const tree = await send('Page.getFrameTree') as { frameTree?: { frame?: { id?: unknown } } } | null;
  const frameId = tree?.frameTree?.frame?.id;
  return typeof frameId === 'string' ? worldIn(send, frameId, worldName) : undefined;
}

/** Runs a fixed script in `contextId`; throws when it threw. */
async function runIn(send: CdpSend, contextId: number, source: string): Promise<void> {
  const reply = await send('Runtime.evaluate', { expression: source, contextId }) as { exceptionDetails?: unknown } | null;
  if (reply?.exceptionDetails) throw new Error('Browser focus unavailable');
}

/** A fixed expression's value in `contextId`; undefined when it threw. */
async function valueIn(send: CdpSend, contextId: number, expression: string): Promise<unknown> {
  const reply = await send('Runtime.evaluate', { expression, contextId, returnByValue: true }) as { result?: { value?: unknown }; exceptionDetails?: unknown } | null;
  return !reply || reply.exceptionDetails ? undefined : reply.result?.value;
}

/** The top frame's focus, read in `worldName`; undefined when any step fails. */
async function readTop(send: CdpSend, worldName: string): Promise<PhoneBrowserFocus | undefined> {
  const contextId = await topWorld(send, worldName);
  return contextId === undefined ? undefined : phoneBrowserFocus(await valueIn(send, contextId, READ_FOCUS_EXPRESSION)) ?? undefined;
}

/** `read` within `ms`, else undefined; a failure is undefined too. */
async function within<T>(read: Promise<T | undefined>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([read.catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The page's focus right now, for the tap reply; undefined past `budgetMs` or on any error. */
export function readFocus(send: CdpSend, budgetMs = READ_FOCUS_MS): Promise<PhoneBrowserFocus | undefined> {
  return within(readTop(send, READ_WORLD), budgetMs);
}

export interface FocusWatch {
  /** The latest state reported; null before the first read lands. */
  readonly current: PhoneBrowserFocus | null;
  /** Stops reporting and removes the binding and the new-document detector (best effort). */
  stop(): Promise<void>;
}

/**
 * Reports the page's focus on every change of (editable, kind), the first
 * read included. A cross-document commit of the main frame reports
 * `{editable:false}` at once, then the new page's own focus once it moves.
 * Rejects when the detector cannot be installed in the top frame. Sends
 * Page.enable (the new-document detector needs it), never Runtime.enable.
 */
export async function watchFocus(cdp: FocusCdp, onChange: (focus: PhoneBrowserFocus) => void): Promise<FocusWatch> {
  const token = randomBytes(8).toString('hex');
  const binding = `__wmuxFocus_${token}`;
  const worldName = `wmux-focus-${token}`;
  const detector = focusDetectorSource(binding);
  // Called as the session's own method: a session's send may rely on `this`.
  const send: CdpSend = (method, params) => cdp.send(method, params);
  const offs: Array<() => void> = [];
  let scriptId: string | null = null;
  let stopped = false;
  let current: PhoneBrowserFocus | null = null;
  // Bumped on each cross-document commit: a read begun before it is stale.
  let generation = 0;
  let reading = false;
  let again = false;
  // The top frame's world in the current document, until it is gone.
  let context: number | null = null;
  let poll: ReturnType<typeof setTimeout> | null = null;

  const set = (focus: PhoneBrowserFocus) => {
    if (stopped || (current && current.editable === focus.editable && current.kind === focus.kind)) return;
    current = focus;
    try { onChange(focus); } catch { /* the caller's own failure */ }
  };
  /** The focus, and whether the page is focused; a context that went is found again once. */
  const read = async (): Promise<{ focus: PhoneBrowserFocus; focused: boolean } | undefined> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      context ??= (await topWorld(send, worldName)) ?? null;
      if (context === null) return undefined;
      let value: unknown;
      try {
        value = await valueIn(send, context, WATCH_FOCUS_EXPRESSION);
      } catch {
        context = null;
        continue;
      }
      const pair = Array.isArray(value) ? value : [];
      const focus = phoneBrowserFocus(pair[0]);
      return focus && typeof pair[1] === 'boolean' ? { focus, focused: pair[1] } : undefined;
    }
    return undefined;
  };
  // One read at a time; a nudge during it reads once more afterwards.
  const refresh = async () => {
    if (stopped) return;
    if (reading) { again = true; return; }
    reading = true;
    try {
      do {
        again = false;
        const at = generation;
        const got = await within(read(), WATCH_READ_MS);
        if (got && at === generation) set(got.focus);
        // A page churning its focus reads at most every READ_GAP_MS.
        if (again && !stopped) await new Promise((resolve) => setTimeout(resolve, READ_GAP_MS));
      } while (again && !stopped);
    } finally {
      reading = false;
    }
    // Whatever this read found, or if it failed: read again in a while.
    if (!stopped && !poll) {
      poll = setTimeout(() => { poll = null; void refresh(); }, FOCUS_POLL_MS);
      (poll as { unref?: () => void }).unref?.();
    }
  };
  const listen = (method: string, handler: (params: Record<string, unknown>) => void) => {
    const off = cdp.on(method, (params) => { if (!stopped) handler(params); });
    if (typeof off === 'function') offs.push(off);
  };
  /** The top frame's world of the current document: the binding, then the detector where the new-document one did not run. */
  const bind = async (frameId: string): Promise<number> => {
    const contextId = await worldIn(send, frameId, worldName);
    await send('Runtime.addBinding', { name: binding, executionContextId: contextId });
    await runIn(send, contextId, detector);
    return contextId;
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (poll) { clearTimeout(poll); poll = null; }
    for (const off of offs.splice(0)) off();
    // Each frame's detector of this watcher goes too, or it would stay, with
    // its listeners, for as long as the document does.
    await within((async () => {
      const tree = await send('Page.getFrameTree') as { frameTree?: FrameNode } | null;
      for (const frameId of frameIds(tree?.frameTree)) {
        await worldIn(send, frameId, worldName).then((contextId) => runIn(send, contextId, TEARDOWN_EXPRESSION)).catch(() => undefined);
      }
      return true;
    })(), TEARDOWN_MS);
    await send('Runtime.removeBinding', { name: binding }).catch(() => undefined);
    if (scriptId !== null) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => undefined);
  };

  listen('Runtime.bindingCalled', (params) => { if (params.name === binding) void refresh(); });
  listen('Page.frameNavigated', (params) => {
    const frame = params.frame as { id?: unknown; parentId?: unknown } | undefined;
    if (!frame || frame.parentId !== undefined || typeof frame.id !== 'string') return;
    generation += 1;
    const at = generation;
    context = null;
    set({ editable: false });
    // The new document's world gets the binding; then its focus is read (a
    // page restored from the back-forward cache keeps the focus it had).
    bind(frame.id).then((contextId) => {
      if (stopped || at !== generation) return;
      context = contextId;
      void refresh();
    }, () => undefined);
  });
  try {
    // Page.enable runs the new-document detector, in every frame.
    await send('Page.enable');
    const added = await send('Page.addScriptToEvaluateOnNewDocument', { source: detector, worldName }) as { identifier?: unknown } | null;
    scriptId = typeof added?.identifier === 'string' ? added.identifier : null;
    // The frames already loaded: the new-document detector does not run in them.
    const tree = await send('Page.getFrameTree') as { frameTree?: FrameNode } | null;
    const [top, ...children] = frameIds(tree?.frameTree);
    if (!top) throw new Error('Browser focus unavailable');
    context = await bind(top);
    for (const frameId of children) {
      await worldIn(send, frameId, worldName).then((contextId) => runIn(send, contextId, detector)).catch(() => undefined);
    }
  } catch (err) {
    await stop();
    throw err;
  }
  void refresh();
  return { get current() { return current; }, stop };
}

interface FrameNode { frame?: { id?: unknown }; childFrames?: FrameNode[] }

/** Frame ids, the top one first. */
function frameIds(node: FrameNode | undefined, out: string[] = []): string[] {
  if (!node) return out;
  if (typeof node.frame?.id === 'string') out.push(node.frame.id);
  for (const child of node.childFrames ?? []) frameIds(child, out);
  return out;
}

/** A builtin pane's webContents.debugger as a FocusCdp (its own session's events only). */
export function electronFocusCdp(dbg: Debugger): FocusCdp {
  return {
    send: (method, params) => dbg.sendCommand(method, params),
    on: (method, handler) => {
      const listener = (_event: unknown, name: string, params: unknown, sessionId?: string) => {
        if (name === method && !sessionId) handler((params ?? {}) as Record<string, unknown>);
      };
      dbg.on('message', listener);
      return () => { dbg.removeListener('message', listener); };
    },
  };
}
