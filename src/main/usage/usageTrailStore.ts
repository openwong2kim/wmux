// Persistence for UsageTrail: one JSON file in wmux's data dir, written
// atomically and at most once per SAVE_DEBOUNCE_MS, plus a flush for quit.
// Every write is synchronous, so a quit flush can never race an older async
// commit. A missing, corrupt or unknown-version file starts an empty trail;
// a file that is there but unusable is moved aside before a save can overwrite it.

import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { quarantineFileSync } from '../../daemon/util/atomicWrite/quarantine';
import type { UsageSnapshot } from '../claude/UsageApi';
import { UsageTrail, isUsageTrailFile, type UsageTrailSample } from './usageTrail';

export const SAVE_DEBOUNCE_MS = 30 * 1000;

export interface UsageTrailStoreDeps {
  now?: () => number;
  log?: (line: string) => void;
}

export class UsageTrailStore {
  private readonly trail: UsageTrail;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(private readonly filePath: string, deps: UsageTrailStoreDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.warn(line));
    this.trail = this.load();
  }

  record(key: string, snapshot: UsageSnapshot | null): void {
    if (!this.trail.record(key, snapshot, this.now())) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flushSync(), SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  read(key: string, sinceMs?: number, untilMs?: number): UsageTrailSample[] {
    return this.trail.read(key, sinceMs, untilMs);
  }

  keys(): string[] {
    return this.trail.keys();
  }

  /** Write any pending change now (the debounce timer and the quit paths). */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    try {
      atomicWriteJSONSync(this.filePath, this.trail.toFile(this.now()));
      this.dirty = false;
    } catch (err) {
      // Stays dirty: the next change or the quit flush retries.
      this.log(`[usageTrail] save failed: ${String(err)}`);
    }
  }

  private load(): UsageTrail {
    try {
      const file = atomicReadJSONSync(this.filePath, { validate: isUsageTrailFile });
      if (file) return UsageTrail.fromFile(file, this.now());
      // The read moves aside a file it rejected; one it could not parse stays.
      quarantineFileSync(this.filePath, 'unparseable usage trail');
    } catch (err) {
      this.log(`[usageTrail] load failed, starting empty: ${String(err)}`);
    }
    return new UsageTrail();
  }
}
