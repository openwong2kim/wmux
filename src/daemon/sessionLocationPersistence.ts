import {
  StateWriter,
  type ExactStateTransaction,
  type ExactStateWriteOutcome,
} from './StateWriter';

export type SessionLocationDurability = 'asap' | 'immediate-retry';

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
  private tail: Promise<void> = Promise.resolve();
  private nextTransactionId = 0;

  constructor(private readonly writer: StateWriter) {}

  submit(request: SessionLocationTransactionRequest): Promise<ExactStateWriteOutcome> {
    const transactionId = ++this.nextTransactionId;
    const execute = async (): Promise<ExactStateWriteOutcome> => {
      let committed = false;
      const transaction: ExactStateTransaction = {
        prepare: () => request.prepare(transactionId),
        commit: () => {
          if (committed) return undefined;
          const state = request.commit(transactionId);
          if (state) committed = true;
          return state;
        },
        current: request.current,
      };

      const outcome = request.durability === 'immediate-retry'
        ? this.writer.writeExactImmediate(transaction, 2)
        : await this.writer.writeExactAsap(transaction);
      if (outcome === 'written' && committed) request.publish(transactionId);
      return outcome;
    };

    const result = this.tail.then(execute);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/**
 * Compatibility for the existing daemon wiring. Removed when all producers
 * submit through SessionLocationTransaction in the next milestone.
 */
export function persistLocationEnrichment(
  save: () => boolean,
  rollback: () => void = () => {},
): boolean {
  if (save() || save()) return true;
  rollback();
  return false;
}
