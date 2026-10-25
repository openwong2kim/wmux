// Sends one of main's push tables (the bot approvals or prompts waiting on the
// owner) to the daemon: coalesced on change, at once on a daemon connect, and
// again at `refreshAt` when a row can leave the table without any change
// being reported (a request expiring on its own).
//
// UNKNOWN IS NOT EMPTY. The daemon reads an empty table as "nothing waits"
// and retracts every banner, so `rows` answers null until its store has an
// answer (a daemon connect can come before the store starts), and nothing is
// sent then.

export interface PushTableFeedDeps<Row> {
  /** The current table, or null while it is not known (nothing is sent). */
  rows: () => Row[] | null;
  push: (rows: Row[]) => Promise<unknown>;
  /** When to publish again with nothing reported, or undefined. */
  refreshAt?: (rows: Row[]) => number | undefined;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface PushTableFeed {
  /** Something may have changed: publish once, soon. */
  schedule(): void;
  /** Publish now (a daemon just connected). */
  publishNow(): void;
  dispose(): void;
}

/** Changes in one burst (a decide that also closes a card) go out as one push. */
const COALESCE_MS = 50;

export function createPushTableFeed<Row>(deps: PushTableFeedDeps<Row>): PushTableFeed {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  let soon: unknown = null;
  let refresh: unknown = null;
  let retry: unknown = null;
  let generation = 0;

  const publishNow = (isRetry = false): void => {
    if (soon !== null) { clearTimer(soon); soon = null; }
    if (refresh !== null) { clearTimer(refresh); refresh = null; }
    if (retry !== null) { clearTimer(retry); retry = null; }
    let rows: Row[] | null;
    try {
      rows = deps.rows();
    } catch {
      return;
    }
    if (rows === null) return;
    // A refused or timed-out push is tried once more, so a retraction is not
    // lost until the next change. Each publication gets its own retry, and a
    // retry gets none, so a daemon that stays unreachable costs two pushes per
    // change; it gets the table on its next connect.
    const gen = ++generation;
    void deps.push(rows).catch(() => {
      if (isRetry || gen !== generation) return;
      retry = setTimer(() => { retry = null; publishNow(true); }, COALESCE_MS);
    });
    const at = deps.refreshAt?.(rows);
    if (at !== undefined) refresh = setTimer(() => publishNow(), Math.max(0, at - now()));
  };

  function schedule(): void {
    if (soon === null) soon = setTimer(() => { soon = null; publishNow(); }, COALESCE_MS);
  }

  return {
    schedule,
    publishNow: () => publishNow(),
    dispose() {
      if (soon !== null) clearTimer(soon);
      if (refresh !== null) clearTimer(refresh);
      if (retry !== null) clearTimer(retry);
      soon = refresh = retry = null;
    },
  };
}
