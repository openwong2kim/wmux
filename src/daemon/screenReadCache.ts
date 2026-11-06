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

/**
 * Kinds kept per session. A kind carries its read's depth (`text:300`), and
 * callers pick depths freely, so the oldest kind is dropped past this. A busy
 * agent pane is read as screen, undimmed screen, the verifier's pane frame and
 * a text depth, plus StallWatch's and Fleet's tail kinds.
 */
const KINDS_PER_SESSION = 6;

/** Counted by the kind's family (`text`, `screen`, `pane`), a fixed set. */
function count(kind: string): ScreenReadCounters {
  const family = kind.split(':', 1)[0];
  let c = counters.get(family);
  if (!c) counters.set(family, (c = { hits: 0, joins: 0, misses: 0 }));
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
  if (known?.fence === fence && (known.pending || 'value' in known)) {
    byKind.delete(kind); // still in use: keep it the newest kind
    byKind.set(kind, known as Entry<unknown>);
    if (known.pending) { c.joins++; return known.pending; }
    c.hits++;
    return Promise.resolve(known.value as T);
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
  byKind.delete(kind); // re-inserted last: the newest kind
  byKind.set(kind, entry as Entry<unknown>);
  for (const oldest of byKind.keys()) {
    if (byKind.size <= KINDS_PER_SESSION) break;
    byKind.delete(oldest);
  }
  return pending;
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

/**
 * A tag for an object a read depends on but the ring's bytes do not name,
 * such as the session's mode tracker (dropped when the shell exits), for use
 * in a fence. Absent is "0".
 */
export function identityTag(value: object | null | undefined): string {
  if (!value) return '0';
  let id = identities.get(value);
  if (id === undefined) identities.set(value, (id = ++nextIdentity));
  return String(id);
}

/** Copies of the counters by kind family, for the daemon's diagnostics. */
export function screenReadCounters(): Record<string, ScreenReadCounters> {
  return Object.fromEntries([...counters].map(([kind, c]) => [kind, { ...c }]));
}

export interface ScreenParseCounters {
  /** Reads that replayed the ring through a terminal parser. */
  parses: number;
  /** From asking to the answer, so the wait for the snapshot queue is in it. */
  msTotal: number;
  msMax: number;
  /** Bytes replayed. */
  bytes: number;
}

const parses = new Map<string, ScreenParseCounters>();

/** A kind's family with its depth reduced to a fixed set of buckets. */
function parseBucket(kind: string): string {
  const [family, depth] = kind.split(':', 2);
  if (family !== 'text') return family;
  const rows = Number(depth);
  if (rows <= 300) return 'text<=300';
  return rows <= 2000 ? 'text<=2000' : 'text>2000';
}

/**
 * One parse of a pane's ring, whether or not its answer may be reused. What a
 * screen read costs, by depth, is what decides how a live screen per pane
 * should be built and how deep it needs to be.
 */
export function noteScreenParse(kind: string, ms: number, bytes: number): void {
  const bucket = parseBucket(kind);
  let c = parses.get(bucket);
  if (!c) parses.set(bucket, (c = { parses: 0, msTotal: 0, msMax: 0, bytes: 0 }));
  c.parses++;
  c.msTotal += ms;
  c.msMax = Math.max(c.msMax, ms);
  c.bytes += bytes || 0;
}

/** Copies of the parse counters by bucket, for the daemon's diagnostics. */
export function screenParseCounters(): Record<string, ScreenParseCounters> {
  return Object.fromEntries([...parses].map(([bucket, c]) => [bucket, { ...c }]));
}

export interface SnapshotQueueCounters {
  /** Jobs that ran on the concurrency-1 snapshot queue. */
  jobs: number;
  /** Waiting for their turn. */
  waitMsTotal: number;
  waitMsMax: number;
  /** Holding the queue. */
  runMsTotal: number;
  runMsMax: number;
}

const queue: SnapshotQueueCounters = { jobs: 0, waitMsTotal: 0, waitMsMax: 0, runMsTotal: 0, runMsMax: 0 };

export function noteSnapshotJobStart(waitMs: number): void {
  queue.jobs++;
  queue.waitMsTotal += waitMs;
  queue.waitMsMax = Math.max(queue.waitMsMax, waitMs);
}

export function noteSnapshotJobEnd(runMs: number): void {
  queue.runMsTotal += runMs;
  queue.runMsMax = Math.max(queue.runMsMax, runMs);
}

export function snapshotQueueCounters(): SnapshotQueueCounters {
  return { ...queue };
}

/** Tests only. */
export function resetScreenReadCounters(): void {
  counters.clear();
  parses.clear();
  Object.assign(queue, { jobs: 0, waitMsTotal: 0, waitMsMax: 0, runMsTotal: 0, runMsMax: 0 });
}
