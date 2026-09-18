import { describe, expect, it, vi } from 'vitest';
import { RemoteAttentionGate, formatRemoteAttention } from '../remoteAttention';
import { RemoteAttentionSubscriber } from '../RemoteAttentionSubscriber';
import type { RemoteHost } from '../../../shared/remoteHosts';

function frame(event: string, body: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
}

/** A fake `/api/events` response whose body yields the given chunks, then ends. */
function fakeStream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = {
    getReader() {
      return {
        async read() {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(chunks[i++]) };
        },
        releaseLock() { /* no-op */ },
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
  return { ok: true, status: 200, body } as unknown as Response;
}

const HOST: RemoteHost = {
  id: 'h1',
  label: 'office-mac',
  origin: 'https://office-mac.example:9600',
  token: 'tok',
  addedAt: 0,
};

describe('formatRemoteAttention', () => {
  it('maps each kind to the local notification vocabulary', () => {
    expect(formatRemoteAttention('critical', { action: 'rm -rf /' })).toEqual({
      title: 'Approval needed',
      body: 'rm -rf /',
      type: 'warning',
      category: 'approval',
    });
    // Body-only notify (OSC 9 carries no title): the body IS the headline.
    expect(formatRemoteAttention('notify', { body: 'Claude is done' })).toEqual({
      title: 'Claude is done',
      body: '',
      type: 'info',
      category: 'terminal',
    });
    // An approval ECHO (resolved/expired) is tier 'info' and must not notify.
    expect(formatRemoteAttention('approval', { tier: 'info', phase: 'resolved' })).toBeNull();
    expect(formatRemoteAttention('approval', { tier: 'act', toolName: 'Bash' })?.body).toBe('Bash');
  });
});

describe('RemoteAttentionGate', () => {
  it('suppresses the initial snapshot and fires only on later transitions', () => {
    const gate = new RemoteAttentionGate();
    gate.beginStream();
    expect(gate.consume('reset', JSON.stringify({ epoch: 'e1', headId: 7 }))).toBeNull();
    // Replayed backlog (ids <= headId): nothing fires.
    for (const id of [5, 6, 7]) {
      expect(gate.consume('notify', JSON.stringify({ sessionId: 's', body: 'old', epoch: 'e1', id }))).toBeNull();
    }
    // First live event after the head.
    const live = gate.consume('notify', JSON.stringify({ sessionId: 's', body: 'fresh', epoch: 'e1', id: 8 }));
    expect(live).toMatchObject({ sessionId: 's', title: 'fresh', category: 'terminal' });
    // The daemon tees attention onto the pane streams too — same epoch:id must
    // never notify twice.
    expect(gate.consume('notify', JSON.stringify({ sessionId: 's', body: 'fresh', epoch: 'e1', id: 8 }))).toBeNull();
  });

  it('does not re-fire the backlog after a reconnect', () => {
    const gate = new RemoteAttentionGate();
    gate.beginStream();
    gate.consume('reset', JSON.stringify({ epoch: 'e1', headId: 1 }));
    expect(gate.consume('critical', JSON.stringify({ sessionId: 's', action: 'x', epoch: 'e1', id: 2 })))
      .not.toBeNull();

    // Stream drops; the reconnect replays the whole window with a NEW head id.
    gate.beginStream();
    expect(gate.consume('reset', JSON.stringify({ epoch: 'e1', headId: 2 }))).toBeNull();
    for (const id of [1, 2]) {
      expect(gate.consume('critical', JSON.stringify({ sessionId: 's', action: 'x', epoch: 'e1', id }))).toBeNull();
    }
    expect(gate.consume('critical', JSON.stringify({ sessionId: 's', action: 'y', epoch: 'e1', id: 3 })))
      .toMatchObject({ body: 'y' });
  });

  it('ignores malformed frames and unknown event names', () => {
    const gate = new RemoteAttentionGate();
    gate.beginStream();
    expect(gate.consume('notify', 'not json')).toBeNull();
    expect(gate.consume('notify', JSON.stringify({ body: 'no session' }))).toBeNull();
    expect(gate.consume('agent.liveness', JSON.stringify({ sessionId: 's', state: 'idle' }))).toBeNull();
  });
});

describe('RemoteAttentionSubscriber', () => {
  it('streams a host\'s events into notifications and reconnects on drop', async () => {
    const seen: Array<{ host: string; title: string }> = [];
    const timers: Array<() => void> = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeStream([
        frame('reset', { epoch: 'e1', headId: 3 }),
        frame('notify', { sessionId: 's', body: 'replayed', epoch: 'e1', id: 3 }),
        frame('notify', { sessionId: 's', title: 'Turn done', body: 'ready', epoch: 'e1', id: 4 }),
      ]))
      .mockResolvedValueOnce(fakeStream([
        frame('reset', { epoch: 'e1', headId: 4 }),
        frame('notify', { sessionId: 's', title: 'Turn done', body: 'ready', epoch: 'e1', id: 4 }),
        frame('critical', { sessionId: 's', action: 'terraform destroy', epoch: 'e1', id: 5 }),
      ]));

    const sub = new RemoteAttentionSubscriber({
      host: HOST,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      jitter: () => 0.5,
      setTimeoutImpl: ((cb: () => void) => {
        timers.push(cb);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as never,
      onNotification: (hostLabel, n) => seen.push({ host: hostLabel, title: n.title }),
    });

    sub.start();
    await vi.waitFor(() => expect(timers.length).toBe(1));
    // Only the post-head event fired; the replayed one did not.
    expect(seen).toEqual([{ host: 'office-mac', title: 'Turn done' }]);

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toBe('https://office-mac.example:9600/api/events');
    expect((fetchImpl.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok',
    });

    timers[0]();
    await vi.waitFor(() => expect(seen.length).toBe(2));
    // Reconnect replayed id 4 (already notified) and delivered id 5 fresh.
    expect(seen[1]).toEqual({ host: 'office-mac', title: 'Approval needed' });

    sub.stop();
  });
});
