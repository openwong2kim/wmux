import {
  StateWriter,
  type ExactStateTransaction,
  type ExactStateWriteOutcome,
} from './StateWriter';
import type {
  DaemonSessionLocationCandidate,
  DaemonSessionLocationCandidateInput,
  DaemonSessionManager,
} from './DaemonSessionManager';
import type { SessionLocationSnapshot } from '../shared/sessionLocation';
import type { DaemonState } from './types';

export type SessionLocationDurability = 'asap' | 'immediate-retry';
export type SessionLocationTransactionOutcome =
  | ExactStateWriteOutcome
  | 'publication-failed';

export interface SessionLocationTransactionRequest {
  durability: SessionLocationDurability;
  prepare: (transactionId: number) => ReturnType<ExactStateTransaction['prepare']>;
  commit: (transactionId: number) => ReturnType<ExactStateTransaction['commit']>;
  current: ExactStateTransaction['current'];
  publish: (transactionId: number) => void;
}

/**
 * Sole daemon coordinator for accepting, persisting, committing, and
 * publishing session-location candidates. Requests run in producer order.
 */
export class SessionLocationTransaction {
  private nextTransactionId = 0;
  private readonly pending: PendingTransaction[] = [];
  private active: PendingTransaction | undefined;
  private readonly flushWaiters: Array<() => void> = [];

  constructor(private readonly writer: StateWriter) {}

  submit(request: SessionLocationTransactionRequest): Promise<SessionLocationTransactionOutcome> {
    const transactionId = ++this.nextTransactionId;
    return new Promise<SessionLocationTransactionOutcome>((resolve, reject) => {
      this.pending.push({
        request,
        transactionId,
        committed: false,
        finalized: false,
        resolve,
        reject,
      });
      queueMicrotask(() => { void this.processNext(); });
    });
  }

  /** Wait until all producer-ordered requests have reached a terminal result. */
  flush(): Promise<void> {
    if (!this.active && this.pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.flushWaiters.push(resolve));
  }

  /**
   * Process-exit drain for both the writer-visible request and every later
   * request still held by this coordinator.
   */
  flushSync(): void {
    if (this.active && !this.active.finalized) {
      const [outcome] = this.writer.flushExactWritesSync();
      if (outcome) this.finalize(this.active, outcome);
    }
    while (this.pending.length > 0) {
      const item = this.pending.shift()!;
      const outcome = this.writer.writeExactImmediate(
        this.exactTransaction(item),
        item.request.durability === 'immediate-retry' ? 2 : 1,
      );
      this.finalize(item, outcome);
    }
    this.notifyFlushed();
  }

  private exactTransaction(item: PendingTransaction): ExactStateTransaction {
    return {
      prepare: () => item.request.prepare(item.transactionId),
      commit: () => {
        if (item.committed) return undefined;
        const state = item.request.commit(item.transactionId);
        if (state) item.committed = true;
        return state;
      },
      current: item.request.current,
    };
  }

  private async processNext(): Promise<void> {
    if (this.active) return;
    const item = this.pending.shift();
    if (!item) {
      this.notifyFlushed();
      return;
    }
    this.active = item;
    try {
      const transaction = this.exactTransaction(item);
      const outcome = item.request.durability === 'immediate-retry'
        ? this.writer.writeExactImmediate(transaction, 2)
        : await this.writer.writeExactAsap(transaction);
      this.finalize(item, outcome);
    } catch (err) {
      if (!item.finalized) {
        item.finalized = true;
        item.reject(err);
      }
    } finally {
      if (this.active === item) this.active = undefined;
      void this.processNext();
    }
  }

  private finalize(item: PendingTransaction, outcome: ExactStateWriteOutcome): void {
    if (item.finalized) return;
    item.finalized = true;
    let terminalOutcome: SessionLocationTransactionOutcome = outcome;
    if (outcome === 'written' && item.committed) {
      try {
        item.request.publish(item.transactionId);
      } catch (err) {
        console.error('[SessionLocationTransaction] Failed to publish committed state:', err);
        terminalOutcome = 'publication-failed';
      }
    }
    item.resolve(terminalOutcome);
  }

  private notifyFlushed(): void {
    if (this.active || this.pending.length > 0) return;
    for (const resolve of this.flushWaiters.splice(0)) resolve();
  }
}

interface PendingTransaction {
  request: SessionLocationTransactionRequest;
  transactionId: number;
  committed: boolean;
  finalized: boolean;
  resolve: (outcome: SessionLocationTransactionOutcome) => void;
  reject: (error: unknown) => void;
}

export interface DaemonSessionLocationPublication {
  cwd: (sessionId: string, cwd: string) => void;
  location: (
    sessionId: string,
    snapshot: SessionLocationSnapshot,
    reason: 'cwd' | 'enriched',
  ) => void;
}

/**
 * Concrete daemon transaction boundary shared by cwd and late enrichment.
 * The manager only stages/commits; this function owns persistence and the
 * post-commit publication order.
 */
export function submitDaemonSessionLocationCandidate(
  transactions: SessionLocationTransaction,
  manager: DaemonSessionManager,
  input: DaemonSessionLocationCandidateInput,
  buildCurrentState: () => DaemonState,
  publication: DaemonSessionLocationPublication,
): Promise<SessionLocationTransactionOutcome> {
  let candidate: DaemonSessionLocationCandidate | undefined;
  let snapshot: SessionLocationSnapshot | undefined;
  return transactions.submit({
    durability: input.reason === 'enriched' ? 'immediate-retry' : 'asap',
    prepare: (transactionId) => {
      candidate = manager.prepareLocationCandidate(input, transactionId);
      if (!candidate) return undefined;
      const sessions = manager.listSessionsWithLocationCandidate(candidate);
      return sessions ? { ...buildCurrentState(), sessions } : undefined;
    },
    commit: (transactionId) => {
      if (!candidate) return undefined;
      snapshot = manager.commitLocationCandidate(candidate, transactionId);
      return snapshot ? buildCurrentState() : undefined;
    },
    current: buildCurrentState,
    publish: () => {
      if (!snapshot) return;
      if (input.reason === 'cwd') {
        publication.cwd(input.sessionId, snapshot.location.cwd);
      }
      publication.location(input.sessionId, snapshot, input.reason);
    },
  });
}
