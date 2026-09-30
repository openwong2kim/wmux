import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startWebSync } from '../webSync';
import { useStore } from '../../stores';

const ws = JSON.stringify({ workspaces: [{ id: 'w1', name: 'one', panes: [{ sessionId: 'pty-1' }] }] });
const sess = JSON.stringify({ sessions: [{ id: 'pty-1', surfaceTitle: 'first' }] });

type Reply = (path: string, init: RequestInit) => Promise<Response>;

function fetchFrom(reply: Reply) {
  return vi.fn((path: string, init: RequestInit) => reply(path, init)) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('startWebSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({ workspaces: [], activeWorkspaceId: '' });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('skips a poll when /api/sessions fails, keeping what the store has, and retries', async () => {
    let failSessions = false;
    const fetchImpl = fetchFrom(async (path) => {
      if (path === '/api/sessions' && failSessions) return new Response('', { status: 503 });
      return new Response(path === '/api/workspaces' ? ws : sess, { status: 200 });
    });
    const stop = startWebSync({ token: 't', fetchImpl, intervalMs: 100, onUnauthorized: () => undefined });
    await vi.advanceTimersByTimeAsync(10);
    const title = () => (useStore.getState().workspaces[0]?.rootPane as { surfaces: { title: string }[] }).surfaces[0].title;
    expect(title()).toBe('first');
    failSessions = true;
    await vi.advanceTimersByTimeAsync(150);
    expect(title()).toBe('first');
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(4);
    stop();
  });

  it('treats 401 and 403 alike: stop polling and hand over to pairing', async () => {
    for (const status of [401, 403]) {
      const onUnauthorized = vi.fn();
      const fetchImpl = fetchFrom(async () => new Response('', { status }));
      startWebSync({ token: 't', fetchImpl, intervalMs: 100, onUnauthorized });
      await vi.advanceTimersByTimeAsync(500);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      // The two GETs run one after the other; a refusal ends the poll at the first.
      expect(fetchImpl.mock.calls.length).toBe(1);
    }
  });

  it('aborts a request that hangs (body included) and keeps polling', async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = fetchFrom((_path, init) => {
      signals.push(init.signal as AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stop = startWebSync({ token: 't', fetchImpl, intervalMs: 100, timeoutMs: 1000, onUnauthorized: () => undefined });
    await vi.advanceTimersByTimeAsync(1050);
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    // One GET per poll got as far as hanging: the next poll still started.
    expect(fetchImpl.mock.calls.length).toBe(2);
    // Stopping cancels the request in flight.
    stop();
    await flush();
    expect(signals[signals.length - 1].aborted).toBe(true);
    warn.mockRestore();
  });
});
