// ─── Versioned JSON files of the factory runtime ───────────────────────────
//
// The bot runtime's stores (settings, bots, wake queue, sessions) keep their
// state in memory and persist it as `{version, ...}` JSON under
// `<wmuxDir>/factory/`. Reads are sync at start; a file written by another
// version is refused (thrown), never guessed at or overwritten. Writes go
// through one serial chain per file and always write the newest in-memory
// state, so a burst of mutations coalesces into few writes and a later write
// can never be overtaken by an earlier one.

import fs from 'node:fs';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { createSerialChain } from '../deck/serialChain';
import { assertNotLiveWmuxPath } from '../../shared/constants';

/** The file's parsed body, or null when it does not exist. Throws when it
 *  exists but is unreadable or carries another version. */
export function readVersionedFile(file: string, version: number): Record<string, unknown> | null {
  // The atomic reader falls back to the write's backup, so a crash between
  // rotating the backup and committing the new file loses nothing.
  const raw = atomicReadJSONSync<unknown>(file);
  if (raw === null && !fs.existsSync(file)) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} is unreadable`);
  }
  const v = (raw as { version?: unknown }).version;
  if (v !== version) throw new Error(`${file} has version ${String(v)}, expected ${version}`);
  return raw as Record<string, unknown>;
}

export interface FilePersister {
  /** Schedule a write of the current snapshot; resolves once it is on disk. */
  schedule(): Promise<void>;
}

export function createFilePersister(file: string, snapshot: () => unknown): FilePersister {
  assertNotLiveWmuxPath(file);
  const chain = createSerialChain();
  let pending: Promise<void> | null = null;
  return {
    schedule() {
      // One queued write is enough: it reads the snapshot when it runs.
      pending ??= chain(async () => {
        pending = null;
        await atomicWriteJSON(file, snapshot());
      });
      return pending;
    },
  };
}
