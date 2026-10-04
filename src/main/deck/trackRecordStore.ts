// ─── Moa track record — the file (P3c) ───────────────────────────────────────
//
// `track-record.json` in the wmux data dir (follows WMUX_DATA_SUFFIX), written
// atomically. Main is the only writer, so the in-memory copy is the truth and
// writes coalesce: a change made while a write is in flight goes out in the
// next one. Stats are never load-bearing: a file that does not read loads as
// empty (keeping nothing but defaults) and a failed write is logged and retried
// with the next change. Shapes and rollups live in src/shared/trackRecord.ts.

import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicReadJSONSync, atomicWriteJSON } from '../../daemon/util/atomicWrite';
import {
  DEFAULT_RETRO_SCHEDULE,
  MAX_SEEN_IDS,
  TRACK_COUNTER_KEYS,
  emptyTrackRecord,
  type RetroCard,
  type RetroSchedule,
  type TrackOpenItem,
  type TrackRecordData,
  type TrackWeek,
} from '../../shared/trackRecord';

export function getTrackRecordPath(dir: string = getWmuxDir()): string {
  return path.join(dir, 'track-record.json');
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s) => str(s)).slice(-MAX_SEEN_IDS) : []);

export function parseRetroSchedule(v: unknown, base: RetroSchedule = DEFAULT_RETRO_SCHEDULE): RetroSchedule {
  const o = isObj(v) ? v : {};
  const day = o.day;
  const hour = o.hour;
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : base.enabled,
    day: num(day) && Number.isInteger(day) && day >= 0 && day <= 6 ? day : base.day,
    hour: num(hour) && Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : base.hour,
  };
}

function parseRefs<T>(v: unknown, extra: (o: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const o of v) {
    if (!isObj(o) || !str(o.workspaceId) || !str(o.agent, 40) || !str(o.ref, 16) || !num(o.ms)) continue;
    const x = extra(o);
    if (x) out.push(x);
  }
  return out;
}

const ref = (o: Record<string, unknown>) => ({ workspaceId: o.workspaceId as string, agent: o.agent as string, ref: o.ref as string, ms: o.ms as number });

function parseWeek(v: unknown): TrackWeek | null {
  if (!isObj(v) || !num(v.weekStart)) return null;
  const rows = Array.isArray(v.rows)
    ? v.rows.flatMap((r) => {
      if (!isObj(r) || !str(r.workspaceId) || !str(r.agent, 40)) return [];
      if (!TRACK_COUNTER_KEYS.every((k) => num(r[k]) && (r[k] as number) >= 0)) return [];
      const row = { workspaceId: r.workspaceId, agent: r.agent } as TrackWeek['rows'][number];
      for (const k of TRACK_COUNTER_KEYS) row[k] = r[k] as number;
      return [row];
    })
    : [];
  const inter = isObj(v.interruptions) ? v.interruptions : {};
  const questions = Array.isArray(v.questions)
    ? v.questions.flatMap((q) => (isObj(q) && str(q.workspaceId) && num(q.at) && Array.isArray(q.print)
      ? [{ workspaceId: q.workspaceId, at: q.at, print: q.print.filter((p): p is string => typeof p === 'string' && /^[0-9a-f]{8}$/.test(p)) }]
      : []))
    : [];
  return {
    weekStart: v.weekStart,
    rows,
    interruptions: { decisions: num(inter.decisions) ? inter.decisions : 0, approvals: num(inter.approvals) ? inter.approvals : 0 },
    slowest: parseRefs(v.slowest, ref),
    missedStalls: parseRefs(v.missedStalls, (o) => (o.state === 'needs-you' || o.state === 'blocked' ? { ...ref(o), state: o.state } : null)),
    questions,
  };
}

function parseOpen(v: unknown): Record<string, TrackOpenItem> {
  const out: Record<string, TrackOpenItem> = {};
  if (!isObj(v)) return out;
  for (const [key, o] of Object.entries(v)) {
    if (!isObj(o) || !str(o.workspaceId) || !str(o.agent, 40) || !num(o.createdAt) || !num(o.since)) continue;
    if (o.state !== 'active' && o.state !== 'needs-you' && o.state !== 'blocked') continue;
    out[key] = {
      workspaceId: o.workspaceId, agent: o.agent, createdAt: o.createdAt, state: o.state, since: o.since,
      ...(o.stallCounted === true ? { stallCounted: true } : {}),
      ...(o.missedCounted === true ? { missedCounted: true } : {}),
    };
  }
  return out;
}

/** Sanitize a file read from disk. Anything unusable falls back to empty. */
export function parseTrackRecord(raw: unknown): TrackRecordData {
  const data = emptyTrackRecord();
  if (!isObj(raw) || raw.version !== 1) return data;
  data.weeks = Array.isArray(raw.weeks) ? raw.weeks.map(parseWeek).filter((w): w is TrackWeek => w !== null) : [];
  data.weeks.sort((a, b) => a.weekStart - b.weekStart);
  data.open = parseOpen(raw.open);
  const seen = isObj(raw.seen) ? raw.seen : {};
  data.seen = {
    links: strList(seen.links),
    decisions: strList(seen.decisions),
    linkedDecisions: strList(seen.linkedDecisions),
    approvals: strList(seen.approvals),
    ledger: strList(seen.ledger),
  };
  const retro = isObj(raw.retro) ? raw.retro : {};
  data.retro.schedule = parseRetroSchedule(retro.schedule);
  if (num(retro.lastRunWeek)) data.retro.lastRunWeek = retro.lastRunWeek;
  if (isObj(retro.card) && num(retro.card.weekStart)) data.retro.card = retro.card as unknown as RetroCard;
  if (retro.dismissed === true) data.retro.dismissed = true;
  return data;
}

export class TrackRecordStore {
  private data: TrackRecordData;
  private writing: Promise<void> | null = null;
  private dirty = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly dir: string = getWmuxDir()) {
    let raw: unknown = null;
    try {
      raw = atomicReadJSONSync<unknown>(getTrackRecordPath(dir));
    } catch {
      raw = null;
    }
    this.data = parseTrackRecord(raw);
  }

  /** A deep copy of the current record. */
  read(): TrackRecordData {
    return structuredClone(this.data);
  }

  /** Change the record in memory and queue a write. `fn` returning false skips both. */
  mutate(fn: (data: TrackRecordData) => boolean | void): void {
    if (fn(this.data) === false) return;
    this.persist();
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* a listener never breaks a write */
      }
    }
  }

  /** Forget every count and the retro card; keep the schedule and the seen ids
   *  (they only stop double counting). */
  clear(): void {
    this.mutate((d) => {
      const kept = { schedule: d.retro.schedule, ...(d.retro.lastRunWeek !== undefined ? { lastRunWeek: d.retro.lastRunWeek } : {}) };
      d.weeks = [];
      d.open = {};
      d.retro = kept;
    });
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolves once everything changed so far is on disk (or failed). */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }

  private persist(): void {
    this.dirty = true;
    if (this.writing) return;
    this.writing = (async () => {
      while (this.dirty) {
        this.dirty = false;
        try {
          // A snapshot: a change made during the write goes out in the next one.
          await atomicWriteJSON(getTrackRecordPath(this.dir), structuredClone(this.data));
        } catch (err) {
          console.warn(`[track-record] write failed; the next change retries: ${String(err)}`);
        }
      }
      this.writing = null;
    })();
  }
}

let store: TrackRecordStore | null = null;

export function getTrackRecordStore(): TrackRecordStore {
  if (!store) store = new TrackRecordStore();
  return store;
}
