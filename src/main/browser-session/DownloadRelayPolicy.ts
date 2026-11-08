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
// folder of main's, events on), and each download goes where its frame says:
//  - a frame a client holds, that asked to allow: downloadWillBegin and
//    downloadProgress go to that client only, on the session it asked on; once
//    complete, the file moves from main's folder into the folder the client
//    named, under the download's guid, before the client hears `completed`, so
//    Playwright's download.path() and saveAs() find it;
//  - a frame a client holds, that asked to deny: cancelled, and it is told;
//  - a frame no client asked for (the user's own tab): finished as Chrome would
//    without wmux, into the user's download folder under Chrome's suggested
//    name, never over an existing file, told to no client.
// A client's folder is untrusted input: absolute, an existing directory, not a
// link itself, resolved. Its file name is the guid only, so a move can replace
// nothing but a guid-named file. A browser context a client created keeps its
// own setting (the client's, forwarded): only it is in that context.
// ---------------------------------------------------------------------------

/** A file left in main's folder longer than this is no download in progress. */
export const DOWNLOAD_FILE_TTL_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const DIR_PREFIX = 'wmux-dl-';
const DIR_NAME = /^wmux-dl-(\d+)-/;
const GUID = /^[A-Za-z0-9-]{1,128}$/;
/** Names tried in the user's folder before a download is given up: "name (1)" .. "name (99)". */
const MAX_DEDUPE = 100;
const MAX_NAME = 200;

/** The file operations a move uses; tests stand in for them. */
export interface RelayFs {
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string, mode: number): Promise<void>;
  /** Flush a written file to disk. */
  fsync(file: string): Promise<void>;
  unlink(file: string): Promise<void>;
  /** Create an empty `file`; EEXIST when anything is there already, a link included. */
  createExclusive(file: string): Promise<void>;
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
  createExclusive: async (file) => {
    const handle = await fsp.open(file, 'wx');
    await handle.close();
  },
  lstat: (p) => fs.lstatSync(p),
  realpath: (p) => fs.realpathSync.native(p),
};

export interface DownloadRelayDeps {
  /** The browser context of a frame the client holds; undefined when it holds none (CdpPipeMux.contextOfFrame). */
  contextOf(client: ClientRef, frameId: string): string | null | undefined;
  /** Whether the client created that browser context (CdpPipeMux.createdContext). */
  created(client: ClientRef, contextId: string): boolean;
  /** The browser context of the page a client's session is attached to (CdpPipeMux.contextOfSession). */
  contextOfSession(client: ClientRef, sessionId: string): string | null | undefined;
  /** Send the client a browser-level event on its root or one of its sessions; false when that is gone. */
  emit(client: ClientRef, method: string, params: Record<string, unknown>, sessionId?: string): boolean;
  /** Cancel a download on main's own session. */
  cancel(guid: string): Promise<unknown>;
  /** Main's folder, where Chrome writes every download of the default context. */
  readonly dir: string;
  /** The user's download folder, for downloads no client asked for; absent: those are cancelled. */
  userDir?(): string | null;
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
  /** Downloads no client asked for, by guid: the name they finish under in the user's folder. */
  private readonly user = new Map<string, string>();
  private readonly fs: RelayFs;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly deps: DownloadRelayDeps) {
    this.fs = deps.fs ?? nodeFs;
    this.sweeper = setInterval(() => this.sweepStale(), SWEEP_EVERY_MS);
    this.sweeper.unref?.();
  }

  /**
   * A client's download commands on the shared default context: its
   * setDownloadBehavior recorded and answered here, its cancelDownload only for
   * its own downloads. One that names a browser context is the grant rules'
   * (its own context passes, another's is refused).
   */
  readonly filter: ClientCommandFilter = (client, command) => {
    if (client.kind !== 'external') return null;
    const { method, params, sessionId } = command;
    if (method === 'Page.setDownloadBehavior') {
      // Chrome applies it to the page's whole browser context.
      const context = sessionId !== undefined ? this.deps.contextOfSession(client, sessionId) : undefined;
      if (typeof context === 'string' && this.deps.created(client, context)) return null;
      return { refuse: refusal('Page.setDownloadBehavior on the shared default browser context is not available to this client; use Browser.setDownloadBehavior'), reason: 'default-context-downloads' };
    }
    if (typeof params.browserContextId === 'string') return null;
    if (method === 'Browser.cancelDownload') {
      // Its own download only; any other guid is, to it, not there. Chrome's
      // `canceled` reaches it through progressed().
      const guid = params.guid;
      if (typeof guid === 'string' && this.handed.get(guid)?.client === client) this.cancel(guid);
      return { absorb: {}, reason: 'cancel-download' };
    }
    if (method !== 'Browser.setDownloadBehavior') return null;
    const refused = this.ask(client, sessionId, params);
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
      this.cancel(guid);
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
  }

  private began(guid: string, params: Record<string, unknown>): void {
    if (!GUID.test(guid)) {
      this.cancel(guid);
      return;
    }
    const frameId = typeof params.frameId === 'string' ? params.frameId : '';
    const holders: Array<[ClientRef, Map<string | undefined, Asked>]> = [];
    for (const [client, sessions] of frameId ? this.asked : []) {
      const context = this.deps.contextOf(client, frameId);
      if (context === undefined) continue;
      // In a context the client made, the download is under its own setting: not this folder's.
      if (context !== null && this.deps.created(client, context)) return;
      holders.push([client, sessions]);
    }
    // A workspace's client before one that sees every target: the page is the workspace's.
    holders.sort(([a], [b]) => Number(a.identity?.everyTarget === true) - Number(b.identity?.everyTarget === true));
    for (const [client, sessions] of holders) {
      for (const [sessionId, asked] of sessions) {
        if (asked.behavior !== 'allow' || !asked.dir) continue;
        this.handed.set(guid, { client, sessionId, dir: asked.dir, events: asked.events });
        if (asked.events) this.deps.emit(client, 'Browser.downloadWillBegin', params, sessionId);
        return;
      }
    }
    const denied = holders.filter(([, sessions]) => [...sessions.values()].some((asked) => asked.behavior === 'deny'));
    if (denied.length) {
      this.cancel(guid);
      for (const [client, sessions] of denied) {
        for (const [sessionId, asked] of sessions) {
          if (asked.behavior !== 'deny' || !asked.events) continue;
          this.deps.emit(client, 'Browser.downloadWillBegin', params, sessionId);
          this.deps.emit(client, 'Browser.downloadProgress', { guid, totalBytes: 0, receivedBytes: 0, state: 'canceled' }, sessionId);
        }
      }
      return;
    }
    // No client asked for it: the user's, as Chrome would have it.
    if (!this.userFolder()) {
      this.cancel(guid);
      return;
    }
    this.user.set(guid, safeDownloadName(params.suggestedFilename));
  }

  private progressed(guid: string, params: Record<string, unknown>): void {
    const state = params.state;
    const name = this.user.get(guid);
    if (name !== undefined) {
      if (state === 'canceled') {
        this.user.delete(guid);
        this.removeTemp(guid);
      } else if (state === 'completed') {
        this.user.delete(guid);
        void this.moveToUser(guid, name).catch((err: unknown) => {
          console.warn('[DownloadRelay] a download could not be placed in the download folder:', (err as NodeJS.ErrnoException).code ?? String(err));
          this.removeTemp(guid);
        });
      }
      return;
    }
    const to = this.handed.get(guid);
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

  private cancel(guid: string): void {
    void this.deps.cancel(guid).catch(() => undefined);
  }

  /** main's folder → the client's, under the guid. */
  async move(guid: string, dir: string): Promise<void> {
    await this.place(path.join(this.deps.dir, guid), path.join(dir, guid), fsConstants.COPYFILE_EXCL);
  }

  /**
   * main's folder → the user's, under `name`, or "name (1)" and on when that is
   * taken: each name is claimed by an exclusive create before the file goes
   * there, so nothing already in the folder is replaced. Returns where it went.
   */
  async moveToUser(guid: string, name: string): Promise<string> {
    const dir = this.userFolder();
    if (!dir) throw new Error('no download folder');
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 0; n < MAX_DEDUPE; n++) {
      const to = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
      try {
        await this.fs.createExclusive(to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      try {
        // Over the empty file just claimed, and only that.
        await this.place(path.join(this.deps.dir, guid), to, 0);
      } catch (err) {
        await this.fs.unlink(to).catch(() => undefined);
        throw err;
      }
      return to;
    }
    throw Object.assign(new Error('no free name'), { code: 'EEXIST' });
  }

  /** A rename on one volume, otherwise a copy that is flushed before the original goes. */
  private async place(from: string, to: string, copyMode: number): Promise<void> {
    try {
      await this.fs.rename(from, to);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    }
    try {
      await this.fs.copyFile(from, to, copyMode);
      await this.fs.fsync(to);
    } catch (err) {
      if (copyMode !== 0) await this.fs.unlink(to).catch(() => undefined);
      throw err;
    }
    await this.fs.unlink(from).catch(() => undefined);
  }

  /** The user's download folder, resolved; it may be a link (a moved Downloads), it is the OS's. */
  private userFolder(): string | null {
    const dir = this.deps.userDir?.();
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
    try {
      const resolved = this.fs.realpath(dir);
      return this.fs.lstat(resolved).isDirectory() ? resolved : null;
    } catch {
      return null;
    }
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
      if (this.handed.has(name) || this.user.has(name)) continue;
      const file = path.join(this.deps.dir, name);
      try {
        const st = fs.lstatSync(file);
        if (st.isFile() && now - st.mtimeMs > DOWNLOAD_FILE_TTL_MS) fs.unlinkSync(file);
      } catch { /* gone */ }
    }
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/**
 * Chrome's suggested name, made safe again for a folder of the user's: no
 * separators, control or bidi-override characters, or characters Windows
 * refuses; no leading dots or spaces, no trailing dots or spaces; a Windows
 * device name gets a leading underscore; at most MAX_NAME characters, the
 * extension kept. "download" when nothing is left.
 */
export function safeDownloadName(suggested: unknown): string {
  let name = typeof suggested === 'string' ? suggested : '';
  // eslint-disable-next-line no-control-regex -- control characters are what is being removed
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*‪-‮⁦-⁩]/g, '_');
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!name) name = 'download';
  if (WINDOWS_RESERVED.test(name.split('.')[0].trim())) name = `_${name}`;
  if (name.length > MAX_NAME) {
    const ext = path.extname(name);
    const keep = ext.length > 0 && ext.length <= 16 ? ext : '';
    name = name.slice(0, MAX_NAME - keep.length).replace(/[.\s]+$/, '') + keep;
  }
  return name;
}

/** Folders of this process's that are in use; any other, of a process gone or of this one, is swept. */
const activeDirs = new Set<string>();

/**
 * Main's own download folder for this process: owner-only, named by pid, so
 * a later start can sweep one whose process is gone. The sweep of earlier
 * folders runs off the main thread's way, and does not hold this up.
 */
export function makeDownloadRelayDir(root = os.tmpdir()): string {
  const dir = fs.mkdtempSync(path.join(root, `${DIR_PREFIX}${process.pid}-`));
  fs.chmodSync(dir, 0o700);
  activeDirs.add(dir);
  void sweepDeadDownloadRelayDirs(root);
  return dir;
}

/** Remove `dir` and the plain files in it; anything else (a link, a folder) is left. A later sweep retries what stays. */
export function removeDownloadRelayDir(dir: string): void {
  activeDirs.delete(dir);
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
    } catch { /* gone, or still open */ }
  }
  try {
    fs.rmdirSync(dir);
  } catch { /* not empty, or gone */ }
}

/** Folders a previous wmux left whose process is gone, and this one's no Chrome uses any more. */
export async function sweepDeadDownloadRelayDirs(root: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    const match = DIR_NAME.exec(name);
    if (!match) continue;
    const dir = path.join(root, name);
    const pid = Number(match[1]);
    if (pid === process.pid ? activeDirs.has(dir) : alive(pid)) continue;
    try {
      if (!(await fsp.lstat(dir)).isDirectory()) continue;
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
