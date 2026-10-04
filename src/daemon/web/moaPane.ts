// ─── Moa pane — the daemon's copy of one main-process fact ──────────────────
//
// A paired device may reach the Moa (HQ brain) pane's turns, chat and input
// routes, and no other brain pane. Whether a pane IS that pane depends on three
// facts only main holds: the Moa master switch, which workspace is the HQ (and
// that it is present), and which daemon session runs that HQ's brain TUI. So
// main PUSHES the answer over `daemon.moa.set` on every change — the same
// direction and shape as `daemon.workspaceFacts.set`. The desktop sidebar
// snapshot carries `moa` too, but it is stale-while-revalidate for up to ten
// seconds: fine for a list hint, not for an access gate that must close the
// moment Moa is switched off.
//
// What the daemon trusts and what it checks:
//   - The pushed id is never enough on its own. `resolveMoaPane` also needs a
//     live session with that id that carries the brain id prefix, the brain
//     env marker, and the pushed HQ workspace id in its own env — so a push
//     cannot point the gate at an ordinary pane, or at another workspace's
//     brain.
//   - Unpublished means closed: `null` until main pushes, and dropped again
//     when the publishing client disconnects (index.ts), so a daemon running
//     without its GUI exposes no brain pane.
//   - The transcript binding rides along because the brain's hooks go to main,
//     never to the daemon, so the daemon has no resume binding for that pane.
//     It is held in memory only and never written to the pane's persisted
//     `meta.resumeBinding`: a persisted binding is what daemon-restart
//     recovery relaunches with `--resume`, and a brain pane must never be
//     relaunched that way.

import { isUsableResumeBinding, type ResumeBinding } from '../../shared/agentResume';
import { ENV_KEYS, isBrainPtyId } from '../../shared/constants';

export interface MoaPaneFact {
  /** The daemon session running the HQ brain TUI. */
  sessionId: string;
  /** The HQ workspace that brain belongs to. */
  workspaceId: string;
  /** The brain's transcript, once its hooks reported one. Memory only. */
  binding?: ResumeBinding;
}

/** Bounds on pushed strings; anything longer is not an id main mints. */
const MAX_ID_CHARS = 128;
const MAX_PATH_CHARS = 4096;

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * Parse one pushed value: a fact, `null` (no Moa pane), or `'invalid'`. A
 * binding that does not parse is dropped and the pane kept: the transcript is
 * a convenience, the pane identity is what the gate keys on.
 */
export function parseMoaPane(raw: unknown): MoaPaneFact | null | 'invalid' {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const r = raw as Record<string, unknown>;
  if (!boundedString(r.sessionId, MAX_ID_CHARS) || !isBrainPtyId(r.sessionId)) return 'invalid';
  if (!boundedString(r.workspaceId, MAX_ID_CHARS)) return 'invalid';
  const fact: MoaPaneFact = { sessionId: r.sessionId, workspaceId: r.workspaceId };
  const b = r.binding as Record<string, unknown> | undefined;
  if (
    isUsableResumeBinding(b)
    && b.agent === 'claude'
    && boundedString(b.sessionId, MAX_ID_CHARS)
    && boundedString(b.cwd, MAX_PATH_CHARS)
    && (b.transcriptPath === undefined || boundedString(b.transcriptPath, MAX_PATH_CHARS))
    && typeof b.ts === 'number' && Number.isFinite(b.ts)
  ) {
    fact.binding = {
      agent: 'claude',
      sessionId: b.sessionId,
      cwd: b.cwd,
      ...(typeof b.transcriptPath === 'string' ? { transcriptPath: b.transcriptPath } : {}),
      ts: b.ts,
    };
  }
  return fact;
}

export type MoaPaneReplaceResult =
  | { ok: true; applied: true; seq: number }
  | { ok: true; applied: false; reason: 'stale'; seq: number };

/** The current fact, replaced whole by each newer push. */
export class MoaPaneStore {
  private fact: MoaPaneFact | null = null;
  /** The `seq` of the fact held. -1 = nothing published yet. */
  private seq = -1;

  /**
   * Replace the fact unless `seq` is not newer than the one held. Main sends
   * these without awaiting each other, so two pushes can be serviced out of
   * order; a late older push must not reopen a pane a newer one closed.
   */
  replace(fact: MoaPaneFact | null, seq: number): MoaPaneReplaceResult {
    if (!Number.isFinite(seq) || seq <= this.seq) return { ok: true, applied: false, reason: 'stale', seq: this.seq };
    this.fact = fact;
    this.seq = seq;
    return { ok: true, applied: true, seq };
  }

  /** The publisher went away: closed, and the next publisher starts from scratch. */
  clear(): void {
    this.fact = null;
    this.seq = -1;
  }

  current(): MoaPaneFact | null {
    return this.fact;
  }
}

/** The slice of a daemon session the check reads. */
interface PaneLike {
  meta: { env?: Record<string, string> };
}

/**
 * The live session `fact` names, only when it really is that workspace's brain
 * pane: present, brain-prefixed id, brain env marker, and the pushed HQ id in
 * the session's own env. Re-run on every access, so a pane that died, a fact
 * that was withdrawn, or a pane swapped under the same id all fail closed.
 */
export function resolveMoaPane<P extends PaneLike>(
  fact: MoaPaneFact | null | undefined,
  getSession: (id: string) => P | undefined,
): P | undefined {
  if (!fact || !isBrainPtyId(fact.sessionId)) return undefined;
  const pane = getSession(fact.sessionId);
  const env = pane?.meta.env;
  if (!pane || env?.[ENV_KEYS.BRAIN_PTY] !== '1' || env[ENV_KEYS.WORKSPACE_ID] !== fact.workspaceId) return undefined;
  return pane;
}
