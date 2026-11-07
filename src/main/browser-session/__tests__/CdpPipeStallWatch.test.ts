// The pipe's stall watch (C2c): a target waiting for a client that shows no
// sign of life is let go for that client, through the mux's own command, and
// only then. A frame, a pong or a backlog read down starts a new period; the
// client's own resume reaching the browser, a detach or its leaving ends the
// wait.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpPipeMux, MUX_ID_BASE, cdpPipeCounters, resetCdpPipeCounters } from '../CdpPipeMux';
import { FakeBrowser } from './fakePipeBrowser';
import { deliberateSleep } from '../../../test-utils/waitFor';

const STALL = 120;

function setup(opts: ConstructorParameters<typeof CdpPipeMux>[2] = {}) {
  const browser = new FakeBrowser();
  const mux = new CdpPipeMux(browser.fromMux, browser.toMux, { stallMs: STALL, ...opts });
  const watch = (mux as unknown as { watch: { pending(): { sessions: number; timers: number } } }).watch;
  return { browser, mux, pending: () => watch.pending() };
}

/**
 * An external client that counts the pings it is sent. With `answerPings`, it
 * answers each one once, a little later, as a live WebSocket does.
 */
function client(mux: CdpPipeMux, label: string, extra: { drain?: () => { buffered: number; flushed: number } } = {}) {
  const inbox: Array<Record<string, unknown>> = [];
  /** When each inbox entry arrived (performance.now()). */
  const arrived: number[] = [];
  let pings = 0;
  let answering = false;
  let pong: () => void = () => undefined;
  const handle = mux.attachExternal(label, (text) => {
    inbox.push(JSON.parse(text) as Record<string, unknown>);
    arrived.push(performance.now());
  }, () => undefined, {
    ping: () => {
      pings++;
      if (answering) setTimeout(() => pong(), 5);
    },
    ...extra,
  });
  pong = handle.pong;
  let nextId = 0;
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    const id = ++nextId;
    handle.receive(JSON.stringify({ id, method, params, ...(sessionId !== undefined && { sessionId }) }));
    return id;
  };
  const replyTo = async (id: number) => {
    await vi.waitFor(() => expect(inbox.some((m) => m.id === id)).toBe(true), { timeout: 5_000 });
    return inbox.find((m) => m.id === id) as { result?: Record<string, unknown> };
  };
  const answerPings = (on: boolean) => { answering = on; };
  return { inbox, arrived, send, replyTo, pong: handle.pong, answerPings, close: handle.close, pings: () => pings };
}

/** `a` pauses new targets for itself; `b` opens one. Resolves with a's paused session and when it paused. */
async function pausedFor(browser: FakeBrowser, a: ReturnType<typeof client>, b: ReturnType<typeof client>) {
  await a.replyTo(a.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }));
  await b.replyTo(b.send('Browser.getVersion'));
  b.send('Target.createTarget', { url: 'about:blank' });
  await vi.waitFor(() => expect(a.inbox.some((m) => m.method === 'Target.attachedToTarget')).toBe(true), { timeout: 5_000 });
  const i = a.inbox.findIndex((m) => m.method === 'Target.attachedToTarget');
  // The watch armed in the same turn the mux relayed the event.
  return { session: (a.inbox[i].params as { sessionId: string }).sessionId, at: a.arrived[i] };
}

/**
 * "Nothing fired yet" for `session`, checked half a period after its attach
 * reached `a` (when the watch armed), not after a poll noticed it. A runner
 * already past the period skips only this check, and says so.
 */
async function noResumeYet(browser: FakeBrowser, a: ReturnType<typeof client>, session: string): Promise<void> {
  const i = a.inbox.findIndex((m) => m.method === 'Target.attachedToTarget' && (m.params as { sessionId: string }).sessionId === session);
  const attachAt = a.arrived[i];
  const wait = attachAt + STALL / 2 - performance.now();
  if (wait > 0) await deliberateSleep(wait, 'well inside the period');
  const seen = resumes(browser, session);
  const late = performance.now() - (attachAt + STALL);
  if (late >= 0) {
    console.warn(`[stall-early-check-skipped] the runner was ${Math.round(late)} ms past the attach's period`);
    return;
  }
  expect(seen).toEqual([]);
}

const resumes = (browser: FakeBrowser, session: string) => browser.received.filter((c) => c.method === 'Runtime.runIfWaitingForDebugger' && c.sessionId === session);

afterEach(() => resetCdpPipeCounters());

describe('CdpPipeStallWatch, through the mux', () => {
  it('lets a target go for a client with no sign of life, on the mux\'s own id, and the client never sees the reply', async () => {
    const { browser, mux, pending } = setup();
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    const { session, at } = await pausedFor(browser, a, b);
    expect(a.pings()).toBe(1);
    await vi.waitFor(() => expect(resumes(browser, session)).toHaveLength(1), { timeout: 5_000 });
    expect(performance.now() - at).toBeGreaterThanOrEqual(STALL - 5);
    expect(resumes(browser, session)[0].id).toBeGreaterThanOrEqual(MUX_ID_BASE);
    await deliberateSleep(30, 'let the reply come back');
    expect(a.inbox.filter((m) => typeof m.id === 'number' && (m.id as number) >= MUX_ID_BASE)).toEqual([]);
    expect(pending()).toEqual({ sessions: 0, timers: 0 });
    expect(cdpPipeCounters().watchdog).toEqual({ armed: 1, fired: 1 });
    mux.close();
  });

  it('one frame and then silence: fires a fresh stall period after that frame', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    const { session } = await pausedFor(browser, a, b);
    await deliberateSleep(STALL / 2, 'part of the period passes');
    const lastFrame = performance.now();
    a.send('Browser.getVersion');
    await vi.waitFor(() => expect(resumes(browser, session)).toHaveLength(1), { timeout: 5_000 });
    expect(performance.now() - lastFrame).toBeGreaterThanOrEqual(STALL - 5);
    expect(cdpPipeCounters().watchdog).toMatchObject({ 'restarted-by-frame': 1, fired: 1 });
    // Pings: at the arm, with the new period, and with the fire (a pong would clear stalled).
    expect(a.pings()).toBe(3);
    mux.close();
  });

  it('a pong to its ping starts a new period and does not end the wait; when pongs stop, it fires', async () => {
    const { browser, mux, pending } = setup();
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    a.answerPings(true);
    const { session } = await pausedFor(browser, a, b);
    await deliberateSleep(STALL * 5, 'several periods, each ping answered');
    expect(resumes(browser, session)).toEqual([]);
    expect(pending()).toEqual({ sessions: 1, timers: 1 });
    // One ping per period, not one per pong.
    expect(a.pings()).toBeGreaterThanOrEqual(4);
    expect(a.pings()).toBeLessThanOrEqual(7);
    expect(cdpPipeCounters().watchdog?.['restarted-by-pong']).toBeGreaterThanOrEqual(3);
    a.answerPings(false);
    await vi.waitFor(() => expect(resumes(browser, session)).toHaveLength(1), { timeout: 5_000 });
    mux.close();
  });

  it('one timer and one ping per period per client, however many of its sessions wait; a fire lets them all go', async () => {
    const { browser, mux, pending } = setup();
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    await pausedFor(browser, a, b);
    b.send('Target.createTarget', { url: 'about:blank' });
    b.send('Target.createTarget', { url: 'about:blank' });
    await vi.waitFor(() => expect(a.inbox.filter((m) => m.method === 'Target.attachedToTarget')).toHaveLength(3), { timeout: 5_000 });
    expect(pending()).toEqual({ sessions: 3, timers: 1 });
    expect(a.pings()).toBe(1);
    const sessions = a.inbox.filter((m) => m.method === 'Target.attachedToTarget').map((m) => (m.params as { sessionId: string }).sessionId);
    await vi.waitFor(() => { for (const s of sessions) expect(resumes(browser, s)).toHaveLength(1); }, { timeout: 5_000 });
    expect(cdpPipeCounters().watchdog).toMatchObject({ armed: 3, fired: 3 });
    expect(pending()).toEqual({ sessions: 0, timers: 0 });
    mux.close();
  });

  it('a resume of its own that a rule kept from the browser does not end the wait', async () => {
    const { browser, mux, pending } = setup({
      filter: (_c, command) => (command.method === 'Runtime.runIfWaitingForDebugger' ? { absorb: {}, reason: 'test' } : null),
    });
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    const { session } = await pausedFor(browser, a, b);
    await a.replyTo(a.send('Runtime.runIfWaitingForDebugger', {}, session));
    expect(pending()).toEqual({ sessions: 1, timers: 1 });
    await vi.waitFor(() => expect(resumes(browser, session)).toHaveLength(1), { timeout: 5_000 });
    expect(resumes(browser, session)[0].id).toBeGreaterThanOrEqual(MUX_ID_BASE);
    mux.close();
  });

  it('a client reading down a backlog that was waiting for it is alive; one that stopped reading is not', async () => {
    const { browser, mux } = setup();
    let flushed = 0;
    let buffered = 4 << 20;
    const reading = setInterval(() => { flushed += 1 << 16; buffered = Math.max(1, buffered - (1 << 16)); }, 10);
    try {
      const a = client(mux, 'a', { drain: () => ({ buffered, flushed }) });
      const b = client(mux, 'b');
      const { session } = await pausedFor(browser, a, b);
      await deliberateSleep(STALL * 4, 'it keeps reading');
      expect(resumes(browser, session)).toEqual([]);
      expect(cdpPipeCounters().watchdog?.['restarted-by-drain']).toBeGreaterThanOrEqual(2);
      clearInterval(reading);
      await vi.waitFor(() => expect(resumes(browser, session)).toHaveLength(1), { timeout: 5_000 });
    } finally {
      clearInterval(reading);
    }
    mux.close();
  });

  it('with no backlog, bytes the socket takes are not a sign of life', async () => {
    const { browser, mux } = setup();
    let flushed = 0;
    const accepted = setInterval(() => { flushed += 100; }, 10);
    try {
      const a = client(mux, 'a', { drain: () => ({ buffered: 0, flushed }) });
      const b = client(mux, 'b');
      const { session } = await pausedFor(browser, a, b);
      await vi.waitFor(() => expect(resumes(browser, session)).toHaveLength(1), { timeout: 5_000 });
    } finally {
      clearInterval(accepted);
    }
    mux.close();
  });

  it('the client resuming the target itself ends the wait, with no timer left', async () => {
    const { browser, mux, pending } = setup();
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    const { session } = await pausedFor(browser, a, b);
    await a.replyTo(a.send('Runtime.runIfWaitingForDebugger', {}, session));
    expect(pending()).toEqual({ sessions: 0, timers: 0 });
    await deliberateSleep(STALL * 2, 'past the deadline');
    expect(resumes(browser, session)).toHaveLength(1);
    expect(resumes(browser, session)[0].id).toBeLessThan(MUX_ID_BASE);
    expect(cdpPipeCounters().watchdog).toEqual({ armed: 1, 'ended-by-client': 1 });
    mux.close();
  });

  it('a frame already queued when the deadline passes is read before judging', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    const { session, at } = await pausedFor(browser, a, b);
    // A frame due just after the deadline, and main busy past both: they run in
    // one timers pass, the deadline first, so only the recheck can see the frame.
    setTimeout(() => a.send('Browser.getVersion'), at + STALL + 2 - performance.now());
    while (performance.now() < at + STALL + 20) { /* main is busy */ }
    await deliberateSleep(20, 'the recheck runs');
    expect(resumes(browser, session)).toEqual([]);
    expect(cdpPipeCounters().watchdog).toMatchObject({ armed: 1, 'restarted-by-frame': 1 });
    mux.close();
  });

  it('a stalled client\'s next target goes at once; any frame from it clears that, and the next one waits again', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    const first = await pausedFor(browser, a, b);
    await vi.waitFor(() => expect(resumes(browser, first.session)).toHaveLength(1), { timeout: 5_000 });

    const paused = () => a.inbox.filter((m) => m.method === 'Target.attachedToTarget').map((m) => (m.params as { sessionId: string }).sessionId);
    b.send('Target.createTarget', { url: 'about:blank' });
    await vi.waitFor(() => expect(paused()).toHaveLength(2), { timeout: 5_000 });
    const second = paused()[1];
    await vi.waitFor(() => expect(resumes(browser, second)).toHaveLength(1), { timeout: 1_000 });
    expect(cdpPipeCounters().watchdog?.['resumed-while-stalled']).toBe(1);

    await a.replyTo(a.send('Browser.getVersion'));
    b.send('Target.createTarget', { url: 'about:blank' });
    await vi.waitFor(() => expect(paused()).toHaveLength(3), { timeout: 5_000 });
    const third = paused()[2];
    await noResumeYet(browser, a, third);
    await vi.waitFor(() => expect(resumes(browser, third)).toHaveLength(1), { timeout: 5_000 });
    expect(cdpPipeCounters().watchdog).toMatchObject({ armed: 2, fired: 2, 'resumed-while-stalled': 1 });
    mux.close();
  });

  it('a pong clears stalled, and a stalled client is pinged when its next target goes', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    const first = await pausedFor(browser, a, b);
    await vi.waitFor(() => expect(resumes(browser, first.session)).toHaveLength(1), { timeout: 5_000 });
    const pingsAtFire = a.pings();
    const paused = () => a.inbox.filter((m) => m.method === 'Target.attachedToTarget').map((m) => (m.params as { sessionId: string }).sessionId);
    b.send('Target.createTarget', { url: 'about:blank' });
    await vi.waitFor(() => expect(paused()).toHaveLength(2), { timeout: 5_000 });
    await vi.waitFor(() => expect(resumes(browser, paused()[1])).toHaveLength(1), { timeout: 1_000 });
    expect(a.pings()).toBe(pingsAtFire + 1);
    a.pong();
    b.send('Target.createTarget', { url: 'about:blank' });
    await vi.waitFor(() => expect(paused()).toHaveLength(3), { timeout: 5_000 });
    await noResumeYet(browser, a, paused()[2]);
    mux.close();
  });

  it('a client that leaves with a wait pending: nothing fires afterwards, and no timer is left', async () => {
    const { browser, mux, pending } = setup();
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    const { session } = await pausedFor(browser, a, b);
    a.close();
    expect(pending()).toEqual({ sessions: 0, timers: 0 });
    await deliberateSleep(STALL * 2, 'past the deadline');
    expect(resumes(browser, session)).toEqual([]);
    expect(cdpPipeCounters().watchdog).toEqual({ armed: 1 });
    mux.close();
  });

  it('a detached session ends its wait', async () => {
    const { browser, mux, pending } = setup();
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    const { session } = await pausedFor(browser, a, b);
    const aBrowserSession = browser.received.find((c) => c.method === 'Target.setAutoAttach')?.sessionId as string;
    browser.event(aBrowserSession, 'Target.detachedFromTarget', { sessionId: session });
    await vi.waitFor(() => expect(pending()).toEqual({ sessions: 0, timers: 0 }), { timeout: 5_000 });
    await deliberateSleep(STALL * 2, 'past the deadline');
    expect(resumes(browser, session)).toEqual([]);
    expect(cdpPipeCounters().watchdog).toEqual({ armed: 1, 'ended-by-detach': 1 });
    mux.close();
  });

  it('the reply to its own resume, arriving after the client left, goes to no one and throws nothing', async () => {
    const { browser, mux } = setup();
    const a = client(mux, 'a');
    const b = client(mux, 'b');
    browser.holdReplies.add('Runtime.runIfWaitingForDebugger');
    const { session } = await pausedFor(browser, a, b);
    await vi.waitFor(() => expect(resumes(browser, session)).toHaveLength(1), { timeout: 5_000 });
    a.close();
    const before = { a: a.inbox.length, b: b.inbox.length };
    browser.releaseHeld();
    await deliberateSleep(30, 'the reply comes back');
    expect({ a: a.inbox.length, b: b.inbox.length }).toEqual(before);
    expect(cdpPipeCounters().dropped).toEqual({});
    mux.close();
  });

  it('main\'s own connections are never watched', async () => {
    const { browser, mux, pending } = setup();
    const own = mux.connect({ label: 'main' });
    await own.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await own.send('Target.createTarget', { url: 'about:blank' });
    await deliberateSleep(STALL * 2, 'past the deadline');
    expect(pending()).toEqual({ sessions: 0, timers: 0 });
    expect(browser.received.some((c) => c.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
    expect(cdpPipeCounters().watchdog).toEqual({});
    mux.close();
  });
});
