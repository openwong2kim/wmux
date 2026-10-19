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
  }>;
  /** Idle panes whose ring sits in its `.buf`, and the ring memory that freed. Absent from older daemons. */
  hibernation?: { sessions: number; freedBytes: number; wakeFailures?: number };
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

export function isDaemonMemoryDiagnostics(value: unknown): value is DaemonMemoryDiagnostics {
  return record(value) && counters(value, ['pid', 'rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes', 'arrayBuffersBytes']) &&
    Array.isArray(value.sessions) && value.sessions.every((session: unknown) =>
      record(session) && typeof session.id === 'string' && typeof session.state === 'string' &&
      counters(session, ['ringStoredBytes', 'ringAllocatedBytes', 'ringCapacityBytes', 'socketQueuedBytes', 'socketPeakQueuedBytes', 'resyncQueuedBytes'])) &&
    (value.hibernation === undefined || (record(value.hibernation) && counters(value.hibernation, ['sessions', 'freedBytes']) &&
      (value.hibernation.wakeFailures === undefined || counters(value.hibernation, ['wakeFailures']))));
}

export function isAppMemoryDiagnostics(value: unknown): value is AppMemoryDiagnostics {
  return record(value) && counters(value, ['mainPid']) && Array.isArray(value.processes) &&
    value.processes.every((p: unknown) => record(p) && typeof p.type === 'string' && counters(p, ['pid', 'workingSetBytes']));
}
