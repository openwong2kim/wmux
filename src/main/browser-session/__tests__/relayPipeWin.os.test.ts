// The relay pipe's DACL against the real Win32 API: a Node pipe starts with
// the default descriptor, narrow() closes it to SYSTEM and this user, and
// instances libuv creates afterwards keep that.
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_PIPE_BUSY, isOwnerOnlyDacl, loadPipeSecurity, parseDacl, relayPipePath, type PipeSecurity } from '../relayPipeWin';

const servers: net.Server[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function security(): PipeSecurity {
  const result = loadPipeSecurity();
  if (!('security' in result)) throw new Error(`pipe security unavailable: ${result.unavailable}`);
  return result.security;
}

/** A pipe server that echoes, listening (synchronously, as Node does on Windows) when this returns. */
function listen(path: string): net.Server {
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined);
    socket.on('data', (data) => socket.write(data));
  });
  server.on('error', () => undefined);
  server.listen(path);
  servers.push(server);
  return server;
}

function echo(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.connect(path, () => client.write('ping'));
    client.once('data', (data) => { resolve(data.toString()); client.destroy(); });
    client.once('error', reject);
  });
}

describe.runIf(process.platform === 'win32')('the relay pipe DACL (Win32)', () => {
  it('Node creates the pipe open to every account; narrow() leaves SYSTEM and this user only', async () => {
    const sec = security();
    const path = relayPipePath();
    const server = listen(path);
    expect(server.listening).toBe(true);
    const before = parseDacl(sec.daclOf(path));
    expect(before?.aces.some((ace) => ace.sid === 'WD')).toBe(true);
    expect(isOwnerOnlyDacl(before, sec.userSid)).toBe(false);

    expect(sec.narrow(path)).toEqual({ ok: true });
    expect(isOwnerOnlyDacl(parseDacl(sec.daclOf(path)), sec.userSid)).toBe(true);
    // The pipe still serves this user.
    expect(await echo(path)).toBe('ping');
  });

  it('instances libuv creates after the change carry the same DACL', async () => {
    const sec = security();
    const path = relayPipePath();
    listen(path);
    expect(sec.narrow(path).ok).toBe(true);
    const clients = Array.from({ length: 8 }, () => net.connect(path).on('error', () => undefined));
    closers.push(() => { for (const c of clients) c.destroy(); });
    await Promise.all(clients.map((c) => new Promise((resolve) => c.once('connect', resolve))));
    expect(isOwnerOnlyDacl(parseDacl(sec.daclOf(path)), sec.userSid)).toBe(true);
  });

  it('says the pipe is busy when every waiting instance is taken, and changes nothing', () => {
    const sec = security();
    const path = relayPipePath();
    listen(path);
    // In this tick libuv has made its pending instances and no more: take them all.
    let busy: number | null = null;
    for (let i = 0; i < 64 && busy === null; i++) {
      const opened = sec.openForReading(path);
      if (typeof opened === 'function') closers.push(opened);
      else busy = opened.error;
    }
    expect(busy).toBe(ERROR_PIPE_BUSY);
    expect(sec.narrow(path)).toEqual({ ok: false, busy: true, reason: `open ${ERROR_PIPE_BUSY}` });
  });

  it('a second relay pipe under the same name fails to bind', async () => {
    const path = relayPipePath();
    listen(path);
    const second = net.createServer();
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      second.once('error', resolve);
      second.listen(path);
    });
    expect(error.code).toBe('EADDRINUSE');
  });
});
