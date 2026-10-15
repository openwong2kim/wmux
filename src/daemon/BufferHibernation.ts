import type { ManagedSession } from './DaemonSessionManager';

/**
 * Idle-pane buffer hibernation.
 *
 * An open pane's ring buffer stays in daemon memory for as long as the pane is
 * open (the TTL reapers never touch an attached pane), so months-old panes that
 * once ran an agent hold their full ring (8 MB by default) indefinitely. A pane
 * that is idle, unwatched and agent-free gets its ring moved to the recovery
 * `.buf` it would be dumped to anyway (RingBuffer.hibernate) and its memory
 * released. The shell keeps running. The bytes come back synchronously on the
 * first read or write of the ring (attach flush, web snapshot, text read, new
 * PTY output), so no caller has to know a ring can be hibernated.
 *
 * The rules only decide WHEN releasing is worth it; correctness does not
 * depend on them, because every access path wakes the ring.
 */

/** Below this many stored bytes, a ring is not worth moving to disk. */
export const HIBERNATE_MIN_BYTES = 1024 * 1024;

/** After a failed dump, wait this long before trying that ring again. */
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;

/** Agent statuses that mean an agent is mid-turn or waiting on the user. */
const BUSY_AGENT_STATUSES = new Set(['running', 'waiting', 'awaiting_input']);

export interface BufferHibernationDeps {
  sessions: () => readonly ManagedSession[];
  /** The recovery dump path for a session (`buffers/<id>.buf`). */
  bufferPath: (id: string) => string;
  ensureBufferDir: () => void;
  /** `config.session.hibernateIdleHours`; 0 or less turns hibernation off. */
  idleHours: () => number;
  /** Agent process truth: true while an attributed agent process is alive. */
  agentProcessAlive: (id: string) => boolean | undefined;
  /** A web or phone client streams this pane or watches its turns. */
  remoteViewer: (id: string) => boolean;
  log: (level: 'info' | 'warn', msg: string) => void;
  now?: () => number;
  minBytes?: number;
}

export interface HibernationSweepResult {
  hibernated: number;
  freedBytes: number;
  failed: number;
}

/**
 * Why `managed` must stay in memory right now, or null when it may hibernate.
 * Pure: reads only in-memory state, never the ring's bytes.
 */
export function hibernationBlocker(
  managed: ManagedSession,
  deps: Pick<BufferHibernationDeps, 'idleHours' | 'agentProcessAlive' | 'remoteViewer' | 'minBytes'>,
  now: number,
): string | null {
  const { meta, ringBuffer } = managed;
  const idleHours = deps.idleHours();
  if (!(idleHours > 0)) return 'off';
  if (meta.state !== 'attached' && meta.state !== 'detached') return 'not-live';
  if (ringBuffer.backend !== 'node') return 'rust-ring';
  if (ringBuffer.isHibernated) return 'hibernated';
  if (ringBuffer.size <= (deps.minBytes ?? HIBERNATE_MIN_BYTES)) return 'small';
  const lastOutput = Date.parse(meta.lastActivity);
  if (!Number.isFinite(lastOutput) || now - lastOutput < idleHours * 3_600_000) return 'recent-output';
  // Something reads this pane (a phone poll, a pane search): releasing it
  // again would only reload it from disk on the next read.
  if (now - ringBuffer.lastWakeAt < idleHours * 3_600_000) return 'recent-wake';
  // An exec unit is its own agent process for as long as the session lives.
  if (meta.exec) return 'agent';
  if (deps.agentProcessAlive(meta.id) === true) return 'agent';
  if (BUSY_AGENT_STATUSES.has(managed.bridge.getAgentStatus())) return 'agent';
  if (managed.promptLog.commandRunningIfKnown() === true) return 'command';
  if (meta.state === 'attached' && managed.viewerVisible) return 'visible';
  if (deps.remoteViewer(meta.id)) return 'remote-viewer';
  return null;
}

export function createBufferHibernation(deps: BufferHibernationDeps): {
  sweep: () => Promise<HibernationSweepResult>;
} {
  const now = deps.now ?? Date.now;
  const retryAt = new WeakMap<object, number>();
  let running = false;

  async function sweep(): Promise<HibernationSweepResult> {
    const result: HibernationSweepResult = { hibernated: 0, freedBytes: 0, failed: 0 };
    if (running || !(deps.idleHours() > 0)) return result;
    running = true;
    try {
      const candidates = deps.sessions().filter((m) => hibernationBlocker(m, deps, now()) === null);
      if (candidates.length > 0) deps.ensureBufferDir();
      for (const managed of candidates) {
        const ring = managed.ringBuffer;
        if ((retryAt.get(ring) ?? 0) > now()) continue;
        try {
          const freed = await ring.hibernate(
            deps.bufferPath(managed.meta.id),
            // Re-checked after the dump lands: an attach, output or agent
            // start during the write keeps the ring in memory.
            () => hibernationBlocker(managed, deps, now()) === null,
          );
          if (freed > 0) {
            result.hibernated++;
            result.freedBytes += freed;
          }
        } catch (err) {
          // The ring was not released, so nothing is lost; try again later.
          result.failed++;
          retryAt.set(ring, now() + RETRY_AFTER_FAILURE_MS);
          deps.log('warn', `[hibernate] dump failed for ${managed.meta.id}, keeping it in memory: ${String(err)}`);
        }
      }
      if (result.hibernated > 0) {
        deps.log('info', `[hibernate] released ${result.hibernated} idle pane buffer(s), ${(result.freedBytes / 1024 / 1024).toFixed(1)} MiB`);
      }
      return result;
    } finally {
      running = false;
    }
  }

  return { sweep };
}
