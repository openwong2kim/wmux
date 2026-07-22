// ─── Statusline mirror — per-account usage cache file ────────────────────────
//
// Mirrors AccountUsageService's in-memory cache (plus the default-credential
// UsagePoller snapshot) to `<wmuxDir>/usage/usage-cache.json` so OUT-OF-PROCESS
// readers — the Claude Code statusline script (wmux-statusline.mjs), which runs
// inside each claude process — can render `account · 5h N% · 7d N%` without an
// IPC channel or any credential access.
//
// Contract:
//   - Content is DERIVED state only: names, config dirs, percentages, ages.
//     Never tokens, never transcript content. Losing/deleting the file is
//     harmless — it regenerates on the next probe.
//   - Writes are debounced (a turn-end can flip several accounts in a burst)
//     and atomic (tmp+rename) so a reader never sees a torn JSON.

import path from 'node:path';
import type { UsageSnapshot } from '../claude/UsageApi';
import { atomicWriteJSONSync } from '../../daemon/util/atomicWrite';

/** One row a statusline process can key on by its own CLAUDE_CONFIG_DIR. */
export interface UsageCacheFileEntry {
  /** Registered account id, or null for the default `~/.claude` credential. */
  accountId: string | null;
  /** Human label ("회사 Max"); 'default' for the unregistered default dir. */
  name: string;
  /** Canonical config dir — the statusline's lookup key. */
  configDir: string;
  status: string;
  snapshot: UsageSnapshot | null;
  fetchedAtMs: number | null;
}

export interface UsageCacheFile {
  version: 1;
  updatedAtMs: number;
  entries: UsageCacheFileEntry[];
}

const DEFAULT_DEBOUNCE_MS = 300;

/**
 * Debounced atomic writer. `collect` is called at flush time so the file always
 * reflects the freshest cache, no matter how many change events coalesced.
 */
export class UsageCacheFileWriter {
  private timer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly filePath: string,
    private readonly collect: () => UsageCacheFileEntry[],
    private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Request a write. Coalesces bursts into one file write per debounce window. */
  schedule(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    // A pending mirror write must never keep the process alive on quit.
    this.timer.unref?.();
  }

  /** Immediate write (used by tests and the dispose path). Never throws — a
   *  full disk or locked file must not take down the usage feature itself. */
  flush(): void {
    try {
      const payload: UsageCacheFile = {
        version: 1,
        updatedAtMs: this.now(),
        entries: this.collect(),
      };
      atomicWriteJSONSync(this.filePath, payload);
    } catch (err) {
      console.warn(`[usage-cache] mirror write failed: ${String(err)}`);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      // Flush what we have so a quit right after a probe still lands on disk.
      this.flush();
    }
    this.disposed = true;
  }
}

export function usageCacheFilePath(wmuxDir: string): string {
  return path.join(wmuxDir, 'usage', 'usage-cache.json');
}
