// Moa learning loop — turn a repeated failure into a proposed safeguard.
//
// Every goal gate the verifier runs reports its outcome here:
//
//   • a FAILURE that also fails on one retry is recorded under a SIGNATURE: the
//     gate command plus the failing lines of its log, normalized (numbers,
//     hashes, paths, durations and colour codes removed), so the same mistake
//     on another branch, task or day has the same signature;
//   • a failure that PASSES on the retry is a FLAKE: recorded separately with
//     its own count, and never drafted (a flaky test is not a bug to pin);
//   • when one signature has been seen in two different places (two goals, or
//     two tasks), a goal DRAFT is created: a proposed goal to add a regression
//     test for it, whose done criteria demand evidence that the new test FAILS
//     on the original bug and PASSES on the fix.
//
// A draft is only a suggestion. Nothing here proposes or approves a goal: the
// operator approves a draft (or dismisses it) from Settings or the goal strip,
// and only that click turns it into a goal. One draft per signature, ever: a
// dismissed signature is not drafted again.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MOA_GOAL_LIMITS } from '../../shared/moaGoal';

export interface GateOutcome {
  kind: 'failure' | 'flake';
  goalId: string;
  repoRoot: string | null;
  taskId: string;
  command: string;
  /** The (first) failing run's log tail. */
  tail: string;
  at: number;
}

export interface FailureRecord {
  signature: string;
  goalId: string;
  taskId: string;
  repoRoot: string | null;
  command: string;
  summary: string;
  at: number;
}

export type FlakeRecord = FailureRecord;

export interface MoaGoalDraft {
  id: string;
  signature: string;
  status: 'draft' | 'approved' | 'dismissed';
  createdAt: number;
  repoRoot: string | null;
  command: string;
  /** The normalized failing line, for the operator. */
  summary: string;
  /** Where it was seen (distinct goal/task pairs). */
  seen: { goalId: string; taskId: string; at: number }[];
  goal: string;
  doneCriteria: string[];
  evidence: string[];
  constraints: string[];
  /** Set once approved: the goal it became. */
  goalId?: string;
}

interface LearningFile {
  version: 1;
  failures: FailureRecord[];
  flakes: FlakeRecord[];
  drafts: MoaGoalDraft[];
}

const FAILURES_MAX = 500;
const FLAKES_MAX = 200;
/** Seen in this many distinct places ⇒ draft. */
export const LEARNING_REPEAT_THRESHOLD = 2;

const FAILING_LINE = /(\bfail(ed|ure|ing)?\b|error\b|\bassert(ion)?|\bexpected\b|\bnot ok\b|\bpanic|exception\b|\btraceback\b|✗|×)/i;
/** Stack frames and source excerpts say where, not what. */
const NOISE_LINE = /^(at |\^+$|Node\.js v)/;

/** One line, normalized so the same mistake reads the same anywhere. */
export function normalizeLine(l: string): string {
  return l
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s:'"`)]*[\\/]([^\s\\/:'"`)]+)/g, '$1') // paths → basename
    .replace(/\b[0-9a-f]{7,64}\b/gi, '<hash>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds?)\b/gi, '<time>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The signature of a failing gate: its command plus its failing lines. */
export function failureSignature(command: string, tail: string): { signature: string; summary: string } {
  const lines = tail
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^(# |> |npm (ERR|error)! )/.test(l))
    .map(normalizeLine)
    .filter((l) => l && !NOISE_LINE.test(l));
  const failing = lines.filter((l) => FAILING_LINE.test(l));
  const key = (failing.length ? failing : lines.slice(-3)).slice(0, 3);
  const signature = crypto.createHash('sha256').update(`${normalizeLine(command)}\n${key.join('\n')}`).digest('hex').slice(0, 16);
  return { signature, summary: (key[0] ?? `${command} failed`).slice(0, 160) };
}

/** The proposed goal for a repeated failure. Within MOA_GOAL_LIMITS. */
export function draftTerms(command: string, summary: string): Pick<MoaGoalDraft, 'goal' | 'doneCriteria' | 'evidence' | 'constraints'> {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const item = MOA_GOAL_LIMITS.TERMS_ITEM_MAX_CHARS;
  return {
    goal: cut(`Add a regression test (or a lint rule) so this repeated gate failure cannot come back: "${summary}"`, MOA_GOAL_LIMITS.GOAL_MAX_CHARS),
    doneCriteria: [
      cut('A new regression test (or rule) targets this failure', item),
      cut('Evidence: the new test FAILS on the original buggy code (log from the commit before the fix)', item),
      cut('Evidence: the same test PASSES with the fix applied (log from the fix commit)', item),
      cut(`The project gate passes: ${command}`, item),
    ],
    evidence: ['test log on the original (failing) commit', 'test log on the fix (passing) commit'],
    constraints: ['do not delete, skip or loosen existing tests', 'no new dependencies'],
  };
}

export class MoaGoalLearning {
  private data: LearningFile;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
    private readonly onChange: () => void = () => undefined,
  ) {
    this.data = this.load();
  }

  private load(): LearningFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<LearningFile>;
      if (raw && raw.version === 1) {
        return {
          version: 1,
          failures: Array.isArray(raw.failures) ? raw.failures : [],
          flakes: Array.isArray(raw.flakes) ? raw.flakes : [],
          drafts: Array.isArray(raw.drafts) ? raw.drafts : [],
        };
      }
    } catch {
      /* missing or unreadable: start empty */
    }
    return { version: 1, failures: [], flakes: [], drafts: [] };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[moa:learning] could not save: ${String(err)}`);
    }
    this.onChange();
  }

  /** Record a gate outcome. Returns the draft it created, if any. */
  record(o: GateOutcome): MoaGoalDraft | null {
    const { signature, summary } = failureSignature(o.command, o.tail);
    const rec: FailureRecord = { signature, goalId: o.goalId, taskId: o.taskId, repoRoot: o.repoRoot, command: o.command, summary, at: o.at };
    if (o.kind === 'flake') {
      this.data.flakes = [...this.data.flakes, rec].slice(-FLAKES_MAX);
      this.save();
      return null;
    }
    this.data.failures = [...this.data.failures, rec].slice(-FAILURES_MAX);
    let draft: MoaGoalDraft | null = null;
    const same = this.data.failures.filter((f) => f.signature === signature && f.repoRoot === o.repoRoot);
    const places = new Map<string, FailureRecord>();
    for (const f of same) places.set(`${f.goalId}\u0000${f.taskId}`, f);
    const flaky = this.data.flakes.some((f) => f.signature === signature);
    if (places.size >= LEARNING_REPEAT_THRESHOLD && !flaky && !this.data.drafts.some((d) => d.signature === signature)) {
      draft = {
        id: `D-${crypto.randomBytes(3).toString('hex')}`,
        signature,
        status: 'draft',
        createdAt: this.now(),
        repoRoot: o.repoRoot,
        command: o.command,
        summary,
        seen: [...places.values()].map((f) => ({ goalId: f.goalId, taskId: f.taskId, at: f.at })),
        ...draftTerms(o.command, summary),
      };
      this.data.drafts = [...this.data.drafts, draft];
    }
    this.save();
    return draft;
  }

  drafts(): MoaGoalDraft[] {
    return this.data.drafts.filter((d) => d.status === 'draft');
  }

  get(id: string): MoaGoalDraft | null {
    return this.data.drafts.find((d) => d.id === id) ?? null;
  }

  flakes(): FlakeRecord[] {
    return [...this.data.flakes];
  }

  failures(): FailureRecord[] {
    return [...this.data.failures];
  }

  dismiss(id: string): boolean {
    return this.settle(id, 'dismissed');
  }

  markApproved(id: string, goalId: string): boolean {
    return this.settle(id, 'approved', goalId);
  }

  private settle(id: string, status: 'approved' | 'dismissed', goalId?: string): boolean {
    const d = this.data.drafts.find((x) => x.id === id);
    if (!d || d.status !== 'draft') return false;
    d.status = status;
    if (goalId) d.goalId = goalId;
    this.save();
    return true;
  }
}

let shared: MoaGoalLearning | null = null;
export function setMoaGoalLearning(l: MoaGoalLearning | null): void {
  shared = l;
}
export function getMoaGoalLearning(): MoaGoalLearning | null {
  return shared;
}
