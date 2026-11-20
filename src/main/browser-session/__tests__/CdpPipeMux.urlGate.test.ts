// The pipe's URL boundary (C2d): on a protected profile an outside client sees,
// attaches to and drives only pages whose URL the profile allows, by the URL
// Chrome last reported; a page it holds that moves off the list is detached.
// Main's own connections see every page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpPipeMux, MUX_ID_BASE, cdpPipeCounters, resetCdpPipeCounters } from '../CdpPipeMux';
import { SCHEME_NOT_ALLOWED, appLaunchUrl, protectedUrlAllowed } from '../ProtectedPipePolicy';
import { FakeBrowser, type Command } from './fakePipeBrowser';

type Inbox = Array<Record<string, unknown>>;

const GATE = { allows: protectedUrlAllowed, handedOff: appLaunchUrl, refusal: SCHEME_NOT_ALLOWED };

function setup(extra: Omit<ConstructorParameters<typeof CdpPipeMux>[2] & object, 'urlGate'> = {}) {
  const browser = new FakeBrowser();
  const mux = new CdpPipeMux(browser.fromMux, browser.toMux, { urlGate: GATE, ...extra });
  return { browser, mux };
}

function client(mux: CdpPipeMux, label = 'relay') {
  const inbox: Inbox = [];
  const c = mux.attachExternal(label, (text) => inbox.push(JSON.parse(text) as Record<string, unknown>), () => undefined);
  let nextId = 0;
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    const id = ++nextId;
    c.receive(JSON.stringify({ id, method, params, ...(sessionId !== undefined && { sessionId }) }));
    return id;
  };
  const replyTo = async (id: number) => {
    await vi.waitFor(() => expect(inbox.some((m) => m.id === id)).toBe(true), { timeout: 5_000 });
    return inbox.find((m) => m.id === id) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
  };
  /** Targets this client was told of, by any Target event. */
  const told = () => inbox
    .filter((m) => typeof m.method === 'string' && (m.method as string).startsWith('Target.'))
    .map((m) => (m.params as { targetInfo?: { targetId?: string } }).targetInfo?.targetId)
    .filter((t): t is string => typeof t === 'string');
  const sessionFor = (targetId: string) => {
    const event = inbox.find((m) => m.method === 'Target.attachedToTarget' && (m.params as { targetInfo: { targetId: string } }).targetInfo.targetId === targetId);
    return (event?.params as { sessionId?: string } | undefined)?.sessionId;
  };
  return { inbox, send, replyTo, told, sessionFor };
}

/** The mux's discovery session is up (it learns every target's URL there). */
async function discovering(browser: FakeBrowser): Promise<void> {
  await vi.waitFor(() => expect(browser.discover.size).toBeGreaterThan(0), { timeout: 5_000 });
}

/** A client that auto-attaches and discovers on its browser session, as Playwright does. */
async function playwrightLike(mux: CdpPipeMux) {
  const c = client(mux);
  await c.replyTo(c.send('Target.setDiscoverTargets', { discover: true }));
  await c.replyTo(c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }));
  return c;
}

/** Chrome reporting a page's new URL on every discovering session. */
function navigated(browser: FakeBrowser, targetId: string, url: string): void {
  for (const s of browser.discover) browser.event(s, 'Target.targetInfoChanged', { targetInfo: { targetId, type: 'page', url, browserContextId: 'DEFAULT' } });
}

/** Wait until the mux let a judged auto-attach go (its own Target.detachFromTarget). */
const letGo = (browser: FakeBrowser) => vi.waitFor(() => expect(browser.received.some((c) => c.method === 'Target.detachFromTarget' && c.id >= MUX_ID_BASE)).toBe(true), { timeout: 5_000 });
const detachesSent = (browser: FakeBrowser) => browser.received.filter((c) => c.method === 'Target.detachFromTarget' && c.id >= MUX_ID_BASE);

/** A page the client created and holds, with the mux's own session on it (where it reads history and hears navigations). */
async function watchedPage(browser: FakeBrowser, c: ReturnType<typeof client>) {
  const page = (await c.replyTo(c.send('Target.createTarget', { url: 'https://a.test/' }))).result?.targetId as string;
  await vi.waitFor(() => expect(c.sessionFor(page)).toBeDefined(), { timeout: 5_000 });
  await vi.waitFor(() => expect(browser.received.some((r) => r.method === 'Page.getNavigationHistory' && r.id >= MUX_ID_BASE)).toBe(true), { timeout: 5_000 });
  const watch = browser.received.find((r) => r.method === 'Page.getNavigationHistory' && r.id >= MUX_ID_BASE)?.sessionId as string;
  return { page, session: c.sessionFor(page) as string, watch };
}

const detachedSession = (browser: FakeBrowser, session: string) => detachesSent(browser).some((d) => d.params.sessionId === session);

afterEach(() => resetCdpPipeCounters());

describe('CdpPipeMux URL boundary (C2d)', () => {
  it('a user-opened chrome://new-tab-page is invisible to an outside client and cannot be attached; main still sees it', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    browser.targets.push({ targetId: 'NTP', title: '', url: 'chrome://new-tab-page/' });
    browser.announce({ targetId: 'NTP', type: 'page', browserContextId: 'DEFAULT', url: 'chrome://new-tab-page/' });
    // The mux judged it: its auto-attach was let go again.
    await letGo(browser);
    expect(c.told()).not.toContain('NTP');
    // Its auto-attach was let go again.
    expect(detachesSent(browser)).toHaveLength(1);
    const list = await c.replyTo(c.send('Target.getTargets'));
    expect((list.result?.targetInfos as Array<{ targetId: string }>).map((t) => t.targetId)).not.toContain('NTP');
    const attach = await c.replyTo(c.send('Target.attachToTarget', { targetId: 'NTP', flatten: true }));
    expect(attach.error?.message).toBe('No target with given id found');
    const own = mux.connect({ label: 'main' });
    const mine = (await own.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string }> };
    expect(mine.targetInfos.map((t) => t.targetId)).toContain('NTP');
    own.close();
    mux.close();
  });

  it.each([
    'CHROME://settings', ' chrome://settings', 'chrome:settings', 'view-source:chrome://settings', 'view-source:https://a.test/',
    'devtools://devtools/bundled/inspector.html', 'chrome-untrusted://x/', 'chrome-extension://abc/x.html', 'file:///tmp/x', 'chrome-search://local-ntp/',
  ])('a page on %j is not shown to an outside client', async (url) => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    browser.announce({ targetId: 'X', type: 'page', browserContextId: 'DEFAULT', url });
    // The mux judged it: its auto-attach was let go again.
    await letGo(browser);
    expect(c.told()).not.toContain('X');
    mux.close();
  });

  it('an attached https page that moves to chrome:// is detached, and its session takes no more commands', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    const created = await c.replyTo(c.send('Target.createTarget', { url: 'https://a.test/' }));
    const page = created.result?.targetId as string;
    await vi.waitFor(() => expect(c.sessionFor(page)).toBeDefined(), { timeout: 5_000 });
    const session = c.sessionFor(page) as string;
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, session))).result).toBeDefined();
    navigated(browser, page, 'chrome://inspect/#remote-debugging');
    await vi.waitFor(() => expect(detachesSent(browser).some((d) => d.params.sessionId === session)).toBe(true), { timeout: 5_000 });
    const after = await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, session));
    expect(after.error).toBeDefined();
    expect(browser.received.filter((r) => r.method === 'Runtime.evaluate' && r.sessionId === session)).toHaveLength(1);
    mux.close();
  });

  it('a page that was on a chrome:// URL stays off-limits after it moves to an allowed one', async () => {
    const { browser, mux } = setup();
    browser.announceAttach = true;
    await discovering(browser);
    const c = await playwrightLike(mux);
    browser.announce({ targetId: 'U', type: 'page', browserContextId: 'DEFAULT', url: 'chrome://new-tab-page/' });
    await letGo(browser);
    navigated(browser, 'U', 'https://typed.test/');
    const attach = await c.replyTo(c.send('Target.attachToTarget', { targetId: 'U', flatten: true }));
    expect(attach.error?.message).toBe('No target with given id found');
    expect(c.sessionFor('U')).toBeUndefined();
    mux.close();
  });

  it('a page with no URL yet counts only as an outside client\'s own page or a popup of an allowed one (P2a)', async () => {
    const { browser, mux } = setup();
    browser.announceAttach = true;
    await discovering(browser);
    const c = await playwrightLike(mux);
    const unknown = await c.replyTo(c.send('Target.attachToTarget', { targetId: 'NEVER-TOLD', flatten: true }));
    expect(unknown.error?.message).toBe('No target with given id found');
    // A tab nobody here made, paused before its first URL (as a user's chrome:// tab is): not shown.
    browser.announce({ targetId: 'BLANK', type: 'page', browserContextId: 'DEFAULT', url: '' });
    await letGo(browser);
    expect(c.told()).not.toContain('BLANK');
    // A popup of the client's own allowed page: shown, with no URL yet.
    const own = (await c.replyTo(c.send('Target.createTarget', { url: 'https://a.test/' }))).result?.targetId as string;
    browser.announce({ targetId: 'POP', type: 'page', browserContextId: 'DEFAULT', url: '', openerId: own });
    await vi.waitFor(() => expect(c.sessionFor('POP')).toBeDefined(), { timeout: 5_000 });
    // The blank tab reaches an allowed URL: attached for the client then.
    navigated(browser, 'BLANK', 'https://later.test/');
    await vi.waitFor(() => expect(c.sessionFor('BLANK')).toBeDefined(), { timeout: 5_000 });
    mux.close();
  });

  it('a page already open with a chrome:// entry in its history is never shown, even on an https URL (P1)', async () => {
    const { browser, mux } = setup();
    browser.targets.push({ targetId: 'RESTORED', title: '', url: 'https://a.test/now' });
    browser.histories.set('RESTORED', [{ id: 1, url: 'chrome://settings/' }, { id: 2, url: 'https://a.test/now' }]);
    await discovering(browser);
    browser.announce({ targetId: 'RESTORED', type: 'page', browserContextId: 'DEFAULT', url: 'https://a.test/now' });
    await vi.waitFor(() => expect(browser.received.some((r) => r.method === 'Page.getNavigationHistory' && r.id >= MUX_ID_BASE)).toBe(true), { timeout: 5_000 });
    const c = client(mux);
    await vi.waitFor(async () => {
      const list = await c.replyTo(c.send('Target.getTargets'));
      expect((list.result?.targetInfos as Array<{ targetId: string }>).map((t) => t.targetId)).not.toContain('RESTORED');
    }, { timeout: 5_000 });
    expect((await c.replyTo(c.send('Target.attachToTarget', { targetId: 'RESTORED', flatten: true }))).error).toBeDefined();
    mux.close();
  });

  it('a page that appears with such a history takes no command before it is let go (P1)', async () => {
    const { browser, mux } = setup();
    browser.histories.set('REOPENED', [{ id: 1, url: 'chrome://version/' }, { id: 2, url: 'https://a.test/back' }]);
    await discovering(browser);
    const c = await playwrightLike(mux);
    // Its history answer is held: the client's command must wait for it.
    browser.holdReplies.add('Page.getNavigationHistory');
    browser.announce({ targetId: 'REOPENED', type: 'page', browserContextId: 'DEFAULT', url: 'https://a.test/back' });
    await vi.waitFor(() => expect(c.sessionFor('REOPENED')).toBeDefined(), { timeout: 5_000 });
    const session = c.sessionFor('REOPENED') as string;
    const id = c.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.x = 1' }, session);
    browser.holdReplies.delete('Page.getNavigationHistory');
    browser.releaseHeld();
    expect((await c.replyTo(id)).error).toBeDefined();
    expect(browser.received.filter((r) => r.method === 'Page.addScriptToEvaluateOnNewDocument')).toEqual([]);
    mux.close();
  });

  it('a navigation toward chrome:// that starts on an attached page lets the client go before it commits (P1)', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    const page = (await c.replyTo(c.send('Target.createTarget', { url: 'https://a.test/' }))).result?.targetId as string;
    await vi.waitFor(() => expect(c.sessionFor(page)).toBeDefined(), { timeout: 5_000 });
    const session = c.sessionFor(page) as string;
    // The mux's own session on the page (it read the history there).
    await vi.waitFor(() => expect(browser.received.some((r) => r.method === 'Page.getNavigationHistory' && r.id >= MUX_ID_BASE)).toBe(true), { timeout: 5_000 });
    const watch = browser.received.find((r) => r.method === 'Page.getNavigationHistory' && r.id >= MUX_ID_BASE)?.sessionId as string;
    browser.event(watch, 'Page.frameStartedNavigating', { frameId: page, url: 'chrome://version/', loaderId: 'L', navigationType: 'historyDifferentDocument' });
    await vi.waitFor(() => expect(detachesSent(browser).some((d) => d.params.sessionId === session)).toBe(true), { timeout: 5_000 });
    // No targetInfoChanged has come yet: the start alone did it.
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, session))).error).toBeDefined();
    mux.close();
  });

  it('an outside client is shown only the history entries it may navigate to (P1)', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    const page = (await c.replyTo(c.send('Target.createTarget', { url: 'https://a.test/' }))).result?.targetId as string;
    await vi.waitFor(() => expect(c.sessionFor(page)).toBeDefined(), { timeout: 5_000 });
    const session = c.sessionFor(page) as string;
    // Its own history is clean at first sight; a later read shows an entry it may not use.
    await vi.waitFor(() => expect(browser.received.some((r) => r.method === 'Page.getNavigationHistory' && r.id >= MUX_ID_BASE)).toBe(true), { timeout: 5_000 });
    browser.histories.set(page, [{ id: 1, url: 'https://a.test/' }, { id: 2, url: 'devtools://devtools/x' }, { id: 3, url: 'https://a.test/two' }]);
    const history = await c.replyTo(c.send('Page.getNavigationHistory', {}, session));
    expect(history.result).toEqual({ currentIndex: 1, entries: [{ id: 1, url: 'https://a.test/' }, { id: 3, url: 'https://a.test/two' }] });
    mux.close();
  });

  it('a session on a page with no reported URL takes no command', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    // Told only to the client's own session, never with a URL: the mux can't judge it.
    const parent = browser.received.find((r) => r.method === 'Target.setAutoAttach' && r.id < MUX_ID_BASE)?.sessionId as string;
    browser.sessions.add('S-NOURL');
    browser.event(parent, 'Target.attachedToTarget', { sessionId: 'S-NOURL', targetInfo: { targetId: 'NOURL', type: 'page', browserContextId: 'DEFAULT' }, waitingForDebugger: false });
    // The mux judged it: its auto-attach was let go again.
    await letGo(browser);
    expect(c.told()).not.toContain('NOURL');
    const answer = await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, 'S-NOURL'));
    expect(answer.error).toBeDefined();
    mux.close();
  });

  it('with grants too, a frame or worker of a granted page follows its page and stays attached (P2b)', async () => {
    const browser = new FakeBrowser();
    browser.announceBeforeReply = true;
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux, {
      urlGate: { allows: protectedUrlAllowed, refusal: SCHEME_NOT_ALLOWED },
      grants: { registry: () => null },
    });
    await discovering(browser);
    const c = await playwrightLike(mux);
    const page = (await c.replyTo(c.send('Target.createTarget', { url: 'https://a.test/' }))).result?.targetId as string;
    await vi.waitFor(() => expect(c.sessionFor(page)).toBeDefined(), { timeout: 5_000 });
    const pageSession = c.sessionFor(page) as string;
    for (const [targetId, type] of [['FRAME', 'iframe'], ['WORKER', 'worker']] as const) {
      browser.sessions.add(`S-${targetId}`);
      browser.event(pageSession, 'Target.attachedToTarget', { sessionId: `S-${targetId}`, targetInfo: { targetId, type, url: 'https://frames.test/x', browserContextId: 'DEFAULT' }, waitingForDebugger: false });
      await vi.waitFor(() => expect(c.sessionFor(targetId)).toBe(`S-${targetId}`), { timeout: 5_000 });
      expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, `S-${targetId}`))).error).toBeUndefined();
    }
    expect(detachesSent(browser).filter((d) => String(d.params.sessionId).startsWith('S-'))).toEqual([]);
    mux.close();
  });

  it('a mailto: link (a navigation Chrome hands to another app) leaves the page usable; a commit to that URL still lets the client go', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    const { page, session, watch } = await watchedPage(browser, c);
    browser.event(watch, 'Page.frameRequestedNavigation', { frameId: page, reason: 'anchorClick', url: 'mailto:someone@a.test', disposition: 'currentTab' });
    browser.event(watch, 'Page.frameStartedNavigating', { frameId: page, url: 'MAILTO:someone@a.test', loaderId: 'L', navigationType: 'differentDocument' });
    // Its reply comes after both events: the page was still the client's then.
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, session))).error).toBeUndefined();
    expect(detachedSession(browser, session)).toBe(false);
    browser.event(watch, 'Page.frameNavigated', { frame: { id: page, loaderId: 'L', url: 'mailto:someone@a.test' }, type: 'Navigation' });
    await vi.waitFor(() => expect(detachedSession(browser, session)).toBe(true), { timeout: 5_000 });
    mux.close();
  });

  it('a page commit with no parent frame to a refused URL lets the client go, whatever frame id it carries', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    const { session, watch } = await watchedPage(browser, c);
    browser.event(watch, 'Page.frameNavigated', { frame: { id: 'ANOTHER-ID', loaderId: 'L', url: 'chrome://settings/' }, type: 'Navigation' });
    await vi.waitFor(() => expect(detachedSession(browser, session)).toBe(true), { timeout: 5_000 });
    mux.close();
  });

  it.each([
    ['a chrome:// redirect', 'Page.frameRequestedNavigation', 'chrome://settings/'],
    ['an unknown scheme', 'Page.frameStartedNavigating', 'web+unknown:x'],
    ['an app scheme wrapped in view-source:', 'Page.frameStartedNavigating', 'view-source:mailto:someone@a.test'],
  ])('%s that only starts still lets the client go at once', async (_what, method, url) => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    const { page, session, watch } = await watchedPage(browser, c);
    browser.event(watch, method, { frameId: page, url, reason: 'httpHeaderRefresh', loaderId: 'L', navigationType: 'differentDocument' });
    await vi.waitFor(() => expect(detachedSession(browser, session)).toBe(true), { timeout: 5_000 });
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, session))).error).toBeDefined();
    mux.close();
  });

  it('a frame or worker on a URL the gate refuses is let go at attach; one that moves to such a URL is let go for good', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    const { session: pageSession } = await watchedPage(browser, c);
    const attachChild = (sessionId: string, targetId: string, type: string, url: string) => {
      browser.sessions.add(sessionId);
      browser.event(pageSession, 'Target.attachedToTarget', { sessionId, targetInfo: { targetId, type, url, browserContextId: 'DEFAULT' }, waitingForDebugger: false });
    };
    attachChild('S-EXT', 'EXT', 'iframe', 'chrome-extension://abc/frame.html');
    attachChild('S-EXTW', 'EXTW', 'worker', 'chrome-extension://abc/worker.js');
    attachChild('S-WEB', 'WEB', 'iframe', 'https://frames.test/x');
    attachChild('S-BLANK', 'BLANK', 'iframe', '');
    await vi.waitFor(() => expect(c.sessionFor('WEB')).toBe('S-WEB'), { timeout: 5_000 });
    await vi.waitFor(() => expect(c.sessionFor('BLANK')).toBe('S-BLANK'), { timeout: 5_000 });
    expect(c.sessionFor('EXT')).toBeUndefined();
    expect(c.sessionFor('EXTW')).toBeUndefined();
    expect(detachedSession(browser, 'S-EXT') && detachedSession(browser, 'S-EXTW')).toBe(true);
    for (const s of ['S-EXT', 'S-EXTW']) expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, s))).error).toBeDefined();
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, 'S-WEB'))).error).toBeUndefined();
    // A frame attached before its URL was known, then reported on a refused one: let go, and kept off after it moves on.
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, 'S-BLANK'))).error).toBeUndefined();
    for (const s of browser.discover) browser.event(s, 'Target.targetInfoChanged', { targetInfo: { targetId: 'BLANK', type: 'iframe', url: 'chrome-extension://abc/frame.html', browserContextId: 'DEFAULT' } });
    await vi.waitFor(() => expect(detachedSession(browser, 'S-BLANK')).toBe(true), { timeout: 5_000 });
    for (const s of browser.discover) browser.event(s, 'Target.targetInfoChanged', { targetInfo: { targetId: 'BLANK', type: 'iframe', url: 'https://frames.test/y', browserContextId: 'DEFAULT' } });
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, 'S-BLANK'))).error).toBeDefined();
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, 'S-WEB'))).error).toBeUndefined();
    mux.close();
  });

  it('a frame whose navigation toward a refused URL the page reported first is let go when it attaches still without a URL', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    const { session: pageSession, watch } = await watchedPage(browser, c);
    // As Chrome reports it: the page's own Page events name the frame's destination, then the frame target attaches paused, with no URL yet.
    for (const [frameId, url] of [['XF', 'chrome-extension://abc/frame.html'], ['WF', 'https://frames.test/x'], ['SF', 'about:srcdoc']]) {
      browser.event(watch, 'Page.frameRequestedNavigation', { frameId, reason: 'scriptInitiated', url, disposition: 'currentTab' });
      browser.event(watch, 'Page.frameStartedNavigating', { frameId, url, loaderId: `L-${frameId}`, navigationType: 'differentDocument' });
    }
    for (const frameId of ['XF', 'WF']) {
      browser.sessions.add(`S-${frameId}`);
      browser.event(pageSession, 'Target.attachedToTarget', { sessionId: `S-${frameId}`, targetInfo: { targetId: frameId, type: 'iframe', url: '', browserContextId: 'DEFAULT' }, waitingForDebugger: true });
    }
    await vi.waitFor(() => expect(c.sessionFor('WF')).toBe('S-WF'), { timeout: 5_000 });
    expect(c.sessionFor('XF')).toBeUndefined();
    expect(detachedSession(browser, 'S-XF')).toBe(true);
    // Paused for a client that never hears of it: the mux lets it run before letting it go.
    expect(browser.received.some((r) => r.method === 'Runtime.runIfWaitingForDebugger' && r.sessionId === 'S-XF' && r.id >= MUX_ID_BASE)).toBe(true);
    expect((await c.replyTo(c.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.x = 1' }, 'S-XF'))).error).toBeDefined();
    expect(browser.received.filter((r) => r.method === 'Page.addScriptToEvaluateOnNewDocument')).toEqual([]);
    mux.close();
  });

  it('a page whose history can\'t be read before its first document is read again once it has a URL, and kept', async () => {
    /** Chrome before a page's first document: no history to read yet. */
    class NoDocumentYet extends FakeBrowser {
      readonly blank = new Set<string>();
      protected override handle(c: Command): void {
        if (c.method === 'Page.getNavigationHistory' && c.sessionId !== undefined && this.blank.has(this.sessionTarget.get(c.sessionId) ?? '')) {
          this.reply(c, '"error":{"code":-32000,"message":"Not attached to an active page"}');
          return;
        }
        super.handle(c);
      }
    }
    const browser = new NoDocumentYet();
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux, { urlGate: GATE });
    await discovering(browser);
    const c = await playwrightLike(mux);
    const { page } = await watchedPage(browser, c);
    const reads = () => browser.received.filter((r) => r.method === 'Page.getNavigationHistory' && r.id >= MUX_ID_BASE && browser.sessionTarget.get(r.sessionId as string) === 'NEW');
    // A popup of the client's page, announced before its first document.
    browser.blank.add('NEW');
    browser.announce({ targetId: 'NEW', type: 'page', browserContextId: 'DEFAULT', url: '', openerId: page });
    await vi.waitFor(() => expect(reads()).toHaveLength(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(c.sessionFor('NEW')).toBeDefined(), { timeout: 5_000 });
    const session = c.sessionFor('NEW') as string;
    browser.blank.delete('NEW');
    navigated(browser, 'NEW', 'https://a.test/next');
    await vi.waitFor(() => expect(reads()).toHaveLength(2), { timeout: 5_000 });
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, session))).error).toBeUndefined();
    expect(detachedSession(browser, session)).toBe(false);
    expect(cdpPipeCounters().dropped['url-gate-tainted']).toBeUndefined();
    mux.close();
  });

  it('an out-of-process frame\'s own navigation toward a refused URL lets the client go before any target change', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    const { page, session: pageSession } = await watchedPage(browser, c);
    browser.sessions.add('S-OOP');
    browser.event(pageSession, 'Target.attachedToTarget', { sessionId: 'S-OOP', targetInfo: { targetId: 'OOP', type: 'iframe', url: 'https://frames.test/x', parentId: page, browserContextId: 'DEFAULT' }, waitingForDebugger: false });
    await vi.waitFor(() => expect(c.sessionFor('OOP')).toBe('S-OOP'), { timeout: 5_000 });
    // The mux's own session on the frame, with Page events on.
    await vi.waitFor(() => expect(browser.received.some((r) => r.method === 'Target.attachToTarget' && r.id >= MUX_ID_BASE && r.params.targetId === 'OOP')).toBe(true), { timeout: 5_000 });
    const frameWatch = [...browser.sessionTarget].filter(([, t]) => t === 'OOP').map(([s]) => s).at(-1) as string;
    await vi.waitFor(() => expect(browser.received.some((r) => r.method === 'Page.enable' && r.sessionId === frameWatch)).toBe(true), { timeout: 5_000 });
    browser.event(frameWatch, 'Page.frameStartedNavigating', { frameId: 'OOP', url: 'chrome-extension://abc/frame.html', loaderId: 'L', navigationType: 'differentDocument' });
    await vi.waitFor(() => expect(detachedSession(browser, 'S-OOP')).toBe(true), { timeout: 5_000 });
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, 'S-OOP'))).error).toBeDefined();
    mux.close();
  });

  it('a frame Chrome names a page as parent for is reachable only while that page is: listed, attached by id, or held', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = client(mux);
    // A page that is off-limits (its history held chrome://), with a frame from an allowed site.
    browser.histories.set('OFF', [{ id: 1, url: 'chrome://settings/' }, { id: 2, url: 'https://a.test/now' }]);
    browser.announce({ targetId: 'OFF', type: 'page', browserContextId: 'DEFAULT', url: 'https://a.test/now' });
    browser.announce({ targetId: 'OFF-F', type: 'iframe', browserContextId: 'DEFAULT', url: 'https://frames.test/x', parentId: 'OFF' });
    await vi.waitFor(() => expect(cdpPipeCounters().dropped['url-gate-tainted']).toBe(1), { timeout: 5_000 });
    expect((await c.replyTo(c.send('Target.attachToTarget', { targetId: 'OFF-F', flatten: true }))).error?.message).toBe('No target with given id found');
    // A frame of the client's own page, attached by id on its browser session: let go when the page is marked.
    const own = (await c.replyTo(c.send('Target.createTarget', { url: 'https://a.test/' }))).result?.targetId as string;
    browser.announce({ targetId: 'OWN-F', type: 'iframe', browserContextId: 'DEFAULT', url: 'https://frames.test/y', parentId: own });
    const attached = await c.replyTo(c.send('Target.attachToTarget', { targetId: 'OWN-F', flatten: true }));
    const frameSession = attached.result?.sessionId as string;
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, frameSession))).error).toBeUndefined();
    navigated(browser, own, 'chrome://settings/');
    await vi.waitFor(() => expect(detachedSession(browser, frameSession)).toBe(true), { timeout: 5_000 });
    expect((await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, frameSession))).error).toBeDefined();
    mux.close();
  });

  it('a first history read that fails before the page has a URL, which it gets meanwhile, holds commands until a read that can decide', async () => {
    /** Chrome before a page's first document, then a history that holds a refused entry; the reads answered one by one. */
    class Scripted extends FakeBrowser {
      readonly reads: Command[] = [];
      protected override handle(c: Command): void {
        if (c.method === 'Page.getNavigationHistory' && c.sessionId !== undefined && this.sessionTarget.get(c.sessionId) === 'LATE') {
          this.reads.push(c);
          return;
        }
        super.handle(c);
      }
      fail(c: Command): void { this.reply(c, '"error":{"code":-32000,"message":"Not attached to an active page"}'); }
      refusedEntry(c: Command): void { this.reply(c, `"result":${JSON.stringify({ currentIndex: 1, entries: [{ id: 1, url: 'chrome://version/' }, { id: 2, url: 'https://a.test/late' }] })}`); }
    }
    const browser = new Scripted();
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux, { urlGate: GATE });
    await discovering(browser);
    const c = await playwrightLike(mux);
    const { page } = await watchedPage(browser, c);
    browser.announce({ targetId: 'LATE', type: 'page', browserContextId: 'DEFAULT', url: '', openerId: page });
    await vi.waitFor(() => expect(browser.reads).toHaveLength(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(c.sessionFor('LATE')).toBeDefined(), { timeout: 5_000 });
    const session = c.sessionFor('LATE') as string;
    // Its URL arrives while the first read is in flight; that change starts a read of its own.
    navigated(browser, 'LATE', 'https://a.test/late');
    await vi.waitFor(() => expect(browser.reads).toHaveLength(2), { timeout: 5_000 });
    const id = c.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.x = 1' }, session);
    browser.fail(browser.reads[0]);
    // The first read is made again; the command still waits.
    await vi.waitFor(() => expect(browser.reads).toHaveLength(3), { timeout: 5_000 });
    expect(browser.received.filter((r) => r.method === 'Page.addScriptToEvaluateOnNewDocument')).toEqual([]);
    browser.refusedEntry(browser.reads[2]);
    expect((await c.replyTo(id)).error).toBeDefined();
    expect(browser.received.filter((r) => r.method === 'Page.addScriptToEvaluateOnNewDocument')).toEqual([]);
    mux.close();
  });

  it('a reply to a command in flight when its page is tainted is refused', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    const { page, session } = await watchedPage(browser, c);
    // The browser answers the command before it handles the mux's detach.
    browser.holdReplies.add('Runtime.evaluate');
    browser.holdReplies.add('Target.detachFromTarget');
    const id = c.send('Runtime.evaluate', { expression: 'document.title' }, session);
    await vi.waitFor(() => expect(browser.received.some((r) => r.method === 'Runtime.evaluate' && r.sessionId === session)).toBe(true), { timeout: 5_000 });
    navigated(browser, page, 'chrome://settings/');
    await vi.waitFor(() => expect(detachedSession(browser, session)).toBe(true), { timeout: 5_000 });
    browser.holdReplies.clear();
    browser.releaseHeld();
    const answer = await c.replyTo(id);
    expect(answer.result).toBeUndefined();
    expect(answer.error?.message).toBe(SCHEME_NOT_ALLOWED.message);
    mux.close();
  });

  it('a reply whose page is tainted while its after-reply rule runs is refused', async () => {
    let finish: (value: null) => void = () => undefined;
    let started = false;
    const { browser, mux } = setup({
      beforeReply: (_client, method) => {
        if (method !== 'Runtime.evaluate') return null;
        started = true;
        return new Promise<null>((resolve) => { finish = resolve; });
      },
    });
    await discovering(browser);
    const c = await playwrightLike(mux);
    const { page, session } = await watchedPage(browser, c);
    const id = c.send('Runtime.evaluate', { expression: 'document.title' }, session);
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 5_000 });
    navigated(browser, page, 'chrome://settings/');
    await vi.waitFor(() => expect(detachedSession(browser, session)).toBe(true), { timeout: 5_000 });
    finish(null);
    const answer = await c.replyTo(id);
    expect(answer.result).toBeUndefined();
    expect(answer.error?.message).toBe(SCHEME_NOT_ALLOWED.message);
    mux.close();
  });

  it('an attach in flight to a page that is tainted before its reply is refused, and its session let go', async () => {
    const { browser, mux } = setup();
    browser.announceAttach = true;
    browser.targets.push({ targetId: 'P', title: '', url: 'https://a.test/' });
    await discovering(browser);
    browser.announce({ targetId: 'P', type: 'page', browserContextId: 'DEFAULT', url: 'https://a.test/' });
    // The mux's own session on it is up first.
    await vi.waitFor(() => expect(browser.received.some((r) => r.method === 'Page.getNavigationHistory' && r.id >= MUX_ID_BASE)).toBe(true), { timeout: 5_000 });
    const c = client(mux);
    browser.holdReplies.add('Target.attachToTarget');
    const id = c.send('Target.attachToTarget', { targetId: 'P', flatten: true });
    await vi.waitFor(() => expect(browser.received.some((r) => r.method === 'Target.attachToTarget' && r.id < MUX_ID_BASE)).toBe(true), { timeout: 5_000 });
    navigated(browser, 'P', 'chrome://settings/');
    await vi.waitFor(() => expect(cdpPipeCounters().dropped['url-gate-tainted']).toBe(1), { timeout: 5_000 });
    browser.holdReplies.clear();
    browser.releaseHeld();
    const answer = await c.replyTo(id);
    expect(answer.result).toBeUndefined();
    expect(answer.error?.message).toBe(SCHEME_NOT_ALLOWED.message);
    const session = [...browser.sessionTarget].filter(([, t]) => t === 'P').map(([s]) => s).at(-1) as string;
    await vi.waitFor(() => expect(detachedSession(browser, session)).toBe(true), { timeout: 5_000 });
    expect(c.sessionFor('P')).toBeUndefined();
    mux.close();
  });

  it('history checks that overlap share one attach of the mux\'s own; a page gone before it lands has that session let go', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const ownAttaches = () => browser.received.filter((r) => r.method === 'Target.attachToTarget' && r.id >= MUX_ID_BASE);
    browser.holdReplies.add('Target.attachToTarget');
    browser.announce({ targetId: 'Q', type: 'page', browserContextId: 'DEFAULT', url: 'https://a.test/one' });
    await vi.waitFor(() => expect(ownAttaches()).toHaveLength(1), { timeout: 5_000 });
    // A URL change while the first attach is in flight starts a second check.
    navigated(browser, 'Q', 'https://a.test/two');
    browser.announce({ targetId: 'R', type: 'page', browserContextId: 'DEFAULT', url: 'https://a.test/r' });
    await vi.waitFor(() => expect(ownAttaches()).toHaveLength(2), { timeout: 5_000 });
    expect(ownAttaches().map((r) => r.params.targetId)).toEqual(['Q', 'R']);
    // R goes before its attach is answered.
    (mux as unknown as { forgetTarget(id: string): void }).forgetTarget('R');
    browser.holdReplies.clear();
    browser.releaseHeld();
    const rSession = [...browser.sessionTarget].find(([, t]) => t === 'R')?.[0] as string;
    await vi.waitFor(() => expect(detachedSession(browser, rSession)).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(browser.received.filter((r) => r.method === 'Page.getNavigationHistory' && r.id >= MUX_ID_BASE && r.params && browser.sessionTarget.get(r.sessionId as string) === 'Q')).toHaveLength(2), { timeout: 5_000 });
    expect(ownAttaches().filter((r) => r.params.targetId === 'Q')).toHaveLength(1);
    mux.close();
  });
});
