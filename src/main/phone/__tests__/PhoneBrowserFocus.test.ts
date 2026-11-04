import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { READ_FOCUS_EXPRESSION, UNFOCUSED_POLL_MS, WATCH_FOCUS_EXPRESSION, focusDetectorSource, readFocus, watchFocus, type FocusCdp } from '../PhoneBrowserFocus';
import { phoneBrowserFocus, phoneBrowserTapReply } from '../../../shared/phoneBrowserPreview';

/**
 * Contract v1.6 focus, main's side: the fixed classifier evaluated against
 * DOM fixtures, the tap reply's read, and the stream watcher over a fake CDP
 * session. The real-Chrome cases are in PhoneBrowserFocus.chrome.runtime.test.ts.
 */

// jsdom ships no type declarations here; only the members used below.
interface JsdomWindow extends Window { eval(code: string): unknown }
const { JSDOM } = createRequire(__filename)('jsdom') as {
  JSDOM: new (html: string, opts: Record<string, unknown>) => { window: JsdomWindow };
};

/** A page focused by `focus`, then changed by `after`, read with the production expression. */
function classify(html: string, focus: (doc: Document) => void = () => undefined, after: (win: Window) => void = () => undefined): unknown {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: 'outside-only' });
  focus(dom.window.document);
  after(dom.window);
  return dom.window.eval(READ_FOCUS_EXPRESSION);
}
const byId = (id: string) => (doc: Document) => (doc.getElementById(id) as HTMLElement).focus();

describe('the focus classifier', () => {
  it.each([
    ['<input id="f">', { editable: true, kind: 'text' }],
    ['<input id="f" type="bogus">', { editable: true, kind: 'text' }],
    ['<input id="f" type="TEXT">', { editable: true, kind: 'text' }],
    ['<input id="f" type="password">', { editable: true, kind: 'password' }],
    ['<input id="f" type="email">', { editable: true, kind: 'email' }],
    ['<input id="f" type="number">', { editable: true, kind: 'number' }],
    ['<input id="f" type="tel">', { editable: true, kind: 'tel' }],
    ['<input id="f" type="url">', { editable: true, kind: 'url' }],
    ['<input id="f" type="search">', { editable: true, kind: 'search' }],
    ['<textarea id="f"></textarea>', { editable: true, kind: 'textarea' }],
    ['<input id="f" readonly>', { editable: false }],
    ['<textarea id="f" readonly></textarea>', { editable: false }],
    ['<input id="f" type="checkbox">', { editable: false }],
    ['<input id="f" type="date">', { editable: false }],
    ['<input id="f" type="submit">', { editable: false }],
    ['<button id="f">go</button>', { editable: false }],
    ['<a id="f" href="#x">link</a>', { editable: false }],
  ])('%s reads as %j', (html, expected) => {
    expect(classify(html, byId('f'))).toEqual(expected);
  });

  it('nothing focused, and a disabled field, read as not editable', () => {
    expect(classify('<input id="f">')).toEqual({ editable: false });
    // A disabled field cannot take focus in a browser; the classifier refuses it anyway.
    expect(classify('<input id="f">', (doc) => {
      const input = doc.getElementById('f') as HTMLInputElement;
      input.focus();
      Object.defineProperty(input, 'disabled', { value: true });
    })).toEqual({ editable: false });
  });

  it('a contenteditable element (jsdom has no isContentEditable: given here)', () => {
    expect(classify('<div id="f" contenteditable="true" tabindex="0">x</div>', (doc) => {
      const div = doc.getElementById('f') as HTMLElement;
      Object.defineProperty(div, 'isContentEditable', { value: true });
      div.focus();
    })).toEqual({ editable: true, kind: 'contenteditable' });
    expect(classify('<div id="f" tabindex="0">x</div>', byId('f'))).toEqual({ editable: false });
  });

  it('follows open shadow roots', () => {
    expect(classify('<div id="host"></div>', (doc) => {
      const root = (doc.getElementById('host') as HTMLElement).attachShadow({ mode: 'open' });
      root.innerHTML = '<div id="inner"></div>';
      const nested = (root.getElementById('inner') as HTMLElement).attachShadow({ mode: 'open' });
      nested.innerHTML = '<input id="deep" type="email">';
      (nested.getElementById('deep') as HTMLElement).focus();
    })).toEqual({ editable: true, kind: 'email' });
  });

  it('follows a same-origin frame; a frame it cannot read is not editable', () => {
    const inFrame = (doc: Document) => {
      const frame = doc.getElementById('fr') as HTMLIFrameElement;
      (frame.contentDocument as Document).body.innerHTML = '<input id="x" type="password">';
      ((frame.contentDocument as Document).getElementById('x') as HTMLElement).focus();
    };
    expect(classify('<iframe id="fr"></iframe>', inFrame)).toEqual({ editable: true, kind: 'password' });
    // Cross-origin: contentDocument is null, or reading it throws (made so after focusing inside it).
    for (const blocked of [() => null, () => { throw new Error('SecurityError'); }]) {
      expect(classify('<iframe id="fr"></iframe>', inFrame, (win) => {
        Object.defineProperty((win as unknown as { HTMLIFrameElement: typeof HTMLIFrameElement }).HTMLIFrameElement.prototype, 'contentDocument', { get: blocked });
      })).toEqual({ editable: false });
    }
  });

  it('answers the kind only: never a value, name, label, placeholder or id', () => {
    const read = classify('<label for="f">Card</label><input id="f" name="card" value="4111" placeholder="Card number" autocomplete="cc-number">', byId('f'));
    expect(read).toEqual({ editable: true, kind: 'text' });
    expect(JSON.stringify(read)).not.toMatch(/4111|card|Card|placeholder|"f"/);
  });
});

describe('the focus shape', () => {
  it('takes editable and a known kind only, and drops everything else', () => {
    expect(phoneBrowserFocus({ editable: true, kind: 'password', value: 'hunter2', id: 'pw' })).toEqual({ editable: true, kind: 'password' });
    expect(phoneBrowserFocus({ editable: false })).toEqual({ editable: false });
    expect(phoneBrowserFocus({ editable: true })).toEqual({ editable: true });
    for (const bad of [null, 'x', [], {}, { editable: 'true' }, { editable: true, kind: 'select' }, { editable: true, kind: 7 }, { editable: false, kind: 'text' }]) {
      expect(phoneBrowserFocus(bad)).toBeNull();
    }
  });

  it('a tap reply keeps a valid focus, and loses one that is not', () => {
    expect(phoneBrowserTapReply({ applied: true })).toEqual({ applied: true });
    expect(phoneBrowserTapReply({ applied: true, focus: { editable: true, kind: 'text', value: 'x' } })).toEqual({ applied: true, focus: { editable: true, kind: 'text' } });
    expect(phoneBrowserTapReply({ applied: true, focus: { editable: true, kind: 'select' } })).toEqual({ applied: true });
    expect(phoneBrowserTapReply({ error: 'browser-input-busy' })).toEqual({ error: 'browser-input-busy' });
  });
});

/** A fake CDP session: answers by method, records each call, and emits events on demand. */
function fakeCdp(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const handlers = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  const cdp: FocusCdp = {
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params });
      return answer(method, params);
    }),
    on: (method, handler) => { handlers.set(method, [...(handlers.get(method) ?? []), handler]); },
  };
  const emit = (method: string, params: Record<string, unknown>) => { for (const h of handlers.get(method) ?? []) h(params); };
  return { cdp, calls, emit };
}

const TREE = { frameTree: { frame: { id: 'top' }, childFrames: [{ frame: { id: 'child' } }] } };

describe('readFocus (the tap reply)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reads the top frame in an isolated world, with the fixed expression', async () => {
    const { cdp, calls } = fakeCdp((method) => method === 'Page.getFrameTree' ? TREE
      : method === 'Page.createIsolatedWorld' ? { executionContextId: 7 }
      : { result: { value: { editable: true, kind: 'password', value: 'hunter2' } } });
    expect(await readFocus(cdp.send)).toEqual({ editable: true, kind: 'password' });
    expect(calls.map((c) => c.method)).toEqual(['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.evaluate']);
    expect(calls[1].params).toEqual({ frameId: 'top', worldName: 'wmux-phone-focus' });
    expect(calls[2].params).toEqual({ expression: READ_FOCUS_EXPRESSION, contextId: 7, returnByValue: true });
  });

  it('is undefined on an error, a thrown expression, a shape that is not one, or past its budget', async () => {
    const world = (value: unknown) => (method: string) => method === 'Page.getFrameTree' ? TREE : method === 'Page.createIsolatedWorld' ? { executionContextId: 1 } : value;
    expect(await readFocus(fakeCdp(() => { throw new Error('detached'); }).cdp.send)).toBeUndefined();
    expect(await readFocus(fakeCdp(world({ exceptionDetails: {}, result: { value: { editable: true, kind: 'text' } } })).cdp.send)).toBeUndefined();
    expect(await readFocus(fakeCdp(world({ result: { value: { editable: true, kind: 'select' } } })).cdp.send)).toBeUndefined();
    expect(await readFocus(fakeCdp(() => ({})).cdp.send)).toBeUndefined();
    vi.useFakeTimers();
    const hung = readFocus(fakeCdp(() => new Promise(() => undefined)).cdp.send);
    await vi.advanceTimersByTimeAsync(300);
    expect(await hung).toBeUndefined();
  });
});

describe('watchFocus (the stream event)', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** A session whose page reads `state.focus` (and `state.focused`), until a read is held. */
  function session() {
    const state: { focus: unknown; focused: boolean; hold: Promise<void> | null; context: number } = { focus: { editable: false }, focused: true, hold: null, context: 3 };
    const fake = fakeCdp(async (method, params) => {
      if (method === 'Page.getFrameTree') return TREE;
      if (method === 'Page.createIsolatedWorld') return { executionContextId: state.context };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
      if (method === 'Runtime.evaluate' && params.expression === WATCH_FOCUS_EXPRESSION) {
        if (params.contextId !== state.context) throw new Error('Cannot find context with specified id');
        const hold = state.hold;
        const value = [state.focus, state.focused];
        if (hold) await hold;
        return { result: { value } };
      }
      return {};
    });
    return { ...fake, state };
  }
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const binding = (calls: Array<{ method: string; params: Record<string, unknown> }>) =>
    calls.find((c) => c.method === 'Runtime.addBinding')!.params.name as string;

  it('installs the binding in its own world only, before the detector, in every current frame', async () => {
    const { cdp, calls } = session();
    const watch = await watchFocus(cdp, () => undefined);
    const methods = calls.map((c) => c.method);
    expect(methods.slice(0, 5)).toEqual(['Runtime.enable', 'Runtime.addBinding', 'Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Page.getFrameTree']);
    const world = calls[1].params.executionContextName as string;
    expect(world).toMatch(/^wmux-focus-[0-9a-f]{16}$/);
    expect(calls[3].params).toEqual({ source: focusDetectorSource(binding(calls)), worldName: world });
    expect(calls.filter((c) => c.method === 'Page.createIsolatedWorld').slice(0, 2).map((c) => c.params)).toEqual([
      { frameId: 'top', worldName: world }, { frameId: 'child', worldName: world },
    ]);
    // The detector goes into each of those worlds.
    expect(calls.filter((c) => c.method === 'Runtime.evaluate' && c.params.expression === focusDetectorSource(binding(calls)))).toHaveLength(2);
    // A second watcher gets names of its own.
    const other = session();
    await watchFocus(other.cdp, () => undefined);
    expect(binding(other.calls)).not.toBe(binding(calls));
    await watch.stop();
  });

  it('reports the first read, then each change of (editable, kind) its binding asks for', async () => {
    const { cdp, calls, emit, state } = session();
    const seen: unknown[] = [];
    const watch = await watchFocus(cdp, (focus) => seen.push(focus));
    await settle();
    expect(seen).toEqual([{ editable: false }]);
    state.focus = { editable: true, kind: 'text' };
    emit('Runtime.bindingCalled', { name: 'someoneElse', payload: '' });
    await settle();
    expect(seen).toHaveLength(1);
    emit('Runtime.bindingCalled', { name: binding(calls), payload: '{"editable":true,"kind":"password"}' });
    await settle();
    // The payload is never read: main's own read decides.
    expect(seen).toEqual([{ editable: false }, { editable: true, kind: 'text' }]);
    emit('Runtime.bindingCalled', { name: binding(calls), payload: '' });
    await settle();
    expect(seen).toHaveLength(2);
    state.focus = { editable: true, kind: 'password' };
    emit('Runtime.bindingCalled', { name: binding(calls), payload: '' });
    await settle();
    expect(seen.at(-1)).toEqual({ editable: true, kind: 'password' });
    expect(watch.current).toEqual({ editable: true, kind: 'password' });
    await watch.stop();
  });

  it('a cross-document commit resets to not editable at once, and a read begun before it is dropped', async () => {
    const { cdp, calls, emit, state } = session();
    const seen: unknown[] = [];
    await watchFocus(cdp, (focus) => seen.push(focus));
    await settle();
    state.focus = { editable: true, kind: 'search' };
    emit('Runtime.bindingCalled', { name: binding(calls) });
    await settle();
    expect(seen.at(-1)).toEqual({ editable: true, kind: 'search' });
    // A read is in flight when the page commits: what it read is the old page's.
    let release = () => undefined as void;
    state.hold = new Promise<void>((resolve) => { release = resolve; });
    state.focus = { editable: true, kind: 'email' };
    emit('Runtime.bindingCalled', { name: binding(calls) });
    await settle();
    emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'top' } });
    expect(seen.at(-1)).toEqual({ editable: true, kind: 'search' });
    emit('Page.frameNavigated', { frame: { id: 'top' } });
    expect(seen.at(-1)).toEqual({ editable: false });
    state.focus = { editable: false };
    state.hold = null;
    release();
    await settle();
    expect(seen).toEqual([{ editable: false }, { editable: true, kind: 'search' }, { editable: false }]);
  });

  it('reads in the same world until it is gone, then finds the new one', async () => {
    const { cdp, calls, emit, state } = session();
    const seen: unknown[] = [];
    await watchFocus(cdp, (focus) => seen.push(focus));
    await settle();
    const trees = () => calls.filter((c) => c.method === 'Page.getFrameTree').length;
    const before = trees();
    state.focus = { editable: true, kind: 'url' };
    emit('Runtime.bindingCalled', { name: binding(calls) });
    await settle();
    expect(seen.at(-1)).toEqual({ editable: true, kind: 'url' });
    expect(trees()).toBe(before);
    // The page's world went (a reload the watcher did not see commit yet).
    state.context = 4;
    state.focus = { editable: true, kind: 'tel' };
    emit('Runtime.bindingCalled', { name: binding(calls) });
    await settle();
    expect(seen.at(-1)).toEqual({ editable: true, kind: 'tel' });
    expect(trees()).toBe(before + 1);
  });

  it('while the page is not focused (no focus events reach it), reads again every second', async () => {
    vi.useFakeTimers();
    const { cdp, state } = session();
    state.focused = false;
    const seen: unknown[] = [];
    const watch = await watchFocus(cdp, (focus) => seen.push(focus));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ editable: false }]);
    // A script's .focus() in a page that is not focused: no event, no nudge.
    state.focus = { editable: true, kind: 'text' };
    await vi.advanceTimersByTimeAsync(UNFOCUSED_POLL_MS);
    expect(seen.at(-1)).toEqual({ editable: true, kind: 'text' });
    // Focused again: events carry it from here, and the reads stop.
    state.focused = true;
    await vi.advanceTimersByTimeAsync(UNFOCUSED_POLL_MS);
    state.focus = { editable: false };
    await vi.advanceTimersByTimeAsync(UNFOCUSED_POLL_MS * 3);
    expect(seen.at(-1)).toEqual({ editable: true, kind: 'text' });
    // And stop ends them too.
    state.focused = false;
    await watch.stop();
    await vi.advanceTimersByTimeAsync(UNFOCUSED_POLL_MS * 3);
    expect(seen.at(-1)).toEqual({ editable: true, kind: 'text' });
  });

  it('stop removes the binding and the detector, and nothing is reported after', async () => {
    const { cdp, calls, emit, state } = session();
    const seen: unknown[] = [];
    const watch = await watchFocus(cdp, (focus) => seen.push(focus));
    await settle();
    await watch.stop();
    expect(calls.slice(-2)).toEqual([
      { method: 'Runtime.removeBinding', params: { name: binding(calls) } },
      { method: 'Page.removeScriptToEvaluateOnNewDocument', params: { identifier: 'script-1' } },
    ]);
    state.focus = { editable: true, kind: 'text' };
    emit('Runtime.bindingCalled', { name: binding(calls) });
    emit('Page.frameNavigated', { frame: { id: 'top' } });
    await settle();
    expect(seen).toEqual([{ editable: false }]);
  });

  it('rejects, and cleans up, when the top frame cannot take the detector', async () => {
    const { cdp, calls } = fakeCdp((method) => method === 'Page.getFrameTree' ? TREE
      : method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 's' }
      : method === 'Page.createIsolatedWorld' ? {} : {});
    await expect(watchFocus(cdp, () => undefined)).rejects.toThrow('Browser focus unavailable');
    expect(calls.slice(-2).map((c) => c.method)).toEqual(['Runtime.removeBinding', 'Page.removeScriptToEvaluateOnNewDocument']);
  });
});

describe('the detector', () => {
  it('calls its binding with nothing, only when its frame\'s focus changed', async () => {
    const dom = new JSDOM('<!doctype html><body><input id="a"><input id="b"><input id="p" type="password"><button id="c">c</button></body>', { runScripts: 'outside-only' });
    const win = dom.window as JsdomWindow & { __nudge: ReturnType<typeof vi.fn> };
    win.__nudge = vi.fn();
    win.eval(focusDetectorSource('__nudge'));
    // Installed twice in one world: the second is a no-op.
    win.eval(focusDetectorSource('__nudge'));
    const tick = () => new Promise((r) => setTimeout(r, 5));
    await tick();
    expect(win.__nudge.mock.calls).toEqual([['']]);
    (dom.window.document.getElementById('a') as HTMLElement).focus();
    await tick();
    expect(win.__nudge).toHaveBeenCalledTimes(2);
    // Same kind of field: no change to report.
    (dom.window.document.getElementById('b') as HTMLElement).focus();
    await tick();
    expect(win.__nudge).toHaveBeenCalledTimes(2);
    (dom.window.document.getElementById('p') as HTMLElement).focus();
    await tick();
    expect(win.__nudge).toHaveBeenCalledTimes(3);
    // A key that changes the field's type while it keeps focus (a show-password toggle).
    (dom.window.document.getElementById('p') as HTMLInputElement).type = 'text';
    dom.window.document.dispatchEvent(new (dom.window as unknown as typeof globalThis).KeyboardEvent('keyup', { bubbles: true }));
    await tick();
    expect(win.__nudge).toHaveBeenCalledTimes(4);
    expect(win.__nudge.mock.calls.every((call) => call.length === 1 && call[0] === '')).toBe(true);
  });

  it('does nothing without its binding', async () => {
    const dom = new JSDOM('<!doctype html><body><input id="a"></body>', { runScripts: 'outside-only' });
    const win = dom.window;
    expect(() => win.eval(focusDetectorSource('__absent'))).not.toThrow();
    expect(win.eval('globalThis.__wmuxFocusDetector')).toBeUndefined();
  });
});
