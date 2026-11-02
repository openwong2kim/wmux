/**
 * The live "Preparing" card of a worktree a person opened: what its new
 * workspace preparation is doing (files copied, setup running for how long),
 * and, when the setup fails, the decision that card asks for:
 *   - retry: run the setup again in the same worktree;
 *   - start: start the agent anyway (paths that start one);
 *   - discard: remove the worktree and the branch it made (paths that made
 *     one), refused when the person changed something in it;
 *   - dismiss: leave the worktree as it is and start nothing.
 * A failure nothing is answered for in time stops the wait (no agent starts)
 * but deletes nothing: the card stays, to Discard or keep.
 *
 * Main owns the cards; the renderer only draws them (WORKSPACE_PREP_EVENT)
 * and answers (WORKSPACE_PREP_DECIDE). Cards carry counts and the setup's last
 * output lines, never a copied file's name or content.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { getWmuxHomeDir } from '../../shared/constants';
import { isDefaultCopyCandidate } from '../../shared/workspacePrepSettings';
import type { ProjectConfigState } from '../../shared/wmuxProjectConfig';
import { listCopyCandidates } from '../project/workspacePrepSettings';
import { saveBlock } from '../project/projectConfigWrite';
import type { WorkspacePrepProgress, WorkspacePrepResult } from './workspacePrep';
import { lingers, type WorkspacePrepCard, type WorkspacePrepDecision } from '../../shared/workspacePrepCard';

export type { WorkspacePrepCard, WorkspacePrepDecision };

/** How long a start waits for an answer to a failed card before it gives up
 *  (no agent starts; nothing is deleted, and the card stays). */
export const WORKSPACE_PREP_DECISION_TTL_MS = 30 * 60 * 1000;

/** Ended cards kept for the person to read (oldest dropped past this). */
const MAX_KEPT_CARDS = 20;

export interface PrepCardHandle {
  readonly id: string;
  progress(p: WorkspacePrepProgress): void;
  /** A finished run: 'ready' / 'skipped' close the card's wait; 'failed' shows the failure. */
  result(r: WorkspacePrepResult): void;
  /** Wait for the person's answer to a failure; 'expire' when none came in
   *  time on a card a start waits on. `late` waits without a limit. */
  decision(opts?: { late?: boolean }): Promise<WorkspacePrepDecision | 'expire'>;
  /** Show more on the card (expired, a refused discard). */
  mark(next: Pick<WorkspacePrepCard, 'expired' | 'discardRefused'>): void;
  /** The card is done (the agent started, or the worktree was left alone). */
  close(): void;
}

type Sink = (card: WorkspacePrepCard) => void;

export class WorkspacePrepCards {
  private readonly cards = new Map<string, WorkspacePrepCard>();
  private readonly waiting = new Map<string, (d: WorkspacePrepDecision) => void>();
  /** Ended cards kept until dismissed: a renderer that mounts later (a
   *  collapsed sidebar opened, a reload) still draws them. */
  private readonly kept = new Set<string>();
  /** Failed cards no start waits on any more, oldest first. */
  private readonly expired = new Set<string>();
  private sink: Sink = () => undefined;

  constructor(
    private readonly opts: {
      now?: () => number;
      decisionTtlMs?: number;
      /** Marks a project once its copy suggestion was shown, so it is made once. */
      suggestions?: CopySuggestionStore;
    } = {},
  ) {}

  setSink(sink: Sink): void {
    this.sink = sink;
  }

  /** Every open card, and every ended one kept for reading (a renderer that
   *  reloads draws them again). */
  list(): WorkspacePrepCard[] {
    return [...this.cards.values()];
  }

  begin(
    title: string,
    startsAgent: boolean,
    extra: { suggestCopy?: WorkspacePrepCard['suggestCopy']; canDiscard?: boolean } = {},
  ): PrepCardHandle {
    const id = randomUUID();
    const now = this.opts.now ?? Date.now;
    let card: WorkspacePrepCard = {
      id, title, startsAgent, status: 'running', phase: 'copying', copied: 0, missing: 0, refused: 0, updatedAt: now(),
      ...(extra.suggestCopy ? { suggestCopy: extra.suggestCopy } : {}),
      ...(extra.canDiscard ? { canDiscard: true } : {}),
    };
    const publish = (next: Partial<WorkspacePrepCard>): void => {
      card = { ...card, ...next, updatedAt: now() };
      this.cards.set(id, card);
      try { this.sink(card); } catch { /* a closed window never fails the preparation */ }
    };
    publish({});
    return {
      id,
      progress: (p) => publish({
        status: 'running',
        phase: p.phase,
        copied: p.copy.copied,
        missing: p.copy.missing,
        refused: p.copy.refused,
        ...(p.setupStartedAt !== undefined ? { setupStartedAt: p.setupStartedAt } : {}),
        ...(p.setupTimeoutMs !== undefined ? { setupTimeoutMs: p.setupTimeoutMs } : {}),
        error: undefined,
        outputTail: undefined,
        timedOut: undefined,
        discardRefused: undefined,
      }),
      result: (r) => publish({
        status: r.status === 'failed' ? 'failed' : r.status === 'skipped' ? 'skipped' : 'ready',
        // In place: a retry finds the files the first run copied already there.
        copied: r.copy.copied + r.copy.present,
        missing: r.copy.missing,
        refused: r.copy.refused,
        ...(r.copyBlocked ? { copyBlocked: true } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
        error: r.error,
        outputTail: r.outputTail,
        timedOut: r.timedOut,
      }),
      decision: (o = {}) => new Promise<WorkspacePrepDecision | 'expire'>((resolve) => {
        // Only a start waits on an answer; a card nothing waits on (the Git
        // page) has no limit.
        const timer = startsAgent && !o.late
          ? setTimeout(() => settle('expire'), this.opts.decisionTtlMs ?? WORKSPACE_PREP_DECISION_TTL_MS)
          : undefined;
        timer?.unref?.();
        const settle = (d: WorkspacePrepDecision | 'expire'): void => {
          if (timer) clearTimeout(timer);
          this.waiting.delete(id);
          resolve(d);
        };
        this.waiting.set(id, settle);
      }),
      mark: (next) => {
        publish(next);
        if (next.expired) this.noteExpired(id);
      },
      close: () => {
        this.waiting.get(id)?.('dismiss');
        this.expired.delete(id);
        const kept = lingers(card);
        if (kept) {
          this.keep(id);
          // Shown now (it stays until dismissed): not made again.
          if (card.suggestCopy) this.opts.suggestions?.add(card.suggestCopy.root);
        } else {
          this.cards.delete(id);
        }
        try { this.sink({ ...card, status: 'closed', ...(kept ? {} : { gone: true }), updatedAt: now() }); } catch { /* best-effort */ }
      },
    };
  }

  /** Expired cards each hold a waiter for a late answer: past the cap the
   *  oldest is closed (kept as it is, as Keep would). */
  private noteExpired(id: string): void {
    this.expired.add(id);
    for (const old of this.expired) {
      if (this.expired.size <= MAX_KEPT_CARDS) break;
      this.expired.delete(old);
      this.waiting.get(old)?.('dismiss');
    }
  }

  private keep(id: string): void {
    this.kept.add(id);
    for (const old of this.kept) {
      if (this.kept.size <= MAX_KEPT_CARDS) break;
      this.kept.delete(old);
      const card = this.cards.get(old);
      this.cards.delete(old);
      if (card) {
        try { this.sink({ ...card, status: 'closed', gone: true, updatedAt: (this.opts.now ?? Date.now)() }); } catch { /* best-effort */ }
      }
    }
  }

  /** The person's answer from the card. False when the card is not waiting.
   *  Dismiss on an ended card that was kept for reading forgets it. */
  decide(id: string, decision: WorkspacePrepDecision): boolean {
    if (this.kept.has(id)) {
      if (decision !== 'dismiss') return false;
      const card = this.cards.get(id);
      this.kept.delete(id);
      this.cards.delete(id);
      // Every window drops it, not only the one it was dismissed in.
      if (card) {
        try { this.sink({ ...card, status: 'closed', gone: true, updatedAt: (this.opts.now ?? Date.now)() }); } catch { /* best-effort */ }
      }
      return true;
    }
    const card = this.cards.get(id);
    const settle = this.waiting.get(id);
    if (!card || !settle || card.status !== 'failed') return false;
    // Once expired, no start waits: neither Start anyway nor a retry before it.
    if ((decision === 'start' || decision === 'retry') && card.expired) return false;
    if (decision === 'start' && !card.startsAgent) return false;
    if (decision === 'discard' && !card.canDiscard) return false;
    settle(decision);
    return true;
  }
}

let shared: WorkspacePrepCards | null = null;

export function getWorkspacePrepCards(): WorkspacePrepCards {
  return (shared ??= new WorkspacePrepCards({ suggestions: fileCopySuggestionStore() }));
}

/** Remove a worktree whose preparation failed. Refused (with its folder)
 *  when the person changed something in it. */
export type PrepCardDiscard = () => Promise<{ removed: true } | { removed: false; path: string }>;

/**
 * Run a preparation under a card, asking the person when it fails, until it
 * succeeds or they answer. `run` is called again on retry. Returns what to do
 * next:
 *   - 'start': launch the agent (also after a successful run);
 *   - 'dismiss': start nothing; the worktree stays;
 *   - 'discarded': start nothing; `discard` removed the worktree;
 *   - 'expired': no answer in time; start nothing, the worktree stays, and
 *     the card keeps taking Discard or keep after this returns.
 * A refused discard shows the folder on the card and waits again.
 */
export async function runWithPrepCard(
  handle: PrepCardHandle,
  run: (onProgress: (p: WorkspacePrepProgress) => void) => Promise<WorkspacePrepResult>,
  opts: { discard?: PrepCardDiscard } = {},
): Promise<{ next: 'start' | 'dismiss' | 'discarded' | 'expired'; last: WorkspacePrepResult }> {
  for (;;) {
    const r = await run((p) => handle.progress(p));
    handle.result(r);
    if (r.status !== 'failed') {
      handle.close();
      return { next: 'start', last: r };
    }
    const d = await answer(handle, opts.discard, false);
    if (d === 'retry') continue;
    if (d === 'expire') {
      handle.mark({ expired: true });
      // The card keeps its answer: Discard or keep, with nothing waiting.
      void answer(handle, opts.discard, true).catch(() => handle.close());
      return { next: 'expired', last: r };
    }
    return { next: d, last: r };
  }
}

/** The person's answer to a failed card. A discard is carried out here; a
 *  refused one is shown and asked again. Closes the card on every final
 *  answer. */
async function answer(
  handle: PrepCardHandle,
  discard: PrepCardDiscard | undefined,
  late: boolean,
): Promise<'retry' | 'expire' | 'start' | 'dismiss' | 'discarded'> {
  for (;;) {
    const d = await handle.decision({ late });
    if (d === 'retry' || d === 'expire') return d;
    if (d === 'discard' && discard) {
      const out = await discard().catch(() => ({ removed: false as const, path: '' }));
      if (!out.removed) {
        handle.mark({ discardRefused: out.path });
        continue;
      }
    }
    handle.close();
    return d === 'discard' ? 'discarded' : d;
  }
}

// ── The one-time "Copy this file too?" suggestion ────────────────────────────

/** Projects the suggestion was made for, so it is made once per project. */
const SUGGESTED_FILE = 'workspace-prep-suggested.json';
const MAX_SUGGESTED = 512;

export interface CopySuggestionStore {
  has(root: string): boolean;
  add(root: string): void;
}

export function fileCopySuggestionStore(file: string = path.join(getWmuxHomeDir(), SUGGESTED_FILE)): CopySuggestionStore {
  const read = (): string[] => {
    try {
      const v = atomicReadJSONSync<{ roots?: unknown }>(file);
      return Array.isArray(v?.roots) ? v.roots.filter((r): r is string => typeof r === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    has: (root) => read().includes(root),
    add: (root) => {
      const roots = read();
      if (roots.includes(root)) return;
      try {
        atomicWriteJSONSync(file, { roots: [...roots, root].slice(-MAX_SUGGESTED) });
      } catch {
        // best-effort: at worst the suggestion is made once more
      }
    },
  };
}

/**
 * The suggestion for a worktree a person opened, made once per project: when
 * the project copies no config files yet (`fanout.copy` never set) and its
 * checkout has `.env` files a worktree does not get. Undefined otherwise. The
 * project is marked once a card has shown it (WorkspacePrepCards.close), so a
 * start that fails before any card, or a card whose setup failed, does not
 * use it up.
 */
export async function copySuggestionFor(
  state: ProjectConfigState,
  sourceCwd: string,
  store: CopySuggestionStore,
  listCandidates: (root: string) => Promise<string[]> = listCopyCandidates,
): Promise<{ cwd: string; count: number; root: string } | undefined> {
  if (state.config?.fanout?.copy !== undefined || state.config?.fanout?.invalidFields?.includes('copy')) return undefined;
  // Not where New workspace setup could save it (the file waits for review).
  if (saveBlock(state, { copy: true })) return undefined;
  const root = state.found && state.configPath ? path.dirname(state.configPath) : sourceCwd;
  const key = path.resolve(root);
  if (store.has(key)) return undefined;
  const count = (await listCandidates(root).catch(() => [])).filter(isDefaultCopyCandidate).length;
  if (count === 0) return undefined;
  return { cwd: sourceCwd, count, root: key };
}
