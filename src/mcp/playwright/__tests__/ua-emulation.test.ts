import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import {
  applyUserAgentEmulation,
  clearUserAgentEmulation,
  hasUserAgentEmulation,
} from '../ua-emulation';

// A device preset is one identity, not a UA string with some hardware left over
// from the real machine. These check that everything the preset claims is
// actually sent — and that a reset takes all of it back.

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';
const REAL_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const IPHONE_METRICS = {
  width: 390,
  height: 664,
  deviceScaleFactor: 3,
  mobile: true,
  hasTouch: true,
  screenWidth: 390,
  screenHeight: 844,
};

type Sent = { method: string; params?: Record<string, unknown> };

function harness() {
  const sent: Sent[] = [];
  const detached: number[] = [];
  let sessionCount = 0;

  const newCDPSession = vi.fn(async () => {
    const id = sessionCount++;
    return {
      send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params });
        if (method === 'Browser.getVersion') return { userAgent: REAL_UA };
        return {};
      }),
      detach: vi.fn(async () => {
        detached.push(id);
      }),
    };
  });

  const pages: Page[] = [];
  const listeners = new Map<string, ((p: Page) => void)[]>();
  const makePage = (): Page => {
    const frame = {};
    return {
      once: vi.fn(),
      // The module re-applies the preset after every main-frame commit,
      // because the library re-initialises its own emulation there.
      on: vi.fn(),
      mainFrame: () => frame,
      viewportSize: () => ({ width: 390, height: 664 }),
      setViewportSize: vi.fn(async () => undefined),
      isClosed: () => false,
    } as unknown as Page;
  };
  const page = makePage();
  pages.push(page);

  const context = {
    newCDPSession,
    pages: () => pages,
    on: (event: string, handler: (p: Page) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
    off: vi.fn(),
    browser: () => ({}),
  } as unknown as BrowserContext;

  return { sent, detached, context, page, pages, makePage, newPage: (p: Page) => {
    pages.push(p);
    for (const handler of listeners.get('page') ?? []) handler(p);
  } };
}

const methods = (sent: Sent[]): string[] => sent.map((s) => s.method);
/**
 * The command sequence with repeats collapsed.
 *
 * The preset is deliberately written more than once — once per session, then
 * again over the caller's page after every other session has been touched,
 * because overrides from different sessions are merged by the last write. What
 * matters here is which commands go out and in what order, not how many times
 * the last-write pass repeats them.
 */
const distinctSequence = (sent: Sent[]): string[] =>
  methods(sent).filter((method, i, all) => method !== all[i - 1]);
const paramsOf = (sent: Sent[], method: string): Record<string, unknown> | undefined =>
  sent.find((s) => s.method === method)?.params;

describe('applyUserAgentEmulation with a device preset', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the UA, the metrics and the touch points together', async () => {
    const h = harness();
    const ok = await applyUserAgentEmulation(
      h.context,
      h.page,
      IPHONE_UA,
      'en-US',
      IPHONE_METRICS,
    );
    expect(ok).toBe(true);
    expect(distinctSequence(h.sent)).toEqual([
      'Emulation.setUserAgentOverride',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
      // The last-write pass over the caller's page.
      'Emulation.setUserAgentOverride',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
    ]);

    const ua = paramsOf(h.sent, 'Emulation.setUserAgentOverride')!;
    expect(ua.userAgent).toBe(IPHONE_UA);
    // navigator.platform used to answer "MacIntel" under an iPhone UA.
    expect(ua.platform).toBe('iPhone');
    expect(ua.acceptLanguage).toBe('en-US');
    // Safari has no userAgentData, so the hints object must be absent, not empty.
    expect(ua).not.toHaveProperty('userAgentMetadata');

    expect(paramsOf(h.sent, 'Emulation.setDeviceMetricsOverride')).toEqual({
      width: 390,
      height: 664,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
      // A portrait phone whose screen.orientation reads "landscape-primary"
      // contradicts its own dimensions.
      screenOrientation: { angle: 0, type: 'portraitPrimary' },
    });
    expect(paramsOf(h.sent, 'Emulation.setTouchEmulationEnabled')).toEqual({
      enabled: true,
      maxTouchPoints: 5,
    });
  });

  it('turns touch off explicitly for a preset without a touchscreen', async () => {
    const h = harness();
    await applyUserAgentEmulation(h.context, h.page, REAL_UA, null, {
      ...IPHONE_METRICS,
      mobile: false,
      hasTouch: false,
    });
    expect(paramsOf(h.sent, 'Emulation.setTouchEmulationEnabled')).toEqual({
      enabled: false,
      maxTouchPoints: 0,
    });
  });

  it('applies the whole preset to a tab opened later, not just the UA', async () => {
    const h = harness();
    await applyUserAgentEmulation(h.context, h.page, IPHONE_UA, null, IPHONE_METRICS);
    h.sent.length = 0;

    h.newPage(h.makePage());
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The new tab gets the identity whole — the UA alone would leave it on
    // this machine's pixel ratio and without a touchscreen.
    expect(distinctSequence(h.sent)).toEqual([
      'Emulation.setUserAgentOverride',
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setTouchEmulationEnabled',
    ]);
  });

  it('sends no metrics commands when no preset was given', async () => {
    const h = harness();
    await applyUserAgentEmulation(h.context, h.page, IPHONE_UA);
    // Written twice (the last-write pass), but never anything else: a UA
    // without a preset must not drag the caller's viewport around with it.
    expect(new Set(methods(h.sent))).toEqual(new Set(['Emulation.setUserAgentOverride']));
  });
});

describe('clearUserAgentEmulation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('takes back the metrics and the touch points along with the UA', async () => {
    const h = harness();
    await applyUserAgentEmulation(h.context, h.page, IPHONE_UA, null, IPHONE_METRICS);
    expect(hasUserAgentEmulation(h.context)).toBe(true);
    h.sent.length = 0;

    await clearUserAgentEmulation(h.context);

    expect(methods(h.sent)).toContain('Emulation.clearDeviceMetricsOverride');
    expect(paramsOf(h.sent, 'Emulation.setTouchEmulationEnabled')).toEqual({
      enabled: false,
      maxTouchPoints: 0,
    });
    // The real UA comes back with the real platform, not the preset's.
    const restored = h.sent.filter((s) => s.method === 'Emulation.setUserAgentOverride').pop()!;
    expect(restored.params!.userAgent).toBe(REAL_UA);
    expect(restored.params!.platform).toBe('MacIntel');
    expect(hasUserAgentEmulation(h.context)).toBe(false);
  });

  it('is a no-op on a context that was never emulated', async () => {
    const h = harness();
    await clearUserAgentEmulation(h.context);
    expect(h.sent).toEqual([]);
  });
});
