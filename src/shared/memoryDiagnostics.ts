/** On-demand diagnostics. All sizes are bytes; counters overlap, so do not sum them. */
export interface DaemonMemoryDiagnostics {
  pid: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  sessions: Array<{
    id: string;
    state: string;
    ringStoredBytes: number;
    ringAllocatedBytes: number;
    ringCapacityBytes: number;
    socketQueuedBytes: number;
    socketPeakQueuedBytes: number;
    resyncQueuedBytes: number;
    /** The ring sits in its `.buf` (idle hibernation); absent from older daemons. */
    ringHibernated?: boolean;
    /** Output this pane has produced since it started; absent from older daemons. */
    ringLifetimeBytes?: number;
  }>;
  /** Idle panes whose ring sits in its `.buf`, and the ring memory that freed. Absent from older daemons. */
  hibernation?: { sessions: number; freedBytes: number; wakeFailures?: number };
  /**
   * Screen reads from the ring, by kind: answered from the previous read
   * (nothing moved), joined to one still running, or parsed. Absent from older daemons.
   */
  screenReads?: Record<string, { hits: number; joins: number; misses: number }>;
  /**
   * Parses of a ring by family and depth (`screen`, `pane`, `text<=300`, ...).
   * `ms` runs from asking to the answer, so it includes the queue wait.
   * Absent from older daemons.
   */
  screenParses?: Record<string, { parses: number; msTotal: number; msMax: number; bytes: number }>;
  /** The concurrency-1 snapshot queue every whole-ring parse waits on. Absent from older daemons. */
  snapshotQueue?: { jobs: number; waitMsTotal: number; waitMsMax: number; runMsTotal: number; runMsMax: number };
  /** Main-thread busy and idle time since the daemon started. Absent from older daemons. */
  eventLoop?: { activeMs: number; idleMs: number };
  /**
   * Native (Rust) snapshot use by backend: answered natively, fell back to
   * xterm after trying, or skipped straight to xterm. `reasons` counts each
   * fallback and skip. Absent from older daemons.
   */
  snapshots?: { ansi: SnapshotBackendCounters; text: SnapshotBackendCounters };
}

export interface SnapshotBackendCounters {
  native: number;
  fallbacks: number;
  skipped: number;
  /** The native module failed and is bypassed until it changes. */
  circuitOpen: boolean;
  reasons: Record<string, number>;
}

export interface AppMemoryDiagnostics {
  mainPid: number;
  processes: Array<{ pid: number; type: string; workingSetBytes: number }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function counters(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) >= 0);
}

/** Absent, or a record whose every entry holds these counters. */
function countersByKey(value: unknown, keys: string[]): boolean {
  return value === undefined || (record(value) && Object.values(value).every((entry) => record(entry) && counters(entry, keys)));
}

function snapshotBackendCounters(value: unknown): boolean {
  return record(value) && counters(value, ['native', 'fallbacks', 'skipped']) &&
    typeof value.circuitOpen === 'boolean' && record(value.reasons) &&
    counters(value.reasons, Object.keys(value.reasons));
}

export function isDaemonMemoryDiagnostics(value: unknown): value is DaemonMemoryDiagnostics {
  return record(value) && counters(value, ['pid', 'rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'arrayBuffersBytes']) &&
    Array.isArray(value.sessions) && value.sessions.every((session: unknown) =>
      record(session) && typeof session.id === 'string' && typeof session.state === 'string' &&
      counters(session, ['ringStoredBytes', 'ringAllocatedBytes', 'ringCapacityBytes', 'socketQueuedBytes', 'socketPeakQueuedBytes', 'resyncQueuedBytes'])) &&
    (value.hibernation === undefined || (record(value.hibernation) && counters(value.hibernation, ['sessions', 'freedBytes']) &&
      (value.hibernation.wakeFailures === undefined || counters(value.hibernation, ['wakeFailures'])))) &&
    (value.snapshots === undefined || (record(value.snapshots) &&
      snapshotBackendCounters(value.snapshots.ansi) && snapshotBackendCounters(value.snapshots.text) &&
      Object.values(value.snapshots).every(snapshotBackendCounters))) &&
    countersByKey(value.screenReads, ['hits', 'joins', 'misses']) &&
    countersByKey(value.screenParses, ['parses', 'msTotal', 'msMax', 'bytes']) &&
    (value.snapshotQueue === undefined || (record(value.snapshotQueue) && counters(value.snapshotQueue, ['jobs', 'waitMsTotal', 'waitMsMax', 'runMsTotal', 'runMsMax']))) &&
    (value.eventLoop === undefined || (record(value.eventLoop) && counters(value.eventLoop, ['activeMs', 'idleMs'])));
}

export function isAppMemoryDiagnostics(value: unknown): value is AppMemoryDiagnostics {
  return record(value) && counters(value, ['mainPid']) && Array.isArray(value.processes) &&
    value.processes.every((p: unknown) => record(p) && typeof p.type === 'string' && counters(p, ['pid', 'workingSetBytes']));
}
