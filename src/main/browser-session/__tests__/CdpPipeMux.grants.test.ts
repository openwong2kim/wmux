// The pipe with grants (C3b): each external client sees and addresses only its
// own targets, on every session it holds; main's own clients see everything.
// Every grant here sits beside the denial it must not turn into, and every
// denial checks where the let-go was sent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpPipeMux, GRANT_HOLD_MAX_FRAMES, MUX_ID_BASE, cdpPipeCounters, resetCdpPipeCounters, type CallerIdentity } from '../CdpPipeMux';
import { FakeBrowser } from './fakePipeBrowser';
import { deliberateSleep } from '../../../test-utils/waitFor';

type Inbox = Array<Record<string, unknown>>;

function setup(records: Map<string, { workspaceId?: string }> = new Map(), holdMs?: number) {
  const browser = new FakeBrowser();
  browser.announceBeforeReply = true;
  const mux = new CdpPipeMux(browser.fromMux, browser.toMux, {
    grants: { registry: (id) => records.get(id) ?? null, ...(holdMs !== undefined && { holdMs }) },
  });
  return { browser, mux, records };
}

function client(mux: CdpPipeMux, label: string, identity: CallerIdentity) {
  const inbox: Inbox = [];
  let gone: string | null = null;
  const c = mux.attachExternal(label, (text) => inbox.push(JSON.parse(text) as Record<string, unknown>), (r) => { gone = r; }, { identity });
  let nextId = 0;
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    const id = ++nextId;
    c.receive(JSON.stringify({ id, method, params, ...(sessionId !== undefined && { sessionId }) }));
    return id;
  };
  const replyTo = async (id: number) => {
    await vi.waitFor(() => expect(inbox.some((m) => m.id === id)).toBe(true), { timeout: 5_000 });
    return inbox.find((m) => m.id === id) as { id: number; result?: Record<string, unknown>; error?: { code: number; message: string }; sessionId?: string };
  };
  const attached = () => inbox.filter((m) => m.method === 'Target.attachedToTarget').map((m) => (m.params as { targetInfo: { targetId: string } }).targetInfo.targetId);
  const autoAttach = async (waitForDebuggerOnStart = true) =>
    replyTo(send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart, flatten: true }));
  return { c, inbox, send, replyTo, attached, autoAttach, gone: () => gone };
}

/** Commands the mux itself sent (its own ids), by method. */
const muxSent = (browser: FakeBrowser, method: string) => browser.received.filter((c) => c.method === method && c.id >= MUX_ID_BASE);

/** The session a client's browser session is, as the browser named it (B<n>), found by the auto-attach command it sent. */
const browserSessionOf = (browser: FakeBrowser, nth: number) => browser.received.filter((c) => c.method === 'Target.setAutoAttach')[nth]?.sessionId as string;

/** A negative check: nothing more arrives in this long. */
const settle = () => deliberateSleep(50, 'a negative check: nothing more arrives');

afterEach(() => resetCdpPipeCounters());

describe('CdpPipeMux grants: main\'s registry', () => {
  it('each client is auto-attached to its workspace\'s pages only; the other\'s is let go on the session it came on', async () => {
    const { browser, mux, records } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const b = client(mux, 'b', { workspaceId: 'ws-b' });
    await a.autoAttach(false);
    await b.autoAttach(false);
    const sa = browserSessionOf(browser, 0);
    const sb = browserSessionOf(browser, 1);
    const main = mux.connect({ label: 'main' });
    // Main's pages, filed under each workspace before Chrome announces them.
    const ta = 'TA';
    const t2 = 'TB';
    records.set(ta, { workspaceId: 'ws-a' });
    records.set(t2, { workspaceId: 'ws-b' });
    for (const [id, url] of [[ta, 'http://a/'], [t2, 'http://b/']]) {
      browser.targets.push({ targetId: id, title: '', url });
      browser.announce({ targetId: id, type: 'page', browserContextId: 'DEFAULT' });
    }
    await vi.waitFor(() => expect(b.attached()).toEqual([t2]), { timeout: 5_000 });
    await vi.waitFor(() => expect(a.attached()).toEqual([ta]), { timeout: 5_000 });
    // A's let-go of B's page, and B's of A's, each on the session it came on.
    await vi.waitFor(() => expect(muxSent(browser, 'Target.detachFromTarget').map((c) => c.sessionId).sort()).toEqual([sa, sb].sort()), { timeout: 5_000 });
    // A command naming the other's target is "not there" and never reaches the browser.
    const before = browser.received.length;
    expect((await a.replyTo(a.send('Target.attachToTarget', { targetId: t2, flatten: true }))).error).toEqual({ code: -32602, message: 'No target with given id found' });
    expect(browser.received.length).toBe(before);
    // Target lists: each its own; main all.
    const listed = async (x: typeof a) => ((await x.replyTo(x.send('Target.getTargets'))).result?.targetInfos as Array<{ targetId: string }>).map((t) => t.targetId);
    expect(await listed(a)).toEqual([ta]);
    expect(await listed(b)).toEqual([t2]);
    const all = ((await main.send('Target.getTargets')) as { targetInfos: Array<{ targetId: string }> }).targetInfos.map((t) => t.targetId);
    expect(all).toEqual(expect.arrayContaining([ta, t2]));
    mux.close();
  });

  it('an operator sees every target; a caller with no workspace sees only what it made', async () => {
    const { browser, mux, records } = setup();
    const op = client(mux, 'op', { everyTarget: true });
    const none = client(mux, 'none', {});
    await op.autoAttach(false);
    await none.autoAttach(false);
    records.set('TX', { workspaceId: 'ws-a' });
    browser.targets.push({ targetId: 'TX', title: '', url: 'http://a/' });
    browser.announce({ targetId: 'TX', type: 'page', browserContextId: 'DEFAULT' });
    await vi.waitFor(() => expect(op.attached()).toEqual(['TX']), { timeout: 5_000 });
    const mine = (await none.replyTo(none.send('Target.createTarget', { url: 'about:blank' }))).result?.targetId as string;
    expect(none.attached()).toEqual([mine]);
    expect(op.attached()).toEqual(['TX', mine]);
    mux.close();
  });

  it('a record under another workspace denies even a page the client created', async () => {
    const { browser, mux, records } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    await a.autoAttach(false);
    // Main files the next page under ws-b before Chrome announces it.
    const next = `T${(browser as unknown as { n: number }).n + 1}`;
    records.set(next, { workspaceId: 'ws-b' });
    const made = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank' }))).result?.targetId as string;
    expect(made).toBe(next);
    expect(a.attached()).toEqual([]);
    expect((await a.replyTo(a.send('Target.activateTarget', { targetId: made }))).error?.code).toBe(-32602);
    mux.close();
  });
});

describe('CdpPipeMux grants: a client\'s own pages (Chrome announces them before the reply)', () => {
  it('a createTarget\'s page reaches its creator before the reply, and no one else', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const b = client(mux, 'b', { workspaceId: 'ws-b' });
    await a.autoAttach();
    await b.autoAttach();
    const id = a.send('Target.createTarget', { url: 'about:blank' });
    const reply = await a.replyTo(id);
    const made = reply.result?.targetId as string;
    const at = a.inbox.findIndex((m) => m.method === 'Target.attachedToTarget' && (m.params as { targetInfo: { targetId: string } }).targetInfo.targetId === made);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(a.inbox.indexOf(reply));
    await settle();
    expect(b.attached()).toEqual([]);
    expect(muxSent(browser, 'Target.detachFromTarget').map((c) => c.sessionId)).toEqual([browserSessionOf(browser, 1)]);
    expect(cdpPipeCounters().absorbed?.['grant-hold']).toBe(1);
    mux.close();
  });

  it('20 concurrent creates across two clients, in the default context and in their own: each gets its own pages only, each before its reply', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const b = client(mux, 'b', { workspaceId: 'ws-b' });
    await a.autoAttach();
    await b.autoAttach();
    const ctxA = (await a.replyTo(a.send('Target.createBrowserContext'))).result?.browserContextId as string;
    const ctxB = (await b.replyTo(b.send('Target.createBrowserContext'))).result?.browserContextId as string;
    const ids: Array<{ who: typeof a; id: number }> = [];
    for (let i = 0; i < 20; i++) {
      for (const [who, ctx] of [[a, ctxA], [b, ctxB]] as const) {
        ids.push({ who, id: who.send('Target.createTarget', { url: 'about:blank', ...(i % 2 === 1 && { browserContextId: ctx }) }) });
      }
    }
    const made = new Map<typeof a, string[]>([[a, []], [b, []]]);
    for (const { who, id } of ids) {
      const reply = await who.replyTo(id);
      const t = reply.result?.targetId as string;
      made.get(who)?.push(t);
      const at = who.inbox.findIndex((m) => m.method === 'Target.attachedToTarget' && (m.params as { targetInfo: { targetId: string } }).targetInfo.targetId === t);
      expect(at, t).toBeGreaterThanOrEqual(0);
      expect(at, t).toBeLessThan(who.inbox.indexOf(reply));
    }
    await settle();
    expect(a.attached().sort()).toEqual([...(made.get(a) ?? [])].sort());
    expect(b.attached().sort()).toEqual([...(made.get(b) ?? [])].sort());
    // Every let-go went to the other client's browser session, 40 in all.
    const detaches = muxSent(browser, 'Target.detachFromTarget').map((c) => c.sessionId);
    expect(detaches).toHaveLength(40);
    expect(new Set(detaches)).toEqual(new Set([browserSessionOf(browser, 0), browserSessionOf(browser, 1)]));
    mux.close();
  });

  it('a page in a browser context the client created is its own at once, with no hold; another client cannot name that context', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const b = client(mux, 'b', { workspaceId: 'ws-b' });
    await a.autoAttach();
    const ctx = (await a.replyTo(a.send('Target.createBrowserContext'))).result?.browserContextId as string;
    await a.replyTo(a.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx }));
    expect(cdpPipeCounters().absorbed?.['grant-hold']).toBeUndefined();
    const before = browser.received.length;
    expect((await b.replyTo(b.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx }))).error)
      .toEqual({ code: -32000, message: `Failed to find browser context with id ${ctx}` });
    expect((await b.replyTo(b.send('Target.disposeBrowserContext', { browserContextId: ctx }))).error)
      .toEqual({ code: -32000, message: `Failed to find context with id ${ctx}` });
    expect((await b.replyTo(b.send('Browser.setDownloadBehavior', { behavior: 'allow', browserContextId: ctx }))).error)
      .toEqual({ code: -32602, message: `Failed to find browser context for id ${ctx}` });
    expect((await b.replyTo(b.send('Browser.cancelDownload', { guid: 'g', browserContextId: ctx }))).error)
      .toEqual({ code: -32602, message: `Failed to find browser context for id ${ctx}` });
    expect(browser.received.slice(before).filter((c) => c.id < MUX_ID_BASE)).toEqual([]);
    // Context lists: each its own.
    expect((await a.replyTo(a.send('Target.getBrowserContexts'))).result?.browserContextIds).toEqual([ctx]);
    expect((await b.replyTo(b.send('Target.getBrowserContexts'))).result?.browserContextIds).toEqual([]);
    mux.close();
  });

  it('a popup goes to the client that holds its opener, at once, and to no one else', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const b = client(mux, 'b', { workspaceId: 'ws-b' });
    await a.autoAttach();
    await b.autoAttach();
    const page = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank' }))).result?.targetId as string;
    // B is creating a page of its own meanwhile: A's popup is still decided at once.
    browser.holdReplies.add('Target.createTarget');
    b.send('Target.createTarget', { url: 'about:blank' });
    await settle();
    const pop = browser.popup(page);
    await vi.waitFor(() => expect(a.attached()).toContain(pop), { timeout: 5_000 });
    browser.releaseHeld();
    await settle();
    expect(b.attached()).not.toContain(pop);
    // Its opener closes: the popup stays A's.
    browser.event(browserSessionOf(browser, 0), 'Target.targetDestroyed', { targetId: page });
    expect((await a.replyTo(a.send('Target.activateTarget', { targetId: pop }))).result).toEqual({ success: true });
    expect((await b.replyTo(b.send('Target.activateTarget', { targetId: pop }))).error?.code).toBe(-32602);
    mux.close();
  });

  it('a hold whose reply never comes ends at its timeout: the unnamed page is let go, everything after it delivered in order', async () => {
    const { browser, mux } = setup(new Map(), 200);
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    await a.autoAttach();
    browser.createWithoutReply = true;
    a.send('Target.createTarget', { url: 'about:blank' });
    await vi.waitFor(() => expect(cdpPipeCounters().absorbed?.['grant-hold']).toBe(1), { timeout: 5_000 });
    const later = a.send('Browser.getVersion');
    await settle();
    expect(a.inbox.some((m) => m.id === later)).toBe(false);
    await vi.waitFor(() => expect(a.inbox.some((m) => m.id === later)).toBe(true), { timeout: 5_000 });
    expect(a.attached()).toEqual([]);
    expect(muxSent(browser, 'Target.detachFromTarget').map((c) => c.sessionId)).toEqual([browserSessionOf(browser, 0)]);
    mux.close();
  });

  it(`a client that piles up more than ${GRANT_HOLD_MAX_FRAMES} frames behind a hold is dropped`, async () => {
    const { browser, mux } = setup(new Map(), 60_000);
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    await a.autoAttach();
    browser.createWithoutReply = true;
    a.send('Target.createTarget', { url: 'about:blank' });
    await vi.waitFor(() => expect(cdpPipeCounters().absorbed?.['grant-hold']).toBe(1), { timeout: 5_000 });
    const session = browserSessionOf(browser, 0);
    for (let i = 0; i <= GRANT_HOLD_MAX_FRAMES; i++) browser.event(session, 'Test.noise', { i });
    await vi.waitFor(() => expect(a.gone()).toBe('too many frames held for a new page'), { timeout: 5_000 });
    expect(cdpPipeCounters().dropped?.['grant-hold-overflow']).toBe(1);
    mux.close();
  });
});

describe('CdpPipeMux grants: discovery and the shared browser', () => {
  it('discovery events are filtered on a page session too', async () => {
    const { browser, mux, records } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const mine = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank' }))).result?.targetId as string;
    const page = (await a.replyTo(a.send('Target.attachToTarget', { targetId: mine, flatten: true }))).result?.sessionId as string;
    await a.replyTo(a.send('Target.setDiscoverTargets', { discover: true }, page));
    records.set('TB', { workspaceId: 'ws-b' });
    browser.targets.push({ targetId: 'TB', title: '', url: 'http://b/' });
    browser.announce({ targetId: 'TB', type: 'page', browserContextId: 'DEFAULT' });
    browser.event(page, 'Target.targetInfoChanged', { targetInfo: { targetId: mine, type: 'page', browserContextId: 'DEFAULT' } });
    await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Target.targetInfoChanged')).toBe(true), { timeout: 5_000 });
    expect(a.inbox.filter((m) => m.method === 'Target.targetCreated' && m.sessionId === page)).toEqual([]);
    expect(cdpPipeCounters().dropped?.['ungranted-target']).toBeGreaterThanOrEqual(1);
    mux.close();
  });

  it('Fetch and Tracing are refused on a browser session, not on a page session', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    for (const method of ['Fetch.enable', 'Tracing.start']) {
      expect((await a.replyTo(a.send(method))).error).toEqual({ code: -32000, message: `${method} is not available to this client` });
    }
    const second = (await a.replyTo(a.send('Target.attachToBrowserTarget'))).result?.sessionId as string;
    expect((await a.replyTo(a.send('Fetch.enable', {}, second))).error?.code).toBe(-32000);
    const mine = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank' }))).result?.targetId as string;
    const page = (await a.replyTo(a.send('Target.attachToTarget', { targetId: mine, flatten: true }))).result?.sessionId as string;
    expect((await a.replyTo(a.send('Fetch.enable', {}, page))).result).toEqual({ echo: 'Fetch.enable' });
    expect(browser.received.filter((c) => c.method === 'Fetch.enable' || c.method === 'Tracing.start').map((c) => c.sessionId)).toEqual([page]);
    expect(cdpPipeCounters().refusals?.['browser-wide']).toBe(3);
    mux.close();
  });

  it('the shared default context: downloads absorbed, permissions and storage refused; a context the client made passes', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    expect((await a.replyTo(a.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: '/x', eventsEnabled: true }))).result).toEqual({});
    for (const method of ['Browser.grantPermissions', 'Browser.resetPermissions', 'Browser.setPermission', 'Storage.getCookies', 'Storage.clearCookies']) {
      expect((await a.replyTo(a.send(method, { permissions: [] }))).error?.message, method).toContain('shared default browser context');
    }
    const ctx = (await a.replyTo(a.send('Target.createBrowserContext'))).result?.browserContextId as string;
    for (const method of ['Browser.setDownloadBehavior', 'Browser.grantPermissions', 'Storage.getCookies']) {
      expect((await a.replyTo(a.send(method, { behavior: 'deny', permissions: [], browserContextId: ctx }))).result, method).toEqual({ echo: method });
    }
    const forwarded = browser.received.filter((c) => c.id < MUX_ID_BASE && (c.method.startsWith('Browser.') || c.method.startsWith('Storage.')));
    expect(forwarded.every((c) => c.params.browserContextId === ctx)).toBe(true);
    expect(forwarded).toHaveLength(3);
    mux.close();
  });

  it('main\'s own clients are never narrowed', async () => {
    const { browser, mux, records } = setup();
    const main = mux.connect({ label: 'main' });
    await main.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const seen: string[] = [];
    main.on('Target.attachedToTarget', (p) => { seen.push((p as { targetInfo: { targetId: string } }).targetInfo.targetId); });
    records.set('TZ', { workspaceId: 'ws-z' });
    browser.targets.push({ targetId: 'TZ', title: '', url: 'http://z/' });
    browser.announce({ targetId: 'TZ', type: 'page', browserContextId: 'DEFAULT' });
    await vi.waitFor(() => expect(seen).toContain('TZ'), { timeout: 5_000 });
    expect(await main.send('Fetch.enable')).toEqual({ echo: 'Fetch.enable' });
    mux.close();
  });
});

describe('CdpPipeMux grants: a grant that comes late, and one that goes', () => {
  it('a page main files under the client\'s workspace after Chrome announced it is attached for the client then; one refiled elsewhere is detached', async () => {
    const { browser, mux, records } = setup();
    browser.announceAttach = true;
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    await a.autoAttach(false);
    const sa = browserSessionOf(browser, 0);
    browser.targets.push({ targetId: 'TL', title: '', url: 'http://a/' });
    browser.announce({ targetId: 'TL', type: 'page', browserContextId: 'DEFAULT' });
    await vi.waitFor(() => expect(muxSent(browser, 'Target.detachFromTarget').map((c) => c.sessionId)).toEqual([sa]), { timeout: 5_000 });
    expect(a.attached()).toEqual([]);
    // Main links the record now.
    records.set('TL', { workspaceId: 'ws-a' });
    mux.regrant();
    await vi.waitFor(() => expect(a.attached()).toEqual(['TL']), { timeout: 5_000 });
    const late = muxSent(browser, 'Target.attachToTarget');
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ sessionId: sa, params: { targetId: 'TL', flatten: true } });
    // Asked again with nothing new: no second attach.
    mux.regrant();
    await settle();
    expect(muxSent(browser, 'Target.attachToTarget')).toHaveLength(1);
    // Refiled under another workspace: its session is detached, on the session it came on.
    const session = (a.inbox.find((m) => m.method === 'Target.attachedToTarget')?.params as { sessionId: string }).sessionId;
    records.set('TL', { workspaceId: 'ws-b' });
    mux.regrant();
    await vi.waitFor(() => expect(muxSent(browser, 'Target.detachFromTarget').some((c) => c.params.sessionId === session && c.sessionId === sa)).toBe(true), { timeout: 5_000 });
    expect(cdpPipeCounters().dropped?.['revoked-target']).toBe(1);
    mux.close();
  });

  it('a page another client was let go of is never attached for it later', async () => {
    const { browser, mux, records } = setup();
    browser.announceAttach = true;
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const b = client(mux, 'b', { workspaceId: 'ws-b' });
    await a.autoAttach(false);
    await b.autoAttach(false);
    browser.targets.push({ targetId: 'TQ', title: '', url: 'http://a/' });
    browser.announce({ targetId: 'TQ', type: 'page', browserContextId: 'DEFAULT' });
    await vi.waitFor(() => expect(muxSent(browser, 'Target.detachFromTarget')).toHaveLength(2), { timeout: 5_000 });
    records.set('TQ', { workspaceId: 'ws-a' });
    mux.regrant();
    await vi.waitFor(() => expect(a.attached()).toEqual(['TQ']), { timeout: 5_000 });
    await settle();
    expect(b.attached()).toEqual([]);
    expect(muxSent(browser, 'Target.attachToTarget')).toHaveLength(1);
    mux.close();
  });
});

describe('CdpPipeMux grants: refusals on the session they came on', () => {
  it('a target refused on a browser session the client attached itself is answered on that session', async () => {
    const { mux, records } = setup();
    records.set('TB', { workspaceId: 'ws-b' });
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const second = (await a.replyTo(a.send('Target.attachToBrowserTarget'))).result?.sessionId as string;
    const reply = await a.replyTo(a.send('Target.attachToTarget', { targetId: 'TB', flatten: true }, second));
    expect(reply).toEqual({ id: reply.id, error: { code: -32602, message: 'No target with given id found' }, sessionId: second });
    const param = await a.replyTo(a.send('Target.detachFromTarget', { sessionId: 'not-mine' }, second));
    expect(param.sessionId).toBe(second);
    mux.close();
  });
});

describe('CdpPipeMux grants: no way around them', () => {
  it('a session on the browser target, however attached, is a browser session: Fetch refused, its auto-attach judged', async () => {
    const { browser, mux, records } = setup();
    browser.announceAttach = true;
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    await a.replyTo(a.send('Browser.getVersion'));
    // The client learns the browser target's id (here: Chrome names it in a targetInfo).
    browser.event(browserSessionOfFirstClient(browser), 'Target.targetInfoChanged', { targetInfo: { targetId: 'BROWSER', type: 'browser' } });
    await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Target.targetInfoChanged')).toBe(true), { timeout: 5_000 });
    const s = (await a.replyTo(a.send('Target.attachToTarget', { targetId: 'BROWSER', flatten: true }))).result?.sessionId as string;
    expect((await a.replyTo(a.send('Fetch.enable', {}, s))).error?.message).toBe('Fetch.enable is not available to this client');
    expect((await a.replyTo(a.send('Tracing.start', {}, s))).error?.code).toBe(-32000);
    await a.replyTo(a.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, s));
    records.set('TO', { workspaceId: 'ws-b' });
    browser.targets.push({ targetId: 'TO', title: '', url: 'http://b/' });
    browser.announce({ targetId: 'TO', type: 'page', browserContextId: 'DEFAULT' });
    await vi.waitFor(() => expect(muxSent(browser, 'Target.detachFromTarget').some((c) => c.sessionId === s)).toBe(true), { timeout: 5_000 });
    expect(a.attached()).not.toContain('TO');
    mux.close();
  });

  it("on a page session, a service worker's attach is judged and let go; the page's own iframe goes with the page", async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const mine = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank' }))).result?.targetId as string;
    const page = (await a.replyTo(a.send('Target.attachToTarget', { targetId: mine, flatten: true }))).result?.sessionId as string;
    browser.sessions.add('SW1');
    browser.event(page, 'Target.attachedToTarget', { sessionId: 'SW1', targetInfo: { targetId: 'SW', type: 'service_worker' }, waitingForDebugger: false });
    await vi.waitFor(() => expect(muxSent(browser, 'Target.detachFromTarget').some((c) => c.sessionId === page && c.params.sessionId === 'SW1')).toBe(true), { timeout: 5_000 });
    expect((await a.replyTo(a.send('Runtime.evaluate', { expression: 'sw' }, 'SW1'))).error?.code).toBe(-32001);
    browser.sessions.add('IF1');
    browser.event(page, 'Target.attachedToTarget', { sessionId: 'IF1', targetInfo: { targetId: 'IFR', type: 'iframe' }, waitingForDebugger: false });
    await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Target.attachedToTarget' && m.sessionId === page)).toBe(true), { timeout: 5_000 });
    expect((await a.replyTo(a.send('Runtime.evaluate', { expression: 'f' }, 'IF1'))).result).toBeDefined();
    mux.close();
  });

  it('a grant that goes ends the session at once, whatever session it was attached on, and the sessions under it', async () => {
    const { browser, mux, records } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const mine = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank' }))).result?.targetId as string;
    const page = (await a.replyTo(a.send('Target.attachToTarget', { targetId: mine, flatten: true }))).result?.sessionId as string;
    records.set('TR', { workspaceId: 'ws-a' });
    browser.event(page, 'Target.targetInfoChanged', { targetInfo: { targetId: 'TR', type: 'page' } });
    const other = (await a.replyTo(a.send('Target.attachToTarget', { targetId: 'TR', flatten: true }, page))).result?.sessionId as string;
    const child = 'IF2';
    browser.sessions.add(child);
    browser.event(other, 'Target.attachedToTarget', { sessionId: child, targetInfo: { targetId: 'IFR2', type: 'iframe' }, waitingForDebugger: false });
    await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Target.attachedToTarget' && m.sessionId === other)).toBe(true), { timeout: 5_000 });
    // Refiled under another workspace.
    records.set('TR', { workspaceId: 'ws-b' });
    mux.regrant();
    const before = browser.received.length;
    expect((await a.replyTo(a.send('Runtime.evaluate', { expression: 'x' }, other))).error?.code).toBe(-32001);
    expect((await a.replyTo(a.send('Runtime.evaluate', { expression: 'y' }, child))).error?.code).toBe(-32001);
    expect(browser.received.slice(before).filter((c) => c.method === 'Runtime.evaluate')).toEqual([]);
    expect(muxSent(browser, 'Target.detachFromTarget').some((c) => c.sessionId === page && c.params.sessionId === other)).toBe(true);
    // The client's own page is untouched.
    expect((await a.replyTo(a.send('Runtime.evaluate', { expression: 'z' }, page))).result).toBeDefined();
    mux.close();
  });

  it("context-wide cookie and cache commands are refused on a page session of the default context, allowed in the client's own", async () => {
    const { mux } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const shared = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank' }))).result?.targetId as string;
    const p1 = (await a.replyTo(a.send('Target.attachToTarget', { targetId: shared, flatten: true }))).result?.sessionId as string;
    for (const method of ['Network.clearBrowserCookies', 'Network.clearBrowserCache', 'Storage.clearDataForOrigin']) {
      expect((await a.replyTo(a.send(method, {}, p1))).error?.message, method).toContain('shared default browser context');
    }
    const ctx = (await a.replyTo(a.send('Target.createBrowserContext'))).result?.browserContextId as string;
    const own = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx }))).result?.targetId as string;
    const p2 = (await a.replyTo(a.send('Target.attachToTarget', { targetId: own, flatten: true }))).result?.sessionId as string;
    expect((await a.replyTo(a.send('Network.clearBrowserCookies', {}, p2))).result).toEqual({ echo: 'Network.clearBrowserCookies' });
    mux.close();
  });

  it('a window is only addressable once the client asked which window holds its own page', async () => {
    const { mux } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    expect((await a.replyTo(a.send('Browser.setWindowBounds', { windowId: 7, bounds: { windowState: 'minimized' } }))).error)
      .toEqual({ code: -32000, message: 'Browser window not found' });
    const mine = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank' }))).result?.targetId as string;
    expect((await a.replyTo(a.send('Browser.getWindowForTarget', { targetId: mine }))).result?.windowId).toBe(7);
    expect((await a.replyTo(a.send('Browser.setWindowBounds', { windowId: 7, bounds: { windowState: 'normal' } }))).result).toEqual({ echo: 'Browser.setWindowBounds' });
    expect((await a.replyTo(a.send('Browser.getWindowBounds', { windowId: 8 }))).error?.message).toBe('Browser window not found');
    mux.close();
  });

  it("what the mux answers itself during a hold waits its turn; a large reply does not count toward the hold's cap", async () => {
    const browser = new FakeBrowser();
    browser.announceBeforeReply = true;
    browser.createWithoutReply = true;
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux, { grants: { registry: () => null, holdMs: 60_000, holdMaxChars: 1_000 } });
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    await a.autoAttach();
    const create = a.send('Target.createTarget', { url: 'about:blank' });
    await vi.waitFor(() => expect(cdpPipeCounters().absorbed?.['grant-hold']).toBe(1), { timeout: 5_000 });
    const absorbed = a.send('Browser.setDownloadBehavior', { behavior: 'allow' });
    const big = a.send('Runtime.evaluate', { expression: 'x'.repeat(5_000) });
    await settle();
    expect(a.inbox.some((m) => m.id === absorbed || m.id === big)).toBe(false);
    expect(a.gone()).toBeNull();
    // Chrome answers the create now.
    const cmd = browser.received.find((c) => c.method === 'Target.createTarget');
    const made = browser.targets[browser.targets.length - 1].targetId;
    browser.reply(cmd as never, `"result":{"targetId":"${made}"}`);
    const reply = await a.replyTo(create);
    const at = (pred: (m: Record<string, unknown>) => boolean) => a.inbox.findIndex(pred);
    const attachedAt = at((m) => m.method === 'Target.attachedToTarget');
    expect(attachedAt).toBeGreaterThanOrEqual(0);
    expect(attachedAt).toBeLessThan(at((m) => m.id === absorbed));
    expect(a.inbox.indexOf(reply)).toBeGreaterThan(attachedAt);
    expect(await a.replyTo(big)).toMatchObject({ result: { result: { value: 'x'.repeat(5_000) } } });
    expect(a.gone()).toBeNull();
    mux.close();
  });
});

/** The first client's browser session, by the first command a client sent on one. */
function browserSessionOfFirstClient(browser: FakeBrowser): string {
  return browser.received.find((c) => c.id < MUX_ID_BASE && typeof c.sessionId === 'string' && c.sessionId.startsWith('B'))?.sessionId as string;
}

describe('CdpPipeMux grants: the shared jar, windows, and a revoked session', () => {
  it('Storage on a default-context page reaches only its own frames and their origins; in its own context, everything', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const mine = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank' }))).result?.targetId as string;
    const page = (await a.replyTo(a.send('Target.attachToTarget', { targetId: mine, flatten: true }))).result?.sessionId as string;
    const on = async (method: string, params: Record<string, unknown> = {}, session = page) => {
      const reply = await a.replyTo(a.send(method, params, session));
      return reply.error ? 'refused' : 'sent';
    };
    // No origin learned yet: nothing origin-scoped passes.
    expect(await on('Storage.trackIndexedDBForOrigin', { origin: 'https://a.example' })).toBe('refused');
    browser.event(page, 'Page.frameNavigated', { frame: { id: mine, url: 'https://a.example/', securityOrigin: 'https://a.example' } });
    browser.event(page, 'Page.frameNavigated', { frame: { id: 'child', parentId: mine, url: 'https://b.example/x', securityOrigin: 'https://b.example' } });
    expect(await on('Storage.trackIndexedDBForOrigin', { origin: 'https://a.example' })).toBe('sent');
    expect(await on('Storage.trackCacheStorageForOrigin', { origin: 'https://b.example' })).toBe('sent');
    expect(await on('Storage.untrackIndexedDBForStorageKey', { storageKey: 'https://a.example/' })).toBe('sent');
    expect(await on('Storage.getStorageKeyForFrame', { frameId: mine })).toBe('sent');
    expect(await on('Storage.getStorageKeyForFrame', { frameId: 'child' })).toBe('sent');
    expect(await on('Storage.getStorageKey')).toBe('sent');
    // A second session to the same page (no Page events of its own) knows the page's origins too.
    const second = (await a.replyTo(a.send('Target.attachToTarget', { targetId: mine, flatten: true }))).result?.sessionId as string;
    expect(second).not.toBe(page);
    expect(await on('Storage.trackIndexedDBForOrigin', { origin: 'https://b.example' }, second)).toBe('sent');
    // Another origin, a partitioned key, another page's frame, and the rest of the domain.
    expect(await on('Storage.trackIndexedDBForOrigin', { origin: 'https://bank.example' })).toBe('refused');
    expect(await on('Storage.trackIndexedDBForStorageKey', { storageKey: 'https://a.example/^0https://c.example' })).toBe('refused');
    expect(await on('Storage.getStorageKeyForFrame', { frameId: 'elsewhere' })).toBe('refused');
    expect(await on('Storage.getStorageKey', { frameId: 'elsewhere' })).toBe('refused');
    for (const [method, params] of [
      ['Storage.clearSharedStorageEntries', { ownerOrigin: 'https://a.example' }],
      ['Storage.deleteSharedStorageEntry', { ownerOrigin: 'https://a.example', key: 'k' }],
      ['Storage.getSharedStorageEntries', { ownerOrigin: 'https://bank.example' }],
      ['Storage.clearTrustTokens', { issuerOrigin: 'https://bank.example' }],
      ['Storage.deleteStorageBucket', { bucket: { storageKey: 'https://bank.example/', name: 'b' } }],
      ['Storage.getInterestGroupDetails', { ownerOrigin: 'https://bank.example', name: 'g' }],
      ['Storage.getUsageAndQuota', { origin: 'https://a.example' }],
    ] as const) expect(await on(method, params)).toBe('refused');
    // A detached frame's origin goes with it; a main-frame navigation starts over.
    browser.event(page, 'Page.frameDetached', { frameId: 'child' });
    expect(await on('Storage.trackCacheStorageForOrigin', { origin: 'https://b.example' })).toBe('refused');
    browser.event(page, 'Page.frameNavigated', { frame: { id: mine, url: 'https://c.example/', securityOrigin: 'https://c.example' } });
    expect(await on('Storage.trackIndexedDBForOrigin', { origin: 'https://a.example' })).toBe('refused');
    expect(await on('Storage.trackIndexedDBForOrigin', { origin: 'https://c.example' })).toBe('sent');
    // Page events off on the one session that heard them: its origins go with them.
    expect(await on('Page.disable')).toBe('sent');
    expect(await on('Storage.trackIndexedDBForOrigin', { origin: 'https://c.example' })).toBe('refused');
    expect(await on('Storage.trackIndexedDBForOrigin', { origin: 'https://c.example' }, second)).toBe('refused');
    // In a context the client made, the storage is its own.
    const ctx = (await a.replyTo(a.send('Target.createBrowserContext'))).result?.browserContextId as string;
    const own = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx }))).result?.targetId as string;
    const p2 = (await a.replyTo(a.send('Target.attachToTarget', { targetId: own, flatten: true }))).result?.sessionId as string;
    expect(await on('Storage.clearSharedStorageEntries', { ownerOrigin: 'https://bank.example' }, p2)).toBe('sent');
    expect(browser.received.filter((c) => c.method === 'Storage.clearSharedStorageEntries').map((c) => c.sessionId)).toEqual([p2]);
    mux.close();
  });

  it('no bulk cookie read on the shared default context: getAllCookies, Storage.getCookies and getCookies with urls refused, the page\'s own cookies kept', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    const mine = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank' }))).result?.targetId as string;
    const page = (await a.replyTo(a.send('Target.attachToTarget', { targetId: mine, flatten: true }))).result?.sessionId as string;
    expect((await a.replyTo(a.send('Network.getAllCookies', {}, page))).error?.message).toContain('shared default browser context');
    expect((await a.replyTo(a.send('Network.getCookies', { urls: ['https://bank.example/'] }, page))).error?.message).toContain('shared default browser context');
    expect((await a.replyTo(a.send('Network.getAllCookies'))).error?.code).toBe(-32000);
    expect((await a.replyTo(a.send('Storage.getCookies', {}, page))).error?.message).toContain('shared default browser context');
    expect((await a.replyTo(a.send('Network.getCookies', {}, page))).result).toEqual({ echo: 'Network.getCookies' });
    expect((await a.replyTo(a.send('Network.setCookie', { name: 'n', value: 'v', url: 'https://a.example/' }, page))).result).toEqual({ echo: 'Network.setCookie' });
    // In a context the client made, the jar is its own.
    const ctx = (await a.replyTo(a.send('Target.createBrowserContext'))).result?.browserContextId as string;
    const own = (await a.replyTo(a.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx }))).result?.targetId as string;
    const p2 = (await a.replyTo(a.send('Target.attachToTarget', { targetId: own, flatten: true }))).result?.sessionId as string;
    expect((await a.replyTo(a.send('Network.getAllCookies', {}, p2))).result).toEqual({ echo: 'Network.getAllCookies' });
    expect((await a.replyTo(a.send('Storage.getCookies', {}, p2))).result).toEqual({ echo: 'Storage.getCookies' });
    expect(browser.received.filter((c) => c.method === 'Storage.getCookies').map((c) => c.sessionId)).toEqual([p2]);
    expect(browser.received.filter((c) => c.method === 'Network.getAllCookies').map((c) => c.sessionId)).toEqual([p2]);
    mux.close();
  });

  it('a window is learned only from a page the client holds, and forgotten when that page\'s grant goes', async () => {
    const { mux, records } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    // On its browser session, with no target: teaches nothing.
    expect((await a.replyTo(a.send('Browser.getWindowForTarget'))).result?.windowId).toBe(7);
    expect((await a.replyTo(a.send('Browser.setWindowBounds', { windowId: 7, bounds: {} }))).error?.message).toBe('Browser window not found');
    // On a page session the client holds: teaches that window.
    records.set('TW', { workspaceId: 'ws-a' });
    const page = (await a.replyTo(a.send('Target.attachToTarget', { targetId: 'TW', flatten: true }))).result?.sessionId as string;
    await a.replyTo(a.send('Browser.getWindowForTarget', {}, page));
    expect((await a.replyTo(a.send('Browser.setWindowBounds', { windowId: 7, bounds: {} }))).result).toEqual({ echo: 'Browser.setWindowBounds' });
    // The page's grant goes: so does the window.
    records.set('TW', { workspaceId: 'ws-b' });
    mux.regrant();
    expect((await a.replyTo(a.send('Browser.setWindowBounds', { windowId: 7, bounds: {} }))).error?.message).toBe('Browser window not found');
    mux.close();
  });

  it('a revoked session hears nothing more before Chrome ends it; its end is still told on the session above it', async () => {
    const { browser, mux, records } = setup();
    const a = client(mux, 'a', { workspaceId: 'ws-a' });
    records.set('TV', { workspaceId: 'ws-a' });
    await a.replyTo(a.send('Browser.getVersion'));
    const page = (await a.replyTo(a.send('Target.attachToTarget', { targetId: 'TV', flatten: true }))).result?.sessionId as string;
    browser.event(page, 'Runtime.consoleAPICalled', { n: 1 });
    await vi.waitFor(() => expect(a.inbox.filter((m) => m.method === 'Runtime.consoleAPICalled')).toHaveLength(1), { timeout: 5_000 });
    records.set('TV', { workspaceId: 'ws-b' });
    mux.regrant();
    browser.event(page, 'Runtime.consoleAPICalled', { n: 2 });
    browser.event(browserSessionOfFirstClient(browser), 'Target.detachedFromTarget', { sessionId: page, targetId: 'TV' });
    await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Target.detachedFromTarget')).toBe(true), { timeout: 5_000 });
    expect(a.inbox.filter((m) => m.method === 'Runtime.consoleAPICalled')).toHaveLength(1);
    expect(cdpPipeCounters().dropped?.['revoked-session']).toBe(1);
    mux.close();
  });
});
