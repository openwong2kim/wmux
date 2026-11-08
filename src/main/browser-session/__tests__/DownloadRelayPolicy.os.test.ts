// Downloads of a shared Chrome's default context, with grants (C3b): each goes
// to the one client holding its frame, into that client's folder, under its
// guid, before the client hears it completed; anyone else's is cancelled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientRef } from '../CdpPipeMux';
import { DownloadRelayPolicy, makeDownloadRelayDir, removeDownloadRelayDir, sweepDeadDownloadRelayDirs, type RelayFs } from '../DownloadRelayPolicy';

const roots: string[] = [];
const policies: DownloadRelayPolicy[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const p of policies.splice(0)) p.dispose();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ext = (label: string): ClientRef => ({ kind: 'external', label });

interface Told { client: ClientRef; method: string; params: Record<string, unknown>; sessionId?: string; fileThere?: boolean }

function setup(frames: Map<string, ClientRef>, fsOverride?: Partial<RelayFs>) {
  const dir = tempDir('wmux-dl-test-');
  const told: Told[] = [];
  const cancelled: string[] = [];
  let watched: { file: string } | null = null;
  const policy = new DownloadRelayPolicy({
    dir,
    contextOf: (client, frameId) => (frames.get(frameId) === client ? null : undefined),
    emit: (client, method, params, sessionId) => {
      told.push({ client, method, params, ...(sessionId !== undefined && { sessionId }), ...(watched && { fileThere: fs.existsSync(watched.file) }) });
      return true;
    },
    cancel: async (guid) => { cancelled.push(guid); },
    ...(fsOverride && { fs: { ...defaultFs(), ...fsOverride } }),
  });
  policies.push(policy);
  const ask = (client: ClientRef, params: Record<string, unknown>, sessionId?: string) =>
    policy.filter(client, { method: 'Browser.setDownloadBehavior', params, ...(sessionId !== undefined && { sessionId }) });
  const write = (guid: string, content: string) => fs.writeFileSync(path.join(dir, guid), content);
  return { dir, told, cancelled, policy, ask, write, watch: (file: string) => { watched = { file }; } };
}

function defaultFs(): RelayFs {
  return {
    rename: (a, b) => fs.promises.rename(a, b),
    copyFile: (a, b, m) => fs.promises.copyFile(a, b, m),
    fsync: async (file) => { const h = await fs.promises.open(file, 'r+'); try { await h.sync(); } finally { await h.close(); } },
    unlink: (f) => fs.promises.unlink(f),
    lstat: (p) => fs.lstatSync(p),
    realpath: (p) => fs.realpathSync.native(p),
  };
}

const begin = (guid: string, frameId: string) => ({ guid, frameId, url: 'https://x.test/f.bin', suggestedFilename: 'f.bin' });

describe('DownloadRelayPolicy', () => {
  it('two workspaces download at once: each gets only its own file and events, the file in place before "completed"', async () => {
    const a = ext('a');
    const b = ext('b');
    const { told, ask, write, policy, watch } = setup(new Map([['FA', a], ['FB', b]]));
    const dirA = tempDir('wmux-dl-a-');
    const dirB = tempDir('wmux-dl-b-');
    expect(ask(a, { behavior: 'allowAndName', downloadPath: dirA, eventsEnabled: true })).toEqual({ absorb: {}, reason: 'default-context-downloads' });
    expect(ask(b, { behavior: 'allowAndName', downloadPath: dirB, eventsEnabled: true }, 'S-B')).toEqual({ absorb: {}, reason: 'default-context-downloads' });
    const ga = 'aaaaaaaa-0000-4000-8000-000000000001';
    const gb = 'bbbbbbbb-0000-4000-8000-000000000002';
    watch(path.join(dirA, ga));
    policy.downloadEvent('Browser.downloadWillBegin', begin(ga, 'FA'));
    policy.downloadEvent('Browser.downloadWillBegin', begin(gb, 'FB'));
    write(ga, 'A-bytes');
    write(gb, 'B-bytes');
    policy.downloadEvent('Browser.downloadProgress', { guid: ga, state: 'inProgress', receivedBytes: 3 });
    policy.downloadEvent('Browser.downloadProgress', { guid: ga, state: 'completed', receivedBytes: 7 });
    policy.downloadEvent('Browser.downloadProgress', { guid: gb, state: 'completed', receivedBytes: 7 });
    await vi.waitFor(() => expect(told.filter((t) => t.params.state === 'completed')).toHaveLength(2), { timeout: 5_000 });
    // The file was in the client's folder when it heard 'completed', and not before it began.
    expect(told.find((t) => t.client === a && t.params.state === 'completed')?.fileThere).toBe(true);
    expect(told.find((t) => t.client === a && t.method === 'Browser.downloadWillBegin')?.fileThere).toBe(false);
    expect(fs.readFileSync(path.join(dirA, ga), 'utf8')).toBe('A-bytes');
    expect(fs.readFileSync(path.join(dirB, gb), 'utf8')).toBe('B-bytes');
    expect(fs.existsSync(path.join(dirA, gb))).toBe(false);
    expect(fs.existsSync(path.join(dirB, ga))).toBe(false);
    expect(told.filter((t) => t.client === a).map((t) => [t.method, t.params.guid, t.params.state ?? null])).toEqual([
      ['Browser.downloadWillBegin', ga, null],
      ['Browser.downloadProgress', ga, 'inProgress'],
      ['Browser.downloadProgress', ga, 'completed'],
    ]);
    expect(told.filter((t) => t.client === b).map((t) => [t.params.guid, t.sessionId])).toEqual([[gb, 'S-B'], [gb, 'S-B']]);
  });

  it('a download in a frame no client holds is cancelled, its file deleted, and no one is told', async () => {
    const a = ext('a');
    const { dir, told, cancelled, ask, write, policy } = setup(new Map([['FA', a]]));
    ask(a, { behavior: 'allowAndName', downloadPath: tempDir('wmux-dl-a-'), eventsEnabled: true });
    const g = 'cccccccc-0000-4000-8000-000000000003';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'NOBODY'));
    write(g, 'x');
    policy.downloadEvent('Browser.downloadProgress', { guid: g, state: 'canceled' });
    expect(cancelled).toEqual([g]);
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, g))).toBe(false), { timeout: 5_000 });
    expect(told).toEqual([]);
  });

  it('refuses a folder that is relative, missing, a file, or a link, and records nothing for it', () => {
    const a = ext('a');
    const { ask } = setup(new Map());
    const real = tempDir('wmux-dl-real-');
    const file = path.join(real, 'f.txt');
    fs.writeFileSync(file, '');
    const link = path.join(tempDir('wmux-dl-link-'), 'to-real');
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    for (const downloadPath of ['relative/dir', path.join(real, 'missing'), file, link, 42, undefined]) {
      const answer = ask(a, { behavior: 'allowAndName', downloadPath, eventsEnabled: true });
      expect(answer, String(downloadPath)).toMatchObject({ refuse: { code: -32000, message: 'downloadPath must be an existing absolute directory, not a link' }, reason: 'download-path' });
    }
    expect(ask(a, { behavior: 'allowAndName', downloadPath: real, eventsEnabled: true })).toMatchObject({ absorb: {} });
  });

  it('across volumes (EXDEV): copied, flushed, then the original removed; a copy that fails cancels for the client', async () => {
    const a = ext('a');
    const exdev = () => Promise.reject(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
    const fsync = vi.fn(defaultFs().fsync);
    const { dir, told, ask, write, policy } = setup(new Map([['FA', a]]), { rename: exdev, fsync });
    const dest = tempDir('wmux-dl-a-');
    ask(a, { behavior: 'allowAndName', downloadPath: dest, eventsEnabled: true });
    const g = 'dddddddd-0000-4000-8000-000000000004';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'FA'));
    write(g, 'moved');
    policy.downloadEvent('Browser.downloadProgress', { guid: g, state: 'completed' });
    await vi.waitFor(() => expect(told.some((t) => t.params.state === 'completed')).toBe(true), { timeout: 5_000 });
    expect(fs.readFileSync(path.join(dest, g), 'utf8')).toBe('moved');
    expect(fs.existsSync(path.join(dir, g))).toBe(false);
    expect(fsync).toHaveBeenCalledWith(path.join(dest, g));

    // A disk that refuses the copy: canceled for the client, nothing left behind.
    const failing = setup(new Map([['FA', a]]), { rename: exdev, copyFile: () => Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' })) });
    const dest2 = tempDir('wmux-dl-a2-');
    failing.ask(a, { behavior: 'allowAndName', downloadPath: dest2, eventsEnabled: true });
    const g2 = 'eeeeeeee-0000-4000-8000-000000000005';
    failing.policy.downloadEvent('Browser.downloadWillBegin', begin(g2, 'FA'));
    failing.write(g2, 'x');
    failing.policy.downloadEvent('Browser.downloadProgress', { guid: g2, state: 'completed' });
    await vi.waitFor(() => expect(failing.told.some((t) => t.params.state === 'canceled')).toBe(true), { timeout: 5_000 });
    expect(failing.told.some((t) => t.params.state === 'completed')).toBe(false);
    await vi.waitFor(() => expect(fs.existsSync(path.join(failing.dir, g2))).toBe(false), { timeout: 5_000 });
    expect(fs.readdirSync(dest2)).toEqual([]);
  });

  it('a client that asked to deny has its downloads cancelled, and is told', () => {
    const a = ext('a');
    const { told, cancelled, ask, policy } = setup(new Map([['FA', a]]));
    ask(a, { behavior: 'deny', eventsEnabled: true });
    const g = 'ffffffff-0000-4000-8000-000000000006';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'FA'));
    expect(cancelled).toEqual([g]);
    expect(told.map((t) => [t.method, t.params.state ?? null])).toEqual([
      ['Browser.downloadWillBegin', null],
      ['Browser.downloadProgress', 'canceled'],
    ]);
  });

  it('a client cancels only its own download; a browser context it created keeps its own setting', () => {
    const a = ext('a');
    const b = ext('b');
    const { cancelled, ask, policy } = setup(new Map([['FA', a]]));
    ask(a, { behavior: 'allowAndName', downloadPath: tempDir('wmux-dl-a-'), eventsEnabled: true });
    const g = '11111111-0000-4000-8000-000000000007';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'FA'));
    expect(policy.filter(b, { method: 'Browser.cancelDownload', params: { guid: g } })).toMatchObject({ absorb: {} });
    expect(cancelled).toEqual([]);
    expect(policy.filter(a, { method: 'Browser.cancelDownload', params: { guid: g } })).toMatchObject({ absorb: {} });
    expect(cancelled).toEqual([g]);
    expect(policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', browserContextId: 'CTX' } })).toBeNull();
    expect(policy.filter({ kind: 'internal', label: 'main' }, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow' } })).toBeNull();
  });

  it('main\'s folder: owner-only, named by pid; a dead process\'s is swept, files only, links left', () => {
    const root = tempDir('wmux-dl-root-');
    const mine = makeDownloadRelayDir(root);
    expect(path.basename(mine)).toMatch(new RegExp(`^wmux-dl-${process.pid}-`));
    if (process.platform !== 'win32') expect(fs.statSync(mine).mode & 0o777).toBe(0o700);
    const dead = path.join(root, 'wmux-dl-999999-abc');
    fs.mkdirSync(dead);
    fs.writeFileSync(path.join(dead, 'g1'), 'x');
    const outside = tempDir('wmux-dl-outside-');
    fs.writeFileSync(path.join(outside, 'keep'), 'k');
    fs.symlinkSync(outside, path.join(dead, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    sweepDeadDownloadRelayDirs(root);
    expect(fs.existsSync(path.join(dead, 'g1'))).toBe(false);
    // The link stays (so the folder does), and what it points at is untouched.
    expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('k');
    expect(fs.existsSync(mine)).toBe(true);
    removeDownloadRelayDir(mine);
    expect(fs.existsSync(mine)).toBe(false);
  });
});
