/**
 * Reuse a screen read while nothing it depends on has changed.
 *
 * A read rebuilds a pane's screen from its ring, so its answer is a function
 * of the ring's bytes and the size it is read at. The fence names both: the
 * ring's lifetime byte count (monotonic across wrap and hibernation) and the
 * size. A read whose fence matches the last one of the same kind on the same
 * session object answers the rows that read produced, with no ring copy and
 * no parse. A read still in flight with the same fence is joined instead of
 * started again. Only the latest answer per session and kind is kept.
 *
 * The session object, not its id, is the owner: a supervised restart
 * re-creates a dead pane under the same id, and the new session must never
 * read the old one's screen.
 */

export interface ScreenReadCounters {
  /** Answered from the previous read: same session, kind and fence. */
  hits: number;
  /** Joined a read of the same fence that was still running. */
  joins: number;
  /** Read the ring and parsed. */
  misses: number;
}

interface Entry<T> {
  fence: string;
  value?: T;
  pending?: Promise<T>;
}

const entries = new WeakMap<object, Map<string, Entry<unknown>>>();
const counters = new Map<string, ScreenReadCounters>();

function count(kind: string): ScreenReadCounters {
  let c = counters.get(kind);
  if (!c) counters.set(kind, (c = { hits: 0, joins: 0, misses: 0 }));
  return c;
}

/**
 * The answer for `kind` on `owner` at `fence` (the fence now): the kept one,
 * the running one, or a new `read()`. A running read of the same fence is
 * joined even if it ends up reading newer bytes, as a queued read always has.
 * `settle` names the fence the answer actually describes, taken in the same
 * synchronous step as the ring copy behind it, or null when the answer must
 * not be reused (a failure, a partial read, a pane that went away).
 */
export function fencedRead<T>(
  owner: object,
  kind: string,
  fence: string,
  read: () => Promise<T>,
  settle: (value: T) => string | null,
): Promise<T> {
  let byKind = entries.get(owner);
  if (!byKind) entries.set(owner, (byKind = new Map()));
  const known = byKind.get(kind) as Entry<T> | undefined;
  const c = count(kind);
  if (known?.fence === fence) {
    if (known.pending) { c.joins++; return known.pending; }
    if ('value' in known) { c.hits++; return Promise.resolve(known.value as T); }
  }
  c.misses++;
  const entry: Entry<T> = { fence };
  const pending = read().then(
    (value) => {
      // A newer read of this kind may have replaced the entry meanwhile.
      if (byKind.get(kind) === entry) {
        const at = settle(value);
        if (at === null) byKind.delete(kind);
        else { entry.fence = at; entry.value = value; delete entry.pending; }
      }
      return value;
    },
    (err: unknown) => {
      if (byKind.get(kind) === entry) byKind.delete(kind);
      throw err;
    },
  );
  entry.pending = pending;
  byKind.set(kind, entry as Entry<unknown>);
  return pending;
}

/** Copies of the counters by kind, for the daemon's diagnostics. */
export function screenReadCounters(): Record<string, ScreenReadCounters> {
  return Object.fromEntries([...counters].map(([kind, c]) => [kind, { ...c }]));
}

/** Tests only. */
export function resetScreenReadCounters(): void {
  counters.clear();
}
