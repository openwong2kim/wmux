// One debugging pipe shared by main and external clients: every frame goes to
// the one owner of its session or command id, or nowhere. A client addresses
// only its own sessions, whatever shape a forged id takes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpPipeMux, MUX_ID_BASE, cdpPipeCounters, resetCdpPipeCounters } from '../CdpPipeMux';
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

  it('a filter (the place for method blocks) refuses a command before it reaches the browser', async () => {
    const { browser, mux } = setup({ filter: (_client, command) => (command.method === 'Browser.close' ? { code: -32000, message: 'refused' } : null) });
    const a = external(mux, 'a');
    expect((await a.replyTo(a.send('Browser.close'))).error).toEqual({ code: -32000, message: 'refused' });
    expect(browser.received.some((c) => c.method === 'Browser.close')).toBe(false);
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
    for (const method of ['Target.detachFromTarget', 'Target.sendMessageToTarget']) {
      for (const named of [aChild, mainChild, 7]) {
        const reply = await b.replyTo(b.send(method, { sessionId: named, message: '{}' }));
        expect(reply.error, `${method} ${named}`).toEqual({ code: -32602, message: 'No session with given id' });
      }
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
