// The broker removes a leftover file at its socket path only when it is a
// socket: anything else there is not its own and stays.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { socketIdentity, staleSocketAction, staleSocketKind } from '../brokerSocketPath';

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
    expect(a).toMatch(/^\d+:\d+:[\d.]+:[\d.]+$/);
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

describe('staleSocketAction: what the broker does after its probe of an in-use path failed', () => {
  const base = { pipeName: '/p.sock', errCode: 'ECONNREFUSED', before: 'a', now: 'a', pathOccupiedCode: 78 } as const;
  it('unreadable → exit 1, the path left alone', () => {
    expect(staleSocketAction({ ...base, kind: 'unreadable' })).toMatchObject({ action: 'exit', code: 1 });
  });
  it.each(['file', 'symlink', 'directory', 'other'] as const)('a %s → exit 78, the path left alone', (kind) => {
    expect(staleSocketAction({ ...base, kind })).toEqual({
      action: 'exit', code: 78, message: `/p.sock is a ${kind}, not a socket; refusing to remove it`,
    });
  });
  it.each(['EAGAIN', 'ETIMEDOUT', 'EACCES', undefined])('a socket whose connect failed with %s → exit 75', (errCode) => {
    expect(staleSocketAction({ ...base, kind: 'socket', errCode })).toMatchObject({ action: 'exit', code: 75 });
  });
  it('a socket that changed, or vanished, between the probe and now → exit 75', () => {
    expect(staleSocketAction({ ...base, kind: 'socket', now: 'b' })).toMatchObject({ action: 'exit', code: 75 });
    expect(staleSocketAction({ ...base, kind: 'socket', before: null })).toMatchObject({ action: 'exit', code: 75 });
  });
  it('the same refused socket → unlink and listen; nothing there → listen', () => {
    expect(staleSocketAction({ ...base, kind: 'socket' })).toEqual({ action: 'listen', unlink: true });
    expect(staleSocketAction({ ...base, kind: 'missing', errCode: 'ENOENT' })).toEqual({ action: 'listen', unlink: false });
  });
});

describe.skipIf(process.platform === 'win32')('socketIdentity carries the times', () => {
  it('includes the change and birth times beside device and inode', async () => {
    const sock = path.join(dir, 't.sock');
    const s = net.createServer();
    await new Promise<void>((r) => s.listen(sock, r));
    try {
      const st = fs.lstatSync(sock);
      expect(socketIdentity(sock)).toBe(`${st.dev}:${st.ino}:${st.ctimeMs}:${st.birthtimeMs}`);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
});

