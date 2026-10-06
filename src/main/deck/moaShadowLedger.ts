// ─── Moa shadow ledger — what the judge would have answered, and the owner's ─
//
// Append-only JSONL at `<wmuxDir>/moa-shadow/decisions.jsonl`, in the
// TaskLedger.ts style: every write runs in one serialized section, memory
// changes only after the line is on disk, and boot replays the file in order
// (a torn last line from a crash mid-append is skipped, never fatal).
//
// Two kinds of line, both keyed `moa:<askerPtyId>:<recordId>`:
//   - a decision: what the judge (or the pre-check, or a rejection) recorded;
//   - an outcome: how the record ended — the owner's choice and whether it
//     matched, or why there is nothing to compare (expired unanswered, lost).
//
// Idempotent by key: recording a key again with the same packet hash returns
// the existing row and writes nothing; a different hash is the same record id
// asking something else, written as its own `id-reused` row (never judged).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSerialChain } from './serialChain';

export const SHADOW_DIRNAME = 'moa-shadow';
export const SHADOW_FILENAME = 'decisions.jsonl';
/** Past this the log is not appended to any more (a measurement, not a store). */
export const SHADOW_MAX_BYTES = 20 * 1024 * 1024;

export interface ShadowDecisionRow {
  kind: 'decision';
  key: string;
  askedAt: number;
  askerPtyId: string;
  question: string;
  options: string[];
  packetHash: string;
  verdict: 'answer' | 'escalate';
  choiceKey: string | null;
  ruleId: string | null;
  reasonCode: string;
  why: string;
  tokens: { input: number; output: number };
  ms: number;
  mode: 'shadow';
}

/**
 * How a judged record ended. `agree` is set only when the owner's choice is
 * known AND the judge answered; an escalation has nothing to agree with.
 */
export interface ShadowOutcomeRow {
  kind: 'outcome';
  key: string;
  /** `resolved` (answered in wmux), `answered-in-terminal`, `expired`, `superseded`, `lost`. */
  outcome: string;
  ownerChoiceKey: string | null;
  resolvedAt: number;
  agree: boolean | null;
}

export type ShadowRow = ShadowDecisionRow | ShadowOutcomeRow;

export interface ShadowStats {
  decisions: number;
  answered: number;
  escalations: number;
  /** Outcomes where both sides named a choice. */
  compared: number;
  agreed: number;
  /** Tokens spent by model calls since local midnight. */
  tokensToday: number;
  /** Model calls since local midnight (the daily cap counts these). */
  callsToday: number;
  /** Decisions made this run that could not be written (kept in memory only). */
  unwritten: number;
  /** The log reached SHADOW_MAX_BYTES: nothing more is judged or written. */
  full: boolean;
}

export function getShadowLedgerPath(wmuxDir: string): string {
  return path.join(wmuxDir, SHADOW_DIRNAME, SHADOW_FILENAME);
}

export function shadowKey(askerPtyId: string, recordId: string): string {
  return `moa:${askerPtyId}:${recordId}`;
}

function localMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function isDecision(v: Record<string, unknown>): boolean {
  return v['kind'] === 'decision' && typeof v['key'] === 'string' && typeof v['packetHash'] === 'string'
    && (v['verdict'] === 'answer' || v['verdict'] === 'escalate') && typeof v['askedAt'] === 'number';
}

function isOutcome(v: Record<string, unknown>): boolean {
  return v['kind'] === 'outcome' && typeof v['key'] === 'string' && typeof v['outcome'] === 'string';
}

/** True for a row that cost a model call (counted against the daily cap). */
export function calledModel(row: ShadowDecisionRow): boolean {
  return row.tokens.input + row.tokens.output > 0 || row.reasonCode === 'judge-failed';
}

export class MoaShadowLedger {
  private readonly file: string;
  /** key → the first decision row; id-reused rows are kept in `rows` only. */
  private readonly decisions = new Map<string, ShadowDecisionRow>();
  private readonly outcomes = new Map<string, ShadowOutcomeRow>();
  private readonly rows: ShadowRow[] = [];
  /** key → a decision whose append failed. Never re-judged, still counted. */
  private readonly unwritten = new Map<string, ShadowDecisionRow>();
  private full = false;
  private readonly serial = createSerialChain();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(wmuxDir: string, opts: { now?: () => number; log?: (line: string) => void } = {}) {
    this.file = getShadowLedgerPath(wmuxDir);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.warn(l));
    this.replay();
    try {
      this.full = fs.statSync(this.file).size > SHADOW_MAX_BYTES;
    } catch {
      this.full = false;
    }
  }

  private replay(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log(`[moa-shadow] read failed: ${String(err)}`);
      return;
    }
    let skipped = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      if (!v || typeof v !== 'object') continue;
      const o = v as Record<string, unknown>;
      if (isDecision(o)) this.commit(o as unknown as ShadowDecisionRow);
      else if (isOutcome(o)) this.commit(o as unknown as ShadowOutcomeRow);
    }
    if (skipped > 0) this.log(`[moa-shadow] replay skipped ${skipped} unreadable line(s)`);
  }

  private commit(row: ShadowRow): void {
    this.rows.push(row);
    if (row.kind === 'decision') {
      if (!this.decisions.has(row.key)) this.decisions.set(row.key, row);
    } else if (!this.outcomes.has(row.key)) {
      this.outcomes.set(row.key, row);
    }
  }

  private async append(row: ShadowRow): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const stat = await fs.promises.stat(this.file);
      if (stat.size > SHADOW_MAX_BYTES) {
        this.full = true;
        throw new Error('shadow ledger is full');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await fs.promises.appendFile(this.file, `${JSON.stringify(row)}\n`, 'utf8');
    this.commit(row);
  }

  get(key: string): ShadowDecisionRow | null {
    return this.decisions.get(key) ?? this.unwritten.get(key) ?? null;
  }

  isFull(): boolean {
    return this.full;
  }

  /**
   * Keep a decision whose write failed, in memory only: get() returns it so
   * the same question is not judged again, and stats() counts its model call
   * against the daily cap. It has no outcome (nothing on disk to join to).
   */
  rememberUnwritten(row: Omit<ShadowDecisionRow, 'kind' | 'mode'>): void {
    if (this.decisions.has(row.key) || this.unwritten.has(row.key)) return;
    this.unwritten.set(row.key, { ...row, kind: 'decision', mode: 'shadow' });
  }

  hasOutcome(key: string): boolean {
    return this.outcomes.has(key);
  }

  /** Judged keys still waiting for an outcome. */
  openKeys(): string[] {
    return [...this.decisions.keys()].filter((k) => !this.outcomes.has(k));
  }

  /**
   * Record a decision. Same key + same hash → the existing row, nothing
   * written. Same key + a different hash → an `id-reused` escalation row is
   * written instead of `row`, and returned. Rejects when the write fails
   * (nothing is committed).
   */
  record(row: Omit<ShadowDecisionRow, 'kind' | 'mode'>): Promise<{ row: ShadowDecisionRow; existing: boolean }> {
    return this.serial(async () => {
      const prior = this.decisions.get(row.key);
      if (prior && prior.packetHash === row.packetHash) return { row: prior, existing: true };
      const next: ShadowDecisionRow = prior
        ? {
            ...row,
            kind: 'decision',
            verdict: 'escalate',
            choiceKey: null,
            ruleId: null,
            reasonCode: 'id-reused',
            why: 'this record id was already judged for a different question',
            tokens: { input: 0, output: 0 },
            ms: 0,
            mode: 'shadow',
          }
        : { ...row, kind: 'decision', mode: 'shadow' };
      await this.append(next);
      return { row: next, existing: false };
    });
  }

  /**
   * Record how a judged record ended. A no-op for a key never judged, or one
   * that already has an outcome. `agree` compares only when the judge
   * answered and the owner's choice is known.
   */
  noteOutcome(key: string, outcome: string, ownerChoiceKey: string | null, resolvedAt?: number): Promise<ShadowOutcomeRow | null> {
    return this.serial(async () => {
      const decision = this.decisions.get(key);
      if (!decision || this.outcomes.has(key)) return null;
      const agree = ownerChoiceKey !== null && decision.verdict === 'answer' && decision.choiceKey !== null
        ? decision.choiceKey === ownerChoiceKey
        : null;
      const row: ShadowOutcomeRow = {
        kind: 'outcome',
        key,
        outcome,
        ownerChoiceKey,
        resolvedAt: resolvedAt ?? this.now(),
        agree,
      };
      await this.append(row);
      return row;
    });
  }

  stats(): ShadowStats {
    const midnight = localMidnight(this.now());
    const s: ShadowStats = {
      decisions: 0, answered: 0, escalations: 0, compared: 0, agreed: 0, tokensToday: 0, callsToday: 0,
      unwritten: this.unwritten.size, full: this.full,
    };
    for (const row of this.unwritten.values()) {
      if (row.askedAt < midnight) continue;
      s.tokensToday += row.tokens.input + row.tokens.output;
      if (calledModel(row)) s.callsToday += 1;
    }
    for (const row of this.rows) {
      if (row.kind === 'decision') {
        s.decisions += 1;
        if (row.verdict === 'answer') s.answered += 1;
        else s.escalations += 1;
        if (row.askedAt >= midnight) {
          s.tokensToday += row.tokens.input + row.tokens.output;
          if (calledModel(row)) s.callsToday += 1;
        }
      } else if (row.agree !== null && this.outcomes.get(row.key) === row) {
        s.compared += 1;
        if (row.agree) s.agreed += 1;
      }
    }
    return s;
  }
}
