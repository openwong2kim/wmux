// The pipe with grants (C3b): each external client sees and addresses only its
// own targets, on every session it holds; main's own clients see everything.
// Every grant here sits beside the denial it must not turn into, and every
// denial checks where the let-go was sent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpPipeMux, GRANT_HOLD_MAX_FRAMES, MUX_ID_BASE, cdpPipeCounters, resetCdpPipeCounters, type CallerIdentity } from '../CdpPipeMux';
import { FakeBrowser } from './fakePipeBrowser';

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

const settle = () => new Promise((r) => setTimeout(r, 50));

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
    const op = client(mux, 'op', { operator: true });
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
    expect(cdpPipeCounters().absorbed['grant-hold']).toBe(1);
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
    expect(cdpPipeCounters().absorbed['grant-hold']).toBeUndefined();
    const before = browser.received.length;
    expect((await b.replyTo(b.send('Target.createTarget', { url: 'about:blank', browserContextId: ctx }))).error)
      .toEqual({ code: -32000, message: `Failed to find browser context with id ${ctx}` });
    expect((await b.replyTo(b.send('Target.disposeBrowserContext', { browserContextId: ctx }))).error)
      .toEqual({ code: -32000, message: `Failed to find context with id ${ctx}` });
    expect((await b.replyTo(b.send('Browser.setDownloadBehavior', { behavior: 'allow', browserContextId: ctx }))).error)
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
    await vi.waitFor(() => expect(cdpPipeCounters().absorbed['grant-hold']).toBe(1), { timeout: 5_000 });
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
    await vi.waitFor(() => expect(cdpPipeCounters().absorbed['grant-hold']).toBe(1), { timeout: 5_000 });
    const session = browserSessionOf(browser, 0);
    for (let i = 0; i <= GRANT_HOLD_MAX_FRAMES; i++) browser.event(session, 'Test.noise', { i });
    await vi.waitFor(() => expect(a.gone()).toBe('too many frames held for a new page'), { timeout: 5_000 });
    expect(cdpPipeCounters().dropped['grant-hold-overflow']).toBe(1);
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
    expect(cdpPipeCounters().dropped['ungranted-target']).toBeGreaterThanOrEqual(1);
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
    expect(cdpPipeCounters().refusals['browser-wide']).toBe(3);
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
    expect(cdpPipeCounters().dropped['revoked-target']).toBe(1);
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
