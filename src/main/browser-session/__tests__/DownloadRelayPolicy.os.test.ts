// Downloads of a shared Chrome's default context, with grants (C3b): each goes
// to the one client holding its frame, into that client's folder, under its
// guid, before the client hears it completed; one no client asked for finishes
// in the user's folder under its own name, never over a file already there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientRef } from '../CdpPipeMux';
import { deliberateSleep } from '../../../test-utils/waitFor';
import {
  DOWNLOAD_FILE_TTL_MS, DownloadRelayPolicy, makeDownloadRelayDir, removeDownloadRelayDir, safeDownloadName, sweepDeadDownloadRelayDirs, type RelayFs,
} from '../DownloadRelayPolicy';

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

const ext = (label: string, everyTarget = false): ClientRef => ({ kind: 'external', label, ...(everyTarget && { identity: { everyTarget: true } }) });

interface Told { client: ClientRef; method: string; params: Record<string, unknown>; sessionId?: string; fileThere?: boolean }

/** Who holds each frame, and in which context (null: the default one, as Chrome names none). */
type Frames = Map<string, Array<{ client: ClientRef; context?: string }>>;
const held = (...pairs: Array<[string, ClientRef, string?]>): Frames => {
  const frames: Frames = new Map();
  for (const [frame, client, context] of pairs) frames.set(frame, [...(frames.get(frame) ?? []), { client, ...(context && { context }) }]);
  return frames;
};

function setup(frames: Frames, opts: { fs?: Partial<RelayFs>; userDir?: string | null; created?: Array<[ClientRef, string]>; sessions?: Map<string, string | null> } = {}) {
  const dir = tempDir('wmux-dl-test-');
  const told: Told[] = [];
  const cancelled: string[] = [];
  let watched: { file: string } | null = null;
  const policy = new DownloadRelayPolicy({
    dir,
    contextOf: (client, frameId) => {
      const holder = frames.get(frameId)?.find((h) => h.client === client);
      return holder ? holder.context ?? null : undefined;
    },
    created: (client, contextId) => (opts.created ?? []).some(([c, id]) => c === client && id === contextId),
    contextOfSession: (_client, sessionId) => opts.sessions?.get(sessionId),
    emit: (client, method, params, sessionId) => {
      told.push({ client, method, params, ...(sessionId !== undefined && { sessionId }), ...(watched && { fileThere: fs.existsSync(watched.file) }) });
      return true;
    },
    cancel: async (guid) => { cancelled.push(guid); },
    ...(opts.userDir !== undefined && { userDir: () => opts.userDir ?? null }),
    ...(opts.fs && { fs: { ...defaultFs(), ...opts.fs } }),
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
    createExclusive: async (f) => { await (await fs.promises.open(f, 'wx')).close(); },
    lstat: (p) => fs.lstatSync(p),
    realpath: (p) => fs.realpathSync.native(p),
  };
}

const begin = (guid: string, frameId: string, suggestedFilename = 'f.bin') => ({ guid, frameId, url: 'https://x.test/f.bin', suggestedFilename });

describe('DownloadRelayPolicy', () => {
  it('two workspaces download at once: each gets only its own file and events, the file in place before "completed"', async () => {
    const a = ext('a');
    const b = ext('b');
    const { told, ask, write, policy, watch } = setup(held(['FA', a], ['FB', b]));
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

  it('a download no client asked for (the user\'s own tab) lands in the user\'s folder under its name, a second one deduped, told to no one', async () => {
    const a = ext('a');
    const user = tempDir('wmux-dl-user-');
    fs.writeFileSync(path.join(user, 'report.pdf'), 'the user\'s own, older');
    const { dir, told, cancelled, ask, write, policy } = setup(held(['FA', a]), { userDir: user });
    ask(a, { behavior: 'allowAndName', downloadPath: tempDir('wmux-dl-a-'), eventsEnabled: true });
    const g1 = 'cccccccc-0000-4000-8000-000000000003';
    const g2 = 'cccccccc-0000-4000-8000-000000000004';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g1, 'USER-TAB', 'report.pdf'));
    policy.downloadEvent('Browser.downloadWillBegin', begin(g2, 'USER-TAB', 'report.pdf'));
    write(g1, 'one');
    write(g2, 'two');
    policy.downloadEvent('Browser.downloadProgress', { guid: g1, state: 'completed' });
    await vi.waitFor(() => expect(fs.existsSync(path.join(user, 'report (1).pdf'))).toBe(true), { timeout: 5_000 });
    policy.downloadEvent('Browser.downloadProgress', { guid: g2, state: 'completed' });
    await vi.waitFor(() => expect(fs.existsSync(path.join(user, 'report (2).pdf'))).toBe(true), { timeout: 5_000 });
    expect(fs.readFileSync(path.join(user, 'report.pdf'), 'utf8')).toBe('the user\'s own, older');
    expect(fs.readFileSync(path.join(user, 'report (1).pdf'), 'utf8')).toBe('one');
    expect(fs.readFileSync(path.join(user, 'report (2).pdf'), 'utf8')).toBe('two');
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(told).toEqual([]);
  });

  it('the user\'s folder: a link already at the name is skipped, never written through; a cancelled one is deleted', async () => {
    const user = tempDir('wmux-dl-user-');
    const elsewhere = tempDir('wmux-dl-else-');
    fs.symlinkSync(elsewhere, path.join(user, 'a.txt'), process.platform === 'win32' ? 'junction' : 'dir');
    const { dir, write, policy } = setup(new Map(), { userDir: user });
    const g = 'dddddddd-0000-4000-8000-000000000010';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'USER-TAB', 'a.txt'));
    write(g, 'x');
    policy.downloadEvent('Browser.downloadProgress', { guid: g, state: 'completed' });
    await vi.waitFor(() => expect(fs.existsSync(path.join(user, 'a (1).txt'))).toBe(true), { timeout: 5_000 });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    const g2 = 'dddddddd-0000-4000-8000-000000000011';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g2, 'USER-TAB', 'b.txt'));
    write(g2, 'y');
    policy.downloadEvent('Browser.downloadProgress', { guid: g2, state: 'canceled' });
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, g2))).toBe(false), { timeout: 5_000 });
    expect(fs.existsSync(path.join(user, 'b.txt'))).toBe(false);
  });

  it('with no user folder wired, a download no client asked for is cancelled and told to no one', () => {
    const { told, cancelled, policy } = setup(new Map());
    const g = 'cccccccc-0000-4000-8000-000000000005';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'NOBODY'));
    expect(cancelled).toEqual([g]);
    expect(told).toEqual([]);
  });

  it('Chrome\'s suggested name is made safe again: separators, reserved names, dots, controls, length', () => {
    expect(safeDownloadName('report.pdf')).toBe('report.pdf');
    expect(safeDownloadName('..\\..\\evil.exe')).toBe('_.._evil.exe');
    expect(safeDownloadName('../x/y.txt')).toBe('_x_y.txt');
    expect(safeDownloadName('a:b*c?"<>|.txt')).toBe('a_b_c_____.txt');
    expect(safeDownloadName('.hidden')).toBe('hidden');
    expect(safeDownloadName('trail. . ')).toBe('trail');
    expect(safeDownloadName('CON')).toBe('_CON');
    expect(safeDownloadName('nul.txt')).toBe('_nul.txt');
    expect(safeDownloadName('lpt1')).toBe('_lpt1');
    expect(safeDownloadName('innocent‮txt.exe')).toBe('innocent_txt.exe');
    expect(safeDownloadName('tab\tnew\nline')).toBe('tab_new_line');
    expect(safeDownloadName('')).toBe('download');
    expect(safeDownloadName(undefined)).toBe('download');
    expect(safeDownloadName('...')).toBe('download');
    const long = safeDownloadName(`${'x'.repeat(300)}.pdf`);
    expect(long).toHaveLength(240);
    expect(long.endsWith('.pdf')).toBe(true);
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
    const { dir, told, ask, write, policy } = setup(held(['FA', a]), { fs: { rename: exdev, fsync } });
    const dest = tempDir('wmux-dl-a-');
    ask(a, { behavior: 'allowAndName', downloadPath: dest, eventsEnabled: true });
    const g = 'dddddddd-0000-4000-8000-000000000004';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'FA'));
    write(g, 'moved');
    policy.downloadEvent('Browser.downloadProgress', { guid: g, state: 'completed' });
    await vi.waitFor(() => expect(told.some((t) => t.params.state === 'completed')).toBe(true), { timeout: 5_000 });
    expect(fs.readFileSync(path.join(dest, g), 'utf8')).toBe('moved');
    expect(fs.existsSync(path.join(dir, g))).toBe(false);
    // The policy works on the resolved folder (macOS: /var is a link to /private/var).
    expect(fsync).toHaveBeenCalledWith(path.join(fs.realpathSync(dest), g));

    // A disk that refuses the copy: canceled for the client, nothing left behind.
    const failing = setup(held(['FA', a]), { fs: { rename: exdev, copyFile: () => Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' })) } });
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

    // Into the user's folder across volumes, a copy that fails: no claimed name
    // left behind, and the only copy kept in main's folder.
    const user = tempDir('wmux-dl-user-');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const toUser = setup(new Map(), { userDir: user, fs: { rename: exdev, copyFile: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) } });
      const g3 = 'eeeeeeee-0000-4000-8000-000000000006';
      toUser.policy.downloadEvent('Browser.downloadWillBegin', begin(g3, 'USER-TAB', 'u.bin'));
      toUser.write(g3, 'x');
      toUser.policy.downloadEvent('Browser.downloadProgress', { guid: g3, state: 'completed' });
      await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5_000 });
      expect(fs.readdirSync(user)).toEqual([]);
      expect(fs.readFileSync(path.join(toUser.dir, g3), 'utf8')).toBe('x');
    } finally {
      warn.mockRestore();
    }
  });

  it('a client that asked to deny has its downloads cancelled, and is told', () => {
    const a = ext('a');
    const { told, cancelled, ask, policy } = setup(held(['FA', a]), { userDir: tempDir('wmux-dl-user-') });
    ask(a, { behavior: 'deny', eventsEnabled: true });
    const g = 'ffffffff-0000-4000-8000-000000000006';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'FA'));
    expect(cancelled).toEqual([g]);
    expect(told.map((t) => [t.method, t.params.state ?? null])).toEqual([
      ['Browser.downloadWillBegin', null],
      ['Browser.downloadProgress', 'canceled'],
    ]);
  });

  it('a client cancels only its own download, and hears Chrome\'s "canceled"; one naming a context is the grant rules\'', () => {
    const a = ext('a');
    const b = ext('b');
    const { told, cancelled, ask, policy } = setup(held(['FA', a]));
    ask(a, { behavior: 'allowAndName', downloadPath: tempDir('wmux-dl-a-'), eventsEnabled: true });
    const g = '11111111-0000-4000-8000-000000000007';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'FA'));
    expect(policy.filter(b, { method: 'Browser.cancelDownload', params: { guid: g } })).toMatchObject({ absorb: {} });
    expect(cancelled).toEqual([]);
    expect(policy.filter(a, { method: 'Browser.cancelDownload', params: { guid: g } })).toMatchObject({ absorb: {} });
    expect(cancelled).toEqual([g]);
    policy.downloadEvent('Browser.downloadProgress', { guid: g, state: 'canceled' });
    expect(told.filter((t) => t.client === a).map((t) => t.params.state ?? null)).toEqual([null, 'canceled']);
    expect(policy.filter(a, { method: 'Browser.cancelDownload', params: { guid: g, browserContextId: 'CTX' } })).toBeNull();
    expect(policy.filter(a, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', browserContextId: 'CTX' } })).toBeNull();
    expect(policy.filter({ kind: 'internal', label: 'main' }, { method: 'Browser.setDownloadBehavior', params: { behavior: 'allow' } })).toBeNull();
  });

  it('Page.setDownloadBehavior: refused on a default-context page, the client\'s own on a page of a context it made', () => {
    const a = ext('a');
    const { policy } = setup(new Map(), { created: [[a, 'CTX-A']], sessions: new Map<string, string | null>([['S-DEFAULT', 'DEFAULT'], ['S-OWN', 'CTX-A']]) });
    const params = { behavior: 'allow', downloadPath: os.tmpdir() };
    expect(policy.filter(a, { method: 'Page.setDownloadBehavior', params, sessionId: 'S-DEFAULT' })).toMatchObject({ refuse: { code: -32000 } });
    expect(policy.filter(a, { method: 'Page.setDownloadBehavior', params })).toMatchObject({ refuse: { code: -32000 } });
    expect(policy.filter(a, { method: 'Page.setDownloadBehavior', params, sessionId: 'S-OWN' })).toBeNull();
  });

  it('a download in a context the client made is left to that context\'s own setting: not handed, moved, or cancelled', () => {
    const a = ext('a');
    const { told, cancelled, ask, policy } = setup(held(['F-OWN', a, 'CTX-A']), { created: [[a, 'CTX-A']], userDir: tempDir('wmux-dl-user-') });
    ask(a, { behavior: 'allowAndName', downloadPath: tempDir('wmux-dl-a-'), eventsEnabled: true });
    const g = '22222222-0000-4000-8000-000000000008';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'F-OWN'));
    policy.downloadEvent('Browser.downloadProgress', { guid: g, state: 'completed' });
    expect(told).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it('a page held by its workspace\'s client and an every-target client: the workspace\'s gets the download', () => {
    const operator = ext('operator', true);
    const ws = ext('ws');
    const { told, ask, policy } = setup(held(['F', operator], ['F', ws]));
    ask(operator, { behavior: 'allowAndName', downloadPath: tempDir('wmux-dl-op-'), eventsEnabled: true });
    ask(ws, { behavior: 'allowAndName', downloadPath: tempDir('wmux-dl-ws-'), eventsEnabled: true });
    policy.downloadEvent('Browser.downloadWillBegin', begin('33333333-0000-4000-8000-000000000009', 'F'));
    expect(told.map((t) => t.client)).toEqual([ws]);
  });

  it('a long Korean name lands, cut to the byte limit on a character boundary and deduped', async () => {
    const user = tempDir('wmux-dl-user-');
    const { dir, write, policy } = setup(new Map(), { userDir: user });
    const longName = `${'보고서'.repeat(40)}.pdf`;
    expect(longName.length).toBe(124);
    const named = safeDownloadName(longName);
    expect(Buffer.byteLength(named)).toBeLessThanOrEqual(240);
    expect(named.endsWith('.pdf')).toBe(true);
    expect(named.includes('�')).toBe(false);
    const g1 = '44444444-0000-4000-8000-000000000001';
    const g2 = '44444444-0000-4000-8000-000000000002';
    for (const [g, body] of [[g1, 'one'], [g2, 'two']] as const) {
      policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'USER-TAB', longName));
      write(g, body);
      policy.downloadEvent('Browser.downloadProgress', { guid: g, state: 'completed' });
      await vi.waitFor(() => expect(fs.existsSync(path.join(dir, g))).toBe(false), { timeout: 5_000 });
    }
    const stem = named.slice(0, -'.pdf'.length);
    expect(fs.readdirSync(user).sort()).toEqual([named, `${stem} (1).pdf`].sort());
    expect(fs.readFileSync(path.join(user, `${stem} (1).pdf`), 'utf8')).toBe('two');
  });

  it('a name the folder refuses falls back to download-<hex> and the extension; when that fails too, the file stays in main\'s folder', async () => {
    const user = tempDir('wmux-dl-user-');
    const tooLong = (file: string) => (path.basename(file).startsWith('download-')
      ? defaultFs().createExclusive(file)
      : Promise.reject(Object.assign(new Error('name too long'), { code: 'ENAMETOOLONG' })));
    const { dir, write, policy } = setup(new Map(), { userDir: user, fs: { createExclusive: tooLong } });
    const g = '55555555-0000-4000-8000-000000000001';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'USER-TAB', 'report.pdf'));
    write(g, 'kept');
    policy.downloadEvent('Browser.downloadProgress', { guid: g, state: 'completed' });
    await vi.waitFor(() => expect(fs.readdirSync(user)).toEqual(['download-55555555.pdf']), { timeout: 5_000 });
    expect(fs.readFileSync(path.join(user, 'download-55555555.pdf'), 'utf8')).toBe('kept');
    expect(fs.existsSync(path.join(dir, g))).toBe(false);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const refusing = setup(new Map(), { userDir: tempDir('wmux-dl-user2-'), fs: { createExclusive: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) } });
      const g2 = '55555555-0000-4000-8000-000000000002';
      refusing.policy.downloadEvent('Browser.downloadWillBegin', begin(g2, 'USER-TAB', 'report.pdf'));
      refusing.write(g2, 'the only copy');
      refusing.policy.downloadEvent('Browser.downloadProgress', { guid: g2, state: 'completed' });
      await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5_000 });
      expect(fs.readFileSync(path.join(refusing.dir, g2), 'utf8')).toBe('the only copy');
    } finally {
      warn.mockRestore();
    }
  });

  it('the workspace\'s deny wins over an every-target client\'s allow', () => {
    const operator = ext('operator', true);
    const ws = ext('ws');
    const { told, cancelled, ask, policy } = setup(held(['F', operator], ['F', ws]));
    ask(operator, { behavior: 'allowAndName', downloadPath: tempDir('wmux-dl-op-'), eventsEnabled: true });
    ask(ws, { behavior: 'deny', eventsEnabled: true });
    const g = '66666666-0000-4000-8000-000000000001';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'F'));
    expect(cancelled).toEqual([g]);
    expect(told.map((t) => [t.client, t.params.state ?? null])).toEqual([[ws, null], [ws, 'canceled']]);
  });

  it('a client\'s folder that is gone by completion: canceled for it, the file deleted', async () => {
    const a = ext('a');
    const { dir, told, ask, write, policy } = setup(held(['FA', a]));
    const dest = tempDir('wmux-dl-a-');
    ask(a, { behavior: 'allowAndName', downloadPath: dest, eventsEnabled: true });
    const g = '77777777-0000-4000-8000-000000000001';
    policy.downloadEvent('Browser.downloadWillBegin', begin(g, 'FA'));
    write(g, 'x');
    fs.rmdirSync(dest);
    policy.downloadEvent('Browser.downloadProgress', { guid: g, state: 'completed' });
    await vi.waitFor(() => expect(told.some((t) => t.params.state === 'canceled')).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, g))).toBe(false), { timeout: 5_000 });
  });

  it('a paused download, silent for longer than the TTL, is kept (its .crdownload too) and lands when it completes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const a = ext('a');
    const user = tempDir('wmux-dl-user-');
    const dest = tempDir('wmux-dl-a-');
    const { dir, told, ask, policy } = setup(held(['FA', a]), { userDir: user });
    ask(a, { behavior: 'allowAndName', downloadPath: dest, eventsEnabled: true });
    const handed = '88888888-0000-4000-8000-000000000001';
    const forUser = '88888888-0000-4000-8000-000000000002';
    try {
      policy.downloadEvent('Browser.downloadWillBegin', begin(handed, 'FA'));
      policy.downloadEvent('Browser.downloadWillBegin', begin(forUser, 'USER-TAB', 'paused.bin'));
      // Chrome's in-progress names, then silence well past the TTL and several sweeps.
      fs.writeFileSync(path.join(dir, `${handed}.crdownload`), 'half A');
      fs.writeFileSync(path.join(dir, `${forUser}.crdownload`), 'half U');
      vi.advanceTimersByTime(DOWNLOAD_FILE_TTL_MS * 3);
      expect(fs.readdirSync(dir).sort()).toEqual([`${handed}.crdownload`, `${forUser}.crdownload`].sort());
    } finally {
      vi.useRealTimers();
    }
    // Resumed and completed: Chrome renames to the guid, then says so.
    for (const guid of [handed, forUser]) fs.renameSync(path.join(dir, `${guid}.crdownload`), path.join(dir, guid));
    policy.downloadEvent('Browser.downloadProgress', { guid: handed, state: 'completed' });
    policy.downloadEvent('Browser.downloadProgress', { guid: forUser, state: 'completed' });
    await vi.waitFor(() => expect(told.some((t) => t.params.state === 'completed')).toBe(true), { timeout: 5_000 });
    expect(fs.readFileSync(path.join(dest, handed), 'utf8')).toBe('half A');
    await vi.waitFor(() => expect(fs.existsSync(path.join(user, 'paused.bin'))).toBe(true), { timeout: 5_000 });
    expect(fs.readFileSync(path.join(user, 'paused.bin'), 'utf8')).toBe('half U');
  });

  it('a completed download this policy does not know is never deleted by it: left to the file sweep, one line logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { dir, told, write, policy } = setup(new Map(), { userDir: tempDir('wmux-dl-user-') });
      const g = '99999999-0000-4000-8000-000000000001';
      write(g, 'whose?');
      policy.downloadEvent('Browser.downloadProgress', { guid: g, state: 'completed' });
      policy.downloadEvent('Browser.downloadProgress', { guid: g, state: 'canceled' });
      await deliberateSleep(50, 'a negative check: no delete of the unknown file is under way');
      expect(fs.readFileSync(path.join(dir, g), 'utf8')).toBe('whose?');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0])).not.toContain(g);
      expect(told).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('main\'s folder: owner-only, named by pid; a dead process\'s and this one\'s unused are swept, files only, links left', async () => {
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
    // One of this process's that no Chrome uses any more (its removal failed earlier).
    const leftover = path.join(root, `wmux-dl-${process.pid}-left`);
    fs.mkdirSync(leftover);
    fs.writeFileSync(path.join(leftover, 'g2'), 'x');
    await sweepDeadDownloadRelayDirs(root);
    expect(fs.existsSync(path.join(dead, 'g1'))).toBe(false);
    expect(fs.existsSync(leftover)).toBe(false);
    // The link stays (so the folder does), and what it points at is untouched.
    expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('k');
    expect(fs.existsSync(mine)).toBe(true);
    removeDownloadRelayDir(mine);
    expect(fs.existsSync(mine)).toBe(false);
  });
});
