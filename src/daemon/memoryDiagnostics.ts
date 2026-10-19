import type { DaemonMemoryDiagnostics } from '../shared/memoryDiagnostics';
import type { ManagedSession } from './DaemonSessionManager';
import type { SessionPipe } from './SessionPipe';
import { RingBuffer } from './RingBuffer';

/** Read counters only: never copy terminal contents or trigger a snapshot. */
export function collectDaemonMemoryDiagnostics(
  sessions: readonly ManagedSession[],
  pipes: ReadonlyMap<string, SessionPipe>,
): DaemonMemoryDiagnostics {
  const memory = process.memoryUsage();
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
  };
}
