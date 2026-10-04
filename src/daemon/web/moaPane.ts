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
//     when the publishing client disconnects (`MoaPaneRpc.onClientClose`), so
//     a daemon running without its GUI exposes no brain pane.
//   - `dialog` says the brain's own permission dialog is on screen. The daemon
//     keeps no approval record for a brain pane, so this is what stops typed
//     input from answering that dialog through the phone.
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
  /** Present while the brain's own permission dialog is up. */
  dialog?: { fingerprint: string };
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
  const dialog = r.dialog as Record<string, unknown> | undefined;
  if (dialog !== undefined) {
    // A malformed dialog is still a dialog: refuse input rather than drop it.
    const fingerprint = dialog && typeof dialog.fingerprint === 'string' && /^[0-9a-f]{1,64}$/.test(dialog.fingerprint)
      ? dialog.fingerprint : 'unknown';
    fact.dialog = { fingerprint };
  }
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
  meta: { env?: Record<string, string>; state?: string };
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
  // A dead or suspended session is still held by the manager; it is not a
  // pane anybody may talk to.
  if (pane.meta.state !== 'attached' && pane.meta.state !== 'detached') return undefined;
  return pane;
}

export interface MoaPaneRpcDeps<P extends PaneLike> {
  /** The daemon's first-party classification of a pipe client. */
  isFirstParty: (clientId: string) => boolean;
  getSession: (id: string) => P | undefined;
  /**
   * A push changed the fact. `pane` is the live pane the new fact resolves to,
   * if any. index.ts arms the process watch and nudges the pane's phone
   * watchers from here.
   */
  onChanged?: (prev: MoaPaneFact | null, next: MoaPaneFact | null, pane: P | undefined) => void;
  log?: (level: 'warn', message: string) => void;
}

export type MoaPaneSetResult =
  | MoaPaneReplaceResult
  | { ok: false; error: string };

/**
 * `daemon.moa.set` and its publisher bookkeeping, apart from the pipe server
 * so the trust rules are testable: first-party only, one publisher at a time
 * (first writer wins while it lives), seq-ordered, cleared with its publisher.
 */
export class MoaPaneRpc<P extends PaneLike> {
  private readonly store = new MoaPaneStore();
  private publisher: string | null = null;

  constructor(private readonly deps: MoaPaneRpcDeps<P>) {}

  current(): MoaPaneFact | null {
    return this.store.current();
  }

  handle(params: unknown, clientId: string): MoaPaneSetResult {
    // Load-bearing: a client that could write this would be choosing which
    // brain pane a phone may type into.
    if (!this.deps.isFirstParty(clientId)) return { ok: false, error: 'daemon.moa.set is first-party only' };
    const payload = (params ?? {}) as { pane?: unknown; seq?: unknown };
    if (typeof payload.seq !== 'number' || !Number.isFinite(payload.seq)) {
      return { ok: false, error: 'daemon.moa.set requires a numeric seq' };
    }
    const fact = parseMoaPane(payload.pane === undefined ? null : payload.pane);
    if (fact === 'invalid') return { ok: false, error: 'daemon.moa.set: invalid pane' };
    // A second first-party client must not take the slot and then, on ITS
    // disconnect, close a pane the real main is still vouching for.
    if (this.publisher !== null && this.publisher !== clientId) {
      this.deps.log?.('warn', `[moa] refused a Moa pane push from ${clientId}: ${this.publisher} is already the publisher`);
      return { ok: false, error: 'another client is already publishing the Moa pane' };
    }
    this.publisher = clientId;
    const prev = this.store.current();
    const result = this.store.replace(fact, payload.seq);
    if (result.applied) this.changed(prev, fact);
    return result;
  }

  /** A pipe client went away; the fact goes with its publisher. */
  onClientClose(clientId: string): void {
    if (this.publisher === null || this.publisher !== clientId) return;
    const prev = this.store.current();
    this.store.clear();
    this.publisher = null;
    if (prev) this.changed(prev, null);
  }

  private changed(prev: MoaPaneFact | null, next: MoaPaneFact | null): void {
    try {
      this.deps.onChanged?.(prev, next, resolveMoaPane(next, this.deps.getSession));
    } catch {
      // Side effects only (process watch, phone nudge); the fact stands.
    }
  }
}
