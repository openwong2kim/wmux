import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { A2A_REMOTE_RECORD_V, isA2aApprovalExposure, isHostId, type A2aApprovalExposure, type HostId } from '../../shared/a2aRemote';
import { isIsoString, isPlainObject, loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Which paired PCs may allow or deny permission prompts in the tasks they sent
 * to a linked pane here (`a2a-remote-approvals.json`), and what each sees of a
 * prompt (`A2aApprovalExposure`). A PC not listed is off.
 *
 * No file means off for every PC: there is no default and nothing else
 * (follow-ups, answers) turns it on. A file that is there but cannot be read
 * or parsed reads as off for every PC, and says so (`damaged`): it is set
 * aside and an empty list written in its place with the time it was found, so
 * the next start reads the same, until a person sets a PC again. If that write
 * fails, the file set aside (`<file>.corrupt-<time>`) with no file in its place
 * still reads as off on the next start. A file that cannot be told apart from
 * a missing one (a folder that cannot be searched) reads as there.
 *
 * Each entry holds a hash of the pairing it was set under (`pairing`): the PC's
 * peer records on this PC when it was set. An entry whose pairing is not the
 * PC's current one reads as off, so a PC paired again starts off even when the
 * removal of its old entry was never written.
 */
export const APPROVALS_FILE = 'a2a-remote-approvals.json';

interface ApprovalEntry {
  exposure: A2aApprovalExposure;
  /** sha256 hex of the PC's pairing when it was set (ApprovalSwitchStoreOptions.pairing). */
  pairing: string;
}

interface ApprovalsSettingsV1 {
  v: 1;
  hosts: Record<HostId, ApprovalEntry>;
  /** Set when the file was found damaged and an empty list written in its place. */
  damagedAt?: string;
}

/** Only ENOENT is a missing file: any other failure to look (EACCES on the folder, say) counts as a file there. */
function fileThere(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/**
 * A PC's pairing here, for ApprovalSwitchStoreOptions.pairing: its unrevoked
 * peer records (it joined this PC) and its host record (this PC joined it),
 * by peer id. A new pairing mints a new peer id. Null: not paired.
 */
export function pairingOf(
  hostId: HostId,
  peers: ReadonlyArray<{ hostId: string; peerId: string; revokedAt?: string }>,
  joined: { peerId: string } | undefined,
): string | null {
  const ids = peers.filter((p) => p.hostId === hostId && !p.revokedAt).map((p) => `peer:${p.peerId}`);
  if (joined) ids.push(`host:${joined.peerId}`);
  return ids.length > 0 ? ids.sort().join('\n') : null;
}

/** A damaged file set aside by an earlier start whose repair write failed. */
function corruptLeftover(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => name.startsWith(`${APPROVALS_FILE}.corrupt-`));
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** Strict: any entry this version does not read makes the whole file damaged, never a partial list. */
export function coerceApprovalsSettings(raw: unknown): ApprovalsSettingsV1 | null {
  if (!isPlainObject(raw)) return null;
  if (raw['v'] !== A2A_REMOTE_RECORD_V || !isPlainObject(raw['hosts'])) return null;
  if (Object.keys(raw).some((k) => k !== 'v' && k !== 'hosts' && k !== 'damagedAt')) return null;
  const hosts: Record<HostId, ApprovalEntry> = {};
  for (const [hostId, entry] of Object.entries(raw['hosts'])) {
    if (!isHostId(hostId) || !isPlainObject(entry) || !isA2aApprovalExposure(entry['exposure'])) return null;
    const pairing = entry['pairing'];
    if (typeof pairing !== 'string' || !/^[0-9a-f]{64}$/.test(pairing) || Object.keys(entry).length !== 2) return null;
    hosts[hostId] = { exposure: entry['exposure'], pairing };
  }
  const damagedAt = raw['damagedAt'];
  if (damagedAt !== undefined && (Object.keys(hosts).length > 0 || !isIsoString(damagedAt))) return null;
  return { v: 1, hosts, ...(typeof damagedAt === 'string' ? { damagedAt } : {}) };
}

export interface ApprovalSwitchStoreOptions {
  dir: string;
  /** The PC's pairing here as it is now (its peer records), or null: not paired. */
  pairing: (hostId: HostId) => string | null;
  now?: () => number;
  log?: StoreLog;
  /** Test seams. */
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
}

export class ApprovalSwitchStore {
  readonly filePath: string;
  private readonly log: StoreLog;
  private readonly now: () => number;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly pairing: (hostId: HostId) => string | null;
  private hosts: Record<HostId, ApprovalEntry>;
  private damaged: boolean;
  private readonly writable: boolean;

  constructor(opts: ApprovalSwitchStoreOptions) {
    this.filePath = path.join(opts.dir, APPROVALS_FILE);
    this.log = opts.log ?? ((): void => undefined);
    this.now = opts.now ?? Date.now;
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    this.pairing = opts.pairing;
    const present = fileThere(this.filePath);
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: APPROVALS_FILE,
      coerce: coerceApprovalsSettings,
      now: this.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'approvals from other PCs are off for every PC until `wmux remote approvals` sets one',
    });
    this.writable = loaded.writable;
    if (loaded.value) {
      this.hosts = loaded.value.hosts;
      this.damaged = loaded.value.damagedAt !== undefined;
    } else if (!present && !corruptLeftover(opts.dir)) {
      this.hosts = {};
      this.damaged = false;
    } else {
      this.hosts = {};
      this.damaged = true;
      // Set aside as damaged (now, or by a start whose repair write failed): an empty list takes its place on disk too.
      if (this.writable) this.persist({ v: 1, hosts: {}, damagedAt: new Date(this.now()).toISOString() });
    }
  }

  private persist(data: ApprovalsSettingsV1): string | null {
    try {
      this.write(this.filePath, data);
      this.scheduleHarden(this.filePath);
      return null;
    } catch (err) {
      const error = `${APPROVALS_FILE}: not saved: ${err instanceof Error ? err.message : String(err)}`;
      this.log('error', `[a2a-remote] ${error}`);
      return error;
    }
  }

  /** sha256 hex of the PC's pairing now, or null when it is not paired. */
  private pairingHash(hostId: HostId): string | null {
    const pairing = this.pairing(hostId);
    return pairing === null ? null : crypto.createHash('sha256').update(pairing).digest('hex');
  }

  /** The entry, when it was set under the PC's current pairing. */
  private current(hostId: HostId, entry: ApprovalEntry): boolean {
    return entry.pairing === this.pairingHash(hostId);
  }

  /** The PCs it is on for, and whether every PC is off because the file was damaged. */
  get(): { hosts: Record<HostId, A2aApprovalExposure>; damaged: boolean } {
    const hosts: Record<HostId, A2aApprovalExposure> = {};
    if (!this.damaged) for (const [hostId, entry] of Object.entries(this.hosts)) if (this.current(hostId, entry)) hosts[hostId] = entry.exposure;
    return { hosts, damaged: this.damaged };
  }

  /** What `hostId` sees of a prompt, or null: off (not listed, no file, damaged, or set under another pairing). */
  exposure(hostId: HostId): A2aApprovalExposure | null {
    if (this.damaged || !Object.prototype.hasOwnProperty.call(this.hosts, hostId)) return null;
    const entry = this.hosts[hostId];
    return this.current(hostId, entry) ? entry.exposure : null;
  }

  /** Whether it is on for any PC. */
  anyOn(): boolean {
    return Object.keys(this.get().hosts).length > 0;
  }

  /** The PC is no longer paired (the revoke cascade): it is off, and stays off if it is paired again. */
  forgetHost(hostId: HostId): boolean {
    return this.retainHosts((h) => h !== hostId);
  }

  /**
   * Keep only the PCs `paired` still knows under the pairing their entry was
   * set in, e.g. on start: a removal whose write failed before a restart is
   * applied again here. Memory first: a removed PC is off even when the file
   * cannot be written (logged), and an entry left on disk by such a write
   * stays off once the PC is paired again (`pairing`).
   */
  retainHosts(paired: (hostId: HostId) => boolean): boolean {
    const gone = Object.entries(this.hosts).filter(([h, entry]) => !paired(h) || !this.current(h, entry)).map(([h]) => h);
    if (gone.length === 0) return false;
    const next = { ...this.hosts };
    for (const h of gone) delete next[h];
    this.hosts = next;
    if (this.writable) this.persist({ v: 1, hosts: next });
    else this.log('error', `[a2a-remote] ${storeUnavailable(APPROVALS_FILE).message}; removed PCs are off until it can be written`);
    return true;
  }

  /** Turn it on for `hostId` with that exposure, or off (`off`: the PC is removed from the list). */
  set(hostId: HostId, exposure: A2aApprovalExposure | 'off'): { ok: true; hosts: Record<HostId, A2aApprovalExposure> } | { ok: false; error: string } {
    if (!this.writable) return { ok: false, error: storeUnavailable(APPROVALS_FILE).message };
    if (!isHostId(hostId)) return { ok: false, error: 'not a host id' };
    const pairing = exposure === 'off' ? null : this.pairingHash(hostId);
    if (exposure !== 'off' && pairing === null) return { ok: false, error: 'that PC is not paired with this one' };
    // A damaged file's list was never read: setting one PC starts from an empty list.
    const next: Record<HostId, ApprovalEntry> = this.damaged ? {} : { ...this.hosts };
    if (exposure === 'off' || pairing === null) delete next[hostId];
    else next[hostId] = { exposure, pairing };
    const error = this.persist({ v: 1, hosts: next });
    if (error) return { ok: false, error };
    this.hosts = next;
    this.damaged = false;
    return { ok: true, hosts: this.get().hosts };
  }
}

/** A pane id as the daemon logs it; anything else is not written to the log. */
const LOGGED_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `a2a.remote.approvals.set`: validate (only a PC `paired` knows now may be
 * turned on), save, and write one log line naming
 * who asked (the caller's pane, or `none`), the PC, and the exposure before
 * and after. Nothing else goes in that line. `changed` runs after a save that
 * turned the PC on or off.
 */
export function setApprovals(
  store: ApprovalSwitchStore,
  params: Record<string, unknown>,
  deps: { log: StoreLog; changed?: (hostId: HostId, on: boolean) => void; paired?: (hostId: HostId) => boolean },
): { ok: true; hosts: Record<HostId, A2aApprovalExposure> } | { ok: false; error: string } {
  const hostId = params['hostId'];
  const exposure = params['exposure'];
  const sender = params['senderPtyId'];
  const by = sender === undefined ? 'none' : typeof sender === 'string' && LOGGED_ID_RE.test(sender) ? sender : 'invalid';
  const validHost = isHostId(hostId);
  const validExposure = exposure === 'off' || isA2aApprovalExposure(exposure);
  const before = validHost ? store.exposure(hostId) ?? 'off' : 'off';
  deps.log('info', `[a2a-remote] approvals set by=${by} host=${validHost ? hostId : 'invalid'} ${before}->${validExposure ? exposure : 'invalid'}`);
  if (!validHost) return { ok: false, error: 'hostId must be a paired PC\'s host id' };
  if (!validExposure) return { ok: false, error: "exposure must be 'off', 'tool-only' or 'command'" };
  // Turning a PC on needs it paired now; turning one off never does.
  if (exposure !== 'off' && deps.paired && !deps.paired(hostId)) return { ok: false, error: 'that PC is not paired with this one' };
  const res = store.set(hostId, exposure);
  if (res.ok && (before === 'off') !== (exposure === 'off')) deps.changed?.(hostId, exposure !== 'off');
  return res;
}
