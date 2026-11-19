// The pipe's URL boundary (C2d): on a protected profile an outside client sees,
// attaches to and drives only pages whose URL the profile allows, by the URL
// Chrome last reported; a page it holds that moves off the list is detached.
// Main's own connections see every page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpPipeMux, MUX_ID_BASE, resetCdpPipeCounters } from '../CdpPipeMux';
import { SCHEME_NOT_ALLOWED, protectedUrlAllowed } from '../ProtectedPipePolicy';
import { FakeBrowser } from './fakePipeBrowser';

type Inbox = Array<Record<string, unknown>>;

function setup() {
  const browser = new FakeBrowser();
  const mux = new CdpPipeMux(browser.fromMux, browser.toMux, { urlGate: { allows: protectedUrlAllowed, refusal: SCHEME_NOT_ALLOWED } });
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
});
