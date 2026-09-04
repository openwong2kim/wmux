import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpSocket } from '../CdpSocket';
import { describeLiveConnectFailure } from '../LiveChromeClient';
import { describeToolError } from '../../../mcp/playwright/toolError';

// The friction on the way IN to Live Chrome. Every case here was reproduced
// against a real Chrome first: the endpoint holds the WebSocket handshake open
// while it asks the user for permission, so the connect budget has to outlast a
// human, and the failure that comes back has to say which of three unrelated
// things went wrong.

type Listener = (ev: { data?: string }) => void;

/** Never opens and never errors — exactly what a handshake parked behind
 *  Chrome's permission prompt looks like from this side. */
class HangingWebSocket {
  static OPEN = 1;
  static instances: HangingWebSocket[] = [];
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    HangingWebSocket.instances.push(this);
  }

  addEventListener(type: string, fn: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  emit(type: string, ev: { data?: string } = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }

  /** The user finally clicked Allow. */
  accept(): void {
    this.readyState = HangingWebSocket.OPEN;
    this.emit('open');
  }

  send(): void { /* not reached in these tests */ }
  close(): void { this.closed = true; this.readyState = 3; }
}

function installFakeWebSocket(): void {
  HangingWebSocket.instances = [];
  vi.stubGlobal('WebSocket', HangingWebSocket as unknown as typeof WebSocket);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CdpSocket: the connect budget is separate from the request budget', () => {
  it('keeps waiting past the request timeout, and succeeds when the user finally allows it', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const socket = new CdpSocket(() => 'ws://127.0.0.1:9222/devtools/browser/secret', {
      label: 'Live',
      timeoutMs: 10_000,
      connectTimeoutMs: 180_000,
    });

    const call = socket.send('Target.getTargets');
    // Let the dial start, then push past the OLD budget. This is the exact
    // window the user was losing: the prompt is up, nobody has clicked yet.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(HangingWebSocket.instances).toHaveLength(1);
    expect(HangingWebSocket.instances[0].closed).toBe(false);

    HangingWebSocket.instances[0].accept();
    await vi.advanceTimersByTimeAsync(0);
    // The dial resolved, so the command went out rather than failing early.
    const settled = await Promise.race([call.then(() => 'resolved'), Promise.resolve('still pending')]);
    expect(settled).toBe('still pending');
  });

  it('still gives up at the connect budget, so a dead endpoint cannot hang forever', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const socket = new CdpSocket(() => 'ws://127.0.0.1:9222/devtools/browser/secret', {
      label: 'Live',
      connectError: 'FALLBACK',
      timeoutMs: 10_000,
      connectTimeoutMs: 180_000,
    });

    const call = socket.send('Target.getTargets').catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200_000);
    await expect(call).resolves.toBe('FALLBACK');
    // The abandoned handshake is dropped, so a late approval cannot open a
    // socket nobody is holding.
    expect(HangingWebSocket.instances[0].closed).toBe(true);
  });

  it('reports that it is still waiting, while the caller is still blocked', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const pending = vi.fn();
    const socket = new CdpSocket(() => 'ws://127.0.0.1:9222/devtools/browser/secret', {
      timeoutMs: 10_000,
      connectTimeoutMs: 180_000,
      connectNoticeAfterMs: 5_000,
      onConnectPending: pending,
    });

    void socket.send('Target.getTargets').catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pending).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(pending).toHaveBeenCalledTimes(1);
    expect(pending.mock.calls[0][0]).toBeGreaterThanOrEqual(5_000);
  });
});

describe('CdpSocket: the failure reason reaches the caller', () => {
  it('asks connectErrorFor which failure this was, instead of one flat string', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const seen: string[] = [];
    const socket = new CdpSocket(() => 'ws://127.0.0.1:9222/devtools/browser/secret', {
      connectError: 'FLAT',
      timeoutMs: 1_000,
      connectTimeoutMs: 1_000,
      connectErrorFor: (reason, endpoint) => {
        seen.push(`${reason} ${endpoint}`);
        return `diagnosed:${reason}`;
      },
    });

    const call = socket.send('Target.getTargets').catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(call).resolves.toBe('diagnosed:timeout');
    expect(seen[0]).toBe('timeout ws://127.0.0.1:9222/devtools/browser/secret');
  });

  it('falls back to the flat message when the diagnosis itself throws', async () => {
    vi.useFakeTimers();
    installFakeWebSocket();
    const socket = new CdpSocket(() => 'ws://127.0.0.1:9222/devtools/browser/secret', {
      connectError: 'FLAT',
      timeoutMs: 1_000,
      connectTimeoutMs: 1_000,
      connectErrorFor: () => { throw new Error('probe blew up'); },
    });

    const call = socket.send('Target.getTargets').catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(call).resolves.toBe('FLAT');
  });
});

describe('describeLiveConnectFailure: three failures, three remedies', () => {
  const endpoint = 'ws://127.0.0.1:9222/devtools/browser/secret';

  it('a timeout on a LISTENING endpoint means nobody has approved it yet', async () => {
    const msg = await describeLiveConnectFailure('timeout', endpoint, async () => true);
    expect(msg).toContain('LIVE_CHROME_AWAITING_APPROVAL');
    expect(msg).toContain('Allow');
  });

  it('a refusal on a LISTENING endpoint points at the endpoint, not the setup', async () => {
    const msg = await describeLiveConnectFailure('error', endpoint, async () => true);
    expect(msg).toContain('LIVE_CHROME_REFUSED');
  });

  it('a dead port sends the user to chrome://inspect, whichever way it failed', async () => {
    for (const reason of ['timeout', 'error'] as const) {
      const msg = await describeLiveConnectFailure(reason, endpoint, async () => false);
      expect(msg).toContain('LIVE_CHROME_UNAVAILABLE');
      expect(msg).toContain('chrome://inspect');
      // Naming the sidebar item, not a fragment: chrome://inspect opens its
      // Devices tab whatever fragment it is handed, so the old
      // `#remote-debugging` link left the user on the wrong page with no clue
      // what to click (dogfood 2026-09-04).
      expect(msg).toContain('"Remote debugging"');
      expect(msg).not.toContain('#remote-debugging');
    }
  });

  it('treats an unparseable endpoint as "no endpoint", not as a live one', async () => {
    const probe = vi.fn(async () => true);
    const msg = await describeLiveConnectFailure('timeout', 'not-a-ws-url', probe);
    expect(msg).toContain('LIVE_CHROME_UNAVAILABLE');
    expect(probe).not.toHaveBeenCalled();
  });

  it('a probe that rejects degrades to the setup hint rather than throwing', async () => {
    const msg = await describeLiveConnectFailure('timeout', endpoint, async () => {
      throw new Error('probe failed');
    });
    expect(msg).toContain('LIVE_CHROME_UNAVAILABLE');
  });
});

describe('the hint survives the agent-facing error formatter', () => {
  // describeToolError strips a leading `identifier: ` prefix as an internal
  // call path. These codes only survive it because they contain underscores,
  // which is load-bearing and entirely accidental — pin it, so tightening that
  // rule cannot silently swallow the one line telling the user to click Allow.
  it.each([
    'LIVE_CHROME_UNAVAILABLE: could not find your Chrome’s remote-debugging endpoint.',
    'LIVE_CHROME_AWAITING_APPROVAL: switch to your Chrome window and click Allow, then retry.',
    'LIVE_CHROME_REFUSED: your Chrome’s remote-debugging endpoint is listening but refused.',
  ])('keeps %s intact', (message) => {
    expect(describeToolError(new Error(message))).toBe(message);
  });
});
