import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import type { HostId } from '../../shared/a2aRemote';
import { coerceContinuePolicy, defaultContinuePolicy, type A2aContinuePolicyV1 } from '../../shared/a2aContinue';
import { loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * This PC's policy for continuing conversations between PCs
 * (`continue-policy.json`): as B, whether it takes them (from the PCs,
 * folders and agents the remote-spawn policy allows); as A, the PCs it may
 * send one to. A missing file is the default: off both ways.
 *
 * Only the app's own human changes it, like the spawn policy.
 */

export const CONTINUE_POLICY_FILE = 'continue-policy.json';

export type ContinuePolicySetResult =
  | { ok: true; policy: A2aContinuePolicyV1 }
  | { ok: false; error: string; conflict?: true };

export interface ContinuePolicyStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seams. */
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
}

export class ContinuePolicyStore {
  readonly filePath: string;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private policy: A2aContinuePolicyV1;
  private readonly writable: boolean;
  /** A removed PC is gone from memory but its removal is not on disk yet: the next write carries it. */
  private unsaved = false;

  constructor(opts: ContinuePolicyStoreOptions) {
    this.filePath = path.join(opts.dir, CONTINUE_POLICY_FILE);
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: CONTINUE_POLICY_FILE,
      coerce: coerceContinuePolicy,
      now: opts.now ?? Date.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'continuing conversations starts off both ways',
    });
    this.policy = loaded.value ?? defaultContinuePolicy();
    this.writable = loaded.writable;
  }

  get(): A2aContinuePolicyV1 {
    return structuredClone(this.policy);
  }

  /**
   * Replace the policy with `raw`. `raw.version` is the version the caller
   * read, and is required; a save whose version is no longer current is a
   * `conflict` and changes nothing. The write lands before the policy in
   * memory changes.
   */
  set(raw: unknown): ContinuePolicySetResult {
    if (!this.writable) return { ok: false, error: storeUnavailable(CONTINUE_POLICY_FILE).message };
    const next = coerceContinuePolicy(raw);
    // coerce reads a missing version as 0: the caller's own must be there.
    const read = (raw as { version?: unknown } | null)?.version;
    if (!next || typeof read !== 'number' || !Number.isInteger(read) || read < 0) return { ok: false, error: 'the policy is not valid' };
    if (read !== this.policy.version) return { ok: false, conflict: true, error: 'the settings changed in the meantime' };
    const saved: A2aContinuePolicyV1 = { ...next, version: this.policy.version + 1 };
    this.write(this.filePath, saved);
    this.scheduleHarden(this.filePath);
    this.policy = saved;
    this.unsaved = false;
    return { ok: true, policy: structuredClone(saved) };
  }

  /** A paired PC was removed: this PC no longer sends it conversations (a re-pair starts from nothing). */
  forgetHost(hostId: HostId): boolean {
    return this.retainHosts((h) => h !== hostId, `forgetting ${hostId}`);
  }

  /**
   * Keep only the PCs `paired` still knows, e.g. on start; true when one was
   * dropped. Memory first: the live policy stops allowing a removed PC even
   * when the file cannot be written. Then a write that fails throws, and the
   * removal stays owed: the next save, or the next call of this (even one
   * that drops nothing, such as after that PC is paired again), writes it.
   */
  retainHosts(paired: (hostId: HostId) => boolean, why = 'dropping PCs no longer paired'): boolean {
    const gone = Object.keys(this.policy.out).filter((h) => !paired(h));
    if (gone.length > 0) {
      const out = { ...this.policy.out };
      for (const h of gone) delete out[h];
      this.policy = { ...this.policy, out, version: this.policy.version + 1 };
      this.unsaved = true;
    }
    if (this.unsaved) {
      try {
        if (!this.writable) throw storeUnavailable(CONTINUE_POLICY_FILE);
        this.write(this.filePath, this.policy);
        this.scheduleHarden(this.filePath);
      } catch (err) {
        throw new Error(`${CONTINUE_POLICY_FILE}: not saved after ${why}: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.unsaved = false;
    }
    return gone.length > 0;
  }
}
