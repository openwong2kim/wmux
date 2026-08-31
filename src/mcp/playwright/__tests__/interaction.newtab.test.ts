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

vi.mock('../snapshot', () => ({ resolveRef: resolveRefMock }));

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

/** A Page double whose click can fire a 'popup' event. */
function makePage(opts: { popupUrl?: string } = {}) {
  const handlers = new Map<string, Set<Handler>>();
  const el = {
    click: vi.fn(async () => {
      if (opts.popupUrl !== undefined) {
        for (const fn of handlers.get('popup') ?? []) fn({ url: () => opts.popupUrl });
      }
    }),
    dblclick: vi.fn(async () => undefined),
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

  it('leaves the RPC lane untouched — there is no Page to listen on', async () => {
    getPage.mockResolvedValue(null);
    resolveWorkspaceBackend.mockResolvedValue('chrome');

    const result = await click({ ref: '3' });
    expect(result.content[0].text).toBe('Clicked element ref=3');
    expect(mockSendRpc).toHaveBeenCalledWith('browser.click.cdp', expect.anything());
  });
});
