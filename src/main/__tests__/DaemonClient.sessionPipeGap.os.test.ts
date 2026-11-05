// A pane's reattach replaces its session pipe: daemon.attachSession lets the
// old client go and stops that pipe, then main connects a new one (#3073).
// Over real sockets, main's DaemonClient against the daemon's SessionPipe:
// what main wrote to the old pipe still reaches the PTY, and a writer that
// finds no pipe in the gap can wait for the new one.
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { DaemonClient } from '../DaemonClient';
import { RingBuffer } from '../../daemon/RingBuffer';
import { SessionPipe } from '../../daemon/SessionPipe';
import { waitFor } from '../../test-utils/waitFor';

const TOKEN = 'gap-test-token';

const pipes: SessionPipe[] = [];
const clients: DaemonClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect().catch(() => {});
  for (const p of pipes.splice(0)) await p.stop().catch(() => {});
});

/** The daemon's pipe for `id`, and what its PTY was given. */
async function daemonPipe(id: string): Promise<{ pipe: SessionPipe; input: () => string }> {
  const pipe = new SessionPipe(id, new RingBuffer(16 * 1024), TOKEN);
  pipes.push(pipe);
  const received: Buffer[] = [];
  pipe.onInput((data) => { received.push(data); });
  await pipe.start();
  return { pipe, input: () => Buffer.concat(received).toString('utf8') };
}

describe('DaemonClient across a session pipe replacement (#3073)', () => {
  it('a write to the old pipe reaches the PTY, and a write in the gap waits for the new pipe', async () => {
    const id = `gap-${crypto.randomUUID().slice(0, 8)}`;
    const client = new DaemonClient('unused-control-pipe', TOKEN);
    clients.push(client);
    const first = await daemonPipe(id);
    await client.connectSessionPipe(id);
    await waitFor(() => first.pipe.isFlushed, 5_000);

    // Written just before the daemon replaces the pipe, and reported written.
    expect(client.writeToSession(id, 'echo before')).toBe(true);
    // daemon.attachSession: the old client goes, the old pipe stops, a new one listens.
    await first.pipe.releaseClient();
    await first.pipe.stop();
    expect(first.input()).toBe('echo before');
    await waitFor(() => !client.isSessionPipeWritable(id), 5_000);
    expect(client.writeToSession(id, 'lost?')).toBe(false);
    const second = await daemonPipe(id);

    // A writer in the gap waits; main's reattach connects the new pipe meanwhile.
    const waited = client.waitForSessionPipe(id, 3_000);
    await client.connectSessionPipe(id, { forceFresh: true });
    expect(await waited).toBe(true);
    expect(client.writeToSession(id, 'echo after')).toBe(true);
    await waitFor(() => second.input() === 'echo after', 5_000);
    expect(first.input()).toBe('echo before');
  });

  it('a wait with no pipe coming answers false at its bound', async () => {
    const client = new DaemonClient('unused-control-pipe', TOKEN);
    clients.push(client);
    const startedAt = Date.now();
    expect(await client.waitForSessionPipe('no-such-session', 120)).toBe(false);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(110);
    expect(client.listenerCount('session-pipe:open')).toBe(0);
  });
});
