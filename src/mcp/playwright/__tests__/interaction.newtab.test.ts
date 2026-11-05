import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendRpc, getPage, resolveWorkspaceBackend, resolveRefMock } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveWorkspaceBackend: vi.fn(),
  resolveRefMock: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    method.startsWith('browser.lease.') || method === 'browser.lifecycle.get'
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope: getPage, resolveWorkspaceBackend }),
  },
}));

// isOutstandingFrameRef/frameRefFallbackMessage: the fail-closed guard
// sanitizeRef consults before any data-wmux-ref resolution. Stubbed to "no
// frame refs outstanding", which is what these RPC-lane cases are about.
vi.mock('../snapshot', () => ({
  resolveRef: resolveRefMock,
  browserScopeKey: () => 'test-scope',
  isOutstandingFrameRef: () => false,
  frameRefFallbackMessage: (ref: string) => `frame ref ${ref}`,
}));

import { registerInteractionTools } from '../tools/interaction';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

/**
 * The trailer every mutating browser result now ends with (resultTrailer.ts).
 * Spelled out here rather than imported: these assertions are exact on purpose,
 * and the trailer is part of what they pin.
 */
const COMMITTED = '\n\neffect_state: committed';

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInteractionTools(server as never, browserToolDeps);
  return tools;
}

const click = collectTools().get('browser_click');
if (!click) throw new Error('browser_click failed to register');

type Handler = (arg: unknown) => void;

/**
 * A Page double whose click can fire a 'popup' event.
 *
 * `popupUrls` models the real sequence: window.open() resolves on about:blank
 * and the popup navigates a beat later, so each read returns the next entry.
 * `clickThrows` exercises the listener-cleanup path.
 */
function makePage(
  opts: {
    popupUrl?: string;
    popupUrls?: string[];
    clickThrows?: boolean;
    /**
     * What Playwright's click does AFTER the popup fired: on macOS the opener
     * is behind the popup's tab and produces no frames, so the click either
     * never settles or rejects at its action timeout.
     */
    afterPopup?: 'hang' | 'timeout';
    /**
     * The popup fires while the click is still approaching the element (an
     * earlier click's window.open timer), before anything was pressed.
     */
    popupBeforePress?: boolean;
  } = {},
) {
  const handlers = new Map<string, Set<Handler>>();
  const urls = opts.popupUrls ?? (opts.popupUrl !== undefined ? [opts.popupUrl] : undefined);
  let read = 0;
  const firePopup = () => {
    if (!urls) return;
    const popup = {
      url: () => urls[Math.min(read++, urls.length - 1)],
    };
    for (const fn of handlers.get('popup') ?? []) fn(popup);
  };
  const el = {
    click: vi.fn(async () => {
      if (!opts.popupBeforePress) firePopup();
      if (opts.clickThrows) throw new Error('Element is not attached to the DOM');
      if (opts.afterPopup === 'hang') await new Promise<never>(() => undefined);
      if (opts.afterPopup === 'timeout') throw new Error('Timeout 1500ms exceeded.');
    }),
    dblclick: vi.fn(async () => undefined),
    // The click path walks the pointer to the element's box before pressing,
    // so a stand-in element has to have one.
    boundingBox: vi.fn(async () => {
      if (opts.popupBeforePress) firePopup();
      return { x: 10, y: 20, width: 100, height: 40 };
    }),
  };
  return {
    el,
    listenerCount: () => handlers.get('popup')?.size ?? 0,
    handlers: (event: string) => [...(handlers.get(event) ?? [])],
    page: {
      on: (event: string, fn: Handler) => {
        const set = handlers.get(event) ?? new Set<Handler>();
        set.add(fn);
        handlers.set(event, set);
      },
      off: (event: string, fn: Handler) => handlers.get(event)?.delete(fn),
      locator: vi.fn(),
      mouse: { move: vi.fn(async () => undefined) },
      viewportSize: () => ({ width: 1280, height: 720 }),
    },
  };
}

beforeEach(() => {
  mockSendRpc.mockReset();
  mockSendRpc.mockResolvedValue({});
  getPage.mockReset();
  resolveWorkspaceBackend.mockReset();
  resolveRefMock.mockReset();
});

describe('browser_click new-tab detection', () => {
  it('names the popup URL on the chrome backend and points at browser_tabs, without naming a surface', async () => {
    const { page, el } = makePage({ popupUrl: 'https://popup.example/checkout' });
    getPage.mockResolvedValue(page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(el);

    const result = await click({ ref: '3' });
    const text = result.content[0].text;

    expect(text).toContain('Clicked element ref=3');
    expect(text).toContain('opened a popup (page: https://popup.example/checkout)');
    expect(text).toContain('use browser_tabs to find it');
    expect(text).not.toContain('not a wmux surface');
    expect(text).not.toContain('surfaceId=');
  });

  it('says nothing extra when the click opens no popup', async () => {
    const { page, el } = makePage();
    getPage.mockResolvedValue(page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(el);

    const result = await click({ ref: '3' });
    expect(result.content[0].text).toBe('Clicked element ref=3' + COMMITTED);
  });

  it('detaches the listener after the click', async () => {
    const watched = makePage({ popupUrl: 'https://popup.example/' });
    getPage.mockResolvedValue(watched.page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(watched.el);

    await click({ ref: '3' });
    expect(watched.listenerCount()).toBe(0);
  });

  it('does not watch on the builtin backend — popups load into the same webview', async () => {
    const watched = makePage({ popupUrl: 'https://popup.example/' });
    getPage.mockResolvedValue(watched.page);
    resolveWorkspaceBackend.mockResolvedValue('builtin');
    resolveRefMock.mockResolvedValue(watched.el);

    const result = await click({ ref: '3' });
    expect(result.content[0].text).toBe('Clicked element ref=3' + COMMITTED);
    expect(watched.listenerCount()).toBe(0);
  });

  it('waits out about:blank and reports the URL the popup settled on', async () => {
    const { page, el } = makePage({
      popupUrls: ['about:blank', 'about:blank', 'https://popup.example/after-nav'],
    });
    getPage.mockResolvedValue(page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(el);

    const result = await click({ ref: '3' });
    expect(result.content[0].text).toContain('https://popup.example/after-nav');
    expect(result.content[0].text).not.toContain('about:blank');
  });

  it('reports about:blank when the popup never navigates', async () => {
    const { page, el } = makePage({ popupUrl: 'about:blank' });
    getPage.mockResolvedValue(page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(el);

    const result = await click({ ref: '3' });
    expect(result.content[0].text).toContain('opened a popup (page: about:blank)');
  });

  it('masks a password parameter in the popup URL and caps its length', async () => {
    const { page, el } = makePage({
      popupUrl: `https://popup.example/login?password=hunter2&x=${'a'.repeat(400)}`,
    });
    getPage.mockResolvedValue(page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(el);

    const text = (await click({ ref: '3' })).content[0].text;
    expect(text).not.toContain('hunter2');
    expect(text.length).toBeLessThan(400);
  });

  it('returns once the popup fires, without waiting for a click that never settles (macOS background tab)', async () => {
    const watched = makePage({ popupUrl: 'https://popup.example/a', afterPopup: 'hang' });
    getPage.mockResolvedValue(watched.page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(watched.el);

    const result = await click({ ref: '3' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('opened a popup (page: https://popup.example/a)');
    expect(watched.el.click).toHaveBeenCalledTimes(1);
    expect(watched.listenerCount()).toBe(0);
  });

  it('does not press the element a second time when the click times out after its popup fired', async () => {
    const watched = makePage({ popupUrl: 'https://popup.example/b', afterPopup: 'timeout' });
    getPage.mockResolvedValue(watched.page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(watched.el);

    const result = await click({ ref: '3' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('opened a popup (page: https://popup.example/b)');
    // One press: the fallback centre click would have opened a second popup.
    expect(watched.el.click).toHaveBeenCalledTimes(1);
  });

  it('does not count a popup that fired before the press as this click landing', async () => {
    const watched = makePage({ popupUrl: 'https://popup.example/early', popupBeforePress: true, clickThrows: true });
    getPage.mockResolvedValue(watched.page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(watched.el);

    const result = await click({ ref: '3' });
    // The press failed, so the click is reported as failed, after the one
    // centre-click retry a click that never landed is owed.
    expect(result.isError).toBe(true);
    expect(watched.el.click).toHaveBeenCalledTimes(2);
    expect(watched.listenerCount()).toBe(0);
  });

  it('an abandoned click that settles later does not touch the next click on the same page', async () => {
    // First click: opens its popup, then Playwright's action stays pending
    // (the opener is behind the popup's tab) and only rejects much later.
    const first = makePage({ popupUrl: 'https://popup.example/first' });
    let rejectAbandoned!: (e: Error) => void;
    const abandoned = new Promise<void>((_, reject) => (rejectAbandoned = reject));
    first.el.click.mockImplementationOnce(async () => {
      for (const fn of first.handlers('popup')) fn({ url: () => 'https://popup.example/first' });
      await abandoned;
    });
    const second = {
      click: vi.fn(async () => undefined),
      dblclick: vi.fn(async () => undefined),
      boundingBox: vi.fn(async () => ({ x: 10, y: 80, width: 100, height: 40 })),
    };
    getPage.mockResolvedValue(first.page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockImplementation(async (_p: unknown, ref: string) => (ref === '3' ? first.el : second));

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const firstResult = await click({ ref: '3' });
      expect(firstResult.isError).toBeFalsy();
      expect(firstResult.content[0].text).toContain('popup.example/first');

      // The next action runs while the first is still pending in the background.
      const secondResult = await click({ ref: '4' });
      expect(secondResult.isError).toBeFalsy();
      expect(secondResult.content[0].text).toBe('Clicked element ref=4' + COMMITTED);
      expect(second.click).toHaveBeenCalledTimes(1);

      // Now the abandoned action gives up. It must not press anything again
      // (clickWithApproach's centre-click fallback) nor surface as an error.
      rejectAbandoned(new Error('Timeout 1500ms exceeded.'));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(first.el.click).toHaveBeenCalledTimes(1);
      expect(second.click).toHaveBeenCalledTimes(1);
      expect(first.listenerCount()).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('[CRIT] detaches the listener when the click itself throws', async () => {
    const watched = makePage({ clickThrows: true });
    getPage.mockResolvedValue(watched.page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(watched.el);

    const result = await click({ ref: '3' });
    expect(result.isError).toBe(true);
    expect(watched.listenerCount()).toBe(0);
  });

  it('[CRIT] detaches the listener when the ref cannot be resolved', async () => {
    const watched = makePage();
    getPage.mockResolvedValue(watched.page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(null);

    const result = await click({ ref: '3' });
    expect(result.isError).toBe(true);
    expect(watched.listenerCount()).toBe(0);
  });

  it('leaves the RPC lane untouched — there is no Page to listen on', async () => {
    getPage.mockResolvedValue(null);
    resolveWorkspaceBackend.mockResolvedValue('chrome');

    const result = await click({ ref: '3' });
    expect(result.content[0].text).toBe('Clicked element ref=3' + COMMITTED);
    expect(mockSendRpc).toHaveBeenCalledWith('browser.click.cdp', expect.anything());
  });
});
