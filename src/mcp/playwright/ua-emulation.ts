// ---------------------------------------------------------------------------
// Keeping an emulated User-Agent applied.
//
// `Emulation.setUserAgentOverride` is scoped to the CDP session that sent it:
// Chromium disables the emulation handler when the session detaches, and the
// override goes with it. Opening a session, sending the override and detaching
// in a `finally` therefore reverts the very thing it just applied.
//
// It is also per target. `context.setExtraHTTPHeaders` covers every page in the
// context, so a UA header applied context-wide alongside a page-scoped hints
// override would disagree again the moment a second tab opened — the same class
// of mismatch the override exists to remove.
//
// So this module holds one live session per page for as long as the emulation
// is meant to last, and re-applies the override to pages that appear later.
//
// The same session carries the rest of the preset. A device preset used to
// reach the page as a UA string and a viewport width and nothing else, so an
// emulated iPhone answered `navigator.platform === 'MacIntel'`,
// `maxTouchPoints === 0` and `devicePixelRatio === 1` — every one of them
// contradicting the UA it had just announced. `platform` rides along on the UA
// override; the metrics and the touch points need their own commands, sent
// here so they live and die with the same session.
//
// `navigator.platform` needs one more thing than the others, and the reason is
// measured rather than guessed. Of everything the override carries, platform is
// the only value Chromium keeps as a page-wide setting instead of as state
// belonging to the session that wrote it. Every DevTools session that detaches
// from a target resets that setting on the way out — including a session that
// never wrote a platform of its own. So a throwaway session opened on the page
// for something unrelated (asking a target for its id, setting a timezone) put
// the host's platform back the moment it detached, while the UA string, the
// hints, the pixel ratio and the touch points all stayed. Measured on a live
// page: after the preset, `Linux armv8l`; after one unrelated session attached
// and detached, `MacIntel`, with everything else still emulated. That is why
// the earlier reading of this — another session outwriting ours — was wrong:
// nothing else writes a platform, and re-sending the override from the session
// still held here restores it immediately.
//
// Re-sending is therefore not a one-time step but a standing obligation, and
// `reassertUserAgentEmulation` below is where the page is put back before a
// tool looks at it.
//
// Input reaches the page too, and by the same route. `page.tap()` is refused
// client-side — the context this process attached to was built without touch —
// and two ways round that were measured and rejected:
// `Emulation.setEmitTouchEventsForMouse` does convert clicks into real touch
// events, but the mouse dispatch that produced them then never returns (>30s,
// every click), and a device-built context is not this architecture — it would
// be a fresh incognito-like context with none of the user's cookies, history or
// extensions, which is a louder signal than the one it removes.
//
// So the touch events are sent directly, as `Input.dispatchTouchEvent`, on the
// session held here (`activeTouchSession` below, dispatched from
// `touch-input.ts`). Reusing this session rather than opening one is not an
// economy: a session opened for the tap and detached afterwards would reset
// `navigator.platform` on the way out, for the reason set out above.
// ---------------------------------------------------------------------------

import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { buildUserAgentOverride, type UserAgentOverride } from '../../shared/uaMetadata';

/**
 * The physical half of a device preset, straight off Playwright's descriptor.
 * Kept separate from the UA override because CDP takes them as different
 * commands, not because they are separable — a preset applies both or neither.
 */
export interface EmulatedDeviceMetrics {
  width: number;
  height: number;
  /** `window.devicePixelRatio`. 3 on an iPhone, 1 on the desktop it was 1 on. */
  deviceScaleFactor: number;
  /** Mobile viewport semantics: meta-viewport, overlay scrollbars, text autosizing. */
  mobile: boolean;
  /** Whether the device has a touchscreen at all — drives `maxTouchPoints`. */
  hasTouch: boolean;
  /** `screen.width`/`screen.height`, which differ from the viewport on a phone. */
  screenWidth?: number;
  screenHeight?: number;
}

/** What a touchscreen device reports for `navigator.maxTouchPoints`. */
const TOUCH_POINTS = 5;

interface EmulationState {
  override: UserAgentOverride;
  /** Absent when the caller emulated a UA without a device preset. */
  metrics?: EmulatedDeviceMetrics;
  /** Live sessions, one per page, held open so the override survives. */
  sessions: Map<Page, CDPSession>;
  /** Listener re-applying the override to pages opened later. */
  onPage: (page: Page) => void;
  /**
   * Per-page listener re-sending the overrides after a navigation.
   *
   * Playwright owns these same Emulation commands on its own session and
   * re-initialises them when a cross-process navigation builds a new frame
   * session — `mobile: false`, `deviceScaleFactor: 1`, and a UA override
   * without our `platform`. Whichever session wrote last wins, so an emulated
   * phone drifted back to a desktop pixel ratio and `navigator.platform ===
   * 'MacIntel'` one navigation after the preset was applied. Re-sending on
   * commit makes ours the last write.
   */
  onNavigated: Map<Page, () => void>;
}

const stateByContext = new WeakMap<BrowserContext, EmulationState>();

/**
 * `CDPSession.send` is typed against the generated protocol table, and
 * `userAgentMetadata` is optional on our override where the table wants an
 * exact command shape. The values are protocol-correct; only the static
 * narrowing is in the way.
 */
type LooseSession = { send(method: string, params?: unknown): Promise<unknown> };
const loose = (session: CDPSession): LooseSession => session as unknown as LooseSession;

/** Send the whole preset — UA override, metrics, touch — on one session. */
async function sendOverrides(session: CDPSession, state: EmulationState): Promise<void> {
  await loose(session).send('Emulation.setUserAgentOverride', state.override);
  if (!state.metrics) return;
  const m = state.metrics;
  const portrait = m.mobile && (m.screenHeight ?? m.height) >= (m.screenWidth ?? m.width);
  await loose(session).send('Emulation.setDeviceMetricsOverride', {
    width: m.width,
    height: m.height,
    deviceScaleFactor: m.deviceScaleFactor,
    mobile: m.mobile,
    ...(m.screenWidth !== undefined && m.screenHeight !== undefined && {
      screenWidth: m.screenWidth,
      screenHeight: m.screenHeight,
    }),
    // A portrait phone whose screen.orientation still reads
    // "landscape-primary" contradicts its own dimensions. Playwright sends
    // this for its mobile contexts too.
    ...(portrait && { screenOrientation: { angle: 0, type: 'portraitPrimary' } }),
  });
  // Sent on both branches: a preset that turns touch OFF (a desktop preset
  // after a phone one) has to say so, and "enabled: false" is how.
  await loose(session).send('Emulation.setTouchEmulationEnabled', {
    enabled: m.hasTouch,
    maxTouchPoints: m.hasTouch ? TOUCH_POINTS : 0,
  });
}

async function applyToPage(
  context: BrowserContext,
  page: Page,
  state: EmulationState,
): Promise<boolean> {
  if (state.sessions.has(page)) return true;
  let session: CDPSession | undefined;
  try {
    session = await context.newCDPSession(page);
    await sendOverrides(session, state);
    state.sessions.set(page, session);
    // Playwright re-initialises its own emulation on a cross-process
    // navigation, so ours has to be written again afterwards or the preset
    // decays into the contradiction it exists to remove.
    const reapply = (): void => {
      const live = state.sessions.get(page);
      if (!live) return;
      void sendOverrides(live, state).catch(() => {});
    };
    state.onNavigated.set(page, reapply);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) reapply();
    });
    // A closed page's session is dead; drop it rather than leaking the entry.
    page.once('close', () => {
      state.sessions.delete(page);
      state.onNavigated.delete(page);
    });
    return true;
  } catch {
    // A send that failed midway leaves a half-applied identity on a session
    // nothing records — the UA override standing with no state entry, so a
    // later reset would find nothing to undo and the phone UA would be
    // permanent. Put the real UA back, then let the session go.
    if (session) {
      const realUserAgent = await realUserAgentFor(context).catch(() => undefined);
      if (realUserAgent) {
        await loose(session)
          .send('Emulation.setUserAgentOverride', buildUserAgentOverride(realUserAgent))
          .catch(() => {});
      }
      await session.detach().catch(() => {});
    }
    return false;
  }
}

/**
 * Apply `userAgent` (plus matching Client Hints, `navigator.platform` and, when
 * `metrics` is given, the preset's pixel ratio, mobile flag and touch points)
 * to every page in `context`, now and as new ones open.
 *
 * Returns false when CDP refused, in which case the caller's UA header is still
 * in force and only the hints are missing.
 */
export async function applyUserAgentEmulation(
  context: BrowserContext,
  page: Page,
  userAgent: string,
  locale?: string | null,
  metrics?: EmulatedDeviceMetrics,
): Promise<boolean> {
  await clearUserAgentEmulation(context);

  const state: EmulationState = {
    override: buildUserAgentOverride(userAgent, locale),
    ...(metrics && { metrics }),
    sessions: new Map(),
    onNavigated: new Map(),
    onPage: () => {},
  };
  state.onPage = (opened: Page) => {
    void applyToPage(context, opened, state);
  };

  const ok = await applyToPage(context, page, state);
  if (!ok) return false;

  // Every other tab already open, then every tab opened from here on.
  for (const other of context.pages()) {
    if (other !== page) await applyToPage(context, other, state);
  }
  context.on('page', state.onPage);
  stateByContext.set(context, state);

  // One more pass over the page the caller is on, after every other session has
  // been touched. Overrides from different CDP sessions are merged by the last
  // write, and the work above — opening sessions for the other tabs, the
  // library's own emulation bookkeeping — can land a write between ours and the
  // caller's next command. Measured: without this, `navigator.platform` fell
  // back to the host's while the UA string, pixel ratio and touch points all
  // held, which is precisely the disagreement the preset removes.
  const primary = state.sessions.get(page);
  if (primary) await sendOverrides(primary, state).catch(() => {});
  return true;
}

/**
 * Undo an emulated UA: restore the browser's real UA and hints, drop any
 * device metrics and touch emulation the preset installed, drop the new-page
 * listener, and close the sessions being held open.
 *
 * The real UA has to be re-applied rather than merely dropped — CDP has no
 * "clear user agent override" command, and detaching the session while the
 * override stands is what leaves it in place.
 */
export async function clearUserAgentEmulation(context: BrowserContext): Promise<void> {
  const state = stateByContext.get(context);
  if (!state) return;
  stateByContext.delete(context);
  context.off('page', state.onPage);

  const realUserAgent = await realUserAgentFor(context);
  for (const [page, session] of state.sessions) {
    // Each command on its own: one refusal must not skip the rest. Sharing a
    // try meant a failed clearDeviceMetricsOverride left five touch points
    // behind and reported a clean reset.
    if (realUserAgent) {
      await loose(session)
        .send('Emulation.setUserAgentOverride', buildUserAgentOverride(realUserAgent))
        .catch(() => {});
    }
    if (state.metrics) {
      // Undo the physical half too. A reset that restored the desktop UA but
      // left devicePixelRatio 3 and five touch points behind would be the
      // same contradiction the preset path exists to remove, only pointing
      // the other way.
      await loose(session).send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await loose(session)
        .send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 0 })
        .catch(() => {});
      // Clearing the override drops the viewport emulation Playwright thinks
      // it still has, so its cached size — the one screenshots clip to and
      // coordinate clicks are scaled by — would describe a window that no
      // longer exists. Writing the size back re-syncs both sides.
      const size = page.viewportSize();
      if (size) await page.setViewportSize(size).catch(() => {});
    }
    await session.detach().catch(() => {});
  }
  state.sessions.clear();
  state.onNavigated.clear();
}

/**
 * Put the emulated identity back on `page` before something reads it.
 *
 * Only the UA override is re-sent. The device metrics and the touch points
 * survive a foreign session detaching — measured — and each extra command is a
 * round-trip paid on every tool call, so this sends the one that does not.
 *
 * A no-op unless this page is under an emulation this module is holding open,
 * and best-effort otherwise: a page that has gone away must not fail the call
 * that was about to use it.
 */
export async function reassertUserAgentEmulation(page: Page): Promise<void> {
  let context: BrowserContext;
  try {
    context = page.context();
  } catch {
    return;
  }
  const state = stateByContext.get(context);
  if (!state) return;
  const session = state.sessions.get(page);
  if (!session) return;
  await loose(session).send('Emulation.setUserAgentOverride', state.override).catch(() => {});
}

/**
 * The live session for `page` when the preset on it claims a touchscreen, or
 * undefined when there is no preset, no touch in it, or no session for this
 * page.
 *
 * This is what makes touch input possible at all: the emulation that told the
 * page it has a touchscreen and the commands that put a finger on it have to
 * travel on the same session, or the second is a mouse pretending again.
 *
 * Deliberately narrow: callers get something they can `send` on and nothing
 * they can detach, because detaching this session is what would undo the
 * emulation it belongs to.
 */
export function activeTouchSession(
  page: Page,
): { send(method: string, params?: unknown): Promise<unknown> } | undefined {
  let context: BrowserContext;
  try {
    context = page.context();
  } catch {
    return undefined;
  }
  const state = stateByContext.get(context);
  if (!state?.metrics?.hasTouch) return undefined;
  const session = state.sessions.get(page);
  return session ? loose(session) : undefined;
}

/** Whether `context` currently has an emulated UA applied. */
export function hasUserAgentEmulation(context: BrowserContext): boolean {
  return stateByContext.has(context);
}

/**
 * The browser's own UA string, read from the version endpoint rather than from
 * a page — a page under an override would report the override back.
 */
async function realUserAgentFor(context: BrowserContext): Promise<string | undefined> {
  try {
    const browser: Browser | null = context.browser();
    if (!browser) return undefined;
    const session = await context.newCDPSession(context.pages()[0]);
    try {
      const version = (await loose(session).send('Browser.getVersion')) as {
        userAgent?: string;
      };
      return version?.userAgent;
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    return undefined;
  }
}
