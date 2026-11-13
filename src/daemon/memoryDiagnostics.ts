import { performance } from 'node:perf_hooks';
import type { DaemonMemoryDiagnostics, SnapshotBackendCounters } from '../shared/memoryDiagnostics';
import type { ManagedSession } from './DaemonSessionManager';
import type { SessionPipe } from './SessionPipe';
import { RingBuffer } from './RingBuffer';
import { screenParseCounters, screenReadCounters, snapshotQueueCounters } from './screenReadCache';
import { getAnsiSnapshotBackendDiagnostics } from './AnsiSnapshotBackend';
import { getTextSnapshotBackendDiagnostics } from './TextSnapshotBackend';
import { tailReadCounters } from './guardedTailRead';

type BackendDiagnostics = SnapshotBackendCounters & { last?: unknown };
/** The counters without the last outcome, which says nothing a count doesn't. */
function snapshotCounters({ native, fallbacks, skipped, circuitOpen, reasons, reasonsSeen }: BackendDiagnostics): SnapshotBackendCounters {
  return { native, fallbacks, skipped, circuitOpen, reasons, ...(reasonsSeen ? { reasonsSeen } : {}) };
}

/** Read counters only: never copy terminal contents or trigger a snapshot. */
export function collectDaemonMemoryDiagnostics(
  sessions: readonly ManagedSession[],
  pipes: ReadonlyMap<string, SessionPipe>,
): DaemonMemoryDiagnostics {
  const memory = process.memoryUsage();
  const loop = performance.eventLoopUtilization();
  const hibernated = sessions.filter(({ ringBuffer }) => ringBuffer.isHibernated);
  return {
    pid: process.pid,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    sessions: sessions.map(({ meta, ringBuffer }) => ({
      id: meta.id,
      state: meta.state,
      ringStoredBytes: ringBuffer.size,
      ringAllocatedBytes: ringBuffer.allocatedBytes,
      ringCapacityBytes: ringBuffer.totalCapacity,
      ringLifetimeBytes: ringBuffer.totalBytesWritten,
      ...(pipes.get(meta.id)?.getMemoryDiagnostics() ?? {
        socketQueuedBytes: 0, socketPeakQueuedBytes: 0, resyncQueuedBytes: 0,
      }),
      ...(ringBuffer.isHibernated ? { ringHibernated: true } : {}),
    })),
    hibernation: {
      sessions: hibernated.length,
      freedBytes: hibernated.reduce((total, { ringBuffer }) => total + ringBuffer.hibernatedBytes, 0),
      wakeFailures: RingBuffer.wakeFailures,
    },
    screenReads: screenReadCounters(),
    screenParses: screenParseCounters(),
    snapshotQueue: snapshotQueueCounters(),
    eventLoop: { activeMs: loop.active, idleMs: loop.idle },
    snapshots: { ansi: snapshotCounters(getAnsiSnapshotBackendDiagnostics()), text: snapshotCounters(getTextSnapshotBackendDiagnostics()) },
    tailReads: tailReadCounters(),
  };
}
