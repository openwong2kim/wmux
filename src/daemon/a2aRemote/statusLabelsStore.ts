import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { A2A_REMOTE_RECORD_V, isA2aStatusLabels, type A2aStatusLabels } from '../../shared/a2aRemote';
import { loadStore, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Whether a menu's labels leave this PC in a worker's status
 * (`a2a-remote-status.json`, headlessStatus.ts): `send` (the default; they are
 * redacted on a spawn link), or `keep` (only how many there are, and the
 * menu's id, go). Its own file, not a field of the spawn policy: a policy
 * rewritten by an older build drops fields it does not know, which would
 * silently turn a `keep` back into sending. A missing, unreadable or garbled
 * file reads as the default (logged once).
 */
export const STATUS_LABELS_FILE = 'a2a-remote-status.json';

interface StatusSettingsV1 {
  v: 1;
  labels: A2aStatusLabels;
}

function coerce(raw: unknown): StatusSettingsV1 | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return r['v'] === A2A_REMOTE_RECORD_V && isA2aStatusLabels(r['labels']) ? { v: 1, labels: r['labels'] } : null;
}

export interface StatusLabelsStoreOptions {
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seams. */
  write?: (filePath: string, data: unknown) => void;
  scheduleHarden?: (filePath: string) => void;
}

export class StatusLabelsStore {
  readonly filePath: string;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private labels: A2aStatusLabels;
  private readonly writable: boolean;

  constructor(opts: StatusLabelsStoreOptions) {
    this.filePath = path.join(opts.dir, STATUS_LABELS_FILE);
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    const loaded = loadStore({
      filePath: this.filePath,
      fileName: STATUS_LABELS_FILE,
      coerce,
      now: opts.now ?? Date.now,
      log: this.log,
      level: 'warn',
      emptyMeans: 'menu labels are sent (the default)',
    });
    this.labels = loaded.value?.labels ?? 'send';
    this.writable = loaded.writable;
  }

  get(): A2aStatusLabels {
    return this.labels;
  }

  set(labels: A2aStatusLabels): { ok: true; labels: A2aStatusLabels } | { ok: false; error: string } {
    if (!this.writable) return { ok: false, error: storeUnavailable(STATUS_LABELS_FILE).message };
    try {
      this.write(this.filePath, { v: 1, labels } satisfies StatusSettingsV1);
      this.scheduleHarden(this.filePath);
    } catch (err) {
      return { ok: false, error: `${STATUS_LABELS_FILE}: not saved: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.labels = labels;
    return { ok: true, labels };
  }
}
