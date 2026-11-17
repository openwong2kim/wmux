// The broker removes a leftover file at its socket path only when it is a
// socket: anything else there is not its own and stays.
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { staleSocketKind } from '../brokerSocketPath';

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
});
