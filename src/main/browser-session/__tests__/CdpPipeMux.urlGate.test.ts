// The pipe's URL boundary (C2d): on a protected profile an outside client sees,
// attaches to and drives only pages whose URL the profile allows, by the URL
// Chrome last reported; a page it holds that moves off the list is detached.
// Main's own connections see every page.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpPipeMux, MUX_ID_BASE, resetCdpPipeCounters } from '../CdpPipeMux';
import { SCHEME_NOT_ALLOWED, protectedUrlAllowed } from '../ProtectedPipePolicy';
import { FakeBrowser } from './fakePipeBrowser';
import { deliberateSleep } from '../../../test-utils/waitFor';

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

const settle = () => deliberateSleep(50, 'a negative check: nothing more arrives');
const detachesSent = (browser: FakeBrowser) => browser.received.filter((c) => c.method === 'Target.detachFromTarget' && c.id >= MUX_ID_BASE);

afterEach(() => resetCdpPipeCounters());

describe('CdpPipeMux URL boundary (C2d)', () => {
  it('a user-opened chrome://new-tab-page is invisible to an outside client and cannot be attached; main still sees it', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    browser.targets.push({ targetId: 'NTP', title: '', url: 'chrome://new-tab-page/' });
    browser.announce({ targetId: 'NTP', type: 'page', browserContextId: 'DEFAULT', url: 'chrome://new-tab-page/' });
    await settle();
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
    await settle();
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

  it('a page let go for its URL is attached again once it is back on an allowed one', async () => {
    const { browser, mux } = setup();
    // Chrome tells an explicit flat attach on the session it came on, too.
    browser.announceAttach = true;
    await discovering(browser);
    const c = await playwrightLike(mux);
    browser.announce({ targetId: 'U', type: 'page', browserContextId: 'DEFAULT', url: 'chrome://new-tab-page/' });
    await settle();
    expect(c.told()).not.toContain('U');
    navigated(browser, 'U', 'https://typed.test/');
    await vi.waitFor(() => expect(c.sessionFor('U')).toBeDefined(), { timeout: 5_000 });
    mux.close();
  });

  it('a page whose URL the mux has not been told is refused; a popup with no URL yet counts as blank', async () => {
    const { browser, mux } = setup();
    await discovering(browser);
    const c = await playwrightLike(mux);
    const unknown = await c.replyTo(c.send('Target.attachToTarget', { targetId: 'NEVER-TOLD', flatten: true }));
    expect(unknown.error?.message).toBe('No target with given id found');
    browser.announce({ targetId: 'POP', type: 'page', browserContextId: 'DEFAULT', url: '' });
    await vi.waitFor(() => expect(c.sessionFor('POP')).toBeDefined(), { timeout: 5_000 });
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
    await settle();
    expect(c.told()).not.toContain('NOURL');
    const answer = await c.replyTo(c.send('Runtime.evaluate', { expression: '1' }, 'S-NOURL'));
    expect(answer.error).toBeDefined();
    mux.close();
  });
});
