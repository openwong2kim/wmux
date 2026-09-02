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
// ---------------------------------------------------------------------------

import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { buildUserAgentOverride, type UserAgentOverride } from '../../shared/uaMetadata';

interface EmulationState {
  override: UserAgentOverride;
  /** Live sessions, one per page, held open so the override survives. */
  sessions: Map<Page, CDPSession>;
  /** Listener re-applying the override to pages opened later. */
  onPage: (page: Page) => void;
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

async function applyToPage(
  context: BrowserContext,
  page: Page,
  state: EmulationState,
): Promise<boolean> {
  if (state.sessions.has(page)) return true;
  try {
    const session = await context.newCDPSession(page);
    await loose(session).send('Emulation.setUserAgentOverride', state.override);
    state.sessions.set(page, session);
    // A closed page's session is dead; drop it rather than leaking the entry.
    page.once('close', () => {
      state.sessions.delete(page);
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply `userAgent` (plus matching Client Hints) to every page in `context`,
 * now and as new ones open.
 *
 * Returns false when CDP refused, in which case the caller's UA header is still
 * in force and only the hints are missing.
 */
export async function applyUserAgentEmulation(
  context: BrowserContext,
  page: Page,
  userAgent: string,
  locale?: string | null,
): Promise<boolean> {
  await clearUserAgentEmulation(context);

  const state: EmulationState = {
    override: buildUserAgentOverride(userAgent, locale),
    sessions: new Map(),
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
  return true;
}

/**
 * Undo an emulated UA: restore the browser's real UA and hints, drop the
 * new-page listener, and close the sessions being held open.
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
  for (const [, session] of state.sessions) {
    try {
      if (realUserAgent) {
        await loose(session).send(
          'Emulation.setUserAgentOverride',
          buildUserAgentOverride(realUserAgent),
        );
      }
    } catch {
      /* the page is gone, or CDP refused; the session detach below is enough */
    }
    await session.detach().catch(() => {});
  }
  state.sessions.clear();
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
