import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
  ipcHandle: vi.fn(),
}));

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: electron.registerSchemesAsPrivileged, handle: electron.handle },
  ipcMain: { handle: electron.ipcHandle, removeHandler: vi.fn() },
  net: { fetch: vi.fn() },
}));

import { IPC } from '../../../shared/constants';
import { PREVIEW_PROTOCOL_SCHEME, previewUrl, type PreviewChangedEvent } from '../../../shared/filePreview';
import { PLUGIN_PROTOCOL_SCHEME } from '../../../shared/pluginHost';
import { closePreview, openPreview, previewStatsForTests, servePreview } from '../previewProtocol';
import { registerPrivilegedSchemes } from '../../privilegedSchemes';

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

class FakeSender extends EventEmitter {
  static next = 1;
  id = FakeSender.next++;
  sent: PreviewChangedEvent[] = [];
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  send(channel: string, payload: PreviewChangedEvent) {
    if (channel === IPC.PREVIEW_CHANGED) this.sent.push(payload);
  }
}

const asSender = (s: FakeSender) => s as unknown as Electron.WebContents;
const get = (url: string) => servePreview(new Request(url));

let dir: string;
let home: string;
const senders: FakeSender[] = [];

function sender(): FakeSender {
  const s = new FakeSender();
  senders.push(s);
  return s;
}

async function waitFor(check: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-preview-')));
  home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  for (const s of senders.splice(0)) s.emit('destroyed');
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('privileged schemes', () => {
  it('registers the plugin, preview and html preview schemes in one call', () => {
    registerPrivilegedSchemes();
    expect(electron.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    const schemes = electron.registerSchemesAsPrivileged.mock.calls[0][0].map((s: { scheme: string }) => s.scheme);
    expect(schemes).toEqual([PLUGIN_PROTOCOL_SCHEME, PREVIEW_PROTOCOL_SCHEME, 'wmux-html']);
  });
});

describe('opening a preview', () => {
  it('serves the bytes of an image behind a token, with inert headers', async () => {
    const file = path.join(dir, 'plot.png');
    fs.writeFileSync(file, PNG);
    const opened = await openPreview(asSender(sender()), file);
    expect(opened).toMatchObject({ ok: true, kind: 'image', mime: 'image/png', exists: true, complete: true, size: PNG.length, version: 1 });
    if (!opened.ok) return;
    expect(opened.token).toMatch(/^[0-9a-f]{32}$/);

    const res = await get(previewUrl(opened.token, file, 1));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-length')).toBe(String(PNG.length));
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('refuses credential stores, unsupported types, relative paths and oversized files', async () => {
    const s = asSender(sender());
    const secret = path.join(home, '.ssh', 'key.png');
    fs.writeFileSync(secret, PNG);
    expect(await openPreview(s, secret)).toEqual({ ok: false, reason: 'denied' });

    const text = path.join(dir, 'notes.txt');
    fs.writeFileSync(text, 'hi');
    expect(await openPreview(s, text)).toEqual({ ok: false, reason: 'unsupported' });
    expect(await openPreview(s, 'plot.png')).toEqual({ ok: false, reason: 'unsupported' });
    expect(await openPreview(s, path.join(dir, 'missing.png'))).toEqual({ ok: false, reason: 'missing' });

    // A symlink named like an image is judged on what it points at.
    const disguised = path.join(dir, 'disguised.png');
    fs.symlinkSync(text, disguised);
    expect(await openPreview(s, disguised)).toEqual({ ok: false, reason: 'unsupported' });

    const huge = path.join(dir, 'huge.png');
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, 65 * 1024 * 1024); // sparse
    expect(await openPreview(s, huge)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses a symlink into ~/.ssh even when home is reached through another spelling', async () => {
    // Home as given is a symlinked path (as a Windows 8.3 short name or a
    // symlinked home would be); the target's canonical path uses the real one.
    const alias = path.join(dir, 'home-alias');
    fs.symlinkSync(home, alias);
    vi.mocked(os.homedir).mockReturnValue(alias);
    fs.writeFileSync(path.join(home, '.ssh', 'id.png'), PNG);
    const link = path.join(dir, 'innocent.png');
    fs.symlinkSync(path.join(home, '.ssh', 'id.png'), link);
    expect(await openPreview(asSender(sender()), link)).toEqual({ ok: false, reason: 'denied' });
  });

  it('answers 404 for a malformed, unknown or closed token', async () => {
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, PNG);
    const s = sender();
    const opened = await openPreview(asSender(s), file);
    if (!opened.ok) throw new Error('open failed');
    expect((await get(`${PREVIEW_PROTOCOL_SCHEME}://not-a-token/a.png`)).status).toBe(404);
    expect((await get(`${PREVIEW_PROTOCOL_SCHEME}://${'0'.repeat(32)}/a.png`)).status).toBe(404);
    // Another renderer cannot close it.
    closePreview(asSender(sender()), opened.token);
    expect((await get(previewUrl(opened.token, file, 1))).status).toBe(200);
    closePreview(asSender(s), opened.token);
    expect((await get(previewUrl(opened.token, file, 1))).status).toBe(404);
  });

  it('re-checks the target on every request: a swapped symlink or a FIFO is never served', async () => {
    const real = path.join(dir, 'real.png');
    fs.writeFileSync(real, PNG);
    const link = path.join(dir, 'link.png');
    fs.symlinkSync(real, link);
    const opened = await openPreview(asSender(sender()), link);
    if (!opened.ok) throw new Error('open failed');
    expect((await get(previewUrl(opened.token, link, 1))).status).toBe(200);

    const secret = path.join(home, '.ssh', 'id.png');
    fs.writeFileSync(secret, PNG);
    fs.unlinkSync(link);
    fs.symlinkSync(secret, link);
    expect((await get(previewUrl(opened.token, link, 1))).status).toBe(404);

    if (process.platform !== 'win32') {
      fs.unlinkSync(link);
      execFileSync('mkfifo', [link]);
      expect((await get(previewUrl(opened.token, link, 1))).status).toBe(404);
    }
  });
});

describe('following the file', () => {
  it('reports a settled rewrite once, and a deletion as missing', async () => {
    const file = path.join(dir, 'chart.png');
    fs.writeFileSync(file, PNG);
    const s = sender();
    const opened = await openPreview(asSender(s), file);
    if (!opened.ok) throw new Error('open failed');

    // Atomic replace: write elsewhere, rename over.
    const tmp = path.join(dir, 'chart.png.tmp');
    fs.writeFileSync(tmp, Buffer.concat([PNG, Buffer.alloc(10)]));
    fs.renameSync(tmp, file);
    await waitFor(() => s.sent.length >= 1);
    // Bytes after IEND: the end marker is no longer last, so it reads as torn.
    expect(s.sent[0]).toMatchObject({ token: opened.token, exists: true, complete: false, size: PNG.length + 10, version: 2 });

    fs.unlinkSync(file);
    await waitFor(() => s.sent.length >= 2);
    expect(s.sent[1]).toMatchObject({ exists: false, version: 3 });

    fs.writeFileSync(file, PNG);
    await waitFor(() => s.sent.length >= 3);
    expect(s.sent[2]).toMatchObject({ exists: true, complete: true, size: PNG.length, version: 4 });
  });

  it('releases every token and watcher when the renderer navigates away', async () => {
    const file = path.join(dir, 'x.png');
    fs.writeFileSync(file, PNG);
    const s = sender();
    const opened = await openPreview(asSender(s), file);
    if (!opened.ok) throw new Error('open failed');
    expect(previewStatsForTests()).toMatchObject({ tokens: 1, watchedDirs: 1, polling: true });

    // A blocked navigation (a file dropped on the window) commits nothing.
    s.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(previewStatsForTests().tokens).toBe(1);

    s.emit('did-navigate');
    expect(previewStatsForTests()).toEqual({ tokens: 0, watchedDirs: 0, polling: false });
    expect((await get(previewUrl(opened.token, file, 1))).status).toBe(404);
  });

  it('drops an open that was still checking when the page reloaded', async () => {
    const file = path.join(dir, 'slow.png');
    fs.writeFileSync(file, PNG);
    const s = sender();
    const pending = openPreview(asSender(s), file);
    s.emit('did-navigate');
    expect(await pending).toEqual({ ok: false, reason: 'missing' });
    expect(previewStatsForTests().tokens).toBe(0);
  });

  it('notices a swap that keeps the size and mtime', async () => {
    const file = path.join(dir, 'same.png');
    fs.writeFileSync(file, PNG);
    const s = sender();
    const opened = await openPreview(asSender(s), file);
    if (!opened.ok) throw new Error('open failed');
    const st = fs.statSync(file);
    const twin = path.join(dir, 'twin.tmp');
    fs.writeFileSync(twin, Buffer.from(PNG));
    fs.utimesSync(twin, st.atime, st.mtime);
    fs.renameSync(twin, file);
    await waitFor(() => s.sent.length >= 1);
    expect(s.sent[0]).toMatchObject({ exists: true, complete: true, version: 2 });
  });

  it('shows a stable file that never gets its end marker after a grace period', async () => {
    const file = path.join(dir, 'motion.png');
    fs.writeFileSync(file, Buffer.concat([PNG, Buffer.from('trailing data after IEND')]));
    const s = sender();
    const opened = await openPreview(asSender(s), file);
    expect(opened).toMatchObject({ ok: true, complete: false });
    await waitFor(() => s.sent.length >= 1, 8000);
    expect(s.sent[0]).toMatchObject({ exists: true, complete: true, version: 2 });
  }, 12000);
});

describe('types follow the real file', () => {
  it('types a symlink by its target, and never matches Object.prototype names', async () => {
    const svg = path.join(dir, 'real.svg');
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
    const alias = path.join(dir, 'alias.png');
    fs.symlinkSync(svg, alias);
    const opened = await openPreview(asSender(sender()), alias);
    expect(opened).toMatchObject({ ok: true, mime: 'image/svg+xml' });
    if (!opened.ok) return;
    expect((await get(previewUrl(opened.token, alias, 1))).headers.get('content-type')).toBe('image/svg+xml');

    const odd = path.join(dir, 'x.constructor');
    fs.writeFileSync(odd, 'x');
    expect(await openPreview(asSender(sender()), odd)).toEqual({ ok: false, reason: 'unsupported' });
  });
});
