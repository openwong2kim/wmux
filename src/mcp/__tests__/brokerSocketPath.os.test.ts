// The broker removes a leftover file at its socket path only when it is a
// socket: anything else there is not its own and stays.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { socketIdentity, staleSocketKind } from '../brokerSocketPath';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsk-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('staleSocketKind', () => {
  it('names a socket, a missing path, a file, a folder and a symlink apart', async () => {
    const sock = path.join(dir, 's.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      expect(staleSocketKind(sock)).toBe('socket');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(staleSocketKind(path.join(dir, 'none'))).toBe('missing');
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    expect(staleSocketKind(path.join(dir, 'f'))).toBe('file');
    fs.mkdirSync(path.join(dir, 'd'));
    expect(staleSocketKind(path.join(dir, 'd'))).toBe('directory');
    fs.symlinkSync(path.join(dir, 'f'), path.join(dir, 'l'));
    expect(staleSocketKind(path.join(dir, 'l'))).toBe('symlink');
  });

  it('gives a socket a stable identity, a new one once rebound, and none to anything else', async () => {
    const sock = path.join(dir, 'id.sock');
    const listen = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(sock, r)); return s; };
    const first = await listen();
    const a = socketIdentity(sock);
    expect(a).toMatch(/^\d+:\d+$/);
    expect(socketIdentity(sock)).toBe(a);
    await new Promise<void>((r) => first.close(() => r()));
    const second = await listen();
    try {
      expect(socketIdentity(sock)).not.toBe(a);
    } finally {
      await new Promise<void>((r) => second.close(() => r()));
    }
    fs.writeFileSync(path.join(dir, 'f2'), 'x');
    expect(socketIdentity(path.join(dir, 'f2'))).toBeNull();
    expect(socketIdentity(path.join(dir, 'gone'))).toBeNull();
  });

  it('reads a path it cannot look at as unreadable, not as a non-socket', () => {
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'x'), 'x');
    fs.chmodSync(locked, 0o000);
    try {
      if (process.getuid?.() === 0) return; // root reads through the mode
      expect(staleSocketKind(path.join(locked, 'x'))).toBe('unreadable');
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

