import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebTerminalServer } from '../WebTerminalServer';
import { openResolvedFile } from '../openResolvedFile';
import type { DaemonSessionManager } from '../../DaemonSessionManager';

/**
 * #1434 — `openResolvedFile` and the two routes that open through it
 * (`/turns/image`, `/turns/file`), against the REAL filesystem of whatever
 * platform runs this. The guarantees under test used to hang off O_NOFOLLOW
 * and O_NONBLOCK, which Node does not define on win32, so the same cases have
 * to pass on NTFS where those flags are silently absent.
 */

/**
 * Whether this process may create a FILE symlink. Windows refuses one without
 * SeCreateSymbolicLinkPrivilege (an elevated shell, or Developer Mode on), so
 * the cases that need one skip there instead of failing. A junction needs no
 * privilege, which is why the directory-swap cases run everywhere.
 */
const canSymlink = ((): boolean => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-symlink-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target'), '');
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
/**
 * Whether the temp volume ignores case (NTFS, default APFS; not the usual
 * Linux filesystems) — where one file has more than one spelling.
 */
const caseInsensitiveTmp = ((): boolean => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-case-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'probe'), '');
    return fs.existsSync(path.join(dir, 'PROBE'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
const isWindows = process.platform === 'win32';

/** The smallest legal PNG: signature, IHDR for 1x1, one IDAT, IEND. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** Still a PNG to the sniffer, but bytes no file inside the boundary holds. */
const SECRET_PNG = Buffer.concat([PNG_1X1, Buffer.from('outside-the-boundary')]);

/** Path spellings compare case-insensitively where the filesystem does. */
const samePath = (a: string, b: string): boolean =>
  isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;

describe('#1434 - openResolvedFile', () => {
  let root: string;
  beforeEach(() => {
    // Resolved natively, as the routes resolve what they hand the helper.
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-open-resolved-')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('opens a regular file and reads it through the handle', async () => {
    const file = path.join(root, 'a.png');
    fs.writeFileSync(file, PNG_1X1);
    const handle = await openResolvedFile(file);
    if (!handle) throw new Error('a regular file inside the tree was refused');
    try {
      expect((await handle.readFile()).equals(PNG_1X1)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it('refuses a directory, and a path that is not there', async () => {
    fs.mkdirSync(path.join(root, 'shots'));
    expect(await openResolvedFile(path.join(root, 'shots'))).toBeNull();
    expect(await openResolvedFile(path.join(root, 'nope.png'))).toBeNull();
  });

  it('refuses a junction (a directory symlink on POSIX) as the last component', async () => {
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    const junction = path.join(root, 'junction');
    fs.symlinkSync(target, junction, 'junction');
    expect(await openResolvedFile(junction)).toBeNull();
  });

  it.skipIf(!caseInsensitiveTmp)('refuses any spelling of a path but the native realpath one', async () => {
    // The contract every caller has to meet. Where the volume ignores case,
    // JS `fs.realpathSync` hands back the caller's casing (this respelling)
    // for the same file the native realpath spells as it is on disk, and the
    // helper compares realpath's answer with what it was given byte for byte.
    const file = path.join(root, 'Shot.png');
    fs.writeFileSync(file, PNG_1X1);
    const respelled = path.join(root, 'SHOT.PNG');
    expect(await openResolvedFile(respelled)).toBeNull();
    const handle = await openResolvedFile(fs.realpathSync.native(respelled));
    if (!handle) throw new Error('the native realpath spelling was refused');
    await handle.close();
  });

  it.skipIf(!canSymlink)('refuses a path that is a file symlink', async () => {
    const target = path.join(root, 'target.png');
    fs.writeFileSync(target, PNG_1X1);
    const link = path.join(root, 'link.png');
    fs.symlinkSync(target, link, 'file');
    expect(await openResolvedFile(link)).toBeNull();
  });

  it('refuses when the path names a different file by the time the handle is checked', async () => {
    // The open landed on the file the gate saw; then the path moved on. What
    // is read is the handle, so the handle and the path have to agree.
    const file = path.join(root, 'a.png');
    fs.writeFileSync(file, PNG_1X1);
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      const handle = await realOpen(...args);
      fs.renameSync(file, `${file}.moved`);
      fs.writeFileSync(file, SECRET_PNG);
      return handle;
    }) as never);
    expect(await openResolvedFile(file)).toBeNull();
  });

  it.skipIf(isWindows)('refuses a FIFO without waiting for a writer', async () => {
    const fifo = path.join(root, 'pipe.png');
    execFileSync('mkfifo', [fifo]);
    expect(await openResolvedFile(fifo)).toBeNull();
  });

  it.runIf(isWindows)('refuses a named pipe on its handle, without waiting on it', async () => {
    // The FIFO Windows has. Node (24, at least) reports one as a regular file
    // when asked by PATH, so it passes the check before the open and is
    // opened; the check on the handle is the one that refuses it. That has to
    // come before any read, which would wait on a server that never writes,
    // and before any further lookup by path, each of which connects again.
    const pipe = `\\\\.\\pipe\\wmux-open-resolved-${process.pid}-${Date.now()}`;
    const sockets = new Set<net.Socket>();
    const pipeServer = net.createServer((socket) => { sockets.add(socket); });
    await new Promise<void>((resolve) => pipeServer.listen(pipe, resolve));
    const lstat = vi.spyOn(fs.promises, 'lstat');
    const realpath = vi.spyOn(fs.promises, 'realpath');
    try {
      expect(await openResolvedFile(pipe)).toBeNull();
      const lstatCalls = lstat.mock.calls.filter(([p]) => p === pipe).length;
      const realpathCalls = realpath.mock.calls.filter(([p]) => p === pipe).length;
      expect({ lstatCalls, realpathCalls }).toEqual({ lstatCalls: 1, realpathCalls: 0 });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => pipeServer.close(() => resolve()));
    }
  });
});

describe('#1434 - turn media routes on the real filesystem', () => {
  let dirs: string[];
  let spawnCwd: string;
  let server: WebTerminalServer;
  let token: string;

  /**
   * A temp tree, resolved the way the route resolves (the NATIVE realpath), so
   * the path an open spy sees is the one computed here.
   */
  const tmpTree = (): string => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-turn-open-')));
    dirs.push(dir);
    return dir;
  };

  /**
   * `boundary/shots/a.png` is the file a caller asks for; `outside/a.png` is a
   * file with the same name the boundary must never serve.
   */
  const layout = () => {
    const root = tmpTree();
    const boundary = path.join(root, 'cwd');
    const shots = path.join(boundary, 'shots');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(shots, { recursive: true });
    fs.mkdirSync(outside);
    const file = path.join(shots, 'a.png');
    fs.writeFileSync(file, PNG_1X1);
    const secret = path.join(outside, 'a.png');
    fs.writeFileSync(secret, SECRET_PNG);
    spawnCwd = boundary;
    return { boundary, shots, outside, file, secret };
  };

  /**
   * Run `swap` the moment the route opens `target`: after its realpath and
   * containment check have passed, before the open lands. That is the window
   * the old flags were supposed to close. `fired()` says whether the swap ran,
   * so a case that never reached the open cannot pass by accident.
   */
  const swapAtOpen = (target: string, swap: () => void) => {
    const realOpen = fs.promises.open;
    let fired = false;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation((async (
      ...args: Parameters<typeof fs.promises.open>
    ) => {
      if (!fired && samePath(String(args[0]), target)) {
        fired = true;
        swap();
      }
      return realOpen(...args);
    }) as never);
    return { spy, fired: () => fired };
  };

  const routes = [
    { route: 'turns/image', notFound: 'image not found' },
    { route: 'turns/file', notFound: 'file not found' },
  ] as const;
  const fetchMedia = (route: string, p: string) =>
    fetch(
      `http://127.0.0.1:${server.status().port}/api/sessions/s1/${route}?path=${encodeURIComponent(p)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

  beforeEach(async () => {
    dirs = [];
    spawnCwd = '';
    const sessionManager = Object.assign(new EventEmitter(), {
      getSession: (id: string) => (id === 's1' ? { meta: { id: 's1', spawnCwd, env: {} } } : undefined),
      listLiveSessions: () => [],
    }) as unknown as DaemonSessionManager;
    server = new WebTerminalServer({
      sessionManager,
      log: () => { /* silent in tests */ },
      assetsDir: os.tmpdir(),
    });
    const info = await server.start({
      port: 0, host: '127.0.0.1', allowInput: false, allowUpload: false, allowTranscript: true,
    });
    token = info.token as string;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server.isRunning) await server.stop();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const { route, notFound } of routes) {
    describe(`/${route}`, () => {
      it('serves a regular file inside the boundary, byte for byte', async () => {
        const { file } = layout();
        const res = await fetchMedia(route, file);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/png');
        expect(Buffer.from(await res.arrayBuffer()).equals(PNG_1X1)).toBe(true);
      });

      it('404s a directory inside the boundary', async () => {
        const { shots } = layout();
        const res = await fetchMedia(route, shots);
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe(notFound);
      });

      it('404s when a directory on the path became a junction after the boundary check', async () => {
        // No privilege needed on Windows, so this is the swap an unelevated
        // process in the pane can actually make there. O_NOFOLLOW never covered
        // it on POSIX either: it only refuses a link in the LAST component.
        const { shots, outside, file } = layout();
        const swap = swapAtOpen(file, () => {
          fs.renameSync(shots, `${shots}-moved`);
          fs.symlinkSync(outside, shots, 'junction');
        });
        const res = await fetchMedia(route, file);
        expect(swap.fired()).toBe(true);
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(SECRET_PNG)).toBe(false);
        expect(res.status).toBe(404);
        expect(JSON.parse(body.toString('utf8')).error).toBe(notFound);
      });

      it.skipIf(!canSymlink)('404s when the file itself became a symlink after the boundary check', async () => {
        const { file, secret } = layout();
        const swap = swapAtOpen(file, () => {
          fs.renameSync(file, `${file}.moved`);
          fs.symlinkSync(secret, file, 'file');
        });
        const res = await fetchMedia(route, file);
        expect(swap.fired()).toBe(true);
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.equals(SECRET_PNG)).toBe(false);
        expect(res.status).toBe(404);
        expect(JSON.parse(body.toString('utf8')).error).toBe(notFound);
      });

      it.skipIf(isWindows)('404s a FIFO inside the boundary instead of parking on it', async () => {
        const { shots } = layout();
        const fifo = path.join(shots, 'pipe.png');
        execFileSync('mkfifo', [fifo]);
        const res = await fetchMedia(route, fifo);
        expect(res.status).toBe(404);
        expect((await res.json()).error).toBe(notFound);
      });
    });
  }
});
