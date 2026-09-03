import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';

const evaluateIsolated = vi.fn(async () => undefined);
vi.mock('../isolated-eval', () => ({
  evaluateIsolated: (...args: unknown[]) => evaluateIsolated(...(args as [])),
}));

import { NavigationNotCommittedError, navigateFromPage } from '../link-navigation';

function fakePage(url = 'https://from.test/'): {
  page: Page;
  resolveNav: (value?: unknown) => void;
  rejectNav: (e: Error) => void;
  setUrl: (next: string) => void;
} {
  let resolveNav!: (value?: unknown) => void;
  let rejectNav!: (e: Error) => void;
  let current = url;
  const navigated = new Promise((resolve, reject) => {
    resolveNav = resolve as (value?: unknown) => void;
    rejectNav = reject;
  });
  const page = {
    url: () => current,
    waitForNavigation: vi.fn(() => navigated),
  } as unknown as Page;
  return { page, resolveNav, rejectNav, setUrl: (next: string) => (current = next) };
}

describe('navigateFromPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    evaluateIsolated.mockResolvedValue(undefined);
  });

  it('arms the navigation wait BEFORE triggering it', async () => {
    const { page } = fakePage();
    const order: string[] = [];
    (page.waitForNavigation as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('wait');
      return Promise.resolve(null);
    });
    evaluateIsolated.mockImplementation(async () => {
      order.push('assign');
      return undefined;
    });

    await navigateFromPage(page, 'https://to.test/x');

    // Reversed, the commit could land in the gap between the two calls.
    expect(order).toEqual(['wait', 'assign']);
  });

  it('waits with a short commit timeout for a navigation that is not the one it left', async () => {
    const { page, resolveNav } = fakePage('https://from.test/');
    const promise = navigateFromPage(page, 'https://to.test/x');
    resolveNav(null);
    await promise;

    const options = (page.waitForNavigation as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { waitUntil: string; timeout: number; url: (u: URL) => boolean };
    expect(options.waitUntil).toBe('domcontentloaded');
    // Short, because the fallback path re-requests the URL: a wait that runs
    // for the page-wide default would stall half a minute first.
    expect(options.timeout).toBeLessThanOrEqual(10_000);
    // The page's own redirect must not satisfy our wait.
    expect(options.url(new URL('https://from.test/'))).toBe(false);
    expect(options.url(new URL('https://to.test/x'))).toBe(true);
  });

  it('runs the assignment in the isolated world, refusing the main world', async () => {
    const { page, resolveNav } = fakePage();
    const promise = navigateFromPage(page, 'https://to.test/x');
    resolveNav(null);
    await promise;

    const [target, script, arg, options] = evaluateIsolated.mock.calls[0] as unknown as [
      Page,
      (a: string) => void,
      string,
      { requireIsolated?: boolean },
    ];
    expect(target).toBe(page);
    expect(arg).toBe('https://to.test/x');
    // The script must be an in-page location assignment: that, not a header, is
    // what makes Chromium label the request as script-initiated.
    expect(String(script)).toContain('location.assign');
    // A page that could see this script could redirect it.
    expect(options.requireIsolated).toBe(true);
  });

  it('propagates a real navigation error rather than inviting a retry', async () => {
    const { page, rejectNav } = fakePage();
    const promise = navigateFromPage(page, 'https://nowhere.invalid/x');
    rejectNav(new Error('net::ERR_NAME_NOT_RESOLVED'));

    await expect(promise).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
    await expect(promise).rejects.not.toBeInstanceOf(NavigationNotCommittedError);
  });

  it('reports a commit that never happened as retryable', async () => {
    const { page, rejectNav } = fakePage();
    const promise = navigateFromPage(page, 'https://to.test/x');
    rejectNav(new Error('Timeout 4000ms exceeded.'));

    await expect(promise).rejects.toBeInstanceOf(NavigationNotCommittedError);
  });

  it('treats a commit that raced the wait as done, so the caller cannot re-request it', async () => {
    const { page, rejectNav, setUrl } = fakePage('https://from.test/');
    const promise = navigateFromPage(page, 'https://to.test/x');
    // The document moved even though the wait gave up: one request went out
    // and repeating it would send a second.
    setUrl('https://to.test/x');
    rejectNav(new Error('Timeout 4000ms exceeded.'));

    await expect(promise).resolves.toEqual({ response: null });
  });

  it('reports an evaluation failure as retryable without waiting out the navigation', async () => {
    const { page, rejectNav } = fakePage();
    evaluateIsolated.mockRejectedValue(new Error('blocked'));

    await expect(navigateFromPage(page, 'https://to.test/x')).rejects.toBeInstanceOf(
      NavigationNotCommittedError,
    );
    // The abandoned wait must not surface as an unhandled rejection.
    rejectNav(new Error('Timeout 4000ms exceeded.'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
