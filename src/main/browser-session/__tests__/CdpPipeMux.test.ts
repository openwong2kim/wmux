// One debugging pipe shared by main and external clients: every frame goes to
// the one owner of its session or command id, or nowhere. A client addresses
// only its own sessions, whatever shape a forged id takes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpPipeMux, MUX_ID_BASE, cdpPipeCounters, resetCdpPipeCounters, type ClientRef } from '../CdpPipeMux';
import { FakeBrowser } from './fakePipeBrowser';

function setup(opts: ConstructorParameters<typeof CdpPipeMux>[2] = {}) {
  const browser = new FakeBrowser();
  const mux = new CdpPipeMux(browser.fromMux, browser.toMux, opts);
  return { browser, mux };
}

/** An external client and everything it receives, parsed. */
function external(mux: CdpPipeMux, label = 'ext') {
  const inbox: Array<Record<string, unknown>> = [];
  const raw: string[] = [];
  let gone: string | null = null;
  const client = mux.attachExternal(label, (text) => { raw.push(text); inbox.push(JSON.parse(text) as Record<string, unknown>); }, (r) => { gone = r; });
  let nextId = 0;
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    const id = ++nextId;
    client.receive(JSON.stringify({ id, method, params, ...(sessionId !== undefined && { sessionId }) }));
    return id;
  };
  const replyTo = async (id: number) => {
    await vi.waitFor(() => expect(inbox.some((m) => m.id === id)).toBe(true), { timeout: 5_000 });
    return inbox.find((m) => m.id === id) as { id: number; result?: Record<string, unknown>; error?: { code: number; message: string }; sessionId?: string };
  };
  return { client, inbox, raw, send, replyTo, gone: () => gone };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => resetCdpPipeCounters());

describe('CdpPipeMux: routing', () => {
  it('opens a browser session per client, remaps ids both ways, and hides the browser session from the client', async () => {
    const { browser, mux } = setup();
    const a = external(mux, 'a');
    const id = a.send('Browser.getVersion');
    const reply = await a.replyTo(id);
    expect(reply).toEqual({ id, result: { echo: 'Browser.getVersion' } });
    // The browser saw the mux's own attach first, then the command on that session under a mux id.
    expect(browser.received[0]).toMatchObject({ method: 'Target.attachToBrowserTarget' });
    expect(browser.received[0].id).toBeGreaterThanOrEqual(MUX_ID_BASE);
    expect(browser.received[1]).toMatchObject({ method: 'Browser.getVersion', sessionId: 'B1' });
    // The reply was spliced, not re-serialized: same bytes after the id.
    expect(a.raw[0]).toBe(`{"id":${id},"result":{"echo":"Browser.getVersion"}}`);
    mux.close();
  });

  it('re-serializes a reply whose id is not first, and keeps a child session id on child traffic', async () => {
    const { mux } = setup();
    const a = external(mux, 'a');
    const odd = a.send('Test.idLast');
    expect(await a.replyTo(odd)).toEqual({ id: odd, result: { ok: true } });
    const child = (await a.replyTo(a.send('Target.attachToTarget', { targetId: 'T0', flatten: true }))).result?.sessionId as string;
    const evalId = a.send('Runtime.evaluate', { expression: '1+1' }, child);
    expect(await a.replyTo(evalId)).toEqual({ id: evalId, result: { result: { type: 'string', value: '1+1' } }, sessionId: child });
    mux.close();
  });

  it('gives auto-attached sessions to the client that asked for them, and only to it', async () => {
    const { mux } = setup();
    const a = external(mux, 'a');
    const b = external(mux, 'b');
    await a.replyTo(a.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }));
    await b.replyTo(b.send('Browser.getVersion'));
    await b.replyTo(b.send('Target.createTarget', { url: 'about:blank' }));
    await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Target.attachedToTarget')).toBe(true), { timeout: 5_000 });
    const attached = a.inbox.find((m) => m.method === 'Target.attachedToTarget') as { params: { sessionId: string }; sessionId?: string };
    // On a's browser session, so a sees it as a root event.
    expect(attached.sessionId).toBeUndefined();
    expect(b.inbox.some((m) => m.method === 'Target.attachedToTarget')).toBe(false);
    // a may drive the child; b may not.
    expect((await a.replyTo(a.send('Runtime.evaluate', { expression: 'x' }, attached.params.sessionId))).result).toBeDefined();
    expect((await b.replyTo(b.send('Runtime.evaluate', { expression: 'x' }, attached.params.sessionId))).error?.code).toBe(-32001);
    mux.close();
  });

  it('serves main through a CdpConnection with its own browser session and events', async () => {
    const { browser, mux } = setup();
    const conn = mux.connect({ label: 'watcher' });
    const seen: Array<[string, string | undefined]> = [];
    conn.on('Target.attachedToTarget', (params, sessionId) => seen.push([String(params.sessionId), sessionId]));
    await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    expect(conn.isOpen()).toBe(true);
    const b = external(mux, 'b');
    await b.replyTo(b.send('Target.createTarget', { url: 'about:blank' }));
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5_000 });
    // The event came on main's browser session: handed over as the browser session (undefined).
    expect(seen[0][1]).toBeUndefined();
    const child = seen[0][0];
    await expect(conn.send('Runtime.evaluate', { expression: '2' }, child)).resolves.toEqual({ result: { type: 'string', value: '2' } });
    // Main's sessions are refused to external clients.
    expect((await b.replyTo(b.send('Runtime.evaluate', { expression: 'x' }, child))).error?.code).toBe(-32001);
    expect(browser.received.filter((c) => c.sessionId === child)).toHaveLength(1);
    mux.close();
  });

  it('closing main\'s connection detaches its browser session; a later send opens a new one and its handlers still apply', async () => {
    const { browser, mux } = setup();
    const onDisconnect = vi.fn();
    const conn = mux.connect({ label: 'guard', onDisconnect });
    const events: string[] = [];
    conn.on('Page.downloadWillBegin', () => events.push('event'));
    await conn.send('Browser.getVersion');
    conn.close();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(conn.isOpen()).toBe(false);
    await vi.waitFor(() => expect(browser.received.some((c) => c.method === 'Target.detachFromTarget' && c.params.sessionId === 'B1')).toBe(true), { timeout: 5_000 });
    await conn.send('Browser.getVersion');
    const sessions = browser.received.filter((c) => c.method === 'Browser.getVersion').map((c) => c.sessionId);
    expect(sessions).toEqual(['B1', 'B2']);
    browser.event('B2', 'Page.downloadWillBegin', {});
    await vi.waitFor(() => expect(events).toEqual(['event']), { timeout: 5_000 });
    // The old session is nobody's now.
    browser.event('B1', 'Page.downloadWillBegin', {});
    await tick();
    expect(events).toEqual(['event']);
    mux.close();
  });

  it('a connection closed before it ever opened rejects what is in flight and reports no disconnect', async () => {
    const { mux } = setup();
    const onDisconnect = vi.fn();
    const conn = mux.connect({ label: 'probe', onDisconnect });
    conn.close();
    expect(onDisconnect).not.toHaveBeenCalled();
    mux.close();
  });

  it('frames split across chunks, several per chunk, and UTF-8 split mid-character all arrive whole', async () => {
    const { browser, mux } = setup();
    const a = external(mux, 'a');
    await a.replyTo(a.send('Target.setAutoAttach', { autoAttach: true, flatten: true }));
    const frames = ['한글 😀 one', 'two', 'x'.repeat(70_000)].map((value) =>
      Buffer.from(`{"method":"Runtime.consoleAPICalled","params":{"args":[{"value":${JSON.stringify(value)}}]},"sessionId":"B1"}\0`));
    const all = Buffer.concat(frames);
    // Cut inside the first frame's multibyte characters and across frame boundaries.
    for (const [from, to] of [[0, 33], [33, 34], [34, frames[0].length + 3], [frames[0].length + 3, all.length]]) browser.toMux.write(all.subarray(from, to));
    await vi.waitFor(() => expect(a.inbox.filter((m) => m.method === 'Runtime.consoleAPICalled')).toHaveLength(3), { timeout: 5_000 });
    const values = a.inbox.filter((m) => m.method === 'Runtime.consoleAPICalled').map((m) => (m.params as { args: Array<{ value: string }> }).args[0].value);
    expect(values).toEqual(['한글 😀 one', 'two', 'x'.repeat(70_000)]);
    mux.close();
  });

  it('when the pipe ends every client is told, main\'s sends reject, and the mux is closed', async () => {
    const { browser, mux } = setup();
    const onClose = vi.fn();
    const ended = new CdpPipeMux(browser.fromMux, browser.toMux, { onClose });
    const onDisconnect = vi.fn();
    const conn = ended.connect({ label: 'watcher', onDisconnect });
    await conn.send('Browser.getVersion');
    const a = external(ended, 'a');
    await a.replyTo(a.send('Browser.getVersion'));
    browser.toMux.end();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(a.gone()).toBe('connection closed');
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(ended.isOpen()).toBe(false);
    await expect(conn.send('Browser.getVersion')).rejects.toThrow('watcher: connection closed');
    mux.close();
  });

  it('a reply on the client\'s browser session with sessionId before the result still carries the client\'s own id', async () => {
    class SessionFirst extends FakeBrowser {
      protected override handle(c: Parameters<FakeBrowser['handle']>[0]): void {
        if (c.method === 'Test.sessionFirst') this.emit(`{"id":${c.id},"sessionId":${JSON.stringify(c.sessionId)},"result":{"ok":true}}`);
        else super.handle(c);
      }
    }
    const browser = new SessionFirst();
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux);
    const a = external(mux, 'a');
    // An id unlike the mux's own numbering, so a reply that kept the mux's would show.
    a.client.receive(JSON.stringify({ id: 77, method: 'Test.sessionFirst', params: {} }));
    expect(await a.replyTo(77)).toEqual({ id: 77, result: { ok: true } });
    mux.close();
  });

  it('a filter refuses or answers a command itself, before it reaches the browser, and counts each by reason', async () => {
    const { browser, mux } = setup({
      filter: (_client, command) => {
        if (command.method === 'Test.refuse') return { refuse: { code: -32000, message: 'refused' }, reason: 'test-refuse' };
        if (command.method === 'Test.answer') return { absorb: { answered: true }, reason: 'test-answer' };
        return null;
      },
    });
    const a = external(mux, 'a');
    expect((await a.replyTo(a.send('Test.refuse', { secret: 'p' }))).error).toEqual({ code: -32000, message: 'refused' });
    const answered = a.send('Test.answer');
    expect(await a.replyTo(answered)).toEqual({ id: answered, result: { answered: true } });
    // On a session the client holds, the answer comes back on that session.
    const page = (await a.replyTo(a.send('Target.attachToTarget', { targetId: 'T0', flatten: true }))).result?.sessionId as string;
    const onPage = a.send('Test.answer', {}, page);
    expect(await a.replyTo(onPage)).toEqual({ id: onPage, result: { answered: true }, sessionId: page });
    // On one it doesn't, the session check comes first.
    expect((await a.replyTo(a.send('Test.answer', {}, 'S-not-mine'))).error?.code).toBe(-32001);
    expect((await a.replyTo(a.send('Browser.getVersion'))).result).toEqual({ echo: 'Browser.getVersion' });
    expect(browser.received.map((c) => c.method)).not.toContain('Test.refuse');
    expect(browser.received.map((c) => c.method)).not.toContain('Test.answer');
    const counters = cdpPipeCounters();
    expect(counters.refusals).toEqual({ 'test-refuse': 1 });
    expect(counters.absorbed).toEqual({ 'test-answer': 2 });
    // Counted by reason only: no params.
    expect(JSON.stringify(counters)).not.toContain('secret');
    mux.close();
  });

  it('Browser.close and the crash commands from an external client are refused on every profile; main\'s own connection still sends them', async () => {
    const { browser, mux } = setup();
    const a = external(mux, 'a');
    for (const method of ['Browser.close', 'Browser.crash', 'Browser.crashGpuProcess']) {
      expect((await a.replyTo(a.send(method))).error).toEqual({ code: -32000, message: `${method} is not available to this client` });
    }
    expect(browser.received.some((c) => c.method.startsWith('Browser.c'))).toBe(false);
    expect(cdpPipeCounters().refusals).toEqual({ 'ends-shared-browser': 3 });
    expect(cdpPipeCounters().refused).toBe(3);
    const own = mux.connect({ label: 'main' });
    await expect(own.send('Browser.close')).resolves.toEqual({ echo: 'Browser.close' });
    mux.close();
  });

  it('a channel that carries protocol messages inside another command is refused from an external client; flat sessions work', async () => {
    const { browser, mux } = setup();
    const a = external(mux, 'a');
    const refused = [
      ['Target.sendMessageToTarget', { sessionId: 'S', message: '{"id":1,"method":"Browser.close"}' }],
      ['Target.exposeDevToolsProtocol', { targetId: 'T0' }],
      ['Target.attachToTarget', { targetId: 'T0' }],
      ['Target.attachToTarget', { targetId: 'T0', flatten: false }],
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false }],
      ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false }],
    ] as const;
    for (const [method, params] of refused) {
      const reply = await a.replyTo(a.send(method, params));
      expect(reply.error?.code, method).toBe(-32000);
      expect(reply.error?.message).toMatch(/is not available to this client$/);
    }
    expect(browser.received.some((c) => c.method === 'Target.sendMessageToTarget' || c.method === 'Target.exposeDevToolsProtocol')).toBe(false);
    expect(browser.received.filter((c) => c.method === 'Target.attachToTarget' || c.method === 'Target.setAutoAttach')).toEqual([]);
    expect(cdpPipeCounters().refusals).toEqual({ 'unsupported-channel': refused.length });
    // Flat, as Playwright sends them, and turning auto-attach off, go through.
    expect((await a.replyTo(a.send('Target.attachToTarget', { targetId: 'T0', flatten: true }))).result?.sessionId).toEqual(expect.any(String));
    expect((await a.replyTo(a.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }))).error).toBeUndefined();
    expect((await a.replyTo(a.send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false }))).error).toBeUndefined();
    // Main's own connection is not held to these rules.
    await expect(mux.connect({ label: 'main' }).send('Target.exposeDevToolsProtocol', { targetId: 'T0' })).resolves.toEqual({ echo: 'Target.exposeDevToolsProtocol' });
    mux.close();
  });

  it('knows the browser context of a page a client was attached to, as Chrome named it', async () => {
    const ref = new Map<string, ClientRef>();
    const { mux } = setup({ filter: (client) => { ref.set(client.label, client); return null; } });
    const a = external(mux, 'a');
    const b = external(mux, 'b');
    await a.replyTo(a.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }));
    const inA = (await a.replyTo(a.send('Target.createTarget', { url: 'http://a/', browserContextId: 'CTX-A' }))).result?.targetId as string;
    const inDefault = (await a.replyTo(a.send('Target.createTarget', { url: 'http://a/2' }))).result?.targetId as string;
    await vi.waitFor(() => expect(a.inbox.filter((m) => m.method === 'Target.attachedToTarget')).toHaveLength(2), { timeout: 5_000 });
    await b.replyTo(b.send('Target.attachToTarget', { targetId: inA, flatten: true }));
    const [ca, cb] = [ref.get('a') as ClientRef, ref.get('b') as ClientRef];
    expect(mux.contextOfFrame(ca, inA)).toBe('CTX-A');
    expect(mux.contextOfFrame(ca, inDefault)).toBe('DEFAULT');
    // b holds the page, but no attach event named its context to b: held, unnamed.
    expect(mux.ownsTarget(cb, inA)).toBe(true);
    expect(mux.contextOfFrame(cb, inA)).toBeNull();
    a.client.close();
    expect(mux.contextOfFrame(ca, inA)).toBeUndefined();
    mux.close();
  });

  it('routes a frame in a page\'s process to the client whose own page session reported it, and stays bounded', async () => {
    const ref = new Map<string, ClientRef>();
    const { browser, mux } = setup({ filter: (client) => { ref.set(client.label, client); return null; } });
    const a = external(mux, 'a');
    const b = external(mux, 'b');
    await a.replyTo(a.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }));
    const page = (await a.replyTo(a.send('Target.createTarget', { url: 'http://a/', browserContextId: 'CTX-A' }))).result?.targetId as string;
    await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Target.attachedToTarget')).toBe(true), { timeout: 5_000 });
    const session = (a.inbox.find((m) => m.method === 'Target.attachedToTarget')?.params as { sessionId: string }).sessionId;
    // b holds the same page on a session of its own, with no Page events on.
    await b.replyTo(b.send('Target.attachToTarget', { targetId: page, flatten: true }));
    const [ca, cb] = [ref.get('a') as ClientRef, ref.get('b') as ClientRef];
    const frames = () => (ca as unknown as { frames: Map<string, Map<string, string>> }).frames;
    const relay = async (method: string, params: Record<string, unknown>) => {
      const seen = a.inbox.length;
      browser.event(session, method, params);
      await vi.waitFor(() => expect(a.inbox.length).toBeGreaterThan(seen), { timeout: 5_000 });
    };

    await relay('Page.frameAttached', { frameId: 'F1', parentFrameId: page });
    await relay('Page.frameAttached', { frameId: 'F2', parentFrameId: 'F1' });
    expect(mux.contextOfFrame(ca, 'F1')).toBe('CTX-A');
    expect(mux.contextOfFrame(ca, 'F2')).toBe('CTX-A');
    // Only frames reported on a client's own session route to it: b holds the
    // page but has no Page events on, so a download in F1 reaches it as before (not at all).
    expect(mux.contextOfFrame(cb, page)).toBeNull();
    expect(mux.contextOfFrame(cb, 'F1')).toBeUndefined();

    // A long-lived page adding and removing frames: detaching one takes its descendants.
    for (let n = 0; n < 50; n++) {
      await relay('Page.frameAttached', { frameId: `L${n}`, parentFrameId: page });
      await relay('Page.frameAttached', { frameId: `L${n}-child`, parentFrameId: `L${n}` });
      await relay('Page.frameDetached', { frameId: `L${n}`, reason: 'remove' });
    }
    expect(frames().get(session)?.size).toBe(2);
    await relay('Page.frameDetached', { frameId: 'F1', reason: 'remove' });
    expect(frames().size).toBe(0);
    expect(mux.contextOfFrame(ca, 'F2')).toBeUndefined();

    // A main-frame navigation starts the page over; a child's navigation is a frame of the page.
    await relay('Page.frameNavigated', { frame: { id: 'N1', parentId: page }, type: 'Navigation' });
    expect(mux.contextOfFrame(ca, 'N1')).toBe('CTX-A');
    await relay('Page.frameNavigated', { frame: { id: page }, type: 'Navigation' });
    expect(frames().size).toBe(0);

    // The session ending takes its frames.
    await relay('Page.frameAttached', { frameId: 'F3', parentFrameId: page });
    expect(frames().size).toBe(1);
    const aBrowserSession = browser.received.find((c) => c.method === 'Target.setAutoAttach')?.sessionId as string;
    browser.event(aBrowserSession, 'Target.detachedFromTarget', { sessionId: session });
    await vi.waitFor(() => expect(frames().size).toBe(0), { timeout: 5_000 });
    mux.close();
  });

  it('commands that add to what the browser offers are refused from an external client on every profile', async () => {
    const { browser, mux } = setup();
    const a = external(mux, 'a');
    const refused = ['Tethering.bind', 'Tethering.unbind', 'Extensions.loadUnpacked', 'Extensions.getExtensions', 'Extensions.setStorageItems',
      'PWA.install', 'PWA.launch', 'PWA.launchFilesInApp', 'Target.openDevTools', 'Target.setRemoteLocations'];
    for (const method of refused) {
      expect((await a.replyTo(a.send(method, {}))).error, method).toEqual({ code: -32000, message: `${method} is not available to this client` });
    }
    expect(browser.received.filter((c) => refused.includes(c.method))).toEqual([]);
    expect(cdpPipeCounters().refusals).toEqual({ 'browser-surface': refused.length });
    // Reading an app's state is not one of them.
    expect((await a.replyTo(a.send('PWA.getOsAppState', { manifestId: 'm' }))).result).toEqual({ echo: 'PWA.getOsAppState' });
    mux.close();
  });

  it('tells its owner when a client leaves, once', async () => {
    const gone: string[] = [];
    const { mux } = setup({ onClientGone: (client) => gone.push(client.label) });
    const a = external(mux, 'a');
    await a.replyTo(a.send('Browser.getVersion'));
    a.client.close();
    a.client.close();
    expect(gone).toEqual(['a']);
    mux.close();
  });

  it('a reply hook holds the client\'s reply until it settles, and turns a failure into an error reply', async () => {
    let release: (error: { code: number; message: string } | null) => void = () => undefined;
    const seen: Array<{ method: string; result: Record<string, unknown> }> = [];
    const { mux } = setup({
      beforeReply: (_client, method, result) => {
        if (method === 'Test.throws') throw new Error('hook failed');
        if (method !== 'Test.held') return null;
        seen.push({ method, result });
        return new Promise((resolve) => { release = resolve; });
      },
    });
    const a = external(mux, 'a');
    const held = a.send('Test.held');
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 5_000 });
    expect(seen[0]).toEqual({ method: 'Test.held', result: { echo: 'Test.held' } });
    // Other traffic is not held behind it.
    expect((await a.replyTo(a.send('Browser.getVersion'))).result).toEqual({ echo: 'Browser.getVersion' });
    expect(a.inbox.some((m) => m.id === held)).toBe(false);
    release(null);
    expect(await a.replyTo(held)).toEqual({ id: held, result: { echo: 'Test.held' } });

    const failed = a.send('Test.held');
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 5_000 });
    release({ code: -32000, message: 'not ready' });
    expect((await a.replyTo(failed)).error).toEqual({ code: -32000, message: 'not ready' });
    // A hook that throws answers the same way, and the frames after it still route.
    expect((await a.replyTo(a.send('Test.throws'))).error).toEqual({ code: -32000, message: 'hook failed' });
    expect((await a.replyTo(a.send('Browser.getVersion'))).result).toEqual({ echo: 'Browser.getVersion' });
    // On a session the client holds, the error comes back on that session.
    const page = (await a.replyTo(a.send('Target.attachToTarget', { targetId: 'T0', flatten: true }))).result?.sessionId as string;
    const onPage = a.send('Test.held', {}, page);
    await vi.waitFor(() => expect(seen).toHaveLength(3), { timeout: 5_000 });
    release({ code: -32000, message: 'not ready' });
    expect(await a.replyTo(onPage)).toEqual({ id: onPage, error: { code: -32000, message: 'not ready' }, sessionId: page });
    expect(cdpPipeCounters().refusals).toEqual({ 'Test.held-after': 2, 'Test.throws-after': 1 });
    expect(cdpPipeCounters().refused).toBe(3);
    mux.close();
  });

  it('knows which pages a client holds, and sends a browser-level event to that client only', async () => {
    // The filter sees each client's ref with its first command.
    const ref = new Map<string, ClientRef>();
    const { mux } = setup({ filter: (client) => { ref.set(client.label, client); return null; } });
    const a = external(mux, 'a');
    const b = external(mux, 'b');
    const ta = (await a.replyTo(a.send('Target.createTarget', { url: 'http://a/' }))).result?.targetId as string;
    const tb = (await b.replyTo(b.send('Target.createTarget', { url: 'http://b/' }))).result?.targetId as string;
    await a.replyTo(a.send('Target.attachToTarget', { targetId: ta, flatten: true }));
    await b.replyTo(b.send('Target.attachToTarget', { targetId: ta, flatten: true }));
    const [ca, cb] = [ref.get('a') as ClientRef, ref.get('b') as ClientRef];
    expect(mux.ownsTarget(ca, ta)).toBe(true);
    expect(mux.ownsTarget(ca, tb)).toBe(false);
    expect(mux.ownsTarget(cb, ta)).toBe(true);
    expect(mux.ownsTarget(cb, tb)).toBe(false);

    expect(mux.emitEvent(ca, 'Browser.downloadWillBegin', { guid: 'g' })).toBe(true);
    await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Browser.downloadWillBegin')).toBe(true), { timeout: 5_000 });
    expect(b.inbox.some((m) => m.method === 'Browser.downloadWillBegin')).toBe(false);
    // On a session it holds, and not on one it doesn't.
    const held = (b.inbox.find((m) => (m.result as { sessionId?: string } | undefined)?.sessionId) as { result: { sessionId: string } }).result.sessionId;
    expect(mux.emitEvent(cb, 'Browser.downloadProgress', { guid: 'g' }, held)).toBe(true);
    expect(mux.emitEvent(ca, 'Browser.downloadProgress', { guid: 'g' }, held)).toBe(false);
    await vi.waitFor(() => expect(b.inbox.find((m) => m.method === 'Browser.downloadProgress')?.sessionId).toBe(held), { timeout: 5_000 });
    expect(a.inbox.some((m) => m.method === 'Browser.downloadProgress')).toBe(false);
    a.client.close();
    expect(mux.ownsTarget(ca, ta)).toBe(false);
    expect(mux.emitEvent(ca, 'Browser.downloadWillBegin', { guid: 'g' })).toBe(false);
    mux.close();
  });
});

describe('CdpPipeMux: a target grant (C3 and C2b)', () => {
  it('a target not granted to a client is not there for it: commands, events, auto-attach and the target list', async () => {
    // Granted by what each client opened: the url names its label.
    const browser = new FakeBrowser();
    const ownTarget = (label: string, targetId: string) => browser.targets.find((t) => t.targetId === targetId)?.url.includes(`//${label}/`) ?? false;
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux, { targetGrant: (client, targetId) => ownTarget(client.label, targetId) });
    const a = external(mux, 'a');
    const b = external(mux, 'b');
    for (const c of [a, b]) await c.replyTo(c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }));
    const ta = (await a.replyTo(a.send('Target.createTarget', { url: 'http://a/' }))).result?.targetId as string;
    const tb = (await b.replyTo(b.send('Target.createTarget', { url: 'http://b/' }))).result?.targetId as string;

    // Each is auto-attached to its own target only; the other's attach is let go on the session it came on.
    await vi.waitFor(() => expect(browser.received.filter((c) => c.method === 'Target.detachFromTarget' && c.id >= MUX_ID_BASE)).toHaveLength(2), { timeout: 5_000 });
    const attachedTo = (c: typeof a) => c.inbox.filter((m) => m.method === 'Target.attachedToTarget').map((m) => (m.params as { targetInfo: { targetId: string } }).targetInfo.targetId);
    expect(attachedTo(a)).toEqual([ta]);
    expect(attachedTo(b)).toEqual([tb]);
    for (const detach of browser.received.filter((c) => c.method === 'Target.detachFromTarget')) {
      expect(browser.sessions.has(detach.params.sessionId as string)).toBe(false);
      expect(['B1', 'B2']).toContain(detach.sessionId);
    }

    // The target list shows each its own.
    const listed = async (c: typeof a) => ((await c.replyTo(c.send('Target.getTargets'))).result?.targetInfos as Array<{ targetId: string }>).map((t) => t.targetId);
    expect(await listed(a)).toEqual([ta]);
    expect(await listed(b)).toEqual([tb]);

    // A command naming the other's target gets the browser's unknown-target answer and never reaches it.
    const before = browser.received.length;
    for (const method of ['Target.attachToTarget', 'Target.closeTarget', 'Target.activateTarget']) {
      expect((await a.replyTo(a.send(method, { targetId: tb, flatten: true }))).error).toEqual({ code: -32602, message: 'No target with given id found' });
    }
    expect(browser.received.length).toBe(before);
    expect((await a.replyTo(a.send('Target.activateTarget', { targetId: ta }))).result).toEqual({ success: true });

    // The other's target events never reach it.
    browser.event('B1', 'Target.targetInfoChanged', { targetInfo: { targetId: tb, type: 'page', url: 'http://b/2' } });
    browser.event('B1', 'Target.targetInfoChanged', { targetInfo: { targetId: ta, type: 'page', url: 'http://a/2' } });
    await vi.waitFor(() => expect(a.inbox.filter((m) => m.method === 'Target.targetInfoChanged')).toHaveLength(1), { timeout: 5_000 });
    expect((a.inbox.find((m) => m.method === 'Target.targetInfoChanged')?.params as { targetInfo: { targetId: string } }).targetInfo.targetId).toBe(ta);
    expect(cdpPipeCounters().dropped['ungranted-target']).toBe(3);
    mux.close();
  });

  it('a browser session the client attached itself is held to the grant too', async () => {
    const browser = new FakeBrowser();
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux, { targetGrant: () => false });
    const a = external(mux, 'a');
    await a.replyTo(a.send('Browser.getVersion'));
    const second = (await a.replyTo(a.send('Target.attachToBrowserTarget'))).result?.sessionId as string;
    expect(second).toMatch(/^B/);
    await a.replyTo(a.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, second));
    const main = mux.connect({ label: 'main' });
    await main.send('Target.createTarget', { url: 'about:blank' });
    // The auto-attach on the client's own browser session is let go on that session, not handed over.
    await vi.waitFor(() => expect(browser.received.some((c) => c.method === 'Target.detachFromTarget' && c.sessionId === second && c.id >= MUX_ID_BASE)).toBe(true), { timeout: 5_000 });
    browser.event(second, 'Target.targetCreated', { targetInfo: { targetId: 'T9', type: 'page' } });
    await vi.waitFor(() => expect(cdpPipeCounters().dropped['ungranted-target']).toBe(2), { timeout: 5_000 });
    expect(a.inbox.some((m) => m.method === 'Target.attachedToTarget' || m.method === 'Target.targetCreated')).toBe(false);
    mux.close();
  });

  it('a page\'s own frames and workers go with the page, and a session the client owns is told it ended after its grant went', async () => {
    const granted = new Set<string>();
    const browser = new FakeBrowser();
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux, { targetGrant: (_client, targetId) => granted.has(targetId) });
    const a = external(mux, 'a');
    await a.replyTo(a.send('Browser.getVersion'));
    granted.add('T0');
    const page = (await a.replyTo(a.send('Target.attachToTarget', { targetId: 'T0', flatten: true }))).result?.sessionId as string;
    // An iframe auto-attached on the page's session: its target was never granted on its own.
    browser.sessions.add('IFRAME');
    browser.event(page, 'Target.attachedToTarget', { sessionId: 'IFRAME', targetInfo: { targetId: 'F1', type: 'iframe' }, waitingForDebugger: false });
    await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Target.attachedToTarget' && m.sessionId === page)).toBe(true), { timeout: 5_000 });
    expect((await a.replyTo(a.send('Runtime.evaluate', { expression: 'f' }, 'IFRAME'))).result).toBeDefined();
    // The grant goes; the page closes: the client still hears its session end, and no longer owns it.
    granted.delete('T0');
    browser.event('B1', 'Target.detachedFromTarget', { sessionId: page, targetId: 'T0' });
    await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Target.detachedFromTarget')).toBe(true), { timeout: 5_000 });
    expect((await a.replyTo(a.send('Runtime.evaluate', { expression: 'x' }, page))).error?.code).toBe(-32001);
    mux.close();
  });
});

describe('CdpPipeMux: forged sessions are refused in every shape', () => {
  async function twoClientsAndMain() {
    const { browser, mux } = setup();
    const a = external(mux, 'a');
    const b = external(mux, 'b');
    const main = mux.connect({ label: 'main' });
    await main.send('Browser.getVersion');
    const mainChild = ((await main.send('Target.attachToTarget', { targetId: 'T0', flatten: true })) as { sessionId: string }).sessionId;
    const aChild = (await a.replyTo(a.send('Target.attachToTarget', { targetId: 'T0', flatten: true }))).result?.sessionId as string;
    await b.replyTo(b.send('Browser.getVersion'));
    return { browser, mux, a, b, main, mainChild, aChild };
  }

  it('top-level sessionIds that are not the sender\'s get the browser\'s unknown-session answer and never reach it', async () => {
    const { browser, mux, b, mainChild, aChild } = await twoClientsAndMain();
    const aBrowserSession = browser.received.find((c) => c.method === 'Target.attachToTarget' && c.sessionId !== undefined && c.sessionId !== 'B1')?.sessionId;
    const forged: unknown[] = [aChild, mainChild, 'B1', aBrowserSession, '', '__proto__', 'constructor', 'x'.repeat(100_000)];
    const before = browser.received.length;
    for (const sessionId of forged) {
      const reply = await b.replyTo(b.send('Runtime.evaluate', { expression: 'steal' }, sessionId as string));
      expect(reply.error, JSON.stringify(sessionId).slice(0, 40)).toEqual({ code: -32001, message: 'Session with given id not found.' });
    }
    // Non-string shapes, written raw.
    let id = 1000;
    for (const shape of ['123', 'null', '{}', '[]', 'true']) {
      b.client.receive(`{"id":${++id},"method":"Runtime.evaluate","params":{},"sessionId":${shape}}`);
      expect((await b.replyTo(id)).error?.code, shape).toBe(-32001);
    }
    expect(browser.received.slice(before).some((c) => c.method === 'Runtime.evaluate')).toBe(false);
    expect(cdpPipeCounters().refused).toBe(forged.length + 5);
    mux.close();
  });

  it('a duplicate sessionId key is read as JSON.parse reads it, and only that one is written out', async () => {
    const { browser, mux, a, aChild, mainChild } = await twoClientsAndMain();
    // Theirs last: JSON.parse keeps the last, which is not a's: refused.
    a.client.receive(`{"id":500,"method":"Runtime.evaluate","params":{"expression":"1"},"sessionId":"${aChild}","sessionId":"${mainChild}"}`);
    expect((await a.replyTo(500)).error?.code).toBe(-32001);
    // Theirs first: the parse keeps a's own; the browser sees only a's.
    a.client.receive(`{"id":501,"method":"Runtime.evaluate","params":{"expression":"1"},"sessionId":"${mainChild}","sessionId":"${aChild}"}`);
    expect((await a.replyTo(501)).result).toBeDefined();
    const written = browser.rawReceived.filter((t) => t.includes('"Runtime.evaluate"'));
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain(mainChild);
    expect(Object.keys(JSON.parse(written[0]) as object).sort()).toEqual(['id', 'method', 'params', 'sessionId']);
    mux.close();
  });

  it('a session named in params is checked for the commands that act on one', async () => {
    const { browser, mux, a, b, aChild, mainChild } = await twoClientsAndMain();
    for (const named of [aChild, mainChild, 7]) {
      const reply = await b.replyTo(b.send('Target.detachFromTarget', { sessionId: named }));
      expect(reply.error, `${named}`).toEqual({ code: -32602, message: 'No session with given id' });
    }
    // sendMessageToTarget is refused from an external client before any session is looked at.
    for (const named of [aChild, mainChild, 7]) {
      expect((await b.replyTo(b.send('Target.sendMessageToTarget', { sessionId: named, message: '{}' }))).error?.code).toBe(-32000);
    }
    expect(browser.received.some((c) => c.method === 'Target.sendMessageToTarget')).toBe(false);
    // Its own child: allowed.
    expect((await a.replyTo(a.send('Target.detachFromTarget', { sessionId: aChild }))).result).toEqual({});
    // A sessionId inside params of any other command is just a parameter: the command still goes out on the sender's own session.
    await b.replyTo(b.send('Runtime.evaluate', { expression: '1', sessionId: mainChild }));
    const sent = browser.received.filter((c) => c.method === 'Runtime.evaluate').at(-1);
    expect(sent?.sessionId).not.toBe(mainChild);
    mux.close();
  });

  it('malformed commands are refused without reaching the browser', async () => {
    const { browser, mux } = setup();
    const a = external(mux, 'a');
    const before = browser.received.length;
    a.client.receive('not json');
    a.client.receive('{"method":"Browser.getVersion"}');
    a.client.receive('{"id":-1,"method":"Browser.getVersion"}');
    a.client.receive('{"id":1.5,"method":"Browser.getVersion"}');
    a.client.receive('{"id":2,"method":7}');
    a.client.receive('{"id":3,"method":"Browser.getVersion","params":[1]}');
    await tick();
    expect(browser.received.length).toBe(before);
    expect(a.inbox.map((m) => m.id)).toEqual([2, 3]);
    mux.close();
  });
});

describe('CdpPipeMux: forged routing never reaches the wrong client', () => {
  it('ids and session ids inside values, console text, URLs, titles and bodies route nothing; foreign ids and unknown sessions are dropped', async () => {
    const { browser, mux } = setup();
    const a = external(mux, 'a');
    const b = external(mux, 'b');
    const main = mux.connect({ label: 'main' });
    const mainEvents: unknown[] = [];
    main.on('Runtime.consoleAPICalled', (p) => mainEvents.push(p));
    await main.send('Browser.getVersion'); // B1
    await a.replyTo(a.send('Browser.getVersion')); // B2
    const bAttach = await b.replyTo(b.send('Target.attachToTarget', { targetId: 'T0', flatten: true })); // B3, child C4
    const bChild = bAttach.result?.sessionId as string;
    const aBefore = a.inbox.length;
    const mainBefore = mainEvents.length;
    // b evaluates text that looks like frames for a, main and a's id.
    const bait = `{"id":1,"result":{}} {"method":"Runtime.consoleAPICalled","sessionId":"B2"} "sessionId":"B1" \u0000 {"id":${MUX_ID_BASE}}`;
    const evalReply = await b.replyTo(b.send('Runtime.evaluate', { expression: bait }, bChild));
    expect((evalReply.result as { result: { value: string } }).result.value).toBe(bait);
    // Events on b's child carrying bait in console text, a URL, a title and a body.
    browser.event(bChild, 'Runtime.consoleAPICalled', { args: [{ value: bait }] });
    browser.event(bChild, 'Page.frameNavigated', { frame: { url: `http://127.0.0.1/?sessionId=B2&id=1`, name: bait } });
    browser.event(bChild, 'Target.targetInfoChanged', { targetInfo: { title: bait, url: 'about:blank#"sessionId":"B1"' } });
    browser.event(bChild, 'Network.dataReceived', { body: bait });
    // Foreign and own-range reply ids, unknown and root sessions.
    browser.emit('{"id":424242,"result":{"x":1}}');
    browser.emit(`{"id":${MUX_ID_BASE + 999},"result":{}}`);
    browser.emit('{"method":"Runtime.consoleAPICalled","params":{},"sessionId":"NOPE"}');
    browser.emit('{"method":"Target.targetCreated","params":{"targetInfo":{"targetId":"T9"}}}');
    await vi.waitFor(() => expect(b.inbox.filter((m) => m.sessionId === bChild && m.method)).toHaveLength(4), { timeout: 5_000 });
    await tick();
    expect(a.inbox.length).toBe(aBefore);
    expect(mainEvents.length).toBe(mainBefore);
    expect(cdpPipeCounters().dropped).toEqual({ 'unknown-id': 1, 'unknown-own-id': 1, 'unknown-session': 1, 'root-event': 1 });
    mux.close();
  });

  it('replies to the mux\'s own commands never reach a client', async () => {
    const { browser, mux } = setup();
    const a = external(mux, 'a');
    await a.replyTo(a.send('Browser.getVersion'));
    a.client.close();
    await vi.waitFor(() => expect(browser.received.some((c) => c.method === 'Target.detachFromTarget')).toBe(true), { timeout: 5_000 });
    await tick();
    // The attach and the detach were the mux's: a saw only its own reply.
    expect(a.inbox).toHaveLength(1);
    expect(browser.received.filter((c) => c.id >= MUX_ID_BASE).map((c) => c.method)).toEqual(['Target.attachToBrowserTarget', 'Target.detachFromTarget']);
    mux.close();
  });

  it('a closed client gets nothing more: late replies and its sessions\' events are dropped', async () => {
    const { browser, mux } = setup();
    const a = external(mux, 'a');
    await a.replyTo(a.send('Target.setAutoAttach', { autoAttach: true, flatten: true }));
    const count = a.inbox.length;
    a.client.close();
    browser.event('B1', 'Target.attachedToTarget', { sessionId: 'C9' });
    await tick();
    expect(a.inbox.length).toBe(count);
    expect(a.gone()).toBe('closed');
    mux.close();
  });

  it('a session detached from a client is no longer its own', async () => {
    const { browser, mux } = setup();
    const a = external(mux, 'a');
    const child = (await a.replyTo(a.send('Target.attachToTarget', { targetId: 'T0', flatten: true }))).result?.sessionId as string;
    browser.event('B1', 'Target.detachedFromTarget', { sessionId: child });
    await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Target.detachedFromTarget')).toBe(true), { timeout: 5_000 });
    expect((await a.replyTo(a.send('Runtime.evaluate', { expression: '1' }, child))).error?.code).toBe(-32001);
    mux.close();
  });
});
