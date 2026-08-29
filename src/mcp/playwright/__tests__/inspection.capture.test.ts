import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Page } from 'playwright-core';

const { mockSendRpc, getPage, resolveWorkspaceBackend } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveWorkspaceBackend: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: {
    getInstance: () => ({
      getPageForScope: getPage,
      resolveWorkspaceBackend,
      drainLocalLifecycle: () => [],
    }),
  },
}));

import { registerInspectionTools } from '../tools/inspection';
import { attachPageCapture } from '../pageCapture';
import { REDACTED_PASSWORD } from '../redact';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

const browserToolDeps = { resolveWorkspaceId: vi.fn(async () => 'ws-test') };

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerInspectionTools(server as never, browserToolDeps);
  return tools;
}

const tools = collectTools();
const consoleTool = tools.get('browser_console');
const network = tools.get('browser_network');
if (!consoleTool || !network) throw new Error('inspection tools failed to register');

// A Page stand-in the capture module can listen on.
interface FakePage extends EventEmitter {
  url: () => string;
}

function makePage(url = 'about:blank'): FakePage {
  const page = new EventEmitter() as FakePage;
  page.url = () => url;
  return page;
}

function asPage(page: FakePage): Page {
  return page as unknown as Page;
}

function consoleMessage(level: string, text: string) {
  return { type: () => level, text: () => text };
}

/** What the engine does on every page resolve under a non-builtin backend. */
function resolveChromePage(page: FakePage): void {
  resolveWorkspaceBackend.mockResolvedValue('chrome');
  getPage.mockResolvedValue(asPage(page));
  attachPageCapture(asPage(page));
}

beforeEach(() => {
  browserToolDeps.resolveWorkspaceId.mockClear();
  mockSendRpc.mockReset();
  getPage.mockReset();
  resolveWorkspaceBackend.mockReset();
  resolveWorkspaceBackend.mockResolvedValue('builtin');
  getPage.mockResolvedValue(null);
});

describe('browser_console — collection starts at page resolve (#1081)', () => {
  it('returns what the page logged during navigation, with no priming call', async () => {
    const page = makePage();
    // browser_navigate resolves the page; the engine attaches capture there.
    resolveChromePage(page);
    // The page loads and throws. Nothing has read the buffer yet.
    page.emit('console', consoleMessage('error', 'Uncaught TypeError during load'));

    const result = await consoleTool({});

    expect(result.content[0].text).toContain('[error] Uncaught TypeError during load');
  });

  it('records one copy of a message when the page is resolved repeatedly', async () => {
    const page = makePage();
    resolveChromePage(page);
    // Ten more tool calls, ten more resolves.
    for (let i = 0; i < 10; i++) attachPageCapture(asPage(page));

    page.emit('console', consoleMessage('log', 'exactly once'));

    const text = (await consoleTool({})).content[0].text;
    expect(text.match(/exactly once/g)).toHaveLength(1);
  });

  it('says the collection is running rather than implying a clean page', async () => {
    resolveChromePage(makePage());

    const text = (await consoleTool({})).content[0].text;

    expect(text).toContain('No console messages.');
    expect(text).toContain('Collecting since');
  });

  it('admits the window it cannot cover when it attached to an open page', async () => {
    const page = makePage('https://x.test/opened-before-the-agent-arrived');
    resolveChromePage(page);

    const empty = (await consoleTool({})).content[0].text;
    expect(empty).toContain('already open when collection started');

    page.emit('console', consoleMessage('warn', 'something later'));
    const withEntries = (await consoleTool({})).content[0].text;
    expect(withEntries).toContain('[warn] something later');
    expect(withEntries).toContain('not included');
  });

  it('clear:true empties the buffer and restarts the window', async () => {
    const page = makePage('https://x.test/opened-before-the-agent-arrived');
    resolveChromePage(page);
    page.emit('console', consoleMessage('log', 'before'));

    const cleared = (await consoleTool({ clear: true })).content[0].text;
    expect(cleared).toContain('[log] before');

    const afterClear = (await consoleTool({})).content[0].text;
    expect(afterClear).toContain('No console messages.');
    // The pre-attach gap is no longer what the emptiness is hiding.
    expect(afterClear).not.toContain('already open when collection started');

    page.emit('console', consoleMessage('log', 'after'));
    expect((await consoleTool({})).content[0].text).toContain('[log] after');
  });

  it('still masks a credential the page logged (eager path, #1079)', async () => {
    const page = makePage();
    resolveChromePage(page);
    page.emit('console', consoleMessage('log', 'POST /login {"password":"hunter2SECRET"}'));

    const text = (await consoleTool({})).content[0].text;

    expect(text).not.toContain('hunter2SECRET');
    expect(text).toContain(`"password":"${REDACTED_PASSWORD}"`);
  });

  it('surfaces an uncaught exception the page threw while loading', async () => {
    const page = makePage();
    resolveChromePage(page);
    const error = new Error('Cannot read properties of undefined');
    error.stack = 'TypeError: Cannot read properties of undefined\n    at boot (app.js:12:5)';
    // Playwright routes this to 'pageerror', not 'console' — and a page that
    // throws on load is the case the whole issue is about.
    page.emit('pageerror', error);

    const text = (await consoleTool({ level: 'error' })).content[0].text;

    expect(text).toContain('[error] Uncaught TypeError: Cannot read properties of undefined');
    expect(text).toContain('at boot (app.js:12:5)');
  });

  it("speaks the filter's vocabulary for warnings ('warning' -> 'warn')", async () => {
    const page = makePage();
    resolveChromePage(page);
    // Playwright reports 'warning'; the level filter and main's capture say 'warn'.
    page.emit('console', consoleMessage('warning', 'deprecated API'));

    const text = (await consoleTool({ level: 'warn' })).content[0].text;

    expect(text).toContain('[warn] deprecated API');
  });

  it('level filtering still applies to the eagerly collected buffer', async () => {
    const page = makePage();
    resolveChromePage(page);
    page.emit('console', consoleMessage('log', 'chatter'));
    page.emit('console', consoleMessage('error', 'the real problem'));

    const text = (await consoleTool({ level: 'error' })).content[0].text;

    expect(text).toContain('the real problem');
    expect(text).not.toContain('chatter');
  });
});

describe('browser_console — transport selection', () => {
  it('reads main\'s capture on builtin even when a Page is available', async () => {
    // Dev builds resolve a Page for builtin guests. Main has been collecting
    // since the guest attached, so that buffer — not this one — is the answer.
    const page = makePage();
    getPage.mockResolvedValue(asPage(page));
    attachPageCapture(asPage(page));
    page.emit('console', consoleMessage('log', 'engine-side buffer'));
    mockSendRpc.mockResolvedValue({ entries: [{ level: 'log', text: 'main-side buffer' }] });

    const text = (await consoleTool({})).content[0].text;

    expect(text).toContain('main-side buffer');
    expect(text).not.toContain('engine-side buffer');
    expect(mockSendRpc).toHaveBeenCalledWith('browser.console.get', expect.anything());
  });

  it('falls back to the engine buffer when main cannot serve the read', async () => {
    const page = makePage();
    getPage.mockResolvedValue(asPage(page));
    attachPageCapture(asPage(page));
    page.emit('console', consoleMessage('error', 'engine-side fallback'));
    mockSendRpc.mockRejectedValue(new Error('browser.console.get: no browser surface'));

    const text = (await consoleTool({})).content[0].text;

    expect(text).toContain('[error] engine-side fallback');
  });

  it('surfaces main\'s error when nothing can serve the read', async () => {
    mockSendRpc.mockRejectedValue(new Error('browser.console.get: BROWSER_NO_TARGET'));

    const result = await consoleTool({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('BROWSER_NO_TARGET');
  });

  it('reports an older main\'s windowless result exactly as before', async () => {
    mockSendRpc.mockResolvedValue({ entries: [] });

    const text = (await consoleTool({})).content[0].text;

    expect(text).toBe('No console messages collected.');
  });

  it('renders the window main reports', async () => {
    mockSendRpc.mockResolvedValue({
      entries: [],
      since: Date.parse('2026-08-29T10:00:00.000Z'),
      missedBefore: true,
    });

    const text = (await consoleTool({})).content[0].text;

    expect(text).toContain('Collecting since 2026-08-29T10:00:00.000Z');
    expect(text).toContain('already open when collection started');
  });
});

describe('browser_network — collection starts at page resolve (#1081)', () => {
  it('lists requests issued before the first read', async () => {
    const page = makePage();
    resolveChromePage(page);
    page.emit('request', { url: () => 'https://x.test/api/login', method: () => 'POST' });

    const text = (await network({})).content[0].text;

    expect(text).toContain('https://x.test/api/login');
    expect(text).toContain('"method": "POST"');
  });

  it('applies the URL glob filter to the eagerly collected buffer', async () => {
    const page = makePage();
    resolveChromePage(page);
    page.emit('request', { url: () => 'https://x.test/api/items', method: () => 'GET' });
    page.emit('request', { url: () => 'https://x.test/static/app.css', method: () => 'GET' });

    const text = (await network({ filter: '*api*' })).content[0].text;

    expect(text).toContain('api/items');
    expect(text).not.toContain('app.css');
  });

  it('masks a credential a page put in a query string (eager path, #1079)', async () => {
    const page = makePage();
    resolveChromePage(page);
    page.emit('request', {
      url: () => 'https://x.test/login?user=alice&password=hunter2SECRET',
      method: () => 'GET',
    });

    const text = (await network({})).content[0].text;

    expect(text).not.toContain('hunter2SECRET');
    expect(text).toContain(`password=${REDACTED_PASSWORD}`);
    expect(text).toContain('user=alice');
  });

  it('clear:true empties the buffer without touching the console window', async () => {
    const page = makePage();
    resolveChromePage(page);
    page.emit('console', consoleMessage('log', 'console survives'));
    page.emit('request', { url: () => 'https://x.test/gone', method: () => 'GET' });

    await network({ clear: true });

    expect((await network({})).content[0].text).toContain('No network requests.');
    expect((await consoleTool({})).content[0].text).toContain('console survives');
  });
});
