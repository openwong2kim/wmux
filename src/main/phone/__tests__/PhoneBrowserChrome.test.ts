import { describe, expect, it, vi } from 'vitest';
import { focusBuiltinTab, handlePhoneBrowser } from '../PhoneBrowser';
import { createPhoneChromeDeps, phoneChromeHelpTabs, phoneChromeTabs, type PhoneChromeDeps, type PhoneChromeRegistry } from '../PhoneBrowserChrome';
import { ChromePageSessionError, type ChromeBackendClient, type ChromeTargetInfo } from '../../browser-session/ChromeLauncher';
import type { RpcResponse } from '../../../shared/rpc';

const METRICS = { cssVisualViewport: { clientWidth: 1000, clientHeight: 700, pageX: 0, pageY: 40, scale: 1 } };

/** A fake CDP page session: answers by method, records every call. */
function fakeChrome(over: Partial<PhoneChromeDeps> = {}) {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let url = 'https://shop.example.com/cart';
  const answer = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'Page.getLayoutMetrics') return METRICS;
    if (method === 'Page.captureScreenshot') return { data: 'aGVsbG8=' };
    return {};
  });
  const deps: PhoneChromeDeps & { setURL(next: string): void } = {
    tabs: vi.fn(async (ws: string) => ws === 'ws-1' ? [{ surfaceId: 'chrome-own', url, title: 'Cart' }] : [{ surfaceId: 'chrome-other', url: 'https://bank.example.com/', title: 'Bank' }]),
    session: vi.fn(async () => ({
      send: async (method: string, params?: Record<string, unknown>) => {
        sent.push({ method, ...(params ? { params } : {}) });
        return answer(method);
      },
    })),
    focus: vi.fn(async () => true),
    canOpen: () => true,
    validateNavigation: vi.fn(async () => undefined),
    setURL: (next: string) => { url = next; },
    ...over,
  };
  return { deps, sent, answer };
}

function fixture(chrome?: PhoneChromeDeps) {
  return {
    backend: () => 'chrome',
    clearViewport: vi.fn(async () => undefined),
    nativeBounds: async () => ({ width: 1000, height: 728 }),
    scroll: vi.fn(async () => undefined),
    input: (_id: number, operation: () => Promise<RpcResponse>) => operation(),
    targets: () => [
      { surfaceId: 'pane', workspaceId: 'ws-1', webContentsId: 1, targetId: 't', wsUrl: 'ws://private' },
    ],
    page: () => ({ title: 'Pane', url: 'https://pane.example.com/' }),
    invoke: vi.fn(async (method: string): Promise<RpcResponse> => ({ id: 'rpc', ok: true, result: method === 'browser.evaluate' ? { value: { width: 1000, height: 728, scrollX: 0, scrollY: 0, scale: 1 } } : { ok: true, tab: { surfaceId: 'chrome-new' } } })),
    ...(chrome ? { chrome } : {}),
  };
}

const scope = { workspaceId: 'ws-1', surfaceId: 'chrome-own' };
const geometry = { width: 1000, height: 700, scrollX: 0, scrollY: 40 };

describe('phone preview on dedicated-profile Chrome', () => {
  it('lists Chrome rows only for a phone that asked, and labels every row then', async () => {
    const { deps } = fakeChrome();
    expect(await handlePhoneBrowser('browser.list', { workspaceId: 'ws-1' }, fixture(deps)))
      .toEqual({ pages: [{ id: 'pane', title: 'Pane', url: 'https://pane.example.com/' }] });
    expect(deps.tabs).not.toHaveBeenCalled();
    expect(await handlePhoneBrowser('browser.list', { workspaceId: 'ws-1', chrome: true }, fixture(deps))).toEqual({ pages: [
      { id: 'pane', title: 'Pane', url: 'https://pane.example.com/', backend: 'builtin' },
      { id: 'chrome-own', title: 'Cart', url: 'https://shop.example.com/cart', backend: 'chrome' },
    ] });
  });

  it('leaves out a row whose URL is over 4096 characters; the other rows stay', async () => {
    const at = (length: number) => { const base = 'https://shop.example.com/?q='; return base + 'a'.repeat(length - base.length); };
    const long = at(300 * 1024);
    const { deps } = fakeChrome();
    deps.setURL(long);
    const panes = {
      ...fixture(deps),
      targets: () => [
        { surfaceId: 'pane', workspaceId: 'ws-1', webContentsId: 1, targetId: 't', wsUrl: 'ws://private' },
        { surfaceId: 'pane-long', workspaceId: 'ws-1', webContentsId: 2, targetId: 't2', wsUrl: 'ws://private' },
      ],
      page: (id: number) => ({ title: 'Pane', url: id === 2 ? long : 'https://pane.example.com/' }),
    };
    expect(await handlePhoneBrowser('browser.list', { workspaceId: 'ws-1', chrome: true }, panes)).toEqual({ pages: [
      { id: 'pane', title: 'Pane', url: 'https://pane.example.com/', backend: 'builtin' },
    ] });
    // At the limit a row is still listed.
    deps.setURL(at(4096));
    expect((await handlePhoneBrowser('browser.list', { workspaceId: 'ws-1', chrome: true }, panes) as { pages: Array<{ id: string }> }).pages.map((p) => p.id))
      .toEqual(['pane', 'chrome-own']);
  });

  it('leaves out a tab that is not an http(s) page, and refuses to drive it', async () => {
    const { deps, sent } = fakeChrome();
    deps.setURL('chrome://settings/');
    const listed = await handlePhoneBrowser('browser.list', { workspaceId: 'ws-1', chrome: true }, fixture(deps)) as { pages: unknown[] };
    expect(listed.pages).toHaveLength(1);
    await expect(handlePhoneBrowser('browser.capture', scope, fixture(deps))).rejects.toThrow('Only HTTP');
    expect(sent).toHaveLength(0);
  });

  it('captures with the builtin shape, clipped to the viewport the geometry describes', async () => {
    const { deps, sent } = fakeChrome();
    const capture = await handlePhoneBrowser('browser.capture', scope, fixture(deps)) as Record<string, unknown>;
    expect(capture).toMatchObject({ data: 'aGVsbG8=', mimeType: 'image/jpeg', geometry, pageURL: 'https://shop.example.com/cart' });
    expect(typeof capture.capturedAt).toBe('number');
    expect(sent.find((c) => c.method === 'Page.captureScreenshot')?.params)
      .toEqual({ format: 'jpeg', quality: 65, clip: { x: 0, y: 40, width: 1000, height: 700, scale: 0.75 } });
  });

  it('retakes an oversized capture smaller, then gives up within the same limit', async () => {
    const { deps, sent, answer } = fakeChrome();
    answer.mockImplementation(async (method: string) => method === 'Page.getLayoutMetrics' ? METRICS : { data: 'x'.repeat(800 * 1024) });
    await expect(handlePhoneBrowser('browser.capture', scope, fixture(deps))).rejects.toThrow('too large for preview');
    expect(sent.filter((c) => c.method === 'Page.captureScreenshot').map((c) => c.params?.quality)).toEqual([65, 50]);
  });

  it('a capture that does not finish in its budget is a hidden tab, and stops there', async () => {
    const { deps, answer, sent } = fakeChrome({ captureMs: 20 });
    let release: (value: unknown) => void = () => undefined;
    answer.mockImplementation(async (method: string) => method === 'Page.getLayoutMetrics' ? METRICS : new Promise((resolve) => { release = resolve; }));
    expect(await handlePhoneBrowser('browser.capture', scope, fixture(deps))).toEqual({ error: 'browser-tab-hidden' });
    const before = sent.length;
    // The late frame lands: the abandoned capture sends nothing more.
    release({ data: 'aGVsbG8=' });
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(before);
  });

  it('a viewport Chrome cannot report (a minimized window) reads as hidden', async () => {
    const { deps, answer } = fakeChrome();
    answer.mockImplementation(async (method: string) => method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { clientWidth: 0, clientHeight: 0, pageX: 0, pageY: 0, scale: 1 } } : { data: 'aGVsbG8=' });
    expect(await handlePhoneBrowser('browser.capture', scope, fixture(deps))).toEqual({ error: 'browser-tab-hidden' });
  });

  it('an input Chrome does not ack in its budget is a hidden tab, and sends nothing after', async () => {
    const { deps, answer, sent } = fakeChrome({ captureMs: 20 });
    let ack: (value: unknown) => void = () => undefined;
    answer.mockImplementation(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') return METRICS;
      if (method === 'Input.dispatchMouseEvent') return new Promise((resolve) => { ack = resolve; });
      return {};
    });
    const tap = { ...scope, expectedURL: 'https://shop.example.com/cart', geometry, x: 0.5, y: 0.5 };
    expect(await handlePhoneBrowser('browser.tap', tap, fixture(deps))).toEqual({ error: 'browser-tab-hidden' });
    // The tab stays locked while that send is still out, so nothing interleaves with it.
    await expect(handlePhoneBrowser('browser.tap', tap, fixture(deps))).rejects.toThrow('input unavailable');
    // The late ack lands: the rest of the abandoned tap is never sent, and the tab unlocks.
    ack({});
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.filter((c) => c.method === 'Input.dispatchMouseEvent')).toHaveLength(1);
  });

  it('a press that times out is still released, once, and nothing new goes out', async () => {
    for (const [action, extra, pressed, released] of [
      ['browser.tap', { geometry, x: 0.5, y: 0.5 }, 'mousePressed', 'mouseReleased'],
      ['browser.key', { key: 'Enter' }, 'keyDown', 'keyUp'],
    ] as const) {
      const { deps, answer, sent } = fakeChrome({ captureMs: 20 });
      let ack: (value: unknown) => void = () => undefined;
      answer.mockImplementation(async (method: string) => {
        if (method === 'Page.getLayoutMetrics') return METRICS;
        const last = sent.at(-1);
        if (last?.params?.type === pressed) return new Promise((resolve) => { ack = resolve; });
        return {};
      });
      expect(await handlePhoneBrowser(action, { ...scope, expectedURL: 'https://shop.example.com/cart', ...extra }, fixture(deps))).toEqual({ error: 'browser-tab-hidden' });
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      const types = () => sent.map((c) => c.params?.type).filter((t) => t === pressed || t === released);
      expect(types()).toEqual([pressed, released]);
      // The late ack of the press does not send a second release.
      ack({});
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      expect(types()).toEqual([pressed, released]);
    }
  });

  it('browser zoom keeps the capture readable but not tappable, and clips in device pixels', async () => {
    const { deps, sent, answer } = fakeChrome();
    answer.mockImplementation(async (method: string) => method === 'Page.getLayoutMetrics'
      ? { cssVisualViewport: { ...METRICS.cssVisualViewport, zoom: 1.5 } } : { data: 'aGVsbG8=' });
    const capture = await handlePhoneBrowser('browser.capture', scope, fixture(deps)) as Record<string, unknown>;
    expect(capture.data).toBe('aGVsbG8=');
    expect(capture.geometry).toBeUndefined();
    expect(sent.find((c) => c.method === 'Page.captureScreenshot')?.params?.clip).toEqual({ x: 0, y: 60, width: 1500, height: 1050, scale: 0.75 });
  });

  it('a Chrome surface while the setting is not Chrome: the backend is unavailable', async () => {
    const { deps } = fakeChrome();
    const builtin = { ...fixture(deps), backend: () => 'builtin' };
    expect(await handlePhoneBrowser('browser.capture', scope, builtin)).toEqual({ error: 'browser-backend-unavailable' });
    expect(deps.tabs).not.toHaveBeenCalled();
  });

  it('typing follows the last ownership and URL check directly, with focus already emulated', async () => {
    const { deps, sent } = fakeChrome();
    const events: string[] = [];
    const tabs = deps.tabs;
    deps.tabs = vi.fn(async (ws: string) => { events.push('check'); return tabs(ws); });
    deps.session = vi.fn(async () => ({ send: async (method: string) => { events.push(method); sent.push({ method }); return {}; } }));
    await handlePhoneBrowser('browser.type', { ...scope, expectedURL: 'https://shop.example.com/cart', text: 'x' }, fixture(deps));
    expect(events.slice(-4)).toEqual(['Emulation.setFocusEmulationEnabled', 'check', 'Input.insertText', 'Emulation.setFocusEmulationEnabled']);
  });

  it('never asks Chrome for an oversized frame', async () => {
    const { deps, sent, answer } = fakeChrome();
    answer.mockImplementation(async (method: string) => method === 'Page.getLayoutMetrics'
      ? { cssVisualViewport: { clientWidth: 4096, clientHeight: 3000, pageX: 0, pageY: 0, scale: 1 } } : { data: 'aGVsbG8=' });
    await handlePhoneBrowser('browser.capture', scope, fixture(deps));
    expect(sent.find((c) => c.method === 'Page.captureScreenshot')?.params?.clip).toMatchObject({ width: 4096, height: 3000, scale: 0.5 });
  });

  it('one page session per request', async () => {
    const { deps } = fakeChrome();
    await handlePhoneBrowser('browser.tap', { ...scope, expectedURL: 'https://shop.example.com/cart', geometry, x: 0.5, y: 0.5 }, fixture(deps));
    expect(deps.session).toHaveBeenCalledTimes(1);
  });

  it('a tab that went away is gone, and so is a Chrome surface this workspace does not have', async () => {
    const { deps } = fakeChrome({ session: vi.fn(async () => { throw new ChromePageSessionError('gone', 'x'); }) });
    expect(await handlePhoneBrowser('browser.capture', scope, fixture(deps))).toEqual({ error: 'browser-tab-gone' });
    const live = fakeChrome();
    // Another workspace's tab: never looked up across workspaces, never driven.
    expect(await handlePhoneBrowser('browser.capture', { workspaceId: 'ws-1', surfaceId: 'chrome-other' }, fixture(live.deps))).toEqual({ error: 'browser-tab-gone' });
    expect(live.deps.session).not.toHaveBeenCalled();
    // Without the Chrome driver, the builtin answer is what it always was.
    await expect(handlePhoneBrowser('browser.capture', { workspaceId: 'ws-1', surfaceId: 'chrome-other' }, fixture())).rejects.toThrow('does not belong');
  });

  it('a socket that is not up says the backend is unavailable', async () => {
    const { deps } = fakeChrome({ session: vi.fn(async () => { throw new ChromePageSessionError('unavailable', 'x'); }) });
    expect(await handlePhoneBrowser('browser.capture', scope, fixture(deps))).toEqual({ error: 'browser-backend-unavailable' });
  });

  it('types with focus emulation around it, and never echoes the text', async () => {
    const { deps, sent } = fakeChrome();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await handlePhoneBrowser('browser.type', { ...scope, expectedURL: 'https://shop.example.com/cart', text: 'hunter2-secret' }, fixture(deps));
    expect(result).toEqual({ applied: true });
    expect(sent.map((c) => c.method)).toEqual(['Emulation.setFocusEmulationEnabled', 'Input.insertText', 'Emulation.setFocusEmulationEnabled']);
    expect(sent[0].params).toEqual({ enabled: true });
    expect(sent[2].params).toEqual({ enabled: false });
    // A failure does not carry Chrome's words, which could quote the input.
    const failing = fakeChrome();
    failing.answer.mockImplementation(async (method: string) => {
      if (method === 'Input.insertText') throw new Error('CDP: cannot insert hunter2-secret');
      return {};
    });
    const err = await handlePhoneBrowser('browser.type', { ...scope, expectedURL: 'https://shop.example.com/cart', text: 'hunter2-secret' }, fixture(failing.deps)).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('hunter2');
    expect(failing.sent.at(-1)).toEqual({ method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } });
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
    log.mockRestore();
  });

  it('enforces the page and the viewport the phone last saw, inside the input closure too', async () => {
    const { deps, sent } = fakeChrome();
    await expect(handlePhoneBrowser('browser.type', { ...scope, expectedURL: 'https://shop.example.com/old', text: 'x' }, fixture(deps))).rejects.toThrow('page changed');
    await expect(handlePhoneBrowser('browser.tap', { ...scope, expectedURL: 'https://shop.example.com/cart', geometry: { ...geometry, scrollY: 0 }, x: 0.5, y: 0.5 }, fixture(deps))).rejects.toThrow('viewport changed');
    expect(sent.some((c) => c.method.startsWith('Input.'))).toBe(false);
    await handlePhoneBrowser('browser.tap', { ...scope, expectedURL: 'https://shop.example.com/cart', geometry, x: 0.5, y: 0.5 }, fixture(deps));
    expect(sent.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(sent.at(-1)?.params).toMatchObject({ x: 500, y: 350 });
    // The tab navigates while the input waits its turn.
    const racing = fakeChrome();
    let reads = 0;
    racing.deps.tabs = vi.fn(async () => [{ surfaceId: 'chrome-own', url: reads++ < 2 ? 'https://shop.example.com/cart' : 'https://evil.example.com/', title: 'Cart' }]);
    await expect(handlePhoneBrowser('browser.type', { ...scope, expectedURL: 'https://shop.example.com/cart', text: 'x' }, fixture(racing.deps))).rejects.toThrow('page changed');
    expect(racing.sent.some((c) => c.method === 'Input.insertText')).toBe(false);
    expect(racing.sent.at(-1)).toEqual({ method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } });
  });

  it('keys go through parseKeyPress; scroll moves the pointer first', async () => {
    const { deps, sent } = fakeChrome();
    await handlePhoneBrowser('browser.key', { ...scope, expectedURL: 'https://shop.example.com/cart', key: 'Shift+Tab' }, fixture(deps));
    expect(sent.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => [c.params?.type, c.params?.key, c.params?.modifiers])).toEqual([['keyDown', 'Tab', 8], ['keyUp', 'Tab', 8]]);
    sent.length = 0;
    await handlePhoneBrowser('browser.scroll', { ...scope, expectedURL: 'https://shop.example.com/cart', geometry, x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5 }, fixture(deps));
    const mouse = sent.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouse.map((c) => c.params?.type)).toEqual(['mouseMoved', 'mouseWheel']);
    expect(mouse[1].params).toMatchObject({ x: 500, y: 350, deltaX: 0, deltaY: 350 });
  });

  it('help-card typing is refused when the tab left the origin the help row showed', async () => {
    const { deps, sent } = fakeChrome();
    const typed = { ...scope, expectedURL: 'https://shop.example.com/cart', text: 'pw' };
    expect(await handlePhoneBrowser('browser.type', { ...typed, helpOrigin: 'https://login.example.com' }, fixture(deps))).toEqual({ error: 'browser-help-origin-changed' });
    expect(sent.some((c) => c.method === 'Input.insertText')).toBe(false);
    expect(await handlePhoneBrowser('browser.type', { ...typed, helpOrigin: 'https://shop.example.com' }, fixture(deps))).toEqual({ applied: true });
    // The same rule on a builtin pane.
    const pane = fixture();
    pane.backend = () => 'builtin';
    expect(await handlePhoneBrowser('browser.type', { workspaceId: 'ws-1', surfaceId: 'pane', expectedURL: 'https://pane.example.com/', text: 'pw', helpOrigin: 'https://login.example.com' }, pane)).toEqual({ error: 'browser-help-origin-changed' });
    expect(pane.invoke).not.toHaveBeenCalledWith('browser.type.cdp', expect.anything());
  });

  it('navigates through the desktop policy, and has no viewport emulation', async () => {
    const { deps, sent } = fakeChrome();
    await handlePhoneBrowser('browser.navigate', { ...scope, url: 'https://shop.example.com/next' }, fixture(deps));
    expect(deps.validateNavigation).toHaveBeenCalledWith('https://shop.example.com/next');
    expect(sent.at(-1)).toEqual({ method: 'Page.navigate', params: { url: 'https://shop.example.com/next' } });
    await expect(handlePhoneBrowser('browser.navigate', { ...scope, url: 'file:///etc/passwd' }, fixture(deps))).rejects.toThrow();
    expect(await handlePhoneBrowser('browser.viewport', { ...scope, mode: 'mobile' }, fixture(deps))).toEqual({ error: 'browser-action-unsupported' });
  });

  it('focus brings forward only a tab of this workspace', async () => {
    const { deps } = fakeChrome();
    expect(await handlePhoneBrowser('browser.focus', scope, fixture(deps))).toEqual({ applied: true });
    expect(deps.focus).toHaveBeenCalledWith('chrome-own', 'ws-1');
    vi.mocked(deps.focus).mockClear();
    expect(await handlePhoneBrowser('browser.focus', { workspaceId: 'ws-1', surfaceId: 'chrome-other' }, fixture(deps))).toEqual({ error: 'browser-tab-gone' });
    expect(deps.focus).not.toHaveBeenCalled();
    // A builtin pane: the renderer's select, when wired.
    const pane = fixture(deps);
    const focusBuiltin = vi.fn(async () => true);
    expect(await handlePhoneBrowser('browser.focus', { workspaceId: 'ws-1', surfaceId: 'pane' }, { ...pane, focusBuiltin })).toEqual({ applied: true });
    expect(focusBuiltin).toHaveBeenCalledWith('pane', 'ws-1');
    expect(await handlePhoneBrowser('browser.focus', { workspaceId: 'ws-1', surfaceId: 'pane' }, pane)).toEqual({ error: 'browser-action-unsupported' });
  });

  it('focusing a builtin pane activates its workspace first, and succeeds only when both took', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const send = (answers: Record<string, unknown>) => async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      return answers[method];
    };
    expect(await focusBuiltinTab(send({ 'workspace.focus': { ok: true }, 'browser.tabs': { ok: true } }), 'pane', 'ws-2')).toBe(true);
    expect(calls).toEqual([
      ['workspace.focus', { id: 'ws-2' }],
      ['browser.tabs', { action: 'select', workspaceId: 'ws-2', surfaceId: 'pane' }],
    ]);
    calls.length = 0;
    expect(await focusBuiltinTab(send({ 'workspace.focus': { ok: false } }), 'pane', 'ws-2')).toBe(false);
    expect(calls.map(([method]) => method)).toEqual(['workspace.focus']);
    expect(await focusBuiltinTab(send({ 'workspace.focus': { ok: true }, 'browser.tabs': { ok: false } }), 'pane', 'ws-2')).toBe(false);
  });

  it('opens a Chrome tab only in a dedicated profile', async () => {
    const { deps } = fakeChrome({ canOpen: () => false });
    const live = fixture(deps);
    expect(await handlePhoneBrowser('browser.open', { workspaceId: 'ws-1', url: 'https://a.example.com/', backend: 'chrome' }, live)).toEqual({ error: 'browser-backend-unavailable' });
    expect(live.invoke).not.toHaveBeenCalled();
    const dedicated = fixture(fakeChrome().deps);
    expect(await handlePhoneBrowser('browser.open', { workspaceId: 'ws-1', url: 'https://a.example.com/', backend: 'chrome' }, dedicated)).toEqual({ surfaceId: 'chrome-new' });
    expect(dedicated.invoke).toHaveBeenCalledWith('browser.tabs', { workspaceId: 'ws-1', action: 'new', url: 'https://a.example.com/' });
    const builtinSetting = { ...fixture(fakeChrome().deps), backend: () => 'builtin' };
    expect(await handlePhoneBrowser('browser.open', { workspaceId: 'ws-1', url: 'https://a.example.com/', backend: 'chrome' }, builtinSetting)).toEqual({ error: 'browser-backend-unavailable' });
    await expect(handlePhoneBrowser('browser.open', { workspaceId: 'ws-1', url: 'https://a.example.com/', backend: 'live' }, dedicated)).rejects.toThrow('Invalid browser backend');
  });
});

describe('stream input (stream:true) on dedicated-profile Chrome', () => {
  const cart = { ...scope, expectedURL: 'https://shop.example.com/cart' };
  const mouse = (sent: ReturnType<typeof fakeChrome>['sent']) => sent.filter((c) => c.method === 'Input.dispatchMouseEvent');

  it('presses a stream key through parseKeyPress, and only on stream input', async () => {
    const { deps, sent } = fakeChrome();
    expect(await handlePhoneBrowser('browser.key', { ...cart, key: 'ArrowDown', stream: true }, fixture(deps))).toEqual({ applied: true });
    expect(sent.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => [c.params?.type, c.params?.key])).toEqual([['keyDown', 'ArrowDown'], ['keyUp', 'ArrowDown']]);
    sent.length = 0;
    await expect(handlePhoneBrowser('browser.key', { ...cart, key: 'ArrowDown' }, fixture(deps))).rejects.toThrow('Unsupported browser key');
    expect(sent).toHaveLength(0);
  });

  it('an input while the last one is still out is browser-input-busy, and sends nothing', async () => {
    const { deps, answer, sent } = fakeChrome();
    let ack: (value: unknown) => void = () => undefined;
    answer.mockImplementation(async (method: string) => {
      if (method === 'Page.getLayoutMetrics') return METRICS;
      if (method === 'Input.insertText') return new Promise((resolve) => { ack = resolve; });
      return {};
    });
    const first = handlePhoneBrowser('browser.type', { ...cart, text: 'one', stream: true }, fixture(deps));
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const before = sent.length;
    expect(await handlePhoneBrowser('browser.type', { ...cart, text: 'two', stream: true }, fixture(deps))).toEqual({ error: 'browser-input-busy' });
    expect(await handlePhoneBrowser('browser.tap', { ...cart, geometry, x: 0.5, y: 0.5, stream: true }, fixture(deps))).toEqual({ error: 'browser-input-busy' });
    // Without the gate, the old failure.
    await expect(handlePhoneBrowser('browser.type', { ...cart, text: 'two' }, fixture(deps))).rejects.toThrow('Browser input unavailable');
    expect(sent.slice(before).filter((c) => c.method.startsWith('Input.') || c.method.startsWith('Emulation.'))).toEqual([]);
    ack({});
    expect(await first).toEqual({ applied: true });
  });

  it('a moved viewport is browser-viewport-changed; a scroll checks the size only', async () => {
    const { deps, sent } = fakeChrome();
    const stale = { ...geometry, scrollY: 0 };
    expect(await handlePhoneBrowser('browser.tap', { ...cart, geometry: stale, x: 0.5, y: 0.5, stream: true }, fixture(deps))).toEqual({ error: 'browser-viewport-changed' });
    expect(await handlePhoneBrowser('browser.scroll', { ...cart, geometry: { ...geometry, height: 699 }, x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5, stream: true }, fixture(deps))).toEqual({ error: 'browser-viewport-changed' });
    expect(mouse(sent)).toEqual([]);
    expect(await handlePhoneBrowser('browser.scroll', { ...cart, geometry: stale, x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5, stream: true }, fixture(deps))).toEqual({ applied: true });
    expect(mouse(sent)[1].params).toMatchObject({ type: 'mouseWheel', x: 500, y: 350, deltaX: 0, deltaY: 350 });
    // Without the gate, both are as strict as before.
    await expect(handlePhoneBrowser('browser.scroll', { ...cart, geometry: stale, x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5 }, fixture(deps))).rejects.toThrow('viewport changed');
  });

  describe('history', () => {
    const plain = { ...cart, direction: 'back' };
    const back = { ...plain, stream: true };
    function withHistory(entries: Array<{ id: number; url: string }>, currentIndex: number) {
      const chrome = fakeChrome();
      chrome.answer.mockImplementation(async (method: string) => method === 'Page.getNavigationHistory' ? { currentIndex, entries } : {});
      const navigated = () => chrome.sent.filter((c) => c.method === 'Page.navigateToHistoryEntry').map((c) => c.params);
      return { ...chrome, navigated };
    }
    const entries = [{ id: 11, url: 'https://shop.example.com/' }, { id: 12, url: 'https://shop.example.com/cart' }, { id: 13, url: 'https://shop.example.com/pay' }];

    it('goes to the entry one step back or forward, through the navigation policy', async () => {
      const { deps, navigated } = withHistory(entries, 1);
      expect(await handlePhoneBrowser('browser.history', back, fixture(deps))).toEqual({ applied: true });
      expect(deps.validateNavigation).toHaveBeenCalledWith('https://shop.example.com/');
      expect(await handlePhoneBrowser('browser.history', { ...back, direction: 'forward' }, fixture(deps))).toEqual({ applied: true });
      expect(navigated()).toEqual([{ entryId: 11 }, { entryId: 13 }]);
    });

    it('nothing to go to is applied:false, and nothing moves', async () => {
      const { deps, navigated } = withHistory(entries.slice(0, 2), 1);
      expect(await handlePhoneBrowser('browser.history', { ...back, direction: 'forward' }, fixture(deps))).toEqual({ applied: false });
      const first = withHistory(entries.slice(1), 0);
      expect(await handlePhoneBrowser('browser.history', back, fixture(first.deps))).toEqual({ applied: false });
      expect([...navigated(), ...first.navigated()]).toEqual([]);
      expect(deps.validateNavigation).not.toHaveBeenCalled();
    });

    it('refuses to move once the history changed during the policy check', async () => {
      for (const after of [
        { currentIndex: 2, entries },
        { currentIndex: 1, entries: [{ id: 21, url: entries[0].url }, ...entries.slice(1)] },
        { currentIndex: 1, entries: [{ id: 11, url: 'https://shop.example.com/other' }, ...entries.slice(1)] },
        { currentIndex: 0, entries },
      ]) {
        const { deps, answer, navigated } = withHistory(entries, 1);
        let reads = 0;
        answer.mockImplementation(async (method: string) => method === 'Page.getNavigationHistory'
          ? (reads++ === 0 ? { currentIndex: 1, entries } : after) : {});
        await expect(handlePhoneBrowser('browser.history', back, fixture(deps))).rejects.toThrow('page changed');
        expect(deps.validateNavigation).toHaveBeenCalledWith('https://shop.example.com/');
        expect(reads).toBe(2);
        expect(navigated()).toEqual([]);
      }
    });

    it('refuses an entry that is not an http(s) page, before the policy and without moving', async () => {
      const { deps, navigated } = withHistory([{ id: 10, url: 'chrome://newtab/' }, entries[1]], 1);
      await expect(handlePhoneBrowser('browser.history', back, fixture(deps))).rejects.toThrow('Only HTTP');
      expect(deps.validateNavigation).not.toHaveBeenCalled();
      expect(navigated()).toEqual([]);
    });

    it('exists only on stream input', async () => {
      const { deps, sent } = withHistory(entries, 1);
      await expect(handlePhoneBrowser('browser.history', plain, fixture(deps))).rejects.toThrow('Unsupported browser operation');
      expect(sent).toHaveLength(0);
    });
  });
});

describe('stream input on a streamed Chrome tab', () => {
  const A = 'https://shop.example.com/search?q=a';
  const B = 'https://shop.example.com/search?q=ab';
  /** A stream on chrome-own whose document has had A, then B (live); the tab list still says A. */
  function streamed(geometryOf: Record<string, unknown> | null = { width: 1017, height: 700, scrollX: 0, scrollY: 40 }, metrics: Record<string, unknown> = { ...METRICS.cssVisualViewport, zoom: 1 }) {
    const chrome = fakeChrome();
    chrome.deps.setURL(A);
    chrome.answer.mockImplementation(async (method: string) => method === 'Page.getLayoutMetrics' ? { cssVisualViewport: metrics } : {});
    const view = { url: B as string | null, docUrls: new Set([A, B]), geometry: geometryOf };
    const deps = { ...fixture(chrome.deps), streams: { tab: (surfaceId: string, workspaceId: string) => (surfaceId === 'chrome-own' && workspaceId === 'ws-1' ? view : null) } } as Parameters<typeof handlePhoneBrowser>[2];
    const sentInput = () => chrome.sent.filter((c) => c.method.startsWith('Input.'));
    return { ...chrome, deps, view, sentInput };
  }
  const input = (command: string, expectedURL: string, extra: Record<string, unknown> = {}) =>
    [command, { ...scope, expectedURL, stream: true, ...extra }] as const;

  it('typing, keys and scroll take an earlier URL of the same document; tap and history need the live one', async () => {
    const r = streamed();
    expect(await handlePhoneBrowser(...input('browser.type', A, { text: 'b' }), r.deps)).toEqual({ applied: true });
    expect(await handlePhoneBrowser(...input('browser.key', A, { key: 'Backspace' }), r.deps)).toEqual({ applied: true });
    expect(await handlePhoneBrowser(...input('browser.scroll', A, { geometry: r.view.geometry, x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.5 }), r.deps)).toEqual({ applied: true });
    const before = r.sentInput().length;
    expect(await handlePhoneBrowser(...input('browser.tap', A, { geometry: r.view.geometry, x: 0.5, y: 0.5 }), r.deps)).toEqual({ error: 'browser-page-changed' });
    expect(await handlePhoneBrowser(...input('browser.history', A, { direction: 'back' }), r.deps)).toEqual({ error: 'browser-page-changed' });
    expect(r.sentInput()).toHaveLength(before);
    expect(await handlePhoneBrowser(...input('browser.tap', B, { geometry: r.view.geometry, x: 0.5, y: 0.5 }), r.deps)).toEqual({ applied: true });
    // Another document's URL is the old failure.
    await expect(handlePhoneBrowser(...input('browser.type', 'https://shop.example.com/cart', { text: 'b' }), r.deps)).rejects.toThrow('page changed');
  });

  it('without stream:true, or on a tab with no stream, the URL check stays exact', async () => {
    const r = streamed();
    await expect(handlePhoneBrowser('browser.type', { ...scope, expectedURL: B, text: 'b' }, r.deps)).rejects.toThrow('page changed');
    expect(await handlePhoneBrowser('browser.type', { ...scope, expectedURL: A, text: 'b' }, r.deps)).toEqual({ applied: true });
    const plain = fakeChrome();
    plain.deps.setURL(B);
    await expect(handlePhoneBrowser(...input('browser.type', A, { text: 'b' }), fixture(plain.deps))).rejects.toThrow('page changed');
  });

  it('a frame up to 24 px wider than the client area (classic scrollbars) maps with the geometry it sent', async () => {
    const r = streamed();
    expect(await handlePhoneBrowser(...input('browser.tap', B, { geometry: r.view.geometry, x: 0.5, y: 0.5 }), r.deps)).toEqual({ applied: true });
    expect(r.sentInput().find((c) => c.params?.type === 'mousePressed')?.params).toMatchObject({ x: 508.5, y: 350 });
    // The same geometry with no stream behind it is a moved viewport.
    const plain = fakeChrome();
    plain.deps.setURL(B);
    expect(await handlePhoneBrowser(...input('browser.tap', B, { geometry: r.view.geometry, x: 0.5, y: 0.5 }), fixture(plain.deps))).toEqual({ error: 'browser-viewport-changed' });
    // Wider than the tolerance: compared with the live viewport, which it does not match.
    const wide = streamed({ width: 1030, height: 700, scrollX: 0, scrollY: 40 });
    expect(await handlePhoneBrowser(...input('browser.tap', B, { geometry: wide.view.geometry, x: 0.5, y: 0.5 }), wide.deps)).toEqual({ error: 'browser-viewport-changed' });
    // A geometry other than the latest frame's (the page scrolled since) is checked live, and moved.
    const r2 = streamed();
    expect(await handlePhoneBrowser(...input('browser.tap', B, { geometry: { width: 1017, height: 700, scrollX: 0, scrollY: 0 }, x: 0.5, y: 0.5 }), r2.deps)).toEqual({ error: 'browser-viewport-changed' });
    expect(r2.sentInput()).toEqual([]);
  });

  it('under pinch zoom maps by the scale, and a tap must name it; browser zoom is refused', async () => {
    const pinch = { width: 390, height: 844, scrollX: 0, scrollY: 40, scale: 0.4 };
    const metrics = { clientWidth: 975, clientHeight: 2110, pageX: 0, pageY: 40, scale: 0.4, zoom: 1 };
    const r = streamed(pinch, metrics);
    expect(await handlePhoneBrowser(...input('browser.tap', B, { geometry: pinch, x: 0.5, y: 0.25 }), r.deps)).toEqual({ applied: true });
    expect(r.sentInput().find((c) => c.params?.type === 'mousePressed')?.params).toMatchObject({ x: 487.5, y: 527.5 });
    expect(await handlePhoneBrowser(...input('browser.scroll', B, { geometry: pinch, x: 0.5, y: 0.5, deltaX: 0, deltaY: 0.1 }), r.deps)).toEqual({ applied: true });
    expect(r.sentInput().filter((c) => c.params?.type === 'mouseWheel').at(-1)?.params).toMatchObject({ x: 487.5, y: 1055, deltaY: 211 });
    const { scale: _scale, ...unscaled } = pinch;
    expect(await handlePhoneBrowser(...input('browser.tap', B, { geometry: unscaled, x: 0.5, y: 0.5 }), r.deps)).toEqual({ error: 'browser-viewport-changed' });
    const zoomed = streamed({ width: 1000, height: 700, scrollX: 0, scrollY: 40 }, { ...METRICS.cssVisualViewport, zoom: 1.25 });
    expect(await handlePhoneBrowser(...input('browser.tap', B, { geometry: { width: 1000, height: 700, scrollX: 0, scrollY: 40 }, x: 0.5, y: 0.5 }), zoomed.deps)).toEqual({ error: 'browser-viewport-changed' });
    expect(zoomed.sentInput()).toEqual([]);
  });
});

describe('which Chrome tabs a workspace has (phoneChromeTabs)', () => {
  function client(tabs: ChromeTargetInfo[], extra: Partial<ChromeBackendClient> = {}): ChromeBackendClient {
    return {
      endpoint: async () => ({}), cdpInfoTargets: async () => [], openTab: async () => { throw new Error('no'); },
      listTargets: vi.fn(async () => tabs), closeSurface: async () => false, hasSurface: () => true, dispose: () => undefined,
      selectSurface: vi.fn(async () => true),
      pageSession: vi.fn(async () => ({ send: async () => ({}) })),
      recordFor: (surfaceId: string) => {
        const found = tabs.find((t) => t.surfaceId === surfaceId);
        return found ? { surfaceId, targetId: found.targetId, url: found.url, createdAt: 0, lastSeenAt: 0, ...(found.workspaceId ? { workspaceId: found.workspaceId } : {}) } : undefined;
      },
      ...extra,
    };
  }
  const tab = (surfaceId: string, workspaceId?: string): ChromeTargetInfo => ({ surfaceId, targetId: `t-${surfaceId}`, url: 'https://a.example.com/', title: surfaceId, ...(workspaceId ? { workspaceId } : {}) });

  it('the workspace\'s own profile only, strict workspace equality, never a launch', async () => {
    const work = client([tab('chrome-mine', 'ws-1'), tab('chrome-nobody'), tab('chrome-theirs', 'ws-2')]);
    const peek = vi.fn((profile: string) => (profile === 'work' ? work : undefined));
    const registry: PhoneChromeRegistry = { profileFor: () => 'work', isPaneBound: () => false, peekLauncher: peek };
    expect((await phoneChromeTabs('ws-1', registry)).map(({ tab }) => tab.surfaceId)).toEqual(['chrome-mine']);
    expect(peek.mock.calls).toEqual([['work']]);
    // A profile no launcher exists for yet lists nothing; it is not created.
    expect(await phoneChromeTabs('ws-1', { ...registry, peekLauncher: () => undefined })).toEqual([]);
  });

  it('never Live Chrome, a client with a write scope, or a pane\'s exclusive profile', async () => {
    const live = client([tab('user-bank', 'ws-1')], { writeScope: {} as ChromeBackendClient['writeScope'] });
    const peek = vi.fn(() => live);
    expect(await phoneChromeTabs('ws-1', { profileFor: () => 'live', isPaneBound: () => false, peekLauncher: peek })).toEqual([]);
    expect(peek).not.toHaveBeenCalled();
    expect(await phoneChromeTabs('ws-1', { profileFor: () => 'lent', isPaneBound: () => false, peekLauncher: peek })).toEqual([]);
    expect(live.listTargets).not.toHaveBeenCalled();
    // A protected pane's profile: its host policy rides on that pane's calls, which the phone would skip.
    const bank = client([tab('chrome-bank', 'ws-1')]);
    expect(await phoneChromeTabs('ws-1', { profileFor: () => 'bank', isPaneBound: (p) => p === 'bank', peekLauncher: () => bank })).toEqual([]);
    expect(bank.listTargets).not.toHaveBeenCalled();
  });

  it('with Chrome\'s tab watcher off or failed, no tab is the preview\'s and help rows are not previewable', async () => {
    const work = client([tab('chrome-mine', 'ws-1')], { canPageSession: () => false });
    const registry: PhoneChromeRegistry = { profileFor: () => 'work', isPaneBound: () => false, peekLauncher: () => work };
    expect(await phoneChromeTabs('ws-1', registry)).toEqual([]);
    expect(await phoneChromeHelpTabs('ws-1', registry)).toMatchObject([{ surfaceId: 'chrome-mine', previewable: false }]);
  });

  it('help rows still read a pane-bound workspace profile, marked not previewable', async () => {
    const work = client([tab('chrome-mine', 'ws-1'), tab('chrome-nobody')]);
    const registry = (bound: boolean): PhoneChromeRegistry => ({ profileFor: () => 'work', isPaneBound: () => bound, peekLauncher: () => work });
    expect(await phoneChromeHelpTabs('ws-1', registry(false))).toMatchObject([{ surfaceId: 'chrome-mine', previewable: true }]);
    expect(await phoneChromeHelpTabs('ws-1', registry(true))).toMatchObject([{ surfaceId: 'chrome-mine', previewable: false }]);
    expect(await phoneChromeHelpTabs('ws-1', { profileFor: () => 'live', isPaneBound: () => false, peekLauncher: () => work })).toEqual([]);
  });

  it('focus and sessions reach only a listed tab, never a Live one', async () => {
    const work = client([tab('chrome-mine', 'ws-1')]);
    const live = client([tab('user-tab', 'ws-1')], { writeScope: {} as ChromeBackendClient['writeScope'] });
    const deps = createPhoneChromeDeps({
      registry: { profileFor: (ws) => (ws === 'ws-live' ? 'live' : 'work'), isPaneBound: () => false, peekLauncher: (p) => (p === 'work' ? work : p === 'live' ? live : undefined) },
      validateNavigation: async () => undefined,
    });
    expect(await deps.focus('chrome-mine', 'ws-1')).toBe(true);
    expect(work.selectSurface).toHaveBeenCalledWith('chrome-mine');
    expect(await deps.focus('user-tab', 'ws-live')).toBe(false);
    expect(await deps.focus('chrome-mine', 'ws-2')).toBe(false);
    expect(live.selectSurface).not.toHaveBeenCalled();
    await expect(deps.session('user-tab', 'ws-live')).rejects.toMatchObject({ reason: 'gone' });
    expect(live.pageSession).not.toHaveBeenCalled();
    // A session goes only to a surface whose own record names this workspace.
    await deps.session('chrome-mine', 'ws-1');
    expect(work.pageSession).toHaveBeenCalledWith('chrome-mine');
    await expect(deps.session('chrome-mine', 'ws-2')).rejects.toMatchObject({ reason: 'gone' });
    await expect(deps.session('chrome-unknown', 'ws-1')).rejects.toMatchObject({ reason: 'gone' });
    expect(work.pageSession).toHaveBeenCalledTimes(1);
    expect(deps.canOpen('ws-live')).toBe(false);
    expect(deps.canOpen('ws-1')).toBe(true);
    const paneBound = createPhoneChromeDeps({
      registry: { profileFor: () => 'work', isPaneBound: () => true, peekLauncher: () => work },
      validateNavigation: async () => undefined,
    });
    expect(paneBound.canOpen('ws-1')).toBe(false);
    // No page sessions possible (tab watcher off or failed): nothing is opened.
    const noWatcher = createPhoneChromeDeps({
      registry: { profileFor: () => 'work', isPaneBound: () => false, peekLauncher: () => client([], { canPageSession: () => false }) },
      validateNavigation: async () => undefined,
    });
    expect(noWatcher.canOpen('ws-1')).toBe(false);
    const notYet = createPhoneChromeDeps({
      registry: { profileFor: () => 'work', isPaneBound: () => false, peekLauncher: () => undefined },
      validateNavigation: async () => undefined,
    });
    expect(notYet.canOpen('ws-1')).toBe(true);
    process.env.WMUX_CHROME_TARGET_WATCHER = '0';
    try {
      expect(notYet.canOpen('ws-1')).toBe(false);
    } finally {
      delete process.env.WMUX_CHROME_TARGET_WATCHER;
    }
    expect(await deps.tabs('ws-live')).toEqual([]);
  });
});
