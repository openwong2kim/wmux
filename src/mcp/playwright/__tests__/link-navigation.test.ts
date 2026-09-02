import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';

const evaluateIsolated = vi.fn(async () => undefined);
vi.mock('../isolated-eval', () => ({
  evaluateIsolated: (...args: unknown[]) => evaluateIsolated(...(args as [])),
}));

import { navigateFromPage } from '../link-navigation';

function fakePage(): { page: Page; resolveNav: (value?: unknown) => void; rejectNav: (e: Error) => void } {
  let resolveNav!: (value?: unknown) => void;
  let rejectNav!: (e: Error) => void;
  const navigated = new Promise((resolve, reject) => {
    resolveNav = resolve as (value?: unknown) => void;
    rejectNav = reject;
  });
  const page = {
    waitForNavigation: vi.fn(() => navigated),
  } as unknown as Page;
  return { page, resolveNav, rejectNav };
}

describe('navigateFromPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    evaluateIsolated.mockResolvedValue(undefined);
  });

  it('arms the navigation wait BEFORE triggering it', async () => {
    const { page, resolveNav } = fakePage();
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
    resolveNav();

    // Reversed, the commit could land in the gap between the two calls.
    expect(order).toEqual(['wait', 'assign']);
  });

  it('runs the assignment in the isolated world and waits for domcontentloaded', async () => {
    const { page, resolveNav } = fakePage();
    const promise = navigateFromPage(page, 'https://to.test/x');
    resolveNav(null);
    await promise;

    expect(page.waitForNavigation).toHaveBeenCalledWith({ waitUntil: 'domcontentloaded' });
    const [target, script, arg] = evaluateIsolated.mock.calls[0] as unknown as [
      Page,
      (a: string) => void,
      string,
    ];
    expect(target).toBe(page);
    expect(arg).toBe('https://to.test/x');
    // The script must be an in-page location assignment: that, not a header, is
    // what makes Chromium label the request as script-initiated.
    expect(String(script)).toContain('location.assign');
  });

  it('propagates the navigation error, exactly as goto would', async () => {
    const { page, rejectNav } = fakePage();
    const promise = navigateFromPage(page, 'https://nowhere.invalid/x');
    rejectNav(new Error('net::ERR_NAME_NOT_RESOLVED'));

    await expect(promise).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
  });

  it('propagates an evaluation failure without waiting out the navigation', async () => {
    const { page, rejectNav } = fakePage();
    evaluateIsolated.mockRejectedValue(new Error('blocked'));

    await expect(navigateFromPage(page, 'https://to.test/x')).rejects.toThrow('blocked');
    // The abandoned wait must not surface as an unhandled rejection.
    rejectNav(new Error('Timeout 30000ms exceeded.'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
