import fs, { constants as fsConstants, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClientCommandFilter, ClientRef } from './CdpPipeMux';

// ---------------------------------------------------------------------------
// Downloads on a shared Chrome's default browser context, with grants (C3b).
// Every client of the pipe shares that context, and Chrome keeps one download
// behaviour for it and sends its download events to the one session that set
// it last. So with grants a client's own setting is answered and recorded,
// never forwarded; main's own session holds the behaviour (allowAndName into a
// folder of main's, events on), and each download goes to the one client that
// holds the frame it began in:
//  - downloadWillBegin and downloadProgress go to that client only, on the
//    session it asked on;
//  - once complete, the file moves from main's folder into the folder the
//    client named, under the download's guid, before the client hears
//    `completed`, so Playwright's download.path() and saveAs() find it;
//  - a download in a frame no client holds is cancelled, its file deleted, and
//    no one told; a client that asked for 'deny' has its downloads cancelled
//    and is told so.
// A client's folder is untrusted input: absolute, an existing directory, not a
// link itself, resolved. The file name is the guid only, so a move can replace
// nothing but a guid-named file. A browser context the client created keeps
// its own setting (the client's, forwarded): only it is in that context.
// ---------------------------------------------------------------------------

/** A file left in main's folder longer than this is no download in progress. */
export const DOWNLOAD_FILE_TTL_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const DIR_PREFIX = 'wmux-dl-';
const GUID = /^[A-Za-z0-9-]{1,128}$/;

/** The file operations a move uses; tests stand in for them. */
export interface RelayFs {
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string, mode: number): Promise<void>;
  /** Flush a written file to disk. */
  fsync(file: string): Promise<void>;
  unlink(file: string): Promise<void>;
  lstat(p: string): { isSymbolicLink(): boolean; isDirectory(): boolean };
  realpath(p: string): string;
}

const nodeFs: RelayFs = {
  rename: (from, to) => fsp.rename(from, to),
  copyFile: (from, to, mode) => fsp.copyFile(from, to, mode),
  fsync: async (file) => {
    const handle = await fsp.open(file, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  unlink: (file) => fsp.unlink(file),
  lstat: (p) => fs.lstatSync(p),
  realpath: (p) => fs.realpathSync.native(p),
};

export interface DownloadRelayDeps {
  /** The browser context of a frame the client holds; undefined when it holds none (CdpPipeMux.contextOfFrame). */
  contextOf(client: ClientRef, frameId: string): string | null | undefined;
  /** Send the client a browser-level event on its root or one of its sessions; false when that is gone. */
  emit(client: ClientRef, method: string, params: Record<string, unknown>, sessionId?: string): boolean;
  /** Cancel a download on main's own session. */
  cancel(guid: string): Promise<unknown>;
  /** Main's folder, where Chrome writes every download of the default context. */
  readonly dir: string;
  readonly fs?: RelayFs;
}

/** What a client asked for on one session: allow into `dir`, or deny. */
interface Asked {
  readonly behavior: 'allow' | 'deny';
  readonly dir?: string;
  readonly events: boolean;
}

/** A download a client was handed. */
interface Handed {
  readonly client: ClientRef;
  readonly sessionId: string | undefined;
  readonly dir: string;
  readonly events: boolean;
}

const refusal = (message: string) => ({ code: -32000, message });

export class DownloadRelayPolicy {
  private readonly asked = new Map<ClientRef, Map<string | undefined, Asked>>();
  private readonly handed = new Map<string, Handed>();
  /** Downloads told to no one (or cancelled): their file goes once Chrome is done. */
  private readonly dropped = new Set<string>();
  private readonly fs: RelayFs;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly deps: DownloadRelayDeps) {
    this.fs = deps.fs ?? nodeFs;
    this.sweeper = setInterval(() => this.sweepStale(), SWEEP_EVERY_MS);
    this.sweeper.unref?.();
  }

  /**
   * A client's Browser.setDownloadBehavior on the shared default context:
   * recorded and answered here. One that names a browser context is the grant
   * rules' (its own context passes, another's is refused).
   */
  readonly filter: ClientCommandFilter = (client, command) => {
    if (client.kind !== 'external') return null;
    if (command.method === 'Browser.cancelDownload') {
      // Its own download only; any other guid is, to it, not there.
      const guid = command.params.guid;
      if (typeof guid === 'string' && this.handed.get(guid)?.client === client) {
        this.handed.delete(guid);
        this.drop(guid);
      }
      return { absorb: {}, reason: 'cancel-download' };
    }
    if (command.method !== 'Browser.setDownloadBehavior' || typeof command.params.browserContextId === 'string') return null;
    const refused = this.ask(client, command.sessionId, command.params);
    return refused ? { refuse: refused, reason: 'download-path' } : { absorb: {}, reason: 'default-context-downloads' };
  };

  /** Record what the client asked; an error when its folder does not check out. */
  private ask(client: ClientRef, sessionId: string | undefined, params: Record<string, unknown>): { code: number; message: string } | null {
    const behavior = params.behavior;
    const events = params.eventsEnabled === true;
    const sessions = this.asked.get(client) ?? new Map<string | undefined, Asked>();
    if (behavior === 'allow' || behavior === 'allowAndName') {
      const dir = this.checkedDir(params.downloadPath);
      if (!dir) return refusal('downloadPath must be an existing absolute directory, not a link');
      sessions.set(sessionId, { behavior: 'allow', dir, events });
    } else if (behavior === 'deny') {
      sessions.set(sessionId, { behavior: 'deny', events });
    } else {
      sessions.delete(sessionId);
    }
    if (sessions.size) this.asked.set(client, sessions);
    else this.asked.delete(client);
    return null;
  }

  /** A download event main's session saw. */
  downloadEvent(method: string, params: Record<string, unknown>): void {
    const guid = typeof params.guid === 'string' ? params.guid : '';
    if (!guid) return;
    if (method === 'Browser.downloadWillBegin') this.began(guid, params);
    else if (method === 'Browser.downloadProgress') this.progressed(guid, params);
  }

  /** A client left: what it asked for goes; a download it was handed is cancelled. */
  forget(client: ClientRef): void {
    this.asked.delete(client);
    for (const [guid, to] of this.handed) {
      if (to.client !== client) continue;
      this.handed.delete(guid);
      this.drop(guid);
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
  }

  private began(guid: string, params: Record<string, unknown>): void {
    if (!GUID.test(guid)) {
      this.drop(guid);
      return;
    }
    const frameId = typeof params.frameId === 'string' ? params.frameId : '';
    const holders = frameId ? [...this.asked].filter(([client]) => this.deps.contextOf(client, frameId) !== undefined) : [];
    for (const [client, sessions] of holders) {
      for (const [sessionId, asked] of sessions) {
        if (asked.behavior !== 'allow' || !asked.dir) continue;
        this.handed.set(guid, { client, sessionId, dir: asked.dir, events: asked.events });
        if (asked.events) this.deps.emit(client, 'Browser.downloadWillBegin', params, sessionId);
        return;
      }
    }
    // No holder took it: cancelled. A holder that asked to deny is told.
    this.drop(guid);
    for (const [client, sessions] of holders) {
      for (const [sessionId, asked] of sessions) {
        if (asked.behavior !== 'deny' || !asked.events) continue;
        this.deps.emit(client, 'Browser.downloadWillBegin', params, sessionId);
        this.deps.emit(client, 'Browser.downloadProgress', { guid, totalBytes: 0, receivedBytes: 0, state: 'canceled' }, sessionId);
      }
    }
  }

  private progressed(guid: string, params: Record<string, unknown>): void {
    const to = this.handed.get(guid);
    const state = params.state;
    if (!to) {
      if (state === 'completed' || state === 'canceled') this.removeTemp(guid);
      return;
    }
    if (state === 'inProgress') {
      if (to.events) this.deps.emit(to.client, 'Browser.downloadProgress', params, to.sessionId);
      return;
    }
    this.handed.delete(guid);
    if (state === 'canceled') {
      if (to.events) this.deps.emit(to.client, 'Browser.downloadProgress', params, to.sessionId);
      this.removeTemp(guid);
      return;
    }
    if (state !== 'completed') return;
    void this.move(guid, to.dir).then(
      () => { if (to.events) this.deps.emit(to.client, 'Browser.downloadProgress', params, to.sessionId); },
      () => {
        this.removeTemp(guid);
        if (to.events) this.deps.emit(to.client, 'Browser.downloadProgress', { ...params, state: 'canceled' }, to.sessionId);
      },
    );
  }

  /** Cancel a download and forget its file once Chrome is done with it. */
  private drop(guid: string): void {
    this.dropped.add(guid);
    void this.deps.cancel(guid).catch(() => undefined);
  }

  /**
   * main's folder → the client's, under the guid: a rename on one volume,
   * otherwise a copy that is flushed before the original goes.
   */
  async move(guid: string, dir: string): Promise<void> {
    const from = path.join(this.deps.dir, guid);
    const to = path.join(dir, guid);
    try {
      await this.fs.rename(from, to);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    }
    try {
      await this.fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
      await this.fs.fsync(to);
    } catch (err) {
      await this.fs.unlink(to).catch(() => undefined);
      throw err;
    }
    await this.fs.unlink(from).catch(() => undefined);
  }

  /** Absolute, an existing directory, not a link itself; resolved. Null otherwise. */
  private checkedDir(value: unknown): string | null {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) return null;
    try {
      const st = this.fs.lstat(value);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
      const resolved = this.fs.realpath(value);
      const again = this.fs.lstat(resolved);
      return again.isDirectory() ? resolved : null;
    } catch {
      return null;
    }
  }

  private removeTemp(guid: string): void {
    this.dropped.delete(guid);
    if (!GUID.test(guid)) return;
    void this.fs.unlink(path.join(this.deps.dir, guid)).catch(() => undefined);
  }

  /** Files in main's folder no download is using, older than DOWNLOAD_FILE_TTL_MS. */
  private sweepStale(): void {
    const now = Date.now();
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (this.handed.has(name)) continue;
      const file = path.join(this.deps.dir, name);
      try {
        const st = fs.lstatSync(file);
        if (st.isFile() && now - st.mtimeMs > DOWNLOAD_FILE_TTL_MS) fs.unlinkSync(file);
      } catch { /* gone */ }
    }
  }
}

/**
 * Main's own download folder for this process: owner-only, named by pid, so
 * a later start can sweep one whose process is gone.
 */
export function makeDownloadRelayDir(root = os.tmpdir()): string {
  sweepDeadDownloadRelayDirs(root);
  const dir = fs.mkdtempSync(path.join(root, `${DIR_PREFIX}${process.pid}-`));
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** Remove `dir` and the plain files in it; anything else (a link, a folder) is left. */
export function removeDownloadRelayDir(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
    } catch { /* gone */ }
  }
  try {
    fs.rmdirSync(dir);
  } catch { /* not empty, or gone */ }
}

/** Folders a previous wmux left whose process is gone. */
export function sweepDeadDownloadRelayDirs(root: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const match = new RegExp(`^${DIR_PREFIX}(\\d+)-`).exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || alive(pid)) continue;
    const dir = path.join(root, name);
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    removeDownloadRelayDir(dir);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
