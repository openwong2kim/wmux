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
 */
export const APPROVALS_FILE = 'a2a-remote-approvals.json';

interface ApprovalsSettingsV1 {
  v: 1;
  hosts: Record<HostId, { exposure: A2aApprovalExposure }>;
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
  const hosts: Record<HostId, { exposure: A2aApprovalExposure }> = {};
  for (const [hostId, entry] of Object.entries(raw['hosts'])) {
    if (!isHostId(hostId) || !isPlainObject(entry) || !isA2aApprovalExposure(entry['exposure'])) return null;
    if (Object.keys(entry).length !== 1) return null;
    hosts[hostId] = { exposure: entry['exposure'] };
  }
  const damagedAt = raw['damagedAt'];
  if (damagedAt !== undefined && (Object.keys(hosts).length > 0 || !isIsoString(damagedAt))) return null;
  return { v: 1, hosts, ...(typeof damagedAt === 'string' ? { damagedAt } : {}) };
}

export interface ApprovalSwitchStoreOptions {
  dir: string;
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
  private hosts: Record<HostId, { exposure: A2aApprovalExposure }>;
  private damaged: boolean;
  private readonly writable: boolean;

  constructor(opts: ApprovalSwitchStoreOptions) {
    this.filePath = path.join(opts.dir, APPROVALS_FILE);
    this.log = opts.log ?? ((): void => undefined);
    this.now = opts.now ?? Date.now;
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
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

  /** The PCs it is on for, and whether every PC is off because the file was damaged. */
  get(): { hosts: Record<HostId, A2aApprovalExposure>; damaged: boolean } {
    const hosts: Record<HostId, A2aApprovalExposure> = {};
    for (const [hostId, entry] of Object.entries(this.hosts)) hosts[hostId] = entry.exposure;
    return { hosts, damaged: this.damaged };
  }

  /** What `hostId` sees of a prompt, or null: off (not listed, no file, or damaged). */
  exposure(hostId: HostId): A2aApprovalExposure | null {
    if (this.damaged) return null;
    return Object.prototype.hasOwnProperty.call(this.hosts, hostId) ? this.hosts[hostId].exposure : null;
  }

  /** Whether it is on for any PC. */
  anyOn(): boolean {
    return !this.damaged && Object.keys(this.hosts).length > 0;
  }

  /** Turn it on for `hostId` with that exposure, or off (`off`: the PC is removed from the list). */
  set(hostId: HostId, exposure: A2aApprovalExposure | 'off'): { ok: true; hosts: Record<HostId, A2aApprovalExposure> } | { ok: false; error: string } {
    if (!this.writable) return { ok: false, error: storeUnavailable(APPROVALS_FILE).message };
    if (!isHostId(hostId)) return { ok: false, error: 'not a host id' };
    // A damaged file's list was never read: setting one PC starts from an empty list.
    const next: Record<HostId, { exposure: A2aApprovalExposure }> = this.damaged ? {} : { ...this.hosts };
    if (exposure === 'off') delete next[hostId];
    else next[hostId] = { exposure };
    const error = this.persist({ v: 1, hosts: next });
    if (error) return { ok: false, error };
    this.hosts = next;
    this.damaged = false;
    return { ok: true, hosts: this.get().hosts };
  }
}
