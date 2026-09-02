import { beforeEach, describe, expect, it, vi } from 'vitest';

// A Referer next to `Sec-Fetch-Site: none` is a pair no browser produces, and
// goto-with-a-referer produces exactly that. So browser_navigate picks its
// route by whether there is a referer to send: from inside the page when there
// is, plain goto when there is not.

const mockSendRpc = vi.fn();
vi.mock('../../wmux-client', () => ({
  sendRpc: (...args: unknown[]) => mockSendRpc(...args),
}));

const navigateFromPage = vi.fn(async () => null);
vi.mock('../link-navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../link-navigation')>()),
  navigateFromPage: (...args: unknown[]) => navigateFromPage(...(args as [])),
}));

// The tool distinguishes "nothing was requested" from "the request failed" by
// this class, so the tests raise the real one.
import { NavigationNotCommittedError as FakeNotCommitted } from '../link-navigation';

const recordAction = vi.fn();
vi.mock('../../browser-replay/actionRing', () => ({
  recordAction: (...args: unknown[]) => recordAction(...args),
}));

const getPageForScope = vi.fn();
const resolveWorkspaceBackend = vi.fn(async () => 'chrome');
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({ getPageForScope, resolveWorkspaceBackend }),
  },
}));

import { registerNavigationTools } from '../tools/navigation';
import type { BrowserToolDeps } from '../browserScope';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function collectTools(deps: BrowserToolDeps): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerNavigationTools(server as never, deps);
  return tools;
}

/** A chrome-backend page whose reported URL can change on navigation. */
function fakePage(startUrl: string, landOn?: string) {
  let current = startUrl;
  const page = {
    url: () => current,
    goto: vi.fn(async (_url: string, _options?: Record<string, unknown>) => {
      current = landOn ?? current;
      return null;
    }),
  };
  return { page, land: (to: string) => { current = to; } };
}

describe('browser_navigate referer route (chrome backend)', () => {
  const resolveWorkspaceId = vi.fn(async () => 'ws-caller');
  let navigate: ToolHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveWorkspaceId.mockResolvedValue('ws-caller');
    resolveWorkspaceBackend.mockResolvedValue('chrome');
    navigateFromPage.mockResolvedValue(null);
    mockSendRpc.mockImplementation((method: string) => {
      if (method === 'browser.lease.acquire') return Promise.resolve({ token: 'lease-1' });
      if (method === 'browser.lifecycle.get') return Promise.resolve({ entries: [] });
      return Promise.resolve({});
    });
    navigate = collectTools({ resolveWorkspaceId })!.get('browser_navigate')!;
  });

  it('navigates from inside the page when leaving a real http(s) document', async () => {
    const { page, land } = fakePage('https://from.test/article');
    navigateFromPage.mockImplementation(async () => {
      land('https://to.test/landing');
      return null;
    });
    getPageForScope.mockResolvedValue(page);

    const res = await navigate({ url: 'https://to.test/landing' });

    expect(navigateFromPage).toHaveBeenCalledWith(page, 'https://to.test/landing');
    // The contradictory pair is exactly page.goto({ referer }); it must not run.
    expect(page.goto).not.toHaveBeenCalled();
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toBe('Navigated to https://to.test/landing');
  });

  it('reports the landing URL after a redirect, not the requested one', async () => {
    const { page, land } = fakePage('https://from.test/article');
    navigateFromPage.mockImplementation(async () => {
      land('https://to.test/after-redirect');
      return null;
    });
    getPageForScope.mockResolvedValue(page);

    const res = await navigate({ url: 'https://to.test/landing' });

    expect(res.content[0].text).toBe('Navigated to https://to.test/after-redirect');
    expect(recordAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tool: 'browser_navigate', url: 'https://to.test/after-redirect' }),
    );
  });

  it('uses plain goto, with no referer, from about:blank', async () => {
    const { page } = fakePage('about:blank', 'https://to.test/first');
    getPageForScope.mockResolvedValue(page);

    const res = await navigate({ url: 'https://to.test/first' });

    expect(navigateFromPage).not.toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledWith('https://to.test/first', {
      waitUntil: 'domcontentloaded',
    });
    expect(res.content[0].text).toBe('Navigated to https://to.test/first');
  });

  it('uses plain goto for a reload — refererFor sends none, so neither do we', async () => {
    const { page } = fakePage('https://from.test/same');
    getPageForScope.mockResolvedValue(page);

    await navigate({ url: 'https://from.test/same' });

    expect(navigateFromPage).not.toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledWith('https://from.test/same', {
      waitUntil: 'domcontentloaded',
    });
  });

  it('falls back to goto WITHOUT a referer when the in-page route never commits', async () => {
    const { page } = fakePage('https://from.test/article', 'https://to.test/landing');
    navigateFromPage.mockRejectedValue(
      new FakeNotCommitted('no navigation committed within 4000ms of the assignment'),
    );
    getPageForScope.mockResolvedValue(page);

    const res = await navigate({ url: 'https://to.test/landing' });

    expect(page.goto).toHaveBeenCalledWith('https://to.test/landing', {
      waitUntil: 'domcontentloaded',
    });
    // No `referer` key anywhere: the fallback drops the header rather than
    // pairing it with Sec-Fetch-Site: none.
    expect(page.goto.mock.calls[0][1]).not.toHaveProperty('referer');
    expect(res.isError).toBeUndefined();
    // The caller asked for one shape of request and got another; the result
    // says so rather than leaving the swap invisible.
    expect(res.content[0].text).toContain('retried without a referer');
  });

  it('reports a real navigation failure without requesting the URL a second time', async () => {
    const { page } = fakePage('https://from.test/article');
    navigateFromPage.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'));
    getPageForScope.mockResolvedValue(page);

    const res = await navigate({ url: 'https://nowhere.invalid/x' });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('ERR_NAME_NOT_RESOLVED');
    // A retry here would be a second request, not a second chance: for a
    // download or a one-time token URL that is a second consumption.
    expect(page.goto).not.toHaveBeenCalled();
  });
});
