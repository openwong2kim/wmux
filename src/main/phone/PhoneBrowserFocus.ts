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
//    in an isolated world of every frame calls a binding that exists only in
//    that world when the frame's own focus may have moved; main then reads
//    the top frame again. The call carries nothing: only main's own read
//    decides the state, so even a forged call could only cause a re-read.
//    Chromium sends a page that is not focused (a dedicated Chrome window
//    behind wmux) no focus events, not even for a script's .focus(); while
//    the page reads as not focused, main also reads again every
//    UNFOCUSED_POLL_MS.
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
/** How often the watcher reads again while the page is not focused (and so gets no focus events). */
export const UNFOCUSED_POLL_MS = 1_000;
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
 * move focus it classifies the frame's own focus, and on a change calls the
 * binding with nothing. `binding` is main's random name, never the phone's.
 */
export function focusDetectorSource(binding: string): string {
  return `(() => {
  const nudge = globalThis[${JSON.stringify(binding)}];
  if (typeof nudge !== 'function' || globalThis.__wmuxFocusDetector) return;
  globalThis.__wmuxFocusDetector = true;
  const classify = ${CLASSIFY};
  let last = '';
  let queued = false;
  const check = () => {
    queued = false;
    let now = '';
    try { now = JSON.stringify(classify(document)); } catch (e) { now = ''; }
    if (now === last) return;
    last = now;
    try { nudge(''); } catch (e) { /* the watcher is gone */ }
  };
  const later = () => { if (!queued) { queued = true; setTimeout(check, 0); } };
  for (const type of ${JSON.stringify(DETECTOR_EVENTS)}) addEventListener(type, later, { capture: true, passive: true });
  addEventListener('load', later);
  addEventListener('pageshow', later);
  later();
})()`;
}

/** The top frame's `worldName` context; undefined when there is none. */
async function topWorld(send: CdpSend, worldName: string): Promise<number | undefined> {
  const tree = await send('Page.getFrameTree') as { frameTree?: { frame?: { id?: unknown } } } | null;
  const frameId = tree?.frameTree?.frame?.id;
  if (typeof frameId !== 'string') return undefined;
  const world = await send('Page.createIsolatedWorld', { frameId, worldName }) as { executionContextId?: unknown } | null;
  return typeof world?.executionContextId === 'number' ? world.executionContextId : undefined;
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
 * Rejects when the detector cannot be installed in the top frame.
 */
export async function watchFocus(cdp: FocusCdp, onChange: (focus: PhoneBrowserFocus) => void): Promise<FocusWatch> {
  const token = randomBytes(8).toString('hex');
  const binding = `__wmuxFocus_${token}`;
  const worldName = `wmux-focus-${token}`;
  const detector = focusDetectorSource(binding);
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
      context ??= (await topWorld(cdp.send, worldName)) ?? null;
      if (context === null) return undefined;
      let value: unknown;
      try {
        value = await valueIn(cdp.send, context, WATCH_FOCUS_EXPRESSION);
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
    let unfocused = false;
    try {
      do {
        again = false;
        const at = generation;
        const got = await within(read(), WATCH_READ_MS);
        if (got && at === generation) set(got.focus);
        unfocused = got?.focused === false;
      } while (again && !stopped);
    } finally {
      reading = false;
    }
    // No focus events reach a page that is not focused: read again in a while.
    if (unfocused && !stopped && !poll) {
      poll = setTimeout(() => { poll = null; void refresh(); }, UNFOCUSED_POLL_MS);
      (poll as { unref?: () => void }).unref?.();
    }
  };
  const listen = (method: string, handler: (params: Record<string, unknown>) => void) => {
    const off = cdp.on(method, (params) => { if (!stopped) handler(params); });
    if (typeof off === 'function') offs.push(off);
  };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (poll) { clearTimeout(poll); poll = null; }
    for (const off of offs.splice(0)) off();
    await cdp.send('Runtime.removeBinding', { name: binding }).catch(() => undefined);
    if (scriptId !== null) await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(() => undefined);
  };

  listen('Runtime.bindingCalled', (params) => { if (params.name === binding) void refresh(); });
  listen('Page.frameNavigated', (params) => {
    const frame = params.frame as { parentId?: unknown } | undefined;
    if (!frame || frame.parentId !== undefined) return;
    generation += 1;
    context = null;
    set({ editable: false });
    // A page restored from the back-forward cache keeps its focus: read it.
    void refresh();
  });
  try {
    // Runtime first: a named binding reaches only the worlds created after
    // Runtime.enable. Page.enable is what runs the new-document detector.
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.addBinding', { name: binding, executionContextName: worldName });
    await cdp.send('Page.enable');
    const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: detector, worldName }) as { identifier?: unknown } | null;
    scriptId = typeof added?.identifier === 'string' ? added.identifier : null;
    // The frames already loaded: the new-document detector does not run in them.
    const tree = await cdp.send('Page.getFrameTree') as { frameTree?: FrameNode } | null;
    const [top, ...children] = frameIds(tree?.frameTree);
    if (!top) throw new Error('Browser focus unavailable');
    await install(cdp.send, top, worldName, detector);
    for (const frameId of children) await install(cdp.send, frameId, worldName, detector).catch(() => undefined);
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

async function install(send: CdpSend, frameId: string, worldName: string, detector: string): Promise<void> {
  const world = await send('Page.createIsolatedWorld', { frameId, worldName }) as { executionContextId?: unknown } | null;
  if (typeof world?.executionContextId !== 'number') throw new Error('Browser focus unavailable');
  const reply = await send('Runtime.evaluate', { expression: detector, contextId: world.executionContextId }) as { exceptionDetails?: unknown } | null;
  if (reply?.exceptionDetails) throw new Error('Browser focus unavailable');
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
