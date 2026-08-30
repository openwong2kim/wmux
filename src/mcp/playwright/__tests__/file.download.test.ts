import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { mockSendRpc, getPage, resolveRef } = vi.hoisted(() => ({
  mockSendRpc: vi.fn(),
  getPage: vi.fn(),
  resolveRef: vi.fn(),
}));

vi.mock('../../wmux-client', () => ({
  sendRpc: (method: string, ...args: unknown[]) =>
    (method.startsWith('browser.lease.') || method === 'browser.lifecycle.get')
      ? Promise.resolve({ token: null })
      : mockSendRpc(method, ...args),
}));

vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({ getPageForScope: getPage }) },
}));

vi.mock('../snapshot', () => ({ resolveRef }));

import {
  BROWSER_DOWNLOAD_SHAPE,
  BROWSER_WAIT_FOR_DOWNLOAD_SHAPE,
  registerFileTools,
} from '../tools/file';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  registerFileTools(server as never, { resolveWorkspaceId: vi.fn(async () => 'ws-test') });
  return tools;
}

const download = collectTools().get('browser_download');
if (!download) throw new Error('browser_download failed to register');

const text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

interface PageOpts {
  /** Where the tab ends up once the click has run. */
  navigatesTo?: string;
  /** Reject waitForEvent, i.e. no download ever started. */
  noDownload?: boolean;
  /** Whether goBack restores the original URL. */
  backWorks?: boolean;
  /** Whether goto can reach the original URL. */
  gotoWorks?: boolean;
}

const START_URL = 'https://app.test/project/42';

function makePage(opts: PageOpts = {}) {
  let url = START_URL;
  const calls: string[] = [];
  const waitArgs: Record<string, unknown>[] = [];

  const page = {
    url: () => url,
    waitForEvent: vi.fn(async (_event: string, args?: Record<string, unknown>) => {
      waitArgs.push(args ?? {});
      if (opts.navigatesTo) url = opts.navigatesTo;
      if (opts.noDownload) throw new Error('Timeout 30000ms exceeded while waiting for event "download"');
      return {
        path: async () => 'C:\\Temp\\playwright-artifacts-x\\abc-123',
        suggestedFilename: () => 'render_final.mp4',
        url: () => 'https://cdn.test/render_final.mp4',
        saveAs: async () => undefined,
      };
    }),
    goBack: vi.fn(async () => {
      calls.push('goBack');
      if (!opts.backWorks) throw new Error('no history entry');
      url = START_URL;
      return null;
    }),
    goto: vi.fn(async (to: string) => {
      calls.push('goto');
      if (opts.gotoWorks === false) throw new Error('net::ERR_ABORTED');
      url = to;
      return null;
    }),
  };
  return { page, calls, waitArgs };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveRef.mockResolvedValue({ click: vi.fn(async () => undefined) });
});

// ---------------------------------------------------------------------------
// What came back. The saved path is a temp name; the browser's own name and the
// source URL used to be reachable only through a second, different tool.
// ---------------------------------------------------------------------------

describe('browser_download result', () => {
  it('reports the browser filename and source URL alongside the saved path', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    const res = await download({ ref: '0' });

    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain('Downloaded: C:\\Temp\\playwright-artifacts-x\\abc-123');
    expect(text(res)).toContain('suggestedFilename: render_final.mp4');
    expect(text(res)).toContain('url: https://cdn.test/render_final.mp4');
  });
});

// ---------------------------------------------------------------------------
// The timeout bounds the START of the download. Exposing it must not turn it
// into a bound on the transfer, which is the property that lets big files work.
// ---------------------------------------------------------------------------

describe('browser_download timeout', () => {
  it('defaults to 30s and applies it to the download event only', async () => {
    const { page, waitArgs } = makePage();
    getPage.mockResolvedValue(page);

    await download({ ref: '0' });

    expect(page.waitForEvent).toHaveBeenCalledWith('download', { timeout: 30_000 });
    expect(waitArgs[0]).toEqual({ timeout: 30_000 });
  });

  it('passes a caller-supplied timeout through', async () => {
    const { page } = makePage();
    getPage.mockResolvedValue(page);

    await download({ ref: '0', timeout: 90_000 });

    expect(page.waitForEvent).toHaveBeenCalledWith('download', { timeout: 90_000 });
  });
});

// ---------------------------------------------------------------------------
// The measured failure: a cross-origin "download" link navigates instead, and
// the agent is left on a page it never asked for.
// ---------------------------------------------------------------------------

describe('browser_download stray navigation', () => {
  const MEDIA = 'https://cdn.other/BigBuckBunny.mp4';

  it('sends the tab back and says what happened', async () => {
    const { page, calls } = makePage({ navigatesTo: MEDIA, noDownload: true, backWorks: true });
    getPage.mockResolvedValue(page);

    const res = await download({ ref: '0' });

    expect(res.isError).toBe(true);
    expect(calls).toEqual(['goBack']);
    expect(page.url()).toBe(START_URL);
    // The diagnosis survives alongside the cause.
    expect(text(res)).toContain('Timeout 30000ms exceeded');
    expect(text(res)).toContain('navigated instead of downloading');
    expect(text(res)).toContain(MEDIA);
    expect(text(res)).toContain(`The tab was sent back to ${START_URL}`);
  });

  it('reloads when there is no history entry, and admits the page was reloaded', async () => {
    const { page, calls } = makePage({ navigatesTo: MEDIA, noDownload: true, backWorks: false });
    getPage.mockResolvedValue(page);

    const res = await download({ ref: '0' });

    expect(calls).toEqual(['goBack', 'goto']);
    expect(page.url()).toBe(START_URL);
    expect(text(res)).toContain('reopened');
    expect(text(res)).toContain('browser_navigate_back would land back here');
  });

  it('says where the tab is stranded when neither route works', async () => {
    const { page } = makePage({
      navigatesTo: MEDIA, noDownload: true, backWorks: false, gotoWorks: false,
    });
    getPage.mockResolvedValue(page);

    const res = await download({ ref: '0' });

    expect(page.url()).toBe(MEDIA);
    expect(text(res)).toContain('could NOT be recovered');
    expect(text(res)).toContain(`still on ${MEDIA}`);
  });

  it('leaves the page alone when a failure did not navigate', async () => {
    // An ordinary miss — a ref that resolves but whose click downloads nothing.
    const { page, calls } = makePage({ noDownload: true });
    getPage.mockResolvedValue(page);

    const res = await download({ ref: '0' });

    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
    expect(text(res)).not.toContain('navigated instead of downloading');
  });

  it('does not undo a navigation the site made on a SUCCESSFUL download', async () => {
    // A site that downloads and then moves to a "thanks" page meant to do that.
    const { page, calls } = makePage({ navigatesTo: 'https://app.test/thanks' });
    getPage.mockResolvedValue(page);

    const res = await download({ ref: '0' });

    expect(res.isError).toBeUndefined();
    expect(calls).toEqual([]);
    expect(page.url()).toBe('https://app.test/thanks');
  });

  it('still reports cleanly when there is no page at all', async () => {
    getPage.mockResolvedValue(null);

    const res = await download({ ref: '0' });

    expect(res.isError).toBe(true);
    expect(text(res)).toContain('No browser page available');
    expect(text(res)).not.toContain('navigated instead of downloading');
  });
});

// The measured wrinkle: in a wmux-opened tab the back navigation lands but
// goBack's promise does not resolve until its own timeout. Judging by URL is
// what keeps that case on the history-preserving route.
describe('browser_download restore judges by URL, not by goBack resolving', () => {
  const MEDIA = 'https://cdn.other/BigBuckBunny.mp4';

  it('counts a back navigation that lands while its promise still hangs', async () => {
    let url = START_URL;
    const calls: string[] = [];
    const page = {
      url: () => url,
      waitForEvent: vi.fn(async () => {
        url = MEDIA;
        throw new Error('Timeout 30000ms exceeded while waiting for event "download"');
      }),
      goBack: vi.fn(() => {
        calls.push('goBack');
        url = START_URL;                       // the navigation lands at once...
        return new Promise(() => { /* ...and the promise never settles */ });
      }),
      goto: vi.fn(async () => { calls.push('goto'); return null; }),
    };
    getPage.mockResolvedValue(page);

    const started = Date.now();
    const res = await download({ ref: '0' });

    expect(calls).toEqual(['goBack']);
    expect(text(res)).toContain('The tab was sent back to');
    // Returned on the poll, not after the 10s restore budget.
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

// Schema-level, because zod rejects before the handler runs. Playwright reads
// timeout 0 as "wait forever": on browser_download that hangs the call the
// start-timeout exists to bound, and on browser_wait_for_download it hangs a
// call whose whole purpose is to give up.
describe('download timeout bounds', () => {
  for (const [name, shape] of [
    ['browser_download', BROWSER_DOWNLOAD_SHAPE],
    ['browser_wait_for_download', BROWSER_WAIT_FOR_DOWNLOAD_SHAPE],
  ] as const) {
    const schema = z.object(shape);
    const base = name === 'browser_download' ? { ref: '0' } : {};

    it(`${name} refuses 0, negatives and fractions`, () => {
      expect(schema.safeParse({ ...base, timeout: 0 }).success).toBe(false);
      expect(schema.safeParse({ ...base, timeout: -1 }).success).toBe(false);
      expect(schema.safeParse({ ...base, timeout: 2.5 }).success).toBe(false);
    });

    it(`${name} accepts a positive whole number, and omitting it`, () => {
      expect(schema.safeParse({ ...base, timeout: 1 }).success).toBe(true);
      expect(schema.safeParse({ ...base, timeout: 90_000 }).success).toBe(true);
      expect(schema.safeParse(base).success).toBe(true);
    });
  }
});
