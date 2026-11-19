// Images on cross-PC A2A messages, piece by piece: what an agent may attach,
// the image store (staging, quotas, sweeps), the blob routes, the sender's
// feature gate and ledger rebuild, the receiver's pulls, and the joiner's
// upload budget. The two-PC path is in delivery.e2e.os.test.ts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_IMAGE_LIMITS, A2A_REMOTE_PROTOCOL, A2A_ROUTES, type A2aOutboxRecordV1, type A2aRemoteImageRef, type HostId } from '../../../shared/a2aRemote';
import type { Message } from '../../../shared/types';
import { FAR_IDS, fakeFileIds } from '../../../test-utils/fileIds';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { remoteTaskId } from '../ids';
import { registerImageRoutes } from '../imageRoutes';
import { imageRoots, imageSourceMessage, readImageSource } from '../imageSource';
import { A2aImageStore, A2A_IMAGE_RETAIN_MS, LOCAL_FOLDER, RECEIVED_HOST_MAX_FILES, STAGING_PEER_MAX_BYTES, STAGING_TTL_MS, sha256 } from '../imageStore';
import { acceptInbound, PULL_MAX_ATTEMPTS, type ImagePull, type InboundDeps } from '../inbound';
import { LinkStore } from '../linkStore';
import { linkAlias, sendRemoteReply, sendRemoteTask, syncRemoteTask, type OutboundDeps, type PreparedImage } from '../outbound';
import { OutboxStore } from '../outboxStore';
import { A2aRouteTable } from '../routes';
import { IMAGE_UPLOAD_MAX_FAILURES, JoinerSession, type SessionClient } from '../session';
import { PinnedClientError } from '../pinnedClient';
import { A2A_REQUEST_BODY_MAX, requestBodyMax } from '../server';

const HOST = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const quiet = (): void => undefined;

/** A structurally valid PNG of `w` x `h` with `pad` bytes of IDAT. */
function png(w: number, h: number, pad = 4, seed = 0): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = Buffer.alloc(pad, seed);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
const refOf = (b: Buffer): A2aRemoteImageRef => ({ sha256: sha256(b), mediaType: 'image/png', bytes: b.length });

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-img-')));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('imageRoots / readImageSource', () => {
  it('takes the pane folder and uploads, never home or a filesystem root, and uploads only without a pane', () => {
    const uploads = path.join(dir, 'uploads');
    expect(imageRoots(path.join(dir, 'proj'), uploads)).toEqual([uploads, path.join(dir, 'proj')]);
    expect(imageRoots(undefined, uploads)).toEqual([uploads]);
    expect(imageRoots(os.homedir(), uploads)).toEqual([uploads]);
    expect(imageRoots(path.parse(dir).root, uploads)).toEqual([uploads]);
    expect(imageRoots('relative/dir', uploads)).toEqual([uploads]);
    // A folder holding the home folder (`/Users`) opens all of it: not a root either.
    expect(imageRoots(path.dirname(os.homedir()), uploads)).toEqual([uploads]);
  });

  it('reads a file inside a root and refuses everything around it', async () => {
    const proj = path.join(dir, 'proj');
    const other = path.join(dir, 'other');
    fs.mkdirSync(path.join(proj, '.cache'), { recursive: true });
    fs.mkdirSync(other);
    const img = png(2, 2);
    fs.writeFileSync(path.join(proj, 'shot.png'), img);
    fs.writeFileSync(path.join(proj, '.cache', 'shot.png'), img);
    fs.writeFileSync(path.join(proj, 'credentials-shot.png'), img);
    fs.writeFileSync(path.join(other, 'secret.png'), img);
    const roots = [path.join(dir, 'uploads'), proj];
    expect(await readImageSource(path.join(proj, 'shot.png'), roots)).toEqual({ ok: true, bytes: img });
    expect(await readImageSource('shot.png', roots)).toEqual({ ok: false, reason: 'relative' });
    expect(await readImageSource(path.join(other, 'secret.png'), roots)).toEqual({ ok: false, reason: 'outside' });
    expect(await readImageSource(path.join(proj, '..', 'other', 'secret.png'), roots)).toEqual({ ok: false, reason: 'outside' });
    expect(await readImageSource(path.join(proj, '.cache', 'shot.png'), roots)).toEqual({ ok: false, reason: 'hidden' });
    expect(await readImageSource(path.join(proj, 'credentials-shot.png'), roots)).toEqual({ ok: false, reason: 'protected' });
    expect(await readImageSource(path.join(proj, 'none.png'), roots)).toEqual({ ok: false, reason: 'missing' });
    fs.writeFileSync(path.join(proj, 'big.png'), Buffer.alloc(A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES + 1));
    expect(await readImageSource(path.join(proj, 'big.png'), roots)).toEqual({ ok: false, reason: 'size' });
  });

  describe('64-bit file IDs that differ only below Number precision', () => {
    const setup = () => {
      const proj = path.join(dir, 'proj');
      const home = path.join(dir, 'home');
      fs.mkdirSync(proj);
      fs.mkdirSync(home);
      const img = png(2, 2);
      const file = path.join(proj, 'shot.png');
      fs.writeFileSync(file, img);
      return { proj, home, img, file, read: () => readImageSource(file, [path.join(dir, 'uploads'), proj], home) };
    };

    it('refuses an opened file that is not the one checked', async () => {
      const { file, read } = setup();
      fakeFileIds({ [file]: { byPath: () => FAR_IDS[0], byHandle: () => FAR_IDS[1] } });
      expect(await read()).toEqual({ ok: false, reason: 'changed' });
    });

    it('refuses when the path names another file after the read', async () => {
      const { file, read } = setup();
      let opened = false;
      fakeFileIds({ [file]: { byPath: () => (opened ? FAR_IDS[1] : FAR_IDS[0]), byHandle: () => { opened = true; return FAR_IDS[0]; } } });
      expect(await read()).toEqual({ ok: false, reason: 'changed' });
    });

    it('does not take a root for the home folder', async () => {
      const { proj, home, img, read } = setup();
      fakeFileIds({ [proj]: { byPath: () => FAR_IDS[0] }, [home]: { byPath: () => FAR_IDS[1] } });
      expect(await read()).toEqual({ ok: true, bytes: img });
    });
  });

  it('a spawn folder that resolves to home, or to a folder holding it, is not a root (a link or a junction)', async () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, 'Pictures'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Pictures', 'me.png'), png(2, 2));
    const uploads = path.join(home, '.wmux', 'uploads');
    fs.mkdirSync(uploads, { recursive: true });
    const toHome = path.join(dir, 'proj-home');
    const toAbove = path.join(dir, 'proj-above');
    fs.symlinkSync(home, toHome, 'junction');
    fs.symlinkSync(dir, toAbove, 'junction');
    for (const [root, file] of [[toHome, path.join(toHome, 'Pictures', 'me.png')], [toAbove, path.join(toAbove, 'home', 'Pictures', 'me.png')]]) {
      const roots = imageRoots(root, uploads, home);
      // The spelling passes the cheap check; what it resolves to does not.
      expect(roots).toContain(root);
      expect(await readImageSource(file, roots, home)).toEqual({ ok: false, reason: 'outside' });
    }
    // The uploads folder inside home still is one.
    fs.writeFileSync(path.join(uploads, 'ok.png'), png(2, 2));
    expect(await readImageSource(path.join(uploads, 'ok.png'), imageRoots(toHome, uploads, home), home)).toMatchObject({ ok: true });
  });

  it('refuses a path outside every root before touching the file system', async () => {
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    const lstat = vi.spyOn(fs.promises, 'lstat');
    try {
      expect(await readImageSource(path.join(dir, 'elsewhere', 'none.png'), [proj])).toEqual({ ok: false, reason: 'outside' });
      expect(lstat).not.toHaveBeenCalled();
    } finally {
      lstat.mockRestore();
    }
  });

  it.runIf(process.platform === 'win32')('refuses a device path, and a share no root is on, by its spelling', async () => {
    const roots = [path.join(dir, 'proj')];
    expect(await readImageSource('\\\\?\\C:\\x.png', roots)).toEqual({ ok: false, reason: 'outside' });
    expect(await readImageSource('\\\\.\\C:\\x.png', roots)).toEqual({ ok: false, reason: 'outside' });
    expect(await readImageSource('\\\\server\\share\\x.png', roots)).toEqual({ ok: false, reason: 'outside' });
  });

  it.skipIf(process.platform === 'win32')('refuses a link out of the root and a hard link', async () => {
    const proj = path.join(dir, 'proj');
    const other = path.join(dir, 'other');
    fs.mkdirSync(proj);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'secret.png'), png(2, 2));
    fs.symlinkSync(path.join(other, 'secret.png'), path.join(proj, 'link.png'));
    fs.linkSync(path.join(other, 'secret.png'), path.join(proj, 'hard.png'));
    const roots = [proj];
    expect(await readImageSource(path.join(proj, 'link.png'), roots)).toEqual({ ok: false, reason: 'outside' });
    expect(await readImageSource(path.join(proj, 'hard.png'), roots)).toEqual({ ok: false, reason: 'links' });
  });

  it('names the uploads folder of this instance in the "outside" refusal', () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '-dogm');
    try {
      expect(imageSourceMessage('outside')).toContain('~/.wmux-dogm/uploads/');
      vi.stubEnv('WMUX_DATA_SUFFIX', '');
      expect(imageSourceMessage('outside')).toContain('~/.wmux/uploads/');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('A2aImageStore', () => {
  const store = (now = Date.now): A2aImageStore => new A2aImageStore({ a2aDir: path.join(dir, 'a2a'), uploadsRoot: path.join(dir, 'uploads'), now });
  /** One image into the local folder: its path, or not kept. */
  const putOne = async (s: A2aImageStore, bytes: Buffer, inUse: ReadonlySet<string> = new Set()): Promise<{ ok: true; path: string } | { ok: false }> => {
    const got = await s.putLocal([{ bytes, info: { mediaType: 'image/png', width: 3, height: 3 } }], () => inUse);
    return got.ok ? { ok: true, path: got.images[0].path } : { ok: false };
  };

  it('claims an upload into the received folder under the receiver\'s own name, once', async () => {
    const s = store();
    const img = png(3, 3);
    await s.stage(HOST, sha256(img), img);
    expect(await s.has(HOST, sha256(img))).toBe(true);
    const got = await s.claim(HOST, refOf(img));
    expect(got).toMatchObject({ ok: true, path: path.join(dir, 'uploads', 'a2a', HOST, `${sha256(img)}.png`), info: { width: 3, height: 3 } });
    expect(fs.existsSync(path.join(dir, 'a2a', 'blobs-in', HOST, sha256(img)))).toBe(false);
    // Again (a resend): the received file answers.
    expect(await s.claim(HOST, refOf(img))).toMatchObject({ ok: true });
    expect(await s.has(HOST, sha256(img))).toBe(true);
    expect(await s.claim(HOST, refOf(png(4, 4)))).toEqual({ ok: false, reason: 'missing' });
  });

  it('keeps one peer within its staging share by dropping its own oldest uploads', async () => {
    let t = 1_000_000;
    const s = store(() => t);
    const big = (seed: number): Buffer => png(8, 8, A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES - 100, seed);
    const shas: string[] = [];
    for (let i = 0; i < 5; i++) {
      const img = big(i + 1);
      shas.push(sha256(img));
      // eslint-disable-next-line no-await-in-loop -- in order
      await s.stage(HOST, sha256(img), img);
      // Distinct times: mtime orders the eviction.
      const f = path.join(dir, 'a2a', 'blobs-in', HOST, sha256(img));
      fs.utimesSync(f, new Date(t), new Date(t));
      t += 1000;
    }
    const held = fs.readdirSync(path.join(dir, 'a2a', 'blobs-in', HOST));
    const bytes = held.reduce((n, f) => n + fs.statSync(path.join(dir, 'a2a', 'blobs-in', HOST, f)).size, 0);
    expect(bytes).toBeLessThanOrEqual(STAGING_PEER_MAX_BYTES);
    expect(held).toContain(shas[4]);
    expect(held).not.toContain(shas[0]);
  });

  it('sweeps received images past the retention and only its own names', async () => {
    let t = Date.now();
    const s = store(() => t);
    const img = png(2, 2);
    const got = await s.storeReceived(HOST, refOf(img), img);
    expect(got.ok).toBe(true);
    const operatorFile = path.join(dir, 'uploads', 'a2a', HOST, 'mine.png');
    fs.writeFileSync(operatorFile, 'x');
    const old = new Date(t - A2A_IMAGE_RETAIN_MS - 1000);
    fs.utimesSync(got.ok ? got.path : '', old, old);
    fs.utimesSync(operatorFile, old, old);
    t += 1;
    await s.sweep();
    expect(fs.existsSync(got.ok ? got.path : '')).toBe(false);
    expect(fs.existsSync(operatorFile)).toBe(true);
  });

  it('replaces a received file whose bytes were changed, instead of standing for them', async () => {
    const s = store();
    const img = png(2, 2);
    const got = await s.storeReceived(HOST, refOf(img), img);
    const file = got.ok ? got.path : '';
    fs.writeFileSync(file, png(3, 3));
    expect(await s.has(HOST, sha256(img))).toBe(false);
    expect(await s.received(HOST, refOf(img))).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect(await s.storeReceived(HOST, refOf(img), img)).toMatchObject({ ok: true, path: file });
    expect(fs.readFileSync(file).equals(img)).toBe(true);
  });

  it('makes room in the local folder from its oldest copies nothing open names', async () => {
    const s = store();
    const kept = png(3, 3, 4, 255);
    const keptAt = await putOne(s, kept);
    if (!keptAt.ok) throw new Error('first local copy not kept');
    const anHourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(keptAt.path, anHourAgo, anHourAgo);
    const inUse = new Set([sha256(kept)]);
    for (let i = 0; i < 101; i += 1) {
      const img = png(3, 3, 4 + i, i);
      // eslint-disable-next-line no-await-in-loop -- in order, oldest first
      const got = await putOne(s, img, inUse);
      expect(got.ok).toBe(true);
    }
    const names = fs.readdirSync(path.join(dir, 'uploads', 'a2a', 'local'));
    expect(names).toHaveLength(100);
    // The oldest of all is still named by an open task: kept.
    expect(fs.existsSync(keptAt.path)).toBe(true);
  });

  it('keeps a sender copy that a send reused after the listing', async () => {
    const s = store(() => Date.now() + 2 * 3600_000);
    const img = png(4, 4);
    const sha = await s.putOutgoing(img);
    let calls = 0;
    // Not referenced when listed; referenced by the time it would go.
    expect(await s.gcOutgoing(() => (calls++ === 0 ? new Set<string>() : new Set([sha])))).toBe(0);
    expect(await s.readOutgoing(sha)).not.toBeNull();
    expect(await s.gcOutgoing(() => new Set<string>())).toBe(1);
  });

  it('refuses to claim for a name that is not a host id, touching no file', async () => {
    const s = store();
    const img = png(3, 3);
    // Where the staging path of `../x` would lead: `a2a/blobs-in/../x/<sha>`.
    const planted = path.join(dir, 'a2a', 'x', sha256(img));
    fs.mkdirSync(path.dirname(planted), { recursive: true });
    fs.writeFileSync(planted, img);
    for (const bad of ['../x', '..', LOCAL_FOLDER]) {
      // eslint-disable-next-line no-await-in-loop -- one name at a time
      const got = await s.claim(bad as HostId, refOf(img));
      expect(fs.existsSync(planted)).toBe(true);
      expect(got).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  /** Holds the first unlink of `target` until `release()`; `reached` settles once it is held. */
  function holdUnlink(target: string): { reached: Promise<void>; release: () => void; restore: () => void } {
    const unlink = fs.promises.unlink;
    let reach!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => (reach = r));
    const released = new Promise<void>((r) => (release = r));
    let held = false;
    const spy = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (p) => {
      if (!held && String(p) === target) {
        held = true;
        reach();
        await released;
      }
      return unlink(p);
    });
    return { reached, release, restore: () => spy.mockRestore() };
  }

  /** Lets `p` finish while another operation is held; one that is (rightly) queued behind it does not. */
  const settledOrQueued = (p: Promise<unknown>): Promise<unknown> =>
    Promise.race([p.catch(() => undefined), deliberateSleep(300, 'a queued call never settles while the one before it is held')]);

  it('keeps the staging share when two uploads from one peer land at once', async () => {
    const s = store();
    const big = (seed: number): Buffer => png(8, 8, A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES - 100, seed);
    for (let i = 1; i <= 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- in order
      await s.stage(HOST, sha256(big(i)), big(i));
    }
    const x = big(10);
    const y = big(11);
    // Both start before either is written: the second must count the first when it makes room.
    await Promise.all([s.stage(HOST, sha256(x), x), s.stage(HOST, sha256(y), y)]);
    const stagingDir = path.join(dir, 'a2a', 'blobs-in', HOST);
    const held = fs.readdirSync(stagingDir);
    expect(held.reduce((n, f) => n + fs.statSync(path.join(stagingDir, f)).size, 0)).toBeLessThanOrEqual(STAGING_PEER_MAX_BYTES);
    expect(held).toEqual(expect.arrayContaining([sha256(x), sha256(y)]));
  });

  it('does not sweep an upload a resend refreshed after the sweep listed it', async () => {
    const s = store();
    const img = png(3, 3);
    await s.stage(HOST, sha256(img), img);
    const staged = path.join(dir, 'a2a', 'blobs-in', HOST, sha256(img));
    const old = new Date(Date.now() - STAGING_TTL_MS - 60_000);
    fs.utimesSync(staged, old, old);
    const gate = holdUnlink(staged);
    try {
      const sweeping = s.sweep();
      // The sweep listed the upload as unclaimed for too long and is about to drop it...
      await gate.reached;
      // ...when a resend asks whether it is here (which refreshes its time).
      const asked = s.has(HOST, sha256(img));
      await settledOrQueued(asked);
      gate.release();
      await sweeping;
      const held = await asked;
      // "Held" spares the resend its upload: the envelope's claim must then find it.
      expect((await s.claim(HOST, refOf(img))).ok).toBe(held);
    } finally {
      gate.restore();
    }
  });

  it('never evicts a local copy another send just found or wrote', async () => {
    const s = store();
    const a = png(3, 3, 4, 7);
    const first = await putOne(s, a);
    if (!first.ok) throw new Error('first local copy not kept');
    const local = path.dirname(first.path);
    // Fill the folder; the copy of `a` is the oldest, so it is the first to make room.
    for (let i = 0; i < RECEIVED_HOST_MAX_FILES - 1; i += 1) fs.writeFileSync(path.join(local, `${crypto.randomBytes(32).toString('hex')}.png`), 'x');
    const anHourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(first.path, anHourAgo, anHourAgo);
    const gate = holdUnlink(first.path);
    try {
      // Another send needs room and is about to remove the copy of `a`...
      const other = putOne(s, png(4, 4, 4, 8));
      await gate.reached;
      // ...while a send of `a` itself is handed that copy's path.
      const again = putOne(s, a);
      await settledOrQueued(again);
      gate.release();
      expect((await other).ok).toBe(true);
      const got = await again;
      if (!got.ok) throw new Error('second send of the same image not kept');
      expect(fs.existsSync(got.path)).toBe(true);
    } finally {
      gate.restore();
    }
  });

  it('reads what open messages name when its turn comes, not when it was queued', async () => {
    const s = store();
    const x = png(3, 3, 4, 21);
    const first = await putOne(s, x);
    if (!first.ok) throw new Error('first local copy not kept');
    const local = path.dirname(first.path);
    // Fill the folder; the copy of `x` is the oldest, so it is the first to make room.
    for (let i = 0; i < RECEIVED_HOST_MAX_FILES - 1; i += 1) fs.writeFileSync(path.join(local, `${crypto.randomBytes(32).toString('hex')}.png`), 'x');
    const anHourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(first.path, anHourAgo, anHourAgo);
    // An upload holds the queue, so the local staging below waits its turn.
    const writeFile = fs.promises.writeFile;
    let reach!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => (reach = r));
    const released = new Promise<void>((r) => (release = r));
    let held = false;
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof writeFile>) => {
      if (!held) {
        held = true;
        reach();
        await released;
      }
      return writeFile(...args);
    });
    try {
      const staged = s.stage(HOST, sha256(png(5, 5)), png(5, 5));
      await reached;
      // A fresh set per call: only a read made when the staging runs sees `x`.
      const open = new Set<string>();
      const putting = s.putLocal([{ bytes: png(4, 4, 4, 22), info: { mediaType: 'image/png', width: 4, height: 4 } }], () => new Set(open));
      // A message naming `x` opens after the staging was queued, before it runs.
      open.add(sha256(x));
      release();
      await staged;
      expect((await putting).ok).toBe(true);
      expect(fs.existsSync(first.path)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('takes back the copies a local staging wrote when a later step throws', async () => {
    const s = store();
    const a = png(3, 3, 4, 31);
    const b = png(4, 4, 4, 32);
    const local = path.join(dir, 'uploads', 'a2a', LOCAL_FOLDER);
    // The first image is not there yet, so it is written (two looks: putLocal's and keepReceived's); looking for the second one throws.
    const copyOfA = path.join(local, `${sha256(a)}.png`);
    let finds = 0;
    let aWritten = false;
    const find = vi.spyOn(s as unknown as { findReceived: () => Promise<null> }, 'findReceived').mockImplementation(async () => {
      finds += 1;
      if (finds === 3) {
        aWritten = fs.existsSync(copyOfA);
        throw new Error('EIO');
      }
      return null;
    });
    try {
      await expect(
        s.putLocal([
          { bytes: a, info: { mediaType: 'image/png', width: 3, height: 3 } },
          { bytes: b, info: { mediaType: 'image/png', width: 4, height: 4 } },
        ], () => new Set()),
      ).rejects.toThrow('EIO');
    } finally {
      find.mockRestore();
    }
    expect(aWritten).toBe(true);
    expect(fs.existsSync(copyOfA)).toBe(false);
  });

  it('runs the next write after one that failed', async () => {
    const s = store();
    const a = png(3, 3);
    const b = png(4, 4);
    const spy = vi.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(s.stage(HOST, sha256(a), a)).rejects.toThrow('disk full');
      await s.stage(HOST, sha256(b), b);
      expect(await s.claim(HOST, refOf(b))).toMatchObject({ ok: true });
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses bytes that do not match their ref', async () => {
    const s = store();
    const img = png(2, 2);
    expect(await s.storeReceived(HOST, { ...refOf(img), bytes: img.length + 1 }, img)).toEqual({ ok: false, reason: 'invalid' });
    expect(await s.storeReceived(HOST, { ...refOf(img), mediaType: 'image/jpeg' }, img)).toEqual({ ok: false, reason: 'invalid' });
    expect(await s.storeReceived('../etc', refOf(img), img)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('blob routes', () => {
  let server: http.Server;
  let port: number;
  let s: A2aImageStore;
  const owed: A2aOutboxRecordV1[] = [];
  /** Waits the store's answers can be held on (a slow disk), and the transfer budget. */
  const hold: { has?: Promise<void>; read?: Promise<void>; budgetMs?: number } = {};

  beforeEach(async () => {
    s = new A2aImageStore({ a2aDir: path.join(dir, 'a2a'), uploadsRoot: path.join(dir, 'uploads') });
    owed.length = 0;
    delete hold.has;
    delete hold.read;
    delete hold.budgetMs;
    const table = new A2aRouteTable();
    const store = {
      has: async (h: string, sha: string) => {
        const wait = hold.has;
        delete hold.has;
        await wait;
        return s.has(h, sha);
      },
      stage: (h: string, sha: string, b: Buffer) => s.stage(h, sha, b),
      readOutgoing: async (sha: string) => {
        const wait = hold.read;
        delete hold.read;
        await wait;
        return s.readOutgoing(sha);
      },
    };
    registerImageRoutes(table, {
      store,
      outbox: { pending: (hostId) => owed.filter((r) => r.hostId === hostId).map((r) => structuredClone(r)) },
      log: quiet,
      transferBudgetMs: (bytes) => hold.budgetMs ?? bytes,
    });
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      // The peer is named by a test header here (the real listener authenticates it).
      const hostId = req.headers['x-test-host'] === 'other' ? OTHER : HOST;
      void table.handle(req, res, url, url.pathname, { peerId: 'p', hostId, name: 'A' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  function send(method: string, sha: string, body?: Buffer, chunked = false, other = false): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = chunked ? { 'Transfer-Encoding': 'chunked' } : body ? { 'Content-Length': body.length } : {};
      if (other) headers['x-test-host'] = 'other';
      const req = http.request(
        { host: '127.0.0.1', port, method, path: `${A2A_ROUTES.blobs}/${sha}`, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      req.on('error', (err) => (/ECONNRESET|EPIPE|socket hang up/.test(String(err)) ? resolve({ status: -1, body: Buffer.alloc(0) }) : reject(err)));
      if (body && chunked) {
        for (let at = 0; at < body.length; at += 256 * 1024) req.write(body.subarray(at, at + 256 * 1024));
        req.end();
      } else {
        req.end(body);
      }
    });
  }

  it('lets only an image upload declare more than a JSON body', () => {
    expect(requestBodyMax('PUT', `${A2A_ROUTES.blobs}/${'a'.repeat(64)}`)).toBe(A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES);
    expect(requestBodyMax('POST', `${A2A_ROUTES.blobs}/${'a'.repeat(64)}`)).toBe(A2A_REQUEST_BODY_MAX);
    expect(requestBodyMax('PUT', A2A_ROUTES.messages)).toBe(A2A_REQUEST_BODY_MAX);
  });

  it('keeps a checked upload and refuses a wrong hash or a non-image', async () => {
    const img = png(5, 5);
    expect((await send('PUT', sha256(img), img)).status).toBe(200);
    expect(await s.has(HOST, sha256(img))).toBe(true);
    expect((await send('PUT', sha256(png(6, 6)), img)).status).toBe(400);
    const html = Buffer.from('<html>png</html>');
    expect((await send('PUT', sha256(html), html)).status).toBe(400);
  });

  it('refuses a chunked upload (no Content-Length) once it passes one image', async () => {
    const tooBig = png(8, 8, A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES + 1024);
    const res = await send('PUT', sha256(tooBig), tooBig, true);
    // 413, or the connection cut right after it.
    expect([413, -1]).toContain(res.status);
    expect(await s.has(HOST, sha256(tooBig))).toBe(false);
  });

  it('serves an image only while an open record owes it to that peer', async () => {
    const img = png(7, 7);
    await s.putOutgoing(img);
    expect((await send('GET', sha256(img))).status).toBe(404);
    owed.push({
      v: 1, epoch: 'e', seq: 1, hostId: HOST, state: 'pending', attempts: 0, createdAt: 'x', updatedAt: 'x',
      envelope: { protocol: A2A_REMOTE_PROTOCOL, linkId: 'l', linkVersion: 2, messageId: 'm', kind: 'task', text: 't', images: [refOf(img)], sentAt: 'x' },
    });
    const got = await send('GET', sha256(img));
    expect(got.status).toBe(200);
    expect(got.body.equals(img)).toBe(true);
    // Owed to HOST, not to another paired PC.
    expect((await send('GET', sha256(img), undefined, false, true)).status).toBe(404);
  });

  const owe = (img: Buffer): void => {
    owed.push({
      v: 1, epoch: 'e', seq: owed.length + 1, hostId: HOST, state: 'pending', attempts: 0, createdAt: 'x', updatedAt: 'x',
      envelope: { protocol: A2A_REMOTE_PROTOCOL, linkId: 'l', linkVersion: 2, messageId: `m${owed.length}`, kind: 'task', text: 't', images: [refOf(img)], sentAt: 'x' },
    });
  };

  /** A request whose body is started but never finished: it holds the peer's upload slot. */
  function stalledPut(sha: string): http.ClientRequest {
    const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `${A2A_ROUTES.blobs}/${sha}`, headers: { 'Content-Length': 2 * 1024 * 1024 } });
    req.on('error', () => undefined);
    req.write(Buffer.alloc(1024));
    return req;
  }

  it('drains the body of a 400 and of a 429, so each answer arrives whole', async () => {
    const body = Buffer.alloc(1024 * 1024, 1);
    const bad = await send('PUT', 'not-a-hash', body);
    expect(bad.status).toBe(400);
    const img = png(9, 9);
    hold.has = new Promise<void>(() => undefined);
    const first = stalledPut(sha256(img));
    await vi.waitFor(() => expect(hold.has).toBeUndefined(), { timeout: 10_000 });
    const busy = await send('PUT', sha256(png(10, 10)), body);
    expect(busy.status).toBe(429);
    expect(JSON.parse(busy.body.toString('utf8'))).toEqual({ ok: false, error: 'unavailable' });
    first.destroy();
  });

  it('gives an upload slot back when the client leaves mid-request', async () => {
    const img = png(5, 5);
    await s.storeReceived(HOST, refOf(img), img);
    hold.has = new Promise<void>(() => undefined);
    const gone = stalledPut(sha256(img));
    await vi.waitFor(() => expect(hold.has).toBeUndefined(), { timeout: 10_000 });
    gone.destroy();
    await vi.waitFor(async () => expect((await send('PUT', sha256(img), img)).status).toBe(200), { timeout: 10_000 });
  });

  it('gives a download slot back when the client leaves mid-request, and cuts a reader past its budget', async () => {
    const img = png(7, 7);
    await s.putOutgoing(img);
    owe(img);
    hold.read = new Promise<void>(() => undefined);
    const gone = http.get({ host: '127.0.0.1', port, path: `${A2A_ROUTES.blobs}/${sha256(img)}` });
    gone.on('error', () => undefined);
    await vi.waitFor(() => expect(hold.read).toBeUndefined(), { timeout: 10_000 });
    gone.destroy();
    await vi.waitFor(async () => expect((await send('GET', sha256(img))).status).toBe(200), { timeout: 10_000 });

    // A reader that stops reading a large image is cut at its budget, and the slot is free again.
    const big = png(64, 64, A2A_REMOTE_IMAGE_LIMITS.IMAGE_MAX_BYTES - 4096, 3);
    await s.putOutgoing(big);
    owe(big);
    hold.budgetMs = 200;
    let slow!: http.ClientRequest;
    // Headers arrive after the route set the reader's budget, so the old budget can go now.
    await new Promise<void>((answered) => {
      slow = http.get({ host: '127.0.0.1', port, path: `${A2A_ROUTES.blobs}/${sha256(big)}` }, (res) => {
        res.pause();
        answered();
      });
      slow.on('error', () => undefined);
    });
    hold.budgetMs = 60_000;
    // Busy (429) until the paused reader is cut at its 200 ms budget.
    await vi.waitFor(async () => expect((await send('GET', sha256(img))).status).toBe(200), { timeout: 10_000 });
    slow.destroy();
  });

  it('keeps an upload HEAD answered for until its envelope claims it', async () => {
    const img = png(5, 5);
    await s.stage(HOST, sha256(img), img);
    const staged = path.join(dir, 'a2a', 'blobs-in', HOST, sha256(img));
    // Unclaimed for just under the staging TTL when the joiner asks about it.
    const old = new Date(Date.now() - STAGING_TTL_MS + 60_000);
    fs.utimesSync(staged, old, old);
    // 200: the joiner will not upload it again, and posts the envelope next.
    expect((await send('HEAD', sha256(img))).status).toBe(200);
    // A sweep two minutes on, past the TTL of the time it had when asked.
    await new A2aImageStore({ a2aDir: path.join(dir, 'a2a'), uploadsRoot: path.join(dir, 'uploads'), now: () => Date.now() + 120_000 }).sweep();
    expect(fs.existsSync(staged)).toBe(true);
    expect(await s.claim(HOST, refOf(img))).toMatchObject({ ok: true });
  });

  it('keeps the connection usable after draining a full upload it already holds', async () => {
    const img = png(64, 64, 1536 * 1024, 7);
    await s.storeReceived(HOST, refOf(img), img);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const once = (method: string, body?: Buffer): Promise<{ status: number; reused: boolean }> =>
        new Promise((resolve, reject) => {
          const req = http.request(
            { host: '127.0.0.1', port, method, agent, path: `${A2A_ROUTES.blobs}/${sha256(img)}`, headers: body ? { 'Content-Length': body.length } : {} },
            (res) => {
              res.resume();
              res.on('end', () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
            },
          );
          req.on('error', reject);
          req.end(body);
        });
      expect(await once('PUT', img)).toEqual({ status: 200, reused: false });
      // The same socket answers the next request: nothing was left unread on it.
      expect(await once('HEAD')).toEqual({ status: 200, reused: true });
    } finally {
      agent.destroy();
    }
  });

  it('says by HEAD whether it holds an image, and answers a full upload of one it holds with a clean 200', async () => {
    const img = png(64, 64, 1536 * 1024, 7);
    expect((await send('HEAD', sha256(img))).status).toBe(404);
    await s.storeReceived(HOST, refOf(img), img);
    expect((await send('HEAD', sha256(img))).status).toBe(200);
    expect((await send('HEAD', sha256(img), undefined, false, true)).status).toBe(404);
    // The whole body is read (and discarded) before the answer: no reset, on any OS.
    const res = await send('PUT', sha256(img), img);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.toString('utf8'))).toEqual({ ok: true });
    expect(fs.existsSync(path.join(dir, 'a2a', 'blobs-in', HOST, sha256(img)))).toBe(false);
  });
});

// --- sender and receiver over the ledger ----------------------------------------

let links: LinkStore;
let tasks: A2aTaskService;
let outbox: OutboxStore;

function ledger(): void {
  links = new LinkStore({ dir, scheduleHarden: quiet });
  outbox = new OutboxStore({ dir, scheduleHarden: quiet });
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: quiet });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'm', daemonEpoch: 1 } });
}

function activeLink(local: { workspaceId: string; paneId: string }, remote: { workspaceId: string; paneId: string }): string {
  const linkId = crypto.randomUUID();
  links.receiveProposal({ linkId, local: { kind: 'pane', ...local }, remote: { hostId: HOST, kind: 'pane', ...remote }, allow: { outbound: true, inbound: true } });
  links.accept(linkId);
  return linkId;
}

describe('sending images', () => {
  let n = 0;
  let copies: Set<string>;
  const prepared = (img: Buffer): PreparedImage => ({ ref: refOf(img), name: 'shot.png', path: path.join(dir, 'blobs', sha256(img)), width: 2, height: 2 });
  const deps = (features: ReadonlySet<string> | undefined, imgs: Buffer[] = [png(2, 2)]): OutboundDeps => ({
    linkStore: links,
    taskService: tasks,
    outbox,
    aliasFor: (l) => linkAlias(l, 'pc-b'),
    mintId: () => `msg-${++n}`,
    peerFeatures: () => features,
    images: {
      prepare: async () => {
        for (const i of imgs) copies.add(sha256(i));
        return { ok: true, images: imgs.map(prepared) };
      },
      hasOutgoing: async (sha) => copies.has(sha),
    },
  });
  const FROM = { workspaceId: 'ws-a', name: 'Web', paneId: 'pane-a' };

  beforeEach(() => {
    ledger();
    n = 0;
    copies = new Set();
  });

  it('refuses images to a PC never seen, and sends the text with a note to one that does not take them', async () => {
    const linkId = activeLink({ workspaceId: 'ws-a', paneId: 'pane-a' }, { workspaceId: 'ws-b', paneId: 'pane-b' });
    const unseen = await sendRemoteTask(deps(undefined), { linkId, from: FROM, title: '', text: 'look', images: ['/x.png'] });
    expect(unseen).toMatchObject({ ok: false, error: expect.stringMatching(/^unavailable: .*not known whether its wmux takes images/) });
    expect(outbox.pending(HOST)).toHaveLength(0);

    const old = await sendRemoteTask(deps(new Set(['link-offer.1'])), { linkId, from: FROM, title: '', text: 'look', images: ['/x.png'] });
    expect(old).toMatchObject({ ok: true, note: expect.stringContaining('does not take images') });
    const [rec] = outbox.pending(HOST);
    expect(rec.envelope.images).toBeUndefined();
    expect(rec.envelope.text).toBe("look\n\n[1 image omitted: the receiving PC's wmux does not take images]");
  });

  it('carries the refs to a PC that takes them, with file parts in the sender ledger', async () => {
    const linkId = activeLink({ workspaceId: 'ws-a', paneId: 'pane-a' }, { workspaceId: 'ws-b', paneId: 'pane-b' });
    const img = png(2, 2);
    const res = await sendRemoteTask(deps(new Set(['images.1']), [img]), { linkId, from: FROM, title: '', text: '', images: ['/x.png'] });
    expect(res.ok).toBe(true);
    const [rec] = outbox.pending(HOST);
    expect(rec.envelope).toMatchObject({ kind: 'task', text: '', images: [refOf(img)] });
    const task = tasks.getTask(res.ok ? res.taskId : '')!;
    expect(task.metadata.title).toBe('1 image');
    expect(task.history[0].parts).toEqual([
      { kind: 'file', file: { name: 'shot.png', mimeType: 'image/png', uri: expect.stringMatching(/^file:/) }, metadata: { sha256: sha256(img), bytes: img.length, width: 2, height: 2 } },
    ]);
  });

  it('sends an image-only reply, and a rebuilt one drops (with a note) an image whose copy is gone', async () => {
    const linkId = activeLink({ workspaceId: 'ws-a', paneId: 'pane-a' }, { workspaceId: 'ws-b', paneId: 'pane-b' });
    const marker = { v: 1 as const, linkId, hostId: HOST, direction: 'inbound' as const, delivered: true, kind: 'pane' as const };
    const inbound = (id: string, history: Message[]) => tasks.createTask({
      id: remoteTaskId(linkId, id), title: 't', from: { workspaceId: `remote:${linkId}`, name: 'B' }, to: { workspaceId: 'ws-a', name: 'Web', paneId: 'pane-a' },
      history: [{ kind: 'message', messageId: id, role: 'user', parts: [{ kind: 'text', text: 'shot please' }] }, ...history],
      remote: { ...marker, messageId: id },
    });
    const a = png(2, 2, 4, 1);
    const b = png(2, 2, 4, 2);
    const d = deps(new Set(['images.1']), [a, b]);

    // An image-only reply goes out with its refs (it used to be skipped for having no text).
    await inbound('in-1', []);
    expect(await sendRemoteReply(d, { taskId: remoteTaskId(linkId, 'in-1'), workspaceId: 'ws-a', text: '', images: ['/a.png', '/b.png'] })).toMatchObject({ ok: true });
    const reply = outbox.pending(HOST).find((r) => r.envelope.kind === 'reply')!;
    expect(reply.envelope).toMatchObject({ text: '', images: [refOf(a), refOf(b)] });

    // A reply still owed after a restart, rebuilt from the ledger once one sender copy was swept.
    const file = (img: Buffer) => ({ kind: 'file' as const, file: { mimeType: 'image/png' }, metadata: { sha256: sha256(img), bytes: img.length } });
    await inbound('in-2', [{ kind: 'message', messageId: 'r-2', role: 'agent', parts: [file(a), file(b)] }]);
    copies = new Set([sha256(a)]);
    expect(await syncRemoteTask(d, remoteTaskId(linkId, 'in-2'))).toMatchObject({ ok: true });
    const rebuilt = outbox.pending(HOST).find((r) => r.envelope.messageId === 'r-2')!;
    expect(rebuilt.envelope.images).toEqual([refOf(a)]);
    expect(rebuilt.envelope.text).toBe('[1 image omitted: this PC no longer has it]');
  });
});

describe('receiving images by pull (this PC joined the sender)', () => {
  let s: A2aImageStore;
  let deps: InboundDeps;
  let attempts: Map<string, number>;

  beforeEach(() => {
    ledger();
    s = new A2aImageStore({ a2aDir: path.join(dir, 'a2a'), uploadsRoot: path.join(dir, 'uploads') });
    attempts = new Map();
    deps = { linkStore: links, taskService: tasks, broadcast: vi.fn(), aliasFor: (l) => linkAlias(l, 'pc-b'), images: { store: s, pullAttempts: attempts } };
  });

  const envOf = (linkId: string, images: A2aRemoteImageRef[], text = 'see') => ({
    protocol: A2A_REMOTE_PROTOCOL, linkId, linkVersion: 2, messageId: 'm-1', kind: 'task', text, images, sentAt: new Date().toISOString(),
  });

  it('stores a pulled image and records its path on the ledger', async () => {
    const linkId = activeLink({ workspaceId: 'ws-a', paneId: 'pane-a' }, { workspaceId: 'ws-b', paneId: 'pane-b' });
    const img = png(9, 4);
    const pull: ImagePull = async () => ({ ok: true, bytes: img });
    const res = await acceptInbound(envOf(linkId, [refOf(img)]), { hostId: HOST, pull }, deps);
    expect(res).toMatchObject({ ok: true, duplicate: false });
    const task = tasks.getTask(remoteTaskId(linkId, 'm-1'))!;
    const part = task.history[0].parts[1];
    expect(part).toMatchObject({ kind: 'file', file: { mimeType: 'image/png' }, metadata: { sha256: sha256(img), width: 9, height: 4 } });
    expect(fs.existsSync(new URL((part as { file: { uri: string } }).file.uri))).toBe(true);
    // A resend is a duplicate and fetches nothing.
    const again = await acceptInbound(envOf(linkId, [refOf(img)]), { hostId: HOST, pull: async () => { throw new Error('no fetch'); } }, deps);
    expect(again).toMatchObject({ ok: true, duplicate: true });
  });

  it('retries a failing pull a few times, then delivers the text with the image marked not received', async () => {
    const linkId = activeLink({ workspaceId: 'ws-a', paneId: 'pane-a' }, { workspaceId: 'ws-b', paneId: 'pane-b' });
    const img = png(2, 2);
    const pull: ImagePull = async () => ({ ok: false, permanent: false, detail: 'timeout' });
    for (let i = 1; i < PULL_MAX_ATTEMPTS; i++) {
      // eslint-disable-next-line no-await-in-loop -- one redelivery at a time
      expect(await acceptInbound(envOf(linkId, [refOf(img)]), { hostId: HOST, pull }, deps)).toEqual({ ok: false, error: 'unavailable' });
    }
    expect(await acceptInbound(envOf(linkId, [refOf(img)]), { hostId: HOST, pull }, deps)).toMatchObject({ ok: true, duplicate: false });
    const parts = tasks.getTask(remoteTaskId(linkId, 'm-1'))!.history[0].parts;
    expect(parts).toEqual([{ kind: 'text', text: 'see' }, { kind: 'file', file: { mimeType: 'image/png' }, metadata: { sha256: sha256(img), bytes: img.length, notReceived: 'missing' } }]);
    expect(attempts.size).toBe(0);
  });

  it('does not count a pull this PC aborted (its stream ended)', async () => {
    const linkId = activeLink({ workspaceId: 'ws-a', paneId: 'pane-a' }, { workspaceId: 'ws-b', paneId: 'pane-b' });
    const img = png(2, 2);
    const pull: ImagePull = async () => ({ ok: false, permanent: false, detail: 'aborted', aborted: true });
    for (let i = 0; i < PULL_MAX_ATTEMPTS + 2; i++) {
      // eslint-disable-next-line no-await-in-loop -- one redelivery at a time
      expect(await acceptInbound(envOf(linkId, [refOf(img)]), { hostId: HOST, pull }, deps)).toEqual({ ok: false, error: 'unavailable' });
    }
    expect(tasks.getTask(remoteTaskId(linkId, 'm-1'))).toBeUndefined();
  });

  it('gives up at once on a permanent failure, and refuses images on a state envelope', async () => {
    const linkId = activeLink({ workspaceId: 'ws-a', paneId: 'pane-a' }, { workspaceId: 'ws-b', paneId: 'pane-b' });
    const img = png(2, 2);
    const res = await acceptInbound(envOf(linkId, [refOf(img)]), { hostId: HOST, pull: async () => ({ ok: false, permanent: true, detail: 'http' }) }, deps);
    expect(res).toMatchObject({ ok: true });
    const bad = { ...envOf(linkId, [refOf(img)]), kind: 'state', taskId: remoteTaskId(linkId, 'm-1'), state: 'working' };
    expect(await acceptInbound(bad, { hostId: HOST }, deps)).toEqual({ ok: false, error: 'bad-request' });
  });

  it('answers attachment-missing to a joiner whose upload is not here', async () => {
    const linkId = activeLink({ workspaceId: 'ws-a', paneId: 'pane-a' }, { workspaceId: 'ws-b', paneId: 'pane-b' });
    expect(await acceptInbound(envOf(linkId, [refOf(png(2, 2))]), { hostId: HOST }, deps)).toEqual({ ok: false, error: 'attachment-missing' });
    expect(tasks.getTask(remoteTaskId(linkId, 'm-1'))).toBeUndefined();
  });
});

describe('JoinerSession image uploads', () => {
  const sessions: JoinerSession[] = [];
  afterEach(async () => {
    for (const x of sessions.splice(0)) await x.stop();
  });

  const img = png(2, 2);
  /** Two replies to one host, the first carrying an image. */
  function replies(): A2aOutboxRecordV1[] {
    return [1, 2].map((seq) => ({
      v: 1, epoch: 'e', seq, hostId: HOST, state: 'pending', attempts: 0, createdAt: new Date().toISOString(), updatedAt: 'x',
      envelope: {
        protocol: A2A_REMOTE_PROTOCOL, linkId: 'l', linkVersion: 2, messageId: `m${seq}`, kind: 'reply', taskId: 't', text: `r${seq}`,
        ...(seq === 1 ? { images: [refOf(img)] } : {}), sentAt: 'x',
      },
    }));
  }

  /**
   * A session over `records`, with `bytes` (the image transfers, or any other
   * client call) in place of the defaults; what it posted, refused and showed.
   */
  function run(
    records: A2aOutboxRecordV1[],
    bytes: Partial<SessionClient>,
  ): { posted: string[]; refused: Array<{ seq: number; code: string; detail?: string }>; warnings: string[]; states: string[]; session: JoinerSession } {
    const posted: string[] = [];
    const warnings: string[] = [];
    const states: string[] = [];
    const refused: Array<{ seq: number; code: string; detail?: string }> = [];
    const client: SessionClient = {
      requestJson: async (_m, p, body) => {
        if (p === A2A_ROUTES.messages) posted.push((body as { messageId: string }).messageId);
        return { status: 200, json: { ok: true, duplicate: false } };
      },
      openStream: async function* (_p, { signal }) {
        yield { event: 'hello', data: { epoch: 'e', features: ['images.1'] } };
        await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
      },
      ...bytes,
    };
    const open = (): A2aOutboxRecordV1[] => records.filter((r) => r.state === 'pending');
    const session = new JoinerSession({
      hostId: HOST,
      host: () => ({ v: 1, hostId: HOST, name: 'B', addresses: ['127.0.0.1'], port: 1, fingerprint256: 'AB', peerId: 'p', createdAt: 'x' }),
      credential: () => ({ peerId: '22222222-2222-4222-8222-222222222222', secret: 'a'.repeat(43) }),
      outbox: {
        epoch: 'e',
        head: () => (open()[0] ? structuredClone(open()[0]) : undefined),
        openCount: () => open().length,
        markSent: (_h, seq) => records[seq - 1],
        markOutcomeUnknown: (_h, seq) => records[seq - 1],
        ack: (_h, c) => {
          for (const r of records) if (r.seq <= c.seq && r.state === 'pending') r.state = 'acked';
          return 1;
        },
        refuse: (_h, seq, code) => {
          records[seq - 1].state = 'refused';
          records[seq - 1].lastError = code;
          return records[seq - 1];
        },
      },
      accept: async () => ({ ok: true, duplicate: false }),
      onRefused: (rec, code, detail) => void refused.push({ seq: rec.seq, code, ...(detail ? { detail } : {}) }),
      reconcileLinks: async () => undefined,
      onStatus: (s) => void states.push(s.state),
      images: { readOutgoing: async () => img },
      timing: { backoffMinMs: 5, backoffMaxMs: 20, livenessMs: 60_000 },
      client: () => client,
      log: (level, msg) => void (level === 'warn' && warnings.push(msg)),
    });
    sessions.push(session);
    session.start();
    return { posted, refused, warnings, states, session };
  }

  /** An upload that never answers on its own: only an abort of its signal ends it. */
  function hangingPut(): { putBytes: NonNullable<SessionClient['putBytes']>; puts: () => number; aborted: () => boolean } {
    let puts = 0;
    let aborted = false;
    return {
      putBytes: (_p, _b, _t, signal) => {
        puts += 1;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new PinnedClientError('aborted', 'aborted', { sent: true }));
          }, { once: true });
        });
      },
      puts: () => puts,
      aborted: () => aborted,
    };
  }

  it('gives up a message whose uploads keep timing out, and the next message still goes', async () => {
    let puts = 0;
    const { posted, refused } = run(replies(), {
      putBytes: async () => {
        puts += 1;
        throw new PinnedClientError('timeout', 'no answer within 30000ms', { sent: true });
      },
    });
    await vi.waitFor(() => expect(posted).toEqual(['m2']), { timeout: 10_000 });
    expect(puts).toBe(IMAGE_UPLOAD_MAX_FAILURES);
    expect(refused).toEqual([{ seq: 1, code: 'attachment-failed', detail: expect.stringContaining('30 seconds') }]);
  });

  it('ends an upload in flight when the session stops, and sends nothing after it', async () => {
    const records = replies();
    const hang = hangingPut();
    const { posted, refused, warnings, session } = run(records, { putBytes: hang.putBytes });
    await vi.waitFor(() => expect(hang.puts()).toBe(1), { timeout: 5_000 });
    let stopped = false;
    void session.stop().then(() => (stopped = true));
    await vi.waitFor(() => expect({ aborted: hang.aborted(), stopped }).toEqual({ aborted: true, stopped: true }), { timeout: 5_000 });
    expect(hang.puts()).toBe(1);
    expect(posted).toEqual([]);
    // Stopped, not failed: the message is still owed, and no failed upload was counted.
    expect(refused).toEqual([]);
    expect(records.find((r) => r.state === 'pending')?.seq).toBe(1);
    expect(warnings.filter((w) => w.includes('image upload'))).toEqual([]);

    // The next session (after a re-pair, a restart) sends it: upload, then the message.
    let puts = 0;
    const next = run(records, {
      putBytes: async () => {
        puts += 1;
        return { status: 200, json: { ok: true } };
      },
    });
    await vi.waitFor(() => expect(next.posted).toEqual(['m1', 'm2']), { timeout: 10_000 });
    expect(puts).toBe(1);
    expect(next.refused).toEqual([]);
  });

  it('does not post a message whose last upload was answered after the session stopped', async () => {
    const records = replies();
    let answer!: (a: { status: number; json: unknown }) => void;
    let puts = 0;
    const posts: string[] = [];
    const { refused, states, session } = run(records, {
      putBytes: () => {
        puts += 1;
        // Answered by the test, whatever the signal says: the answer lands after the stop.
        return new Promise((resolve) => (answer = resolve));
      },
      // The other PC was re-paired: a POST through this (old) session meets a certificate it does not pin.
      requestJson: async (_m, p, body) => {
        if (p === A2A_ROUTES.messages) {
          posts.push((body as { messageId: string }).messageId);
          throw new PinnedClientError('fingerprint-mismatch', 'not the pinned certificate', { sent: false });
        }
        return { status: 200, json: { ok: true } };
      },
    });
    await vi.waitFor(() => expect(puts).toBe(1), { timeout: 5_000 });
    const stopping = session.stop();
    answer({ status: 200, json: { ok: true } });
    await stopping;
    expect(posts).toEqual([]);
    expect(states).not.toContain('identity-changed');
    expect(session.current().state).not.toBe('identity-changed');
    // Still owed, not refused: the next session sends it.
    expect(refused).toEqual([]);
    expect(records.find((r) => r.state === 'pending')?.seq).toBe(1);
  });

  it('does not post from a send whose session was stopped, even when it is started again before that send ends', async () => {
    const records = replies();
    const events: string[] = [];
    let answerFirst!: (a: { status: number; json: unknown }) => void;
    // Started again before the stop settles, the session runs the stopped stream loop too; ending
    // every stream when the test is done lets the final stop end both.
    let endStreams!: () => void;
    const ended = new Promise<void>((r) => (endStreams = r));
    const { session } = run(records, {
      openStream: async function* (_p, { signal }) {
        yield { event: 'hello', data: { epoch: 'e', features: ['images.1'] } };
        await Promise.race([ended, new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }))]);
      },
      putBytes: () => {
        events.push('put');
        // The first upload is answered by the test, after the restart; later ones at once.
        if (events.filter((e) => e === 'put').length === 1) return new Promise((resolve) => (answerFirst = resolve));
        return Promise.resolve({ status: 200, json: { ok: true } });
      },
      requestJson: async (_m, p, body) => {
        if (p === A2A_ROUTES.messages) events.push(`post:${(body as { messageId: string }).messageId}`);
        return { status: 200, json: { ok: true, duplicate: false } };
      },
    });
    await vi.waitFor(() => expect(events).toEqual(['put']), { timeout: 5_000 });
    // Stopped and started again at once: the restart gets a new stop signal.
    const stopping = session.stop();
    session.start();
    answerFirst({ status: 200, json: { ok: true } });
    try {
      // The stopped send posts nothing: the restarted session uploads again, then posts.
      await vi.waitFor(() => expect(events).toContain('post:m2'), { timeout: 10_000 });
      expect(events.slice(0, 3)).toEqual(['put', 'put', 'post:m1']);
    } finally {
      endStreams();
      await session.stop();
      await stopping;
    }
  });

  it('does not report a changed identity for a message whose POST failed after the session stopped', async () => {
    const records = replies();
    let fail!: () => void;
    let posts = 0;
    const { refused, states, session } = run(records, {
      putBytes: async () => ({ status: 200, json: { ok: true } }),
      // The other PC was re-paired while the POST was out: it fails on a certificate this (old) session does not pin.
      requestJson: (_m, p) => {
        if (p !== A2A_ROUTES.messages) return Promise.resolve({ status: 200, json: { ok: true } });
        posts += 1;
        return new Promise((_resolve, reject) => (fail = () => reject(new PinnedClientError('fingerprint-mismatch', 'not the pinned certificate', { sent: false }))));
      },
    });
    await vi.waitFor(() => expect(posts).toBe(1), { timeout: 5_000 });
    const stopping = session.stop();
    fail();
    await stopping;
    expect(states).not.toContain('identity-changed');
    expect(session.current().state).not.toBe('identity-changed');
    // Still owed, not refused: the next session sends it.
    expect(refused).toEqual([]);
    expect(records.find((r) => r.state === 'pending')?.seq).toBe(1);
  });

  it('ends an upload in flight when the certificate is not the pinned one', async () => {
    const records = replies();
    const hang = hangingPut();
    let mismatch!: () => void;
    const pinFails = new Promise<void>((r) => (mismatch = r));
    const { posted, refused, states } = run(records, {
      putBytes: hang.putBytes,
      openStream: async function* () {
        yield { event: 'hello', data: { epoch: 'e', features: ['images.1'] } };
        await pinFails;
        throw new PinnedClientError('fingerprint-mismatch', 'not the pinned certificate', { sent: false });
      },
    });
    await vi.waitFor(() => expect(hang.puts()).toBe(1), { timeout: 5_000 });
    mismatch();
    await vi.waitFor(() => expect(hang.aborted()).toBe(true), { timeout: 5_000 });
    expect(states).toContain('identity-changed');
    expect(posted).toEqual([]);
    expect(refused).toEqual([]);
    expect(records.find((r) => r.state === 'pending')?.seq).toBe(1);
  });

  it('asks first and does not upload an image the other PC already holds', async () => {
    let puts = 0;
    const asked: string[] = [];
    const { posted, refused } = run(replies(), {
      headStatus: async (p) => {
        asked.push(p);
        return 200;
      },
      putBytes: async () => {
        puts += 1;
        return { status: 200, json: { ok: true } };
      },
    });
    await vi.waitFor(() => expect(posted).toEqual(['m1', 'm2']), { timeout: 10_000 });
    expect(asked).toEqual([`${A2A_ROUTES.blobs}/${sha256(img)}`]);
    expect(puts).toBe(0);
    expect(refused).toEqual([]);
  });
});
