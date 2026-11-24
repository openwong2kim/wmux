// Screencast frames, the bulk of the pipe's traffic, go to an outside client's
// page session as the bytes Chrome wrote, unparsed. Every other place such a
// frame can land still takes the parsed path and its rules.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpPipeMux, cdpPipeCounters, resetCdpPipeCounters, type CallerIdentity } from '../CdpPipeMux';
import { FakeBrowser } from './fakePipeBrowser';
import { deliberateSleep } from '../../../test-utils/waitFor';

function client(mux: CdpPipeMux, identity?: Omit<CallerIdentity, 'lane'>) {
  const inbox: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  const bytes: Buffer[] = [];
  const c = mux.attachExternal('a', (text) => {
    texts.push(text);
    inbox.push(JSON.parse(text) as Record<string, unknown>);
  }, () => undefined, { identity: identity && { lane: 'engine', ...identity }, sendBytes: (b) => bytes.push(b) });
  let nextId = 0;
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++nextId;
    c.receive(JSON.stringify({ id, method, params }));
    return id;
  };
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const id = send(method, params);
    await vi.waitFor(() => expect(inbox.some((m) => m.id === id)).toBe(true), { timeout: 5_000 });
    return inbox.find((m) => m.id === id) as { result?: Record<string, unknown> };
  };
  return { inbox, texts, bytes, send, call };
}

/** A screencast frame as Chrome writes it on `sessionId`: method first, sessionId last. */
const screencasts = (inbox: Array<Record<string, unknown>>) => inbox.filter((m) => m.method === 'Page.screencastFrame');

const screencastFrame = (sessionId: string) =>
  `{"method":"Page.screencastFrame","params":{"data":"${'QUJD'.repeat(64 * 1024)}","metadata":{"offsetTop":0,"timestamp":1.5},"sessionId":7},"sessionId":"${sessionId}"}`;

afterEach(() => {
  vi.restoreAllMocks();
  resetCdpPipeCounters();
});

describe('CdpPipeMux: screencast frames', () => {
  it('reach the client\'s page session as the bytes Chrome wrote, neither decoded nor parsed', async () => {
    const browser = new FakeBrowser();
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux);
    const a = client(mux);
    const page = (await a.call('Target.attachToTarget', { targetId: 'T0', flatten: true })).result?.sessionId as string;
    const frame = screencastFrame(page);
    const parse = vi.spyOn(JSON, 'parse');
    browser.emit(frame);
    await vi.waitFor(() => expect(a.bytes).toHaveLength(1), { timeout: 5_000 });
    expect(a.bytes[0].equals(Buffer.from(frame))).toBe(true);
    expect(parse.mock.calls.filter(([text]) => String(text).includes('Page.screencastFrame'))).toEqual([]);
    expect(a.texts.some((t) => t.includes('Page.screencastFrame'))).toBe(false);
    expect(cdpPipeCounters()).toMatchObject({ frames: expect.any(Number), largestFrameBytes: Buffer.byteLength(frame) });
    mux.close();
  });

  it('anywhere else take the parsed path: the client\'s root is rewritten, a session it does not hold is dropped, a revoked one hears nothing', async () => {
    const browser = new FakeBrowser();
    browser.announceBeforeReply = true;
    const records = new Map<string, { workspaceId?: string }>([['TV', { workspaceId: 'ws-a' }]]);
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux, { grants: { registry: (id) => records.get(id) ?? null } });
    const a = client(mux, { workspaceId: 'ws-a' });
    await a.call('Browser.getVersion');
    const root = browser.received.find((c) => c.method === 'Browser.getVersion')?.sessionId as string;
    const page = (await a.call('Target.attachToTarget', { targetId: 'TV', flatten: true })).result?.sessionId as string;

    // On the client's own browser session: it never sees that session's id.
    browser.emit(screencastFrame(root));
    await vi.waitFor(() => expect(screencasts(a.inbox)).toHaveLength(1), { timeout: 5_000 });
    expect(screencasts(a.inbox)[0].sessionId).toBeUndefined();

    // On a session no client holds: dropped and counted.
    browser.emit(screencastFrame('NOBODY'));
    await vi.waitFor(() => expect(cdpPipeCounters().dropped['unknown-session']).toBe(1), { timeout: 5_000 });

    // On a page session whose grant went: dropped, until Chrome ends it.
    records.set('TV', { workspaceId: 'ws-b' });
    mux.regrant();
    browser.emit(screencastFrame(page));
    await vi.waitFor(() => expect(cdpPipeCounters().dropped['revoked-session']).toBe(1), { timeout: 5_000 });

    expect(a.bytes).toEqual([]);
    expect(screencasts(a.inbox)).toHaveLength(1);
    mux.close();
  });

  it('cut from a larger read, are copied out of it, so a waiting frame holds only its own bytes', async () => {
    const browser = new FakeBrowser();
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux);
    const a = client(mux);
    const page = (await a.call('Target.attachToTarget', { targetId: 'T0', flatten: true })).result?.sessionId as string;
    const small = `{"method":"Page.screencastFrame","params":{"data":"QUJD","metadata":{"offsetTop":0,"timestamp":1.5},"sessionId":7},"sessionId":"${page}"}`;
    // One read from the pipe: the small frame, then a large one for nobody.
    const large = `{"method":"Runtime.consoleAPICalled","params":{"text":"${'x'.repeat(1024 * 1024)}"},"sessionId":"NOBODY"}`;
    browser.toMux.write(Buffer.from(`${small}\0${large}\0`));
    await vi.waitFor(() => expect(a.bytes).toHaveLength(1), { timeout: 5_000 });
    expect(a.bytes[0].equals(Buffer.from(small))).toBe(true);
    expect(a.bytes[0].buffer.byteLength).toBeLessThanOrEqual(2 * a.bytes[0].length);
    mux.close();
  });

  it('wait behind a hold for a new page like every other frame', async () => {
    const browser = new FakeBrowser();
    browser.announceBeforeReply = true;
    const records = new Map<string, { workspaceId?: string }>([['TV', { workspaceId: 'ws-a' }]]);
    const mux = new CdpPipeMux(browser.fromMux, browser.toMux, { grants: { registry: (id) => records.get(id) ?? null, holdMs: 200 } });
    const a = client(mux, { workspaceId: 'ws-a' });
    await a.call('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const page = (await a.call('Target.attachToTarget', { targetId: 'TV', flatten: true })).result?.sessionId as string;
    browser.createWithoutReply = true;
    a.send('Target.createTarget', { url: 'about:blank' });
    await vi.waitFor(() => expect(cdpPipeCounters().absorbed?.['grant-hold']).toBe(1), { timeout: 5_000 });
    browser.emit(screencastFrame(page));
    await deliberateSleep(50, 'a negative check: nothing more arrives');
    expect(screencasts(a.inbox)).toEqual([]);
    // The hold ends at its timeout: what waited is delivered, on the parsed path.
    await vi.waitFor(() => expect(screencasts(a.inbox)).toHaveLength(1), { timeout: 5_000 });
    expect(a.bytes).toEqual([]);
    mux.close();
  });
});
