// A daemon session pipe that fell behind asks main to re-flush it with a
// pushed control event. Real DaemonClient over a real DaemonPipeServer, into
// main's handler (createResyncNeededHandler) as pty.handler wires it.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: () => undefined,
  getLastBroadcastAgentStatus: () => undefined,
  hasOutstandingRunningClaim: () => false,
}));

import { DaemonPipeServer } from '../../daemon/DaemonPipeServer';
import { DaemonClient } from '../DaemonClient';
import { createResyncNeededHandler, createSessionResync } from '../ipc/handlers/sessionResync';
import { waitFor } from '../../test-utils/waitFor';

const TOKEN = 'test-token-resync-needed';

function pipeName(): string {
  const id = crypto.randomUUID().slice(0, 8);
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-test-resyncneeded-${id}`;
  return path.join(os.tmpdir(), `wmux-test-resyncneeded-${id}.sock`);
}

describe('session.resyncNeeded from the daemon to main\'s handler', () => {
  let server: DaemonPipeServer;
  let client: DaemonClient;

  beforeEach(async () => {
    const name = pipeName();
    server = new DaemonPipeServer(name);
    server.setAuthToken(TOKEN);
    // As daemon/index.ts: main identifies, then may subscribe to events.
    server.onRpc('daemon.client.identify', async (params, ctx) => {
      if (params['role'] !== 'main') return { ok: false };
      server.markFirstParty(ctx.clientId);
      return { ok: true };
    });
    server.onRpc('daemon.events.subscribe', async (_p, ctx) => ({ ok: server.subscribeEvents(ctx.clientId) }));
    await server.start();
    client = new DaemonClient(name, TOKEN);
    expect(await client.connect()).toBe(true);
  });

  afterEach(async () => {
    await client.disconnect();
    await server.stop();
  });

  // Main's handler as pty.handler builds it, over this client.
  function wire(ownsPipe: (id: string) => boolean): string[] {
    const notices: string[] = [];
    const resync = createSessionResync(client);
    const handle = createResyncNeededHandler({
      resync: () => resync,
      ownsPipe,
      flushBatch: (id) => notices.push(`flush:${id}`),
      notify: (notice, id, code) => notices.push(`${notice}:${id}${code ? `:${code}` : ''}`),
    });
    client.on('session:resyncNeeded', ({ sessionId }: { sessionId: string }) => handle(sessionId));
    return notices;
  }

  // The client subscribes during connect; push until the first event lands.
  async function push(sessionId: string, seen: () => boolean): Promise<void> {
    await waitFor(() => {
      server.broadcast({ type: 'session.resyncNeeded', sessionId, data: null });
      return seen();
    }, 5000);
  }

  it('reaches the main that holds the pipe, which tells the renderer and runs the re-flush', async () => {
    // The pipe is this main's (ownsPipe), but no scanner can be armed here:
    // the episode fails and main says so after its notice.
    const notices = wire(() => true);
    await push('s1', () => notices.includes('starting:s1'));
    await waitFor(() => notices.some((n) => n.startsWith('failed:s1')), 5000);
    expect(notices.slice(0, 3)).toEqual(['flush:s1', 'starting:s1', 'failed:s1:pipe-not-writable']);
  });

  it('a main without the session\'s pipe answers nothing', async () => {
    const seen: string[] = [];
    client.on('session:resyncNeeded', ({ sessionId }: { sessionId: string }) => seen.push(sessionId));
    const notices = wire((id) => client.isSessionPipeWritable(id));
    await push('s2', () => seen.includes('s2'));
    expect(notices).toEqual([]);
  });
});
