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
function makePage(opts: { popupUrl?: string; popupUrls?: string[]; clickThrows?: boolean } = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const urls = opts.popupUrls ?? (opts.popupUrl !== undefined ? [opts.popupUrl] : undefined);
  let read = 0;
  const el = {
    click: vi.fn(async () => {
      if (urls) {
        const popup = {
          url: () => urls[Math.min(read++, urls.length - 1)],
        };
        for (const fn of handlers.get('popup') ?? []) fn(popup);
      }
      if (opts.clickThrows) throw new Error('Element is not attached to the DOM');
    }),
    dblclick: vi.fn(async () => undefined),
    // The click path walks the pointer to the element's box before pressing,
    // so a stand-in element has to have one.
    boundingBox: vi.fn(async () => ({ x: 10, y: 20, width: 100, height: 40 })),
  };
  return {
    el,
    listenerCount: () => handlers.get('popup')?.size ?? 0,
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
  it('names the popup URL on the chrome backend, without claiming a surface', async () => {
    const { page, el } = makePage({ popupUrl: 'https://popup.example/checkout' });
    getPage.mockResolvedValue(page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(el);

    const result = await click({ ref: '3' });
    const text = result.content[0].text;

    expect(text).toContain('Clicked element ref=3');
    expect(text).toContain('opened a popup (page: https://popup.example/checkout)');
    expect(text).toContain('not a wmux surface');
    expect(text).not.toContain('surfaceId=');
  });

  it('says nothing extra when the click opens no popup', async () => {
    const { page, el } = makePage();
    getPage.mockResolvedValue(page);
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    resolveRefMock.mockResolvedValue(el);

    const result = await click({ ref: '3' });
    expect(result.content[0].text).toBe('Clicked element ref=3');
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
    expect(result.content[0].text).toBe('Clicked element ref=3');
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
    expect(result.content[0].text).toBe('Clicked element ref=3');
    expect(mockSendRpc).toHaveBeenCalledWith('browser.click.cdp', expect.anything());
  });
});
